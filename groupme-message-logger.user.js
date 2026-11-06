// ==UserScript==
// @name         GroupMe Message Logger
// @namespace    dunkirk.sh
// @version      0.1
// @description  Keeps deleted GroupMe messages on screen (highlighted in red) and shows the edit history of edited ones, Vencord MessageLogger style
// @icon         https://web.groupme.com/favicon.ico
// @author       Kieran Klukas
// @license      MIT
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/groupme-message-logger.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/groupme-message-logger.user.js
// @match        https://web.groupme.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
	// Let your own deletions go through like normal instead of logging them.
	const IGNORE_SELF = false;
	// Forget plain messages older than this. Deleted and edited ones are kept forever.
	const MAX_AGE_DAYS = 30;

	const DB_NAME = "groupme-message-logger";
	const STORE = "messages";
	const PUSH_HOST = "push.groupme.com";
	const API_HOST = "api.groupme.com";

	/** @type {Map<string, any>} */
	const records = new Map();
	let myUserId = null;
	let db = null;

	// ---------- storage ----------

	const openDb = () =>
		new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
			req.onsuccess = () => {
				// Step aside if another tab wants to upgrade or delete the database.
				req.result.onversionchange = () => {
					req.result.close();
					db = null;
				};
				resolve(req.result);
			};
			req.onerror = () => reject(req.error);
		});

	const ready = openDb()
		.then((opened) => {
			db = opened;
			return new Promise((resolve) => {
				const tx = db.transaction(STORE, "readwrite");
				const store = tx.objectStore(STORE);
				const cutoff = Date.now() / 1000 - MAX_AGE_DAYS * 86400;
				store.openCursor().onsuccess = (event) => {
					const cursor = event.target.result;
					if (!cursor) return;
					const rec = cursor.value;
					// Drop "edits" that never changed the text (left by older versions).
					if (rec.history?.length) {
						const versions = [...rec.history.map((h) => h.text), rec.text];
						rec.history = rec.history.filter((h, i) => h.text !== versions[i + 1]);
					}
					const keep = rec.deleted || rec.history?.length || (rec.created_at || 0) > cutoff;
					if (!keep) cursor.delete();
					else if (!records.has(rec.id)) records.set(rec.id, rec);
					else records.set(rec.id, mergeRecords(rec, records.get(rec.id)));
					cursor.continue();
				};
				tx.oncomplete = tx.onerror = () => resolve();
			});
		})
		.catch((err) => console.error("[message logger] could not open storage", err));

	// Never hold up GroupMe for long waiting on storage.
	const readyOrTimeout = () => Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1500))]);

	const pendingWrites = new Set();
	let flushScheduled = false;

	function save(rec) {
		records.set(rec.id, rec);
		pendingWrites.add(rec.id);
		if (flushScheduled) return;
		flushScheduled = true;
		setTimeout(() => {
			flushScheduled = false;
			if (!db) return ready.then(() => db && flush());
			flush();
		}, 250);
		scheduleDecorate();
	}

	function flush() {
		if (!db) return;
		try {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			for (const id of pendingWrites) {
				const rec = records.get(id);
				if (rec) store.put(rec);
			}
			pendingWrites.clear();
		} catch (err) {
			console.error("[message logger] could not save", err);
		}
	}

	// A record written before the db finished loading wins over the stored copy,
	// except for the bits that only ever accumulate.
	function mergeRecords(stored, fresh) {
		const keepStored = stored.deleted || !hasContent(fresh);
		return {
			...stored,
			...fresh,
			text: keepStored ? stored.text : fresh.text,
			attachments: keepStored ? stored.attachments : fresh.attachments,
			history: [...(stored.history || []), ...(fresh.history || [])],
			deleted: stored.deleted || fresh.deleted,
		};
	}

	// ---------- message bookkeeping ----------

	const hasContent = (rec) => rec?.text !== undefined;
	const isDeleted = (msg) => typeof msg?.deleted_at === "number" && typeof msg?.deletion_actor === "string";
	// Key order differs between push and REST copies of the same attachment.
	const canonical = (value) =>
		JSON.stringify(value, (_, v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
				: v,
		);
	const sameText = (a, b) => (a.text || "") === (b.text || "");
	const sameAttachments = (a, b) => canonical(a.attachments || []) === canonical(b.attachments || []);

	// Only text changes count as edits; history entries hold text alone.
	function applyContent(rec, next, at) {
		const textChanged = !sameText(rec, next);
		if (!textChanged && sameAttachments(rec, next)) return null;
		return {
			...rec,
			history: textChanged ? [...(rec.history || []), { text: rec.text || "", at: at || null }] : rec.history || [],
			text: next.text || "",
			attachments: next.attachments || [],
		};
	}

	function remember(msg) {
		if (!msg?.id || msg.system || msg.user_id === "system" || msg.event) return;
		const existing = records.get(msg.id);
		if (existing?.deleted) return;
		if (hasContent(existing)) {
			const updated = applyContent(existing, msg, msg.updated_at);
			if (updated) save(updated);
			return;
		}
		save({
			...existing,
			id: msg.id,
			conversation: msg.group_id || msg.chat_id || msg.conversation_id,
			sender_id: msg.sender_id,
			name: msg.name,
			created_at: msg.created_at,
			history: existing?.history || [],
			text: msg.text || "",
			attachments: msg.attachments || [],
		});
	}

	function recordEdit(data) {
		const rec = records.get(data?.message_id);
		if (!hasContent(rec) || rec.deleted) return;
		const next = {
			text: data.message?.text ?? rec.text,
			attachments: data.message?.attachments ?? rec.attachments,
		};
		const updated = applyContent(rec, next, data.updated_at);
		if (updated) save(updated);
	}

	// Returns true when the deletion should be hidden from the app.
	function recordDeletion(data) {
		const rec = records.get(data?.message_id);
		if (IGNORE_SELF && rec && myUserId && rec.sender_id === myUserId) return false;
		save({
			...(rec || { id: data.message_id, history: [] }),
			deleted: { at: data.deleted_at || Math.floor(Date.now() / 1000), actor: data.deletion_actor || "sender" },
		});
		// Without the original text there is nothing worth keeping on screen.
		return hasContent(rec);
	}

	// Rewrites a message from the REST API in place. Deleted messages we have a copy
	// of come back with their original content.
	function reviveMessage(msg) {
		if (!msg?.id) return;
		if (!isDeleted(msg)) return remember(msg);
		const rec = records.get(msg.id);
		if (!hasContent(rec)) return;
		if (IGNORE_SELF && myUserId && rec.sender_id === myUserId) return;
		if (!rec.deleted) save({ ...rec, deleted: { at: msg.deleted_at, actor: msg.deletion_actor } });
		msg.text = rec.text;
		msg.attachments = rec.attachments || [];
		delete msg.deleted_at;
		delete msg.deletion_actor;
	}

	// ---------- push (faye) ----------

	// Processes one batch of bayeux messages and returns the filtered batch, or null
	// when nothing changed.
	// Anything that goes wrong in here must never stop GroupMe from getting the batch.
	function processPushBatch(raw) {
		try {
			return filterPushBatch(raw);
		} catch (err) {
			console.error("[message logger] could not process push message", err);
			return null;
		}
	}

	function filterPushBatch(raw) {
		let batch;
		try {
			batch = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!Array.isArray(batch)) batch = [batch];
		let changed = false;
		const kept = batch.filter((envelope) => {
			const data = envelope?.data;
			const subject = data?.subject;
			if (data?.type !== "line.create" && data?.type !== "direct_message.create") return true;
			const eventType = subject?.event?.type;
			if (eventType === "message.deleted") {
				if (recordDeletion(subject.event.data)) {
					changed = true;
					return false;
				}
				return true;
			}
			if (eventType === "message.update") recordEdit(subject.event.data);
			else remember(subject);
			return true;
		});
		return changed ? JSON.stringify(kept) : null;
	}

	const wrappedListeners = new WeakMap();

	function wrapSocketListener(socket, listener) {
		if (typeof listener !== "function") return listener;
		let wrapped = wrappedListeners.get(listener);
		if (wrapped) return wrapped;
		wrapped = function (event) {
			if (typeof event?.data === "string" && socket.url.includes(PUSH_HOST)) {
				const rewritten = processPushBatch(event.data);
				if (rewritten !== null) {
					event = new MessageEvent("message", {
						data: rewritten,
						origin: event.origin,
						lastEventId: event.lastEventId,
					});
				}
			}
			return listener.call(this, event);
		};
		wrappedListeners.set(listener, wrapped);
		return wrapped;
	}

	const onmessageDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
	Object.defineProperty(WebSocket.prototype, "onmessage", {
		...onmessageDesc,
		set(listener) {
			onmessageDesc.set.call(this, wrapSocketListener(this, listener));
		},
	});

	const origAddEventListener = WebSocket.prototype.addEventListener;
	WebSocket.prototype.addEventListener = function (type, listener, options) {
		if (type === "message") listener = wrapSocketListener(this, listener);
		return origAddEventListener.call(this, type, listener, options);
	};
	const origRemoveEventListener = WebSocket.prototype.removeEventListener;
	WebSocket.prototype.removeEventListener = function (type, listener, options) {
		if (type === "message") listener = wrappedListeners.get(listener) || listener;
		return origRemoveEventListener.call(this, type, listener, options);
	};

	// Faye falls back to long-polling over XHR when websockets are unavailable.
	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		this.__gmlUrl = String(url);
		return origOpen.call(this, method, url, ...rest);
	};
	const responseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
	Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
		...responseTextDesc,
		get() {
			const text = responseTextDesc.get.call(this);
			if (this.readyState !== 4 || !this.__gmlUrl?.includes(PUSH_HOST)) return text;
			if (this.__gmlCache?.source !== text) {
				this.__gmlCache = { source: text, result: processPushBatch(text) ?? text };
			}
			return this.__gmlCache.result;
		},
	});

	// ---------- REST (fetch) ----------

	const MESSAGE_ENDPOINT = /\/v\d\/(groups\/[^/]+\/messages|direct_messages|users\/me)(\/|\?|$)/;

	const origFetch = window.fetch;
	window.fetch = async function (input, init) {
		const response = await origFetch.call(this, input, init);
		try {
			const url = input instanceof Request ? input.url : String(input);
			const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
			if (method !== "GET" || !url.includes(API_HOST) || !MESSAGE_ENDPOINT.test(url) || !response.ok) {
				return response;
			}
			const body = await response.clone().json();
			const payload = body?.response;
			if (!payload) return response;

			if (/\/users\/me/.test(url)) {
				myUserId = payload.id ?? myUserId;
				return response;
			}

			await readyOrTimeout();
			const list = payload.messages || payload.direct_messages || (payload.message ? [payload.message] : []);
			list.forEach(reviveMessage);

			const rewritten = new Response(JSON.stringify(body), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
			Object.defineProperty(rewritten, "url", { value: response.url });
			return rewritten;
		} catch (err) {
			console.error("[message logger] could not process response", err);
			return response;
		}
	};

	// ---------- rendering ----------

	const CSS = `
		[data-gml-bubble] {
			background-color: rgb(240 71 71 / 0.09) !important;
			outline: 1px solid rgb(240 71 71 / 0.35);
			outline-offset: -1px;
		}
		[data-gml-bubble] > [data-large-emoji],
		[data-gml-bubble] > [data-large-emoji] * {
			color: rgb(255 110 110) !important;
		}
		[data-gml-label]::after {
			content: attr(data-gml-label);
			display: inline-block;
			margin-left: 8px;
			padding: 1px 7px;
			border-radius: 999px;
			background: rgb(240 71 71 / 0.18);
			color: rgb(255 130 130);
			font-size: 11px;
			font-weight: 500;
			line-height: 16px;
			vertical-align: 1px;
		}
		[data-gml-bubble][data-gml-label]::after {
			display: table;
			margin: 4px 0 0;
		}
		[data-gml-history]::before {
			content: attr(data-gml-history);
			display: block;
			white-space: pre-wrap;
			margin-bottom: 4px;
			padding-left: 8px;
			border-left: 2px solid currentColor;
			opacity: 0.5;
			font-size: 0.92em;
		}
	`;

	const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

	function deletionLabel(deleted) {
		const who = deleted.actor === "sender" ? "" : "by admin ";
		return `deleted ${who}${timeFormat.format(new Date(deleted.at * 1000))}`;
	}

	function setAttr(el, name, value) {
		if (!el) return;
		if (value == null) el.removeAttribute(name);
		else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
	}

	function decorate() {
		for (const el of document.querySelectorAll("[data-message-id]")) {
			const rec = records.get(el.getAttribute("data-message-id"));
			const bubble = el.querySelector("[data-yourmessage]");
			const text = bubble?.querySelector(":scope > [data-large-emoji]");
			// The pill sits next to the timestamp; without a header it goes under the text.
			const time = bubble?.querySelector("[data-message-time]");
			const label = rec?.deleted ? deletionLabel(rec.deleted) : null;
			setAttr(bubble, "data-gml-bubble", label === null ? null : "");
			setAttr(time, "data-gml-label", label);
			setAttr(bubble, "data-gml-label", time ? null : label);
			const history = rec?.history?.length ? rec.history.map((h) => h.text || "(no text)").join("\n") : null;
			setAttr(text, "data-gml-history", history);
		}
	}

	let decorateScheduled = false;
	function scheduleDecorate() {
		if (decorateScheduled) return;
		decorateScheduled = true;
		requestAnimationFrame(() => {
			decorateScheduled = false;
			decorate();
		});
	}

	function startRendering() {
		const style = document.createElement("style");
		style.textContent = CSS;
		document.head.append(style);
		new MutationObserver(scheduleDecorate).observe(document.body, { childList: true, subtree: true });
		ready.then(scheduleDecorate);
	}

	if (document.body) startRendering();
	else document.addEventListener("DOMContentLoaded", startRendering, { once: true });

	window.groupmeMessageLogger = {
		records,
		clear() {
			records.clear();
			pendingWrites.clear();
			if (db) db.transaction(STORE, "readwrite").objectStore(STORE).clear();
			scheduleDecorate();
		},
	};
})();
