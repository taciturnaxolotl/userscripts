// ==UserScript==
// @name         Slack Allow HTTP OAuth URLs
// @namespace    dunkirk.sh
// @version      0.3
// @description  Allow http:// redirect URLs in Slack OAuth settings
// @author       Kieran Klukas
// @license      MIT
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/slack-http-oauth.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/slack-http-oauth.user.js
// @match        https://app.slack.com/app-settings/*/*/oauth*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  const httpInputs = new Set();

  function enableButton(btn) {
    btn.classList.remove("c-button--disabled");
    btn.removeAttribute("disabled");
    btn.setAttribute("aria-disabled", "false");
  }

  function disableButton(btn) {
    btn.classList.add("c-button--disabled");
    btn.setAttribute("aria-disabled", "true");
  }

  function getRow(input) {
    return input.closest(".tableEditorContainer__L7IH6");
  }

  function getAddButton(row) {
    return row?.querySelector('button[aria-label="Add Redirect URL"]');
  }

  function getValidationMsg(row) {
    return row?.querySelector(".validationMessaging__hBFXt");
  }

  function watchForHTTPEntries() {
    const urlInputs = document.querySelectorAll('input[aria-label="Redirect URL"]');

    for (const input of urlInputs) {
      if (input._httpListener) continue;
      input._httpListener = true;

      input.addEventListener("input", function () {
        const row = getRow(this);
        if (!row) return;

        const btn = getAddButton(row);
        const msg = getValidationMsg(row);

        if (this.value.trim().startsWith("http://")) {
          httpInputs.add(this);
          if (btn) {
            enableButton(btn);
            btn.textContent = "add 😈";
          }
          if (msg) msg.style.display = "none";
        } else {
          httpInputs.delete(this);
          if (msg) msg.style.removeProperty("display");
          if (btn && !this.value.trim()) {
            disableButton(btn);
            btn.textContent = "Add";
          }
        }
      });
    }
  }

  function fixHttpButtons() {
    for (const input of httpInputs) {
      if (!input.value.trim().startsWith("http://")) {
        httpInputs.delete(input);
        continue;
      }

      const row = getRow(input);
      if (!row) { httpInputs.delete(input); continue; }

      const btn = getAddButton(row);
      if (!btn) { httpInputs.delete(input); continue; }

      enableButton(btn);
      btn.textContent = "add 😈";

      const msg = getValidationMsg(row);
      if (msg) msg.style.display = "none";
    }
  }

  function watchButtonAttributes() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "attributes") continue;
        const btn = mutation.target;
        const row = btn.closest(".tableEditorContainer__L7IH6");
        if (!row) continue;

        const input = row.querySelector('input[aria-label="Redirect URL"]');
        if (!input?.value.trim().startsWith("http://")) continue;

        // Re-enable if something disabled it
        if (btn.classList.contains("c-button--disabled") || btn.getAttribute("aria-disabled") === "true") {
          enableButton(btn);
          btn.textContent = "add 😈";
        }
      }
    });

    for (const btn of document.querySelectorAll('button[aria-label="Add Redirect URL"]')) {
      if (!btn._observed) {
        observer.observe(btn, { attributes: true, attributeFilter: ["class", "aria-disabled", "disabled"] });
        btn._observed = true;
      }
    }

    return observer;
  }

  watchForHTTPEntries();
  fixHttpButtons();
  const btnObserver = watchButtonAttributes();
  setInterval(fixHttpButtons, 800);

  new MutationObserver((() => {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        watchForHTTPEntries();
        fixHttpButtons();

        for (const btn of document.querySelectorAll('button[aria-label="Add Redirect URL"]')) {
          if (!btn._observed) {
            btnObserver.observe(btn, { attributes: true, attributeFilter: ["class", "aria-disabled", "disabled"] });
            btn._observed = true;
          }
        }

        pending = false;
      }, 200);
    };
  })()).observe(document.body, { childList: true, subtree: true });
})();
