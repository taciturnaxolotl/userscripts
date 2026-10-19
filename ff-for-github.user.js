// ==UserScript==
// @name         Fast-forward merge for GitHub
// @namespace    dunkirk.sh
// @version      1.12
// @description  Adds fast-forward merging to GitHub's merge method dropdown and compare pages. Based on simnalamburt/ff-for-github.
// @icon         https://github.githubassets.com/favicons/favicon.png
// @author       Kieran Klukas, simnalamburt
// @license      MIT OR Apache-2.0
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/ff-for-github.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/ff-for-github.user.js
// @match        https://github.com/*
// @exclude      https://github.com/login*
// @exclude      https://github.com/session*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(() => {
	const TOKEN_KEY = "github-token";
	const REPO_CACHE_MS = 5 * 60_000;
	const REFETCH_DEBOUNCE_MS = 800;
	const STALE_AFTER_MS = 60_000;
	const CONFIRM_TIMEOUT_MS = 5_000;
	const MOVE_TO_END_PATH =
		"m10.78 8.53-3.75 3.75a.749.749 0 1 1-1.06-1.06l2.469-2.47H1.75a.75.75 0 0 1 0-1.5h6.689L5.97 4.78a.749.749 0 1 1 1.06-1.06l3.75 3.75a.749.749 0 0 1 0 1.06ZM13 12.25v-8.5a.75.75 0 0 1 1.5 0v8.5a.75.75 0 0 1-1.5 0Z";

	const getToken = () => (GM_getValue(TOKEN_KEY, "") || "").trim();

	const X_PATH =
		"M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z";
	const ALERT_PATH =
		"M4.855.708c.5-.896 1.79-.896 2.29 0l4.675 8.351a1.312 1.312 0 0 1-1.146 1.954H1.33A1.313 1.313 0 0 1 .183 9.058ZM7 7V3H5v4Zm-1 3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z";
	const NEW_TOKEN_URL =
		"https://github.com/settings/personal-access-tokens/new";

	function setToken(token) {
		if (token) GM_setValue(TOKEN_KEY, token);
		else GM_deleteValue(TOKEN_KEY);
		repoCache.clear();
		resetPage();
		schedule();
	}

	let prcClasses = null;
	function prc(name) {
		if (!prcClasses) {
			prcClasses = new Set();
			const walk = (rules) => {
				for (const rule of rules) {
					if (rule.cssRules) walk(rule.cssRules);
					for (const m of rule.selectorText?.matchAll(/\.(prc-[\w-]+)/g) ?? [])
						prcClasses.add(m[1]);
				}
			};
			for (const sheet of document.styleSheets) {
				try {
					walk(sheet.cssRules);
				} catch {}
			}
		}
		const prefix = `prc-${name}-`;
		for (const cls of prcClasses)
			if (cls.startsWith(prefix) && cls.length - prefix.length === 5)
				return cls;
		return null;
	}

	function promptForToken() {
		const need = [
			"Dialog-Backdrop",
			"Dialog-Dialog",
			"Dialog-Header",
			"Dialog-HeaderInner",
			"Dialog-HeaderContent",
			"Dialog-Title",
			"Dialog-Body",
			"Dialog-Footer",
			"Button-ButtonBase",
			"Button-ButtonContent",
			"Button-Label",
			"Button-IconButton",
			"FormControl-ControlVerticalLayout",
			"FormControl-Caption",
			"components-Label",
			"components-TextInputWrapper",
			"components-TextInputBaseWrapper",
			"components-Input",
			"components-InputValidation",
			"components-ValidationIcon",
			"components-ValidationText",
		];
		const c = Object.fromEntries(need.map((n) => [n, prc(n)]));
		if (Object.values(c).some((v) => !v)) {
			const entered = prompt("GitHub token", "");
			if (entered !== null) setToken(entered.trim());
			return;
		}

		document.getElementById("ghff-token-dialog")?.parentElement.remove();
		const id = "ghff-token-dialog";
		const existing = !!getToken();

		const button = (label, variant, extra = {}) =>
			h(
				"button",
				{
					type: "button",
					class: c["Button-ButtonBase"],
					"data-variant": variant,
					"data-size": "medium",
					"data-no-visuals": "true",
					...extra,
				},
				h(
					"span",
					{ class: c["Button-ButtonContent"], "data-align": "center" },
					h("span", { class: c["Button-Label"] }, label),
				),
			);

		const input = h("input", {
			id: `${id}-input`,
			type: "password",
			class: c["components-Input"],
			"data-component": "input",
			autocomplete: "off",
			spellcheck: "false",
			"data-1p-ignore": "true",
			"data-lpignore": "true",
			"data-bwignore": "true",
			"aria-describedby": `${id}-caption`,
		});
		const inputWrap = h(
			"span",
			{
				class: `TextInput-wrapper ${c["components-TextInputWrapper"]} ${c["components-TextInputBaseWrapper"]}`,
				"data-block": "true",
				"data-size": "medium",
				"data-no-trailing-action": "true",
				"data-no-leading-visual": "true",
				"data-no-trailing-visual": "true",
				"data-component": "TextInput",
			},
			input,
		);
		inputWrap.style.fontFamily = "var(--fontStack-monospace)";

		const errorText = h("span", { class: c["components-ValidationText"] });
		const error = h(
			"div",
			{
				class: c["components-InputValidation"],
				id: `${id}-error`,
				"data-validation-status": "error",
				hidden: "",
			},
			[
				h(
					"span",
					{ class: c["components-ValidationIcon"], "aria-hidden": "true" },
					octicon("", ALERT_PATH, 12),
				),
				errorText,
			],
		);
		const caption = h(
			"span",
			{ class: c["FormControl-Caption"], id: `${id}-caption` },
			[
				"Needs Contents (read and write) and Pull requests (read). ",
				h(
					"a",
					{
						class: "Link--inTextBlock",
						href: NEW_TOKEN_URL,
						target: "_blank",
						rel: "noopener",
					},
					"Create a token",
				),
			],
		);

		const close = h(
			"button",
			{
				type: "button",
				class: `${c["Button-ButtonBase"]} ${c["Button-IconButton"]}`,
				"data-variant": "invisible",
				"data-size": "medium",
				"aria-label": "Close",
			},
			octicon("", X_PATH),
		);
		const remove = existing
			? button("Remove", "danger", { style: "margin-right: auto" })
			: null;
		const cancel = button("Cancel", "default");
		const save = button("Save", "primary", {
			type: "submit",
			form: `${id}-form`,
		});

		const form = h(
			"form",
			{ id: `${id}-form` },
			h("div", { class: c["FormControl-ControlVerticalLayout"] }, [
				h(
					"label",
					{ class: c["components-Label"], for: input.id },
					"Personal access token",
				),
				inputWrap,
				error,
				caption,
			]),
		);

		const dialog = h(
			"div",
			{
				id,
				class: c["Dialog-Dialog"],
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": `${id}-title`,
				"data-position-regular": "center",
				"data-position-narrow": "center",
				"data-width": "large",
				"data-height": "auto",
				"data-has-footer": "",
			},
			[
				h(
					"div",
					{ class: c["Dialog-Header"] },
					h("div", { class: c["Dialog-HeaderInner"] }, [
						h(
							"div",
							{ class: c["Dialog-HeaderContent"] },
							h(
								"h1",
								{ class: c["Dialog-Title"], id: `${id}-title` },
								"GitHub token",
							),
						),
						close,
					]),
				),
				h("div", { class: c["Dialog-Body"] }, form),
				h(
					"div",
					{ class: c["Dialog-Footer"] },
					[remove, cancel, save].filter(Boolean),
				),
			],
		);
		const backdrop = h(
			"div",
			{ class: c["Dialog-Backdrop"], style: "z-index: 1000" },
			dialog,
		);
		document.body.append(backdrop);

		const previousFocus = document.activeElement;
		let busy = false;
		const done = () => {
			backdrop.remove();
			document.removeEventListener("keydown", onKey, true);
			previousFocus?.focus?.();
		};
		const showError = (message) => {
			errorText.textContent = message;
			error.hidden = !message;
			setAttr(inputWrap, "data-validation", message ? "error" : null);
			setAttr(input, "aria-invalid", message ? "true" : null);
			setAttr(
				input,
				"aria-describedby",
				message ? `${id}-error ${id}-caption` : `${id}-caption`,
			);
		};
		const setBusy = (on) => {
			busy = on;
			for (const b of [save, cancel, remove, close].filter(Boolean))
				b.disabled = on;
			input.disabled = on;
			save.querySelector(`.${c["Button-Label"]}`).textContent = on
				? "Saving…"
				: "Save";
		};
		function onKey(event) {
			if (event.key === "Escape" && !busy) {
				event.preventDefault();
				event.stopPropagation();
				done();
			} else if (event.key === "Tab") {
				const focusable = [
					...dialog.querySelectorAll("button, input, a[href]"),
				].filter((el) => !el.disabled);
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		}
		document.addEventListener("keydown", onKey, true);

		input.addEventListener("input", () => showError(""));
		cancel.addEventListener("click", done);
		close.addEventListener("click", done);
		backdrop.addEventListener("mousedown", (event) => {
			if (event.target === backdrop && !busy) done();
		});
		remove?.addEventListener("click", () => {
			setToken("");
			done();
		});
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const token = input.value.trim();
			if (!token) {
				showError("Token can't be blank");
				input.focus();
				return;
			}
			setBusy(true);
			try {
				await api("GET", "/user", undefined, token);
				setToken(token);
				done();
			} catch (err) {
				setBusy(false);
				showError(
					err.status === 401 ? "Token is invalid or expired" : err.message,
				);
				input.focus();
			}
		});

		setTimeout(() => input.focus(), 50);
	}

	GM_registerMenuCommand("Set GitHub token", promptForToken);
	GM_registerMenuCommand("Clear GitHub token", () => setToken(""));

	class ApiError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}

	function api(method, path, body, token = getToken()) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method,
				url: `https://api.github.com${path}`,
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					Authorization: `Bearer ${token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				data: body ? JSON.stringify(body) : undefined,
				anonymous: true,
				nocache: true,
				onload: (res) => {
					let data = null;
					try {
						data = JSON.parse(res.responseText);
					} catch {}
					if (res.status >= 200 && res.status < 300) resolve(data);
					else
						reject(
							new ApiError(
								res.status,
								data?.message || `GitHub API returned ${res.status}`,
							),
						);
				},
				onerror: () =>
					reject(new ApiError(0, "Couldn't reach api.github.com.")),
				ontimeout: () => reject(new ApiError(0, "api.github.com timed out.")),
			});
		});
	}

	const enc = encodeURIComponent;
	const encRef = (ref) => ref.split("/").map(enc).join("/");

	const REPO_CACHE_KEY = "repo-cache";
	const repoCache = { clear: () => GM_deleteValue(REPO_CACHE_KEY) };
	async function getRepo(owner, repo) {
		const key = `${owner}/${repo}`.toLowerCase();
		const cache = GM_getValue(REPO_CACHE_KEY, {});
		const hit = cache[key];
		if (hit && Date.now() - hit.at < REPO_CACHE_MS) return hit.data;
		const full = await api("GET", `/repos/${enc(owner)}/${enc(repo)}`);
		const data = {
			permissions: full.permissions,
			default_branch: full.default_branch,
		};
		const fresh = GM_getValue(REPO_CACHE_KEY, {});
		for (const [k, v] of Object.entries(fresh))
			if (Date.now() - v.at >= REPO_CACHE_MS) delete fresh[k];
		fresh[key] = { at: Date.now(), data };
		GM_setValue(REPO_CACHE_KEY, fresh);
		return data;
	}

	const HIDDEN = { kind: "hidden" };

	async function fetchPullStatus({ owner, repo, number }) {
		const [repoInfo, pr] = await Promise.all([
			getRepo(owner, repo),
			api("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`),
		]);
		if (!repoInfo.permissions?.push) return HIDDEN;
		if (pr.state !== "open" || pr.draft) return HIDDEN;

		const stack = await findStackBelow(owner, repo, pr);
		const bases = stack.map((p) => p.base.ref).reverse();
		const cmps = await Promise.all(
			bases.map((base) =>
				api(
					"GET",
					`/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${pr.head.sha}`,
				),
			),
		);
		const blocking = cmps.findIndex((cmp) => cmp.status !== "ahead");
		const cmp = cmps[blocking === -1 ? 0 : blocking];
		return {
			kind: "ready",
			status: cmp.status,
			aheadBy: cmps[0].ahead_by ?? 0,
			behindBy: cmp.behind_by ?? 0,
			base: bases[0],
			blockingBase: bases[blocking === -1 ? 0 : blocking],
			bases,
			stackSize: stack.length,
			pulls: stack.map((p) => p.number).reverse(),
			head: pr.head.ref,
			headSha: pr.head.sha,
		};
	}

	async function findStackBelow(owner, repo, pr) {
		if (!pr.stack?.number || !(pr.stack.position > 1)) return [pr];
		const stack = await api(
			"GET",
			`/repos/${enc(owner)}/${enc(repo)}/stacks/${pr.stack.number}`,
		);
		const members = stack.pull_requests ?? [];
		const index = members.findIndex((p) => p.number === pr.number);
		if (index < 1 || members.slice(0, index).some((p) => p.state !== "open"))
			return [pr];
		return members.slice(0, index + 1).reverse();
	}

	async function fetchCompareStatus({ owner, repo, base, head }) {
		const repoInfo = await getRepo(owner, repo);
		if (!repoInfo.permissions?.push) return HIDDEN;

		const baseRef = splitQualified(base ?? repoInfo.default_branch);
		if (baseRef.owner && baseRef.owner.toLowerCase() !== owner.toLowerCase())
			return HIDDEN;

		try {
			await api(
				"GET",
				`/repos/${enc(owner)}/${enc(repo)}/branches/${encRef(baseRef.ref)}`,
			);
		} catch (err) {
			if (err.status === 404) return HIDDEN;
			throw err;
		}

		const cmp = await api(
			"GET",
			`/repos/${enc(owner)}/${enc(repo)}/compare/${enc(baseRef.ref)}...${enc(head)}`,
		);

		let headSha = null;
		if (cmp.status === "ahead") {
			const commits = cmp.commits ?? [];
			if (commits.length && commits.length === cmp.total_commits) {
				headSha = commits[commits.length - 1].sha;
			} else if (!splitQualified(head).owner) {
				headSha = (
					await api(
						"GET",
						`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(head)}`,
					)
				).sha;
			} else {
				throw new Error("This comparison is too large to fast-forward.");
			}
		}

		return {
			kind: "ready",
			status: cmp.status,
			aheadBy: cmp.ahead_by ?? 0,
			behindBy: cmp.behind_by ?? 0,
			base: baseRef.ref,
			head: splitQualified(head).ref,
			headSha,
		};
	}

	async function fastForward(owner, repo, base, sha) {
		try {
			await api(
				"PATCH",
				`/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${encRef(base)}`,
				{
					sha,
					force: false,
				},
			);
		} catch (err) {
			if (err.status === 422 && /fast.?forward/i.test(err.message)) {
				throw new Error(`${base} has new commits and can't be fast-forwarded.`);
			}
			if (err.status === 422 || err.status === 403) {
				throw new Error(`Couldn't update ${base}: ${err.message}`);
			}
			throw err;
		}
	}

	function splitQualified(ref) {
		const i = ref.indexOf(":");
		return i > 0
			? { owner: ref.slice(0, i), ref: ref.slice(i + 1) }
			: { owner: null, ref };
	}

	function parseRoute() {
		const path = location.pathname;

		const pull = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
		if (pull) {
			const [, owner, repo, number] = pull;
			return {
				kind: "pull",
				owner,
				repo,
				number,
				key: `pull:${owner}/${repo}#${number}`,
			};
		}

		const compare = path.match(/^\/([^/]+)\/([^/]+)\/compare\/(.+?)\/?$/);
		if (compare) {
			const [, owner, repo, rawSpec] = compare;
			let spec;
			try {
				spec = decodeURIComponent(rawSpec);
			} catch {
				return null;
			}
			const sep = spec.includes("...")
				? "..."
				: spec.includes("..")
					? ".."
					: null;
			const [base, head] = sep ? spec.split(sep) : [null, spec];
			if (!head || base === "") return null;
			return {
				kind: "compare",
				owner,
				repo,
				base,
				head,
				key: `compare:${owner}/${repo}:${base ?? ""}...${head}`,
			};
		}

		return null;
	}

	let page = null;

	const MERGEBOX = "[data-testid='mergebox-border-container']";
	const METHOD_GROUP = "ul[role='group'][aria-label='Merge method']";
	const methodKey = (route) =>
		`method:${route.owner}/${route.repo}`.toLowerCase();

	function resetPage(route = page?.route) {
		removeUi();
		clearTimeout(page?.refetchTimer);
		clearTimeout(page?.confirmTimer);
		page = route
			? {
					route,
					result: null,
					fetchedAt: 0,
					fingerprint: null,
					fetching: false,
					refetchQueued: false,
					refetchTimer: null,
					seq: 0,
					confirming: false,
					confirmTimer: null,
					merging: false,
					mergeError: null,
					mergedSha: null,
					chosen:
						route.kind === "pull" && GM_getValue(methodKey(route), "") === "ff",
				}
			: null;
		if (page) requestRefetch(0);
	}

	function requestRefetch(delay = REFETCH_DEBOUNCE_MS) {
		if (!page || (page.mergedSha && page.route.kind === "compare")) return;
		clearTimeout(page.refetchTimer);
		page.refetchTimer = setTimeout(runFetch, delay);
	}

	async function runFetch() {
		const current = page;
		if (!current) return;
		if (current.fetching) {
			current.refetchQueued = true;
			return;
		}
		current.fetching = true;
		const seq = ++current.seq;
		let result;
		try {
			if (!getToken()) result = { kind: "no-token" };
			else if (current.route.kind === "pull")
				result = await fetchPullStatus(current.route);
			else result = await fetchCompareStatus(current.route);
		} catch (err) {
			result =
				err.status === 404
					? {
							kind: "error",
							message: "Your token doesn't have access to this repository.",
							quiet: true,
						}
					: err.status === 401
						? {
								kind: "error",
								message:
									"Your GitHub token is invalid. Set a new one from the userscript menu.",
							}
						: { kind: "error", message: err.message };
		}
		current.fetching = false;
		if (page !== current || seq !== current.seq) return;
		current.result = result;
		current.fetchedAt = Date.now();
		if (current.refetchQueued) {
			current.refetchQueued = false;
			requestRefetch();
		}
		schedule();
	}

	async function runMerge() {
		const current = page;
		const result = current?.result;
		if (
			!current ||
			result?.kind !== "ready" ||
			result.status !== "ahead" ||
			current.merging
		)
			return;

		current.merging = true;
		current.mergeError = null;
		schedule();
		try {
			for (const base of result.bases ?? [result.base]) {
				await fastForward(
					current.route.owner,
					current.route.repo,
					base,
					result.headSha,
				);
			}
			current.mergedSha = result.headSha;
		} catch (err) {
			current.mergeError = err.message;
		}
		current.merging = false;
		if (page === current && !current.mergedSha) requestRefetch(0);
		schedule();
	}

	function onActionClick(event) {
		event.preventDefault();
		event.stopPropagation();
		if (!page || page.merging) return;
		if (!page.confirming) {
			page.confirming = true;
			clearTimeout(page.confirmTimer);
			const current = page;
			page.confirmTimer = setTimeout(() => {
				current.confirming = false;
				schedule();
			}, CONFIRM_TIMEOUT_MS);
			schedule();
			return;
		}
		clearTimeout(page.confirmTimer);
		page.confirming = false;
		runMerge();
	}

	const ui = { menuItem: null, mainItem: null, panel: null, box: null };

	function removeUi() {
		for (const key of Object.keys(ui)) {
			const value = ui[key];
			(value?.root ?? value)?.remove();
			ui[key] = null;
		}
		for (const el of document.querySelectorAll("[data-ghff-hidden]"))
			el.removeAttribute("data-ghff-hidden");
		restoreNativeChecks(document);
	}

	const style = document.createElement("style");
	style.textContent = `
    [data-ghff-hidden] { display: none !important; }
    [data-ghff] .commit-link tt {
      white-space: break-spaces;
      background-color: var(--bgColor-neutral-muted, var(--color-neutral-muted));
      border-radius: 6px;
      margin: 0;
      padding: 0.2em 0.4em;
      font-size: 85%;
    }
    [data-ghff] .commit-link:hover,
    [data-ghff] .issue-link:hover,
    [data-a11y-link-underlines="true"] [data-ghff] .commit-link,
    [data-a11y-link-underlines="true"] [data-ghff] .issue-link {
      text-decoration: underline;
      text-underline-offset: 0.2rem;
    }
  `;
	(document.head || document.documentElement).append(style);

	function h(tag, props = {}, children = []) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === "class") el.className = v;
			else if (k === "style") el.style.cssText = v;
			else el.setAttribute(k, v);
		}
		for (const child of [].concat(children)) el.append(child);
		return el;
	}

	function octicon(extraClass = "", d = MOVE_TO_END_PATH, size = 16) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("class", `octicon ${extraClass}`.trim());
		svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
		svg.setAttribute("width", String(size));
		svg.setAttribute("height", String(size));
		svg.setAttribute("fill", "currentColor");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS(ns, "path");
		path.setAttribute("d", d);
		svg.append(path);
		return svg;
	}

	const setText = (el, text) => {
		if (!el) return;
		if (!Array.isArray(text)) {
			if (el.ghffKey !== undefined || el.textContent !== text)
				el.textContent = text;
			el.ghffKey = undefined;
			return;
		}
		const key = JSON.stringify(text);
		if (el.ghffKey === key) return;
		el.ghffKey = key;
		el.replaceChildren(
			...text.map((part) =>
				typeof part === "string"
					? part
					: part.pr
						? pullLink(part.pr)
						: commitLink(part.sha),
			),
		);
	};

	function pullLink(number) {
		const { owner, repo } = page.route;
		return h(
			"a",
			{
				class: "issue-link js-issue-link",
				href: `https://github.com/${owner}/${repo}/pull/${number}`,
				"data-url": `https://github.com/${owner}/${repo}/issues/${number}`,
				"data-hovercard-type": "pull_request",
				"data-hovercard-url": `/${owner}/${repo}/pull/${number}/hovercard`,
			},
			`#${number}`,
		);
	}

	function commitLink(sha) {
		const { owner, repo } = page.route;
		const url = `https://github.com/${owner}/${repo}/commit/${sha}`;
		return h(
			"a",
			{
				class: "commit-link",
				href: url,
				"data-hovercard-type": "commit",
				"data-hovercard-url": `${url}/hovercard`,
			},
			h("tt", {}, short(sha)),
		);
	}
	const setAttr = (el, name, value) => {
		if (value === null || value === undefined || value === false) {
			if (el.hasAttribute(name)) el.removeAttribute(name);
		} else if (el.getAttribute(name) !== String(value)) {
			el.setAttribute(name, String(value));
		}
	};
	const setHidden = (el, hidden) => {
		if (el.hidden !== hidden) el.hidden = hidden;
	};
	const hideNative = (el, hidden) =>
		el && setAttr(el, "data-ghff-hidden", hidden ? "" : null);
	const placeBefore = (el, ref) => {
		if (el.nextSibling !== ref || el.parentNode !== ref.parentNode)
			ref.before(el);
	};
	const placeAfter = (el, ref) => {
		if (el.previousSibling !== ref || el.parentNode !== ref.parentNode)
			ref.after(el);
	};

	const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
	const short = (sha) => sha.slice(0, 7);

	const ffReady = (result) =>
		result?.kind === "ready" && result.status === "ahead";
	const ffActive = () =>
		!!page?.chosen &&
		(!page.result || ffReady(page.result) || !!page.mergedSha);

	function chooseFastForward(chosen) {
		if (!page || page.chosen === chosen) return;
		page.chosen = chosen;
		page.confirming = false;
		page.mergeError = null;
		if (chosen) GM_setValue(methodKey(page.route), "ff");
		else GM_deleteValue(methodKey(page.route));
		schedule();
	}

	function closeMethodMenu() {
		document
			.querySelector(
				`${MERGEBOX} [data-component='ButtonGroup'] button[aria-haspopup][aria-expanded='true']`,
			)
			?.click();
	}

	function onMenuItem(event) {
		event.preventDefault();
		event.stopPropagation();
		const result = page?.result;
		if (result?.kind === "no-token") {
			closeMethodMenu();
			promptForToken();
		} else if (ffReady(result)) {
			chooseFastForward(true);
			closeMethodMenu();
		}
	}

	function onNativeMethodPicked(event) {
		if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ")
			return;
		const item = event.target.closest?.("[role='menuitemradio']");
		if (item && !item.dataset.ghff && item.closest(METHOD_GROUP))
			chooseFastForward(false);
	}
	document.addEventListener("click", onNativeMethodPicked, true);
	document.addEventListener("keydown", onNativeMethodPicked, true);

	function describeMenuItem() {
		const result = page.result;
		if (!result) return { desc: "Checking…", disabled: true };
		if (result.kind === "no-token")
			return {
				desc: "Requires a GitHub token. Click to add one.",
				disabled: false,
			};
		if (result.kind === "error")
			return result.quiet ? null : { desc: result.message, disabled: true };
		if (result.kind !== "ready") return null;
		const stacked = result.stackSize > 1;
		if (result.status === "ahead") {
			const commits =
				result.aheadBy === 1 ? "The 1 commit" : `The ${result.aheadBy} commits`;
			const from = stacked
				? `these ${result.stackSize} branches`
				: "this branch";
			return {
				desc: `${commits} from ${from} will be added to the base branch unchanged.`,
				disabled: false,
			};
		}
		if (result.status === "diverged") {
			const who =
				stacked && result.blockingBase !== result.base
					? result.blockingBase
					: "The base branch";
			return {
				desc: `${who} has ${plural(result.behindBy, "commit")} that ${result.behindBy === 1 ? "isn't" : "aren't"} in this branch.`,
				disabled: true,
			};
		}
		return null;
	}

	function buildMenuItem(template) {
		const root = template.cloneNode(true);
		for (const attr of [
			"id",
			"aria-labelledby",
			"aria-describedby",
			"aria-keyshortcuts",
			"aria-disabled",
		]) {
			root.removeAttribute(attr);
		}
		root.id = "ghff-method";
		root.dataset.ghff = "method";
		root.setAttribute("tabindex", "-1");
		const label = root.querySelector(
			"[data-component='ActionList.Item.Label']",
		);
		const desc = root.querySelector(
			"[data-component='ActionList.Description']",
		);
		if (label) {
			label.id = "ghff-method--label";
			root.setAttribute("aria-labelledby", label.id);
		}
		if (desc) {
			desc.id = "ghff-method--description";
			root.setAttribute("aria-describedby", desc.id);
		}
		root.addEventListener("click", onMenuItem);
		root.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") onMenuItem(event);
		});
		return { root, label, desc };
	}

	function restoreNativeChecks(scope) {
		for (const li of scope?.querySelectorAll("[data-ghff-checked]") ?? []) {
			li.setAttribute("aria-checked", li.dataset.ghffChecked);
			delete li.dataset.ghffChecked;
		}
	}

	function reconcileMenu() {
		const group = document.querySelector(METHOD_GROUP);
		const info = group && page.route.kind === "pull" && describeMenuItem();
		if (!info) {
			ui.menuItem?.root.remove();
			ui.menuItem = null;
			restoreNativeChecks(group);
			return;
		}

		const natives = [...group.children].filter(
			(li) => !li.dataset.ghff && li.getAttribute("role") === "menuitemradio",
		);
		if (!natives.length) return;
		if (!ui.menuItem || ui.menuItem.root.parentNode !== group) {
			ui.menuItem?.root.remove();
			ui.menuItem = buildMenuItem(natives[natives.length - 1]);
		}
		const item = ui.menuItem;
		if (group.lastElementChild !== item.root) group.append(item.root);

		setText(item.label, "Fast-forward merge");
		setText(item.desc, info.desc);
		setAttr(item.root, "aria-disabled", info.disabled ? "true" : null);

		const active = ffActive();
		setAttr(item.root, "aria-checked", String(active));
		if (active) {
			for (const li of natives) {
				if (!("ghffChecked" in li.dataset))
					li.dataset.ghffChecked = li.getAttribute("aria-checked") ?? "false";
				setAttr(li, "aria-checked", "false");
			}
		} else {
			restoreNativeChecks(group);
		}
	}

	function cloneButton(
		native,
		{ variant, extraClass = "", onClick, keepCount = false },
	) {
		const button = native.cloneNode(true);
		for (const attr of [
			"id",
			"aria-labelledby",
			"aria-describedby",
			"aria-haspopup",
			"aria-expanded",
			"style",
			"title",
			"disabled",
		]) {
			button.removeAttribute(attr);
		}
		button.className =
			[...native.classList].filter((c) => c.startsWith("prc-")).join(" ") +
			" " +
			extraClass;
		button.setAttribute("data-variant", variant);
		button.setAttribute("data-loading", "false");
		button.setAttribute("aria-disabled", "false");
		for (const visual of button.querySelectorAll(
			"[data-component='leadingVisual'], [data-component='trailingVisual']",
		))
			if (!keepCount || !visual.querySelector("[data-component='ButtonCounter']"))
				visual.remove();
		if (!button.querySelector("[data-component='trailingVisual']"))
			button.removeAttribute("data-has-count");
		const label = button.querySelector("[data-component='text']");
		if (label) label.textContent = "";
		else button.append(h("span", { "data-component": "text" }));
		button.type = "button";
		button.dataset.ghff = "button";
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!button.disabled) onClick();
		});
		return button;
	}

	const buttonLabel = (button) =>
		button.querySelector("[data-component='text']");

	function setButtonState(button, { text, disabled = false, title = null }) {
		setText(buttonLabel(button), text);
		setAttr(button, "disabled", disabled ? "" : null);
		setAttr(button, "aria-disabled", String(disabled));
		setAttr(button, "title", title);
	}

	function buildMainItem(nativeItem, nativeButton) {
		const root = nativeItem.cloneNode(false);
		root.removeAttribute("data-ghff-hidden");
		root.dataset.ghff = "main";
		const button = cloneButton(nativeButton, {
			variant: nativeButton.getAttribute("data-variant") || "primary",
			extraClass: "flex-1",
			keepCount: true,
			onClick: () => {
				if (!page) return;
				page.confirming = true;
				page.mergeError = null;
				schedule();
				setTimeout(() => ui.panel?.confirm.focus(), 150);
			},
		});
		root.append(button);
		return { root, button };
	}

	function buildPanel(nativeButton) {
		const text = h("span", { class: "fgColor-muted" });
		const confirm = cloneButton(nativeButton, {
			variant: "primary",
			extraClass: "flex-self-stretch flex-shrink-0",
			onClick: runMerge,
		});
		const cancel = cloneButton(nativeButton, {
			variant: "default",
			extraClass: "flex-self-stretch flex-shrink-0",
			onClick: () => {
				if (!page) return;
				page.confirming = false;
				page.mergeError = null;
				schedule();
			},
		});
		const root = h(
			"div",
			{
				class: "bgColor-muted borderColor-muted tmp-p-3 rounded-2",
				"data-ghff": "confirm",
			},
			h("div", {}, [
				text,
				h(
					"div",
					{
						class:
							"d-flex flex-column flex-sm-row flex-sm-items-center gap-2 tmp-mt-3",
					},
					[confirm, cancel],
				),
			]),
		);
		return { root, text, confirm, cancel };
	}

	function nativeMergeButton(container) {
		const group = container.querySelector("[data-component='ButtonGroup']");
		return [...(group?.querySelectorAll("button") ?? [])].find(
			(b) => !b.closest("[data-ghff]") && !b.hasAttribute("aria-haspopup"),
		);
	}

	function pullFingerprint(container) {
		const headings = [...container.querySelectorAll("h3:not(.sr-only)")].map(
			(el) => el.textContent.trim(),
		);
		return [
			document
				.querySelector("[data-component='StateLabel']")
				?.getAttribute("data-status"),
			document.querySelector("#prs-commits-anchor-tab")?.textContent.trim(),
			...headings,
		].join("|");
	}

	function reconcilePull() {
		const container = document.querySelector(MERGEBOX);
		if (!container) {
			removeUi();
			return;
		}

		const fingerprint = pullFingerprint(container);
		if (fingerprint !== page.fingerprint) {
			if (page.fingerprint !== null) requestRefetch();
			page.fingerprint = fingerprint;
		}

		reconcileMenu();

		const nativeButton = nativeMergeButton(container);
		const nativeItem = nativeButton?.parentElement;
		const row = nativeButton?.closest(
			"[data-component='ButtonGroup']",
		)?.parentElement;
		const active = !!row && ffActive();
		const showPanel = active && page.confirming;

		const blocked =
			!!nativeButton &&
			(nativeButton.disabled ||
				nativeButton.getAttribute("aria-disabled") === "true");
		const blockedTitle = blocked ? "Merging is blocked" : null;
		const bypassBox = [
			...container.querySelectorAll("input[type='checkbox']"),
		].find((input) =>
			/bypass/i.test(
				input.closest("[data-component='FormControl']")?.textContent ?? "",
			),
		);
		const bypassing = !!bypassBox?.checked && !blocked;
		const stacked = page.result?.stackSize > 1;

		if (active && !showPanel) {
			if (!ui.mainItem || !ui.mainItem.root.isConnected) {
				ui.mainItem?.root.remove();
				ui.mainItem = buildMainItem(nativeItem, nativeButton);
			}
			placeBefore(ui.mainItem.root, nativeItem);
			hideNative(nativeItem, true);
			const pending = !page.result;
			const counter = ui.mainItem.button.querySelector(
				"[data-component='trailingVisual']",
			);
			if (counter) setHidden(counter, !stacked);
			setButtonState(ui.mainItem.button, {
				text: stacked
					? bypassing
						? "Bypass rules and fast-forward stack"
						: "Fast-forward stack"
					: bypassing
						? "Bypass rules and fast-forward"
						: "Fast-forward merge",
				disabled: blocked || pending,
				title: pending ? "Checking…" : blockedTitle,
			});
			setAttr(
				ui.mainItem.button,
				"data-variant",
				nativeButton.getAttribute("data-variant") || "primary",
			);
		} else {
			ui.mainItem?.root.remove();
			ui.mainItem = null;
			hideNative(nativeItem, false);
		}

		if (showPanel) {
			if (!ui.panel || !ui.panel.root.isConnected) {
				ui.panel?.root.remove();
				ui.panel = buildPanel(nativeButton);
			}
			const panel = ui.panel;
			if (panel.root.parentNode !== container || panel.root.nextSibling)
				container.append(panel.root);
			for (const child of container.children)
				hideNative(child, child !== panel.root);

			const { result, merging, mergeError, mergedSha } = page;
			const prs = result?.pulls?.length > 1 ? result.pulls : null;
			const target = prs
				? [
						`${prs.length} pull requests (`,
						{ pr: prs[0] },
						"–",
						{ pr: prs[prs.length - 1] },
						")",
					]
				: [result?.base ?? "the base branch"];
			let text;
			if (mergedSha)
				text = ["Fast-forwarded ", ...target, " to ", { sha: mergedSha }];
			else if (mergeError) text = mergeError;
			else if (merging)
				text = ["Fast-forwarding ", ...target, " to ", { sha: result.headSha }, "…"];
			else
				text = ["This will fast-forward ", ...target, " to ", { sha: result.headSha }];
			setText(panel.text, text);
			panel.text.classList.toggle("fgColor-danger", !!mergeError && !mergedSha);
			panel.text.classList.toggle("fgColor-muted", !mergeError || !!mergedSha);

			setHidden(panel.confirm.parentElement, !!mergedSha);
			setButtonState(panel.confirm, {
				text: merging
					? "Fast-forwarding…"
					: mergeError
						? "Try again"
						: bypassing
							? `Confirm bypass rules and fast-forward${stacked ? " stack" : ""}`
							: `Confirm fast-forward${stacked ? " stack" : ""}`,
				disabled: merging || blocked,
				title: blockedTitle,
			});
			setAttr(panel.confirm, "data-variant", bypassing ? "danger" : "primary");
			setButtonState(panel.cancel, { text: "Cancel", disabled: merging });
		} else {
			ui.panel?.root.remove();
			ui.panel = null;
			for (const child of container.children) hideNative(child, false);
		}
	}

	function describeCompare() {
		const { result, mergeError, merging, mergedSha, confirming } = page;
		if (!result || result.kind !== "ready") {
			if (result?.kind === "error" && !result.quiet) {
				return {
					tone: "danger",
					heading: "Couldn't check for fast-forward",
					body: result.message,
				};
			}
			return null;
		}
		if (mergedSha) {
			return {
				tone: "success",
				heading: `Fast-forwarded ${result.base}`,
				body: [`${result.base} is now at `, { sha: mergedSha }],
			};
		}
		if (result.status === "ahead") {
			return {
				tone: "success",
				heading: mergeError ? "Fast-forward failed" : "Able to fast-forward",
				body:
					mergeError ??
					`${result.base} can be fast-forwarded to ${result.head}.`,
				error: !!mergeError,
				action: merging
					? "Fast-forwarding…"
					: confirming
						? `Confirm fast-forward`
						: `Fast-forward ${result.base}`,
			};
		}
		if (result.status === "diverged") {
			return {
				tone: "muted",
				heading: "Can't fast-forward",
				body: `${result.base} has ${plural(result.behindBy, "commit")} that ${result.behindBy === 1 ? "isn't" : "aren't"} in ${result.head}.`,
			};
		}
		return null;
	}

	function buildCompareBox() {
		const icon = h("span", { class: "flex-shrink-0 mr-2" });
		const heading = h("div", { class: "h4" });
		const body = h("div", { class: "f6" });
		const button = h("button", {
			type: "button",
			class: "btn flex-shrink-0 ml-md-3 mt-2 mt-md-0",
		});
		button.addEventListener("click", onActionClick);
		const root = h(
			"div",
			{ class: "Box my-3", "data-ghff": "compare" },
			h("div", { class: "Box-row d-block d-md-flex flex-items-center" }, [
				h("div", { class: "flex-auto d-flex flex-items-start min-width-0" }, [
					icon,
					h("div", { class: "min-width-0" }, [heading, body]),
				]),
				button,
			]),
		);
		return { root, icon, heading, body, button, tone: null };
	}

	function reconcileCompare() {
		const bucket = document.querySelector("#commits_bucket");
		let summary = bucket?.previousElementSibling;
		if (summary && summary === ui.box?.root)
			summary = summary.previousElementSibling;
		const wanted = describeCompare();
		if (!summary || !wanted) {
			removeUi();
			return;
		}

		if (!ui.box) ui.box = buildCompareBox();
		const box = ui.box;
		placeBefore(box.root, summary);

		if (box.tone !== wanted.tone) {
			box.icon.replaceChildren(octicon(`color-fg-${wanted.tone}`));
			box.tone = wanted.tone;
		}
		setText(box.heading, wanted.heading);
		setText(box.body, wanted.body);
		box.body.classList.toggle("color-fg-danger", !!wanted.error);
		box.body.classList.toggle("color-fg-muted", !wanted.error);

		setHidden(box.button, !wanted.action);
		if (wanted.action) {
			setText(box.button, wanted.action);
			box.button.classList.toggle("btn-danger", page.confirming);
			setAttr(box.button, "disabled", page.merging ? "" : null);
		}
	}

	function reconcile() {
		const route = parseRoute();
		if ((route?.key ?? null) !== (page?.route.key ?? null)) resetPage(route);
		if (!page) return;
		if (page.route.kind === "pull") reconcilePull();
		else reconcileCompare();
	}

	let scheduled = false;
	function schedule() {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			scheduled = false;
			reconcile();
		}, 100);
	}

	new MutationObserver(() => {
		if (
			page?.route.kind === "pull" &&
			!ui.menuItem?.root.isConnected &&
			document.querySelector(METHOD_GROUP)
		) {
			reconcileMenu();
		}
		schedule();
	}).observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["aria-disabled", "disabled", "data-status"],
	});

	document.addEventListener("visibilitychange", () => {
		if (
			document.visibilityState === "visible" &&
			page &&
			Date.now() - page.fetchedAt > STALE_AFTER_MS
		) {
			requestRefetch(0);
		}
	});
	document.addEventListener("change", schedule, true);
	window.addEventListener("popstate", schedule);
	document.addEventListener("turbo:load", schedule);

	schedule();
})();
