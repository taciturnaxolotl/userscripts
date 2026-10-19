// ==UserScript==
// @name         Canvas Multi-File Upload
// @namespace    dunkirk.sh
// @version      1.7
// @description  Pick or drop several files at once on a Canvas assignment submission; each one lands in its own upload row, and empty rows never appear.
// @author       Kieran Klukas
// @license      MIT
// @homepageURL  https://tangled.org/dunkirk.sh/userscripts
// @supportURL   https://tangled.org/dunkirk.sh/userscripts/issues
// @updateURL    https://tangled.org/dunkirk.sh/userscripts/raw/main/canvas-multi-upload.user.js
// @downloadURL  https://tangled.org/dunkirk.sh/userscripts/raw/main/canvas-multi-upload.user.js
// @match        https://*.instructure.com/courses/*/assignments/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  const FILE_INPUT = 'input[type=file][name^="attachments"]';
  const ADD_LINK = '.add_another_file_link';
  const ROW = '.submission_attachment';
  const REMOVE_LINK = '.remove_attachment_link';
  const HIDDEN = 'cmu-hidden';
  let spreading = false;

  // Injected at document-start so a row is never painted before we can hide it.
  const style = document.createElement('style');
  style.textContent = `.${HIDDEN} { display: none !important; }`;
  (document.head || document.documentElement).append(style);

  const rows = () => [...document.querySelectorAll(FILE_INPUT)];
  const empties = () => rows().filter(r => !r.files.length);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const hide = input => input.closest(ROW)?.classList.add(HIDDEN);
  const show = input => input.closest(ROW)?.classList.remove(HIDDEN);

  const assign = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const drop = input => {
    filled.delete(input.name);
    input.closest(ROW)?.querySelector(REMOVE_LINK)?.click();
  };

  // Canvas only grows a row once the previous one holds a file, and the new
  // input lands in the DOM a render later. Reuse any empty row we already have
  // and re-click sparingly, or the lag buys us a row we never fill.
  async function addRow() {
    for (let click = 0; click < 4; click++) {
      const spare = empties()[0];
      if (spare) return spare;
      document.querySelector(ADD_LINK)?.click();
      for (let i = 0; i < 12 && !empties().length; i++) await wait(50);
    }
    return empties()[0];
  }

  async function spread(input, files) {
    spreading = true;
    try {
      assign(input, files[0]);
      for (const file of files.slice(1)) {
        const row = await addRow();
        if (!row) break;
        row.multiple = true;
        assign(row, file);
        show(row);
        await wait(50);
      }
    } finally {
      spreading = false;
      remember();
      // Any row still empty here is one our own clicking conjured up.
      empties().forEach(drop);
    }
  }

  document.addEventListener('change', e => {
    if (spreading || !e.target.matches?.(FILE_INPUT)) return;
    if (e.target.files.length > 1) spread(e.target, [...e.target.files]);
    else remember();
  }, true);

  // Clearing a file from its chip fires no event, so we track which rows have
  // held a file and drop the ones that just lost theirs. Rows that were never
  // filled stay put: those are the ones the user asked for with Add Another File.
  // Keyed by name, not node: React remounts the input when its row re-renders.
  const filled = new Set();
  const remember = () => rows().forEach(r => r.files.length && filled.add(r.name));

  function prune() {
    if (spreading) return;
    const emptied = rows().filter(r => filled.has(r.name) && !r.files.length);
    if (emptied.length === rows().length) emptied.pop();
    emptied.forEach(drop);
    // Whatever survived is meant to be seen, including the one empty row we keep.
    rows().forEach(r => { show(r); tidyRemoveLink(r); });
  }

  // Hide the row on the way down rather than after the fact: React swaps the
  // chip for a drop zone the instant it is clicked, and prune lands later.
  document.addEventListener('click', e => {
    // In a filled row the chip's dismiss button is the only button there is.
    const row = e.target.closest?.('button')?.closest(ROW);
    if (row?.querySelector(FILE_INPUT)?.files.length) row.classList.add(HIDDEN);
    setTimeout(prune, 150);
    setTimeout(prune, 600);
  }, true);

  // Removing a row makes Canvas re-show every row's own x, which is redundant
  // next to the chip's. Purely subtractive: a row with no file keeps whatever
  // Canvas decided, since its x is the only way to dismiss it.
  const tidyRemoveLink = r => {
    const link = r.closest(ROW)?.querySelector(REMOVE_LINK);
    if (r.files.length && link && link.style.display !== 'none') link.style.display = 'none';
  };

  const sync = () => rows().forEach(r => {
    r.multiple = true;
    tidyRemoveLink(r);
    if (spreading && !r.files.length) hide(r);
  });
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true });
  sync();
  remember();
  document.documentElement.dataset.canvasMultiUpload = '1.5';
})();
