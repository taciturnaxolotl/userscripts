// ==UserScript==
// @name         Amazon URL Cleaner
// @namespace    dunkirk.sh
// @version      0.4
// @description  Removes fluff from Amazon URLs to get clean product links
// @icon         https://www.amazon.com/favicon.ico
// @author       Kieran Klukas
// @license      MIT
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/clean-amazon-urls.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/clean-amazon-urls.user.js
// @match        https://www.amazon.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  function cleanURL() {
    const url = window.location.href;
    const match = url.match(/amazon\.com.*?\/([A-Z0-9]{10})/);
    if (match) {
      const asin = match[1];
      const clean = `https://www.amazon.com/dp/${asin}`;
      if (url !== clean) {
        window.history.replaceState(null, "", clean);
      }
    }
  }

  cleanURL();

  window.addEventListener("locationchange", cleanURL);
  window.addEventListener("popstate", cleanURL);
})();
