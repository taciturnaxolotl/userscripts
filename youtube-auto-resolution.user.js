// ==UserScript==
// @name         YouTube Auto Resolution
// @namespace    dunkirk.sh
// @version      2.0
// @description  Picks the highest available video quality (or a cap you set) on every YouTube video, including ones you navigate to without a reload. Adapted from zackton's version
// @author       Kieran Klukas, zackton
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/youtube-auto-resolution.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/youtube-auto-resolution.user.js
// @match        https://www.youtube.com/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
	// Highest quality to pick. "highres" means whatever is best; "hd1080" caps at 1080p, and so on.
	const MAX_QUALITY = "highres";

	const ORDER = [
		"highres",
		"hd2880",
		"hd2160",
		"hd1440",
		"hd1080",
		"hd720",
		"large",
		"medium",
		"small",
		"tiny",
	];
	const PLAYERS = "#movie_player, #shorts-player";

	const applied = new WeakMap();

	function pick(levels) {
		const cap = ORDER.indexOf(MAX_QUALITY);
		const ranked = levels
			.filter((q) => ORDER.includes(q))
			.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
		return (
			ranked.find((q) => ORDER.indexOf(q) >= cap) ?? ranked[ranked.length - 1]
		);
	}

	function apply(player) {
		if (typeof player.getAvailableQualityLevels !== "function") return;
		const videoId = player.getVideoData?.()?.video_id;
		if (!videoId || applied.get(player) === videoId) return;

		const target = pick(player.getAvailableQualityLevels());
		if (!target) return;

		player.setPlaybackQualityRange?.(target, target);
		player.setPlaybackQuality?.(target);
		if (player.getPlaybackQuality?.() === target) applied.set(player, videoId);
	}

	function hook(player) {
		if (player.dataset.autoResolution) return;
		if (
			typeof player.addEventListener !== "function" ||
			typeof player.getAvailableQualityLevels !== "function"
		)
			return;
		player.dataset.autoResolution = "1";
		player.addEventListener("onStateChange", () => apply(player));
		player.addEventListener("onPlaybackQualityChange", () => apply(player));
		apply(player);
	}

	function scan() {
		for (const player of document.querySelectorAll(PLAYERS)) {
			hook(player);
			apply(player);
		}
	}

	document.addEventListener("yt-navigate-finish", scan);
	document.addEventListener("yt-player-updated", scan);
	document.addEventListener("loadeddata", scan, true);
	new MutationObserver(() => {
		if (
			[...document.querySelectorAll(PLAYERS)].some(
				(p) => !p.dataset.autoResolution,
			)
		)
			scan();
	}).observe(document.documentElement, { childList: true, subtree: true });
})();
