// ==UserScript==
// @name         reMarkable Download & Print
// @namespace    dunkirk.sh
// @version      1.1
// @description  Adds Download PDF and Print to the reMarkable web app, stitching the app's own rendered pages into a lossless PDF.
// @match        https://app.remarkable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  const SCALE = 2; // 1 = 1404x1872 per page, 2 = 2808x3744. 3 works too, and is slow.
  const CONCURRENCY = 4;
  const PT = 595.28; // page width in points; height follows the render's aspect

  const gql = async (query, variables) => {
    const r = await fetch('/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const { data, errors } = await r.json();
    if (errors) throw new Error(errors[0]?.message ?? 'graphql error');
    return data;
  };

  // One round trip for every page URL: the schema only exposes page(index:), so
  // alias the whole document into a single query rather than paying N latencies.
  async function pageUrls(id) {
    const { document: meta } = await gql(
      'query($id:String!){document(id:$id){name pageCount}}', { id });
    const alias = Array.from({ length: meta.pageCount },
      (_, i) => `p${i}:page(index:${i}){image(scale:${SCALE})}`).join(' ');
    const { document: pages } = await gql(
      `query($id:String!){document(id:$id){${alias}}}`, { id });
    return {
      name: meta.name,
      urls: Array.from({ length: meta.pageCount }, (_, i) => pages[`p${i}`].image),
    };
  }

  // The renders arrive as PNG. Rather than re-encode (JPEG rings badly around
  // ink), hand PDF the raw samples and let Flate do what it does best on line
  // art. Grayscale when the page is grayscale, which is nearly always.
  async function samples(url) {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const { width: w, height: h } = bitmap;
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = cx.getImageData(0, 0, w, h).data;

    let gray = true;
    for (let i = 0; i < rgba.length && gray; i += 4)
      gray = rgba[i] === rgba[i + 1] && rgba[i + 1] === rgba[i + 2];

    const n = gray ? 1 : 3;
    const out = new Uint8Array(w * h * n);
    for (let p = 0, o = 0; p < rgba.length; p += 4) {
      out[o++] = rgba[p];
      if (!gray) { out[o++] = rgba[p + 1]; out[o++] = rgba[p + 2]; }
    }
    return { w, h, gray, data: await deflate(out) };
  }

  const deflate = async bytes => new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  ).arrayBuffer());

  // A PDF is three objects per page plus a catalog: the page, its one-line
  // content stream, and the image itself. Offsets are tracked as we write.
  function buildPdf(pages) {
    const enc = new TextEncoder();
    const parts = [];
    let len = 0;
    const put = d => {
      const b = typeof d === 'string' ? enc.encode(d) : d;
      parts.push(b);
      len += b.length;
    };
    const offsets = [];
    const obj = (n, ...body) => {
      offsets[n] = len;
      put(`${n} 0 obj\n`);
      body.forEach(put);
      put('\nendobj\n');
    };

    const count = pages.length;
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');

    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Count ${count} /Kids [${kids}] >>`);

    pages.forEach(({ w, h, gray, data }, i) => {
      const [page, content, image] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
      const pw = PT, ph = Math.round(PT * h / w * 100) / 100;
      obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
        `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
      const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
      obj(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      obj(image, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
        `/ColorSpace /Device${gray ? 'Gray' : 'RGB'} /BitsPerComponent 8 ` +
        `/Filter /FlateDecode /Length ${data.length} >>\nstream\n`, data, '\nendstream');
    });

    const size = 3 + count * 3;
    const xref = len;
    put(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    return new Blob(parts, { type: 'application/pdf' });
  }

  // Fixed pool of workers pulling from a shared cursor: pages render at wildly
  // different speeds and a batched map would idle on the slowest of each group.
  async function render(urls, onProgress) {
    const out = new Array(urls.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < urls.length) {
        const i = next++;
        out[i] = await samples(urls[i]);
        onProgress(++done);
      }
    }));
    return out;
  }

  async function toPdf(id, onProgress) {
    const { name, urls } = await pageUrls(id);
    onProgress(0, urls.length);
    return { name, blob: buildPdf(await render(urls, d => onProgress(d, urls.length))) };
  }

  const toast = (() => {
    let el;
    return text => {
      if (!el) {
        el = document.createElement('div');
        el.className = 'shadow-box interface-md font-medium';
        el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
          'z-index:9999;padding:10px 18px;border-radius:8px;background:#1c1c1c;color:#fff;' +
          'font:500 14px/1 system-ui,sans-serif;pointer-events:none;transition:opacity .2s';
        document.body.append(el);
      }
      el.textContent = text;
      el.style.opacity = text ? '1' : '0';
    };
  })();

  const safe = name => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'document';

  // A hidden iframe rather than a new tab: rendering outlives the click's user
  // activation, so a popup opened afterwards would be blocked, and the viewer's
  // own print handler is reachable from here anyway.
  const print = url => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    frame.src = url;
    frame.addEventListener('load', () => frame.contentWindow.print(), { once: true });
    document.body.append(frame);
    return () => frame.remove();
  };

  const save = (url, name) => {
    Object.assign(document.createElement('a'), { href: url, download: `${name}.pdf` }).click();
    return () => {};
  };

  let busy = false;

  async function run(id, action) {
    if (busy) return; // a second render would only fight the first for bandwidth
    busy = true;
    try {
      toast('Rendering…');
      const { name, blob } = await toPdf(id, (d, n) => toast(`Rendering page ${d} of ${n}…`));
      const url = URL.createObjectURL(blob);
      const cleanup = action === 'print' ? print(url) : save(url, safe(name));
      setTimeout(() => { cleanup(); URL.revokeObjectURL(url); }, 60_000);
      toast('');
    } catch (e) {
      toast(`Failed: ${e.message}`);
      setTimeout(() => toast(''), 4000);
    } finally {
      busy = false;
    }
  }

  const ICONS = {
    download: 'M22.5 3v27.88l-8.44-8.44-2.12 2.12L24 36.62l12.06-12.06-2.12-2.12-8.44 8.44V3h-3ZM6 39v-6H3v9h42v-9h-3v6H6Z',
    print: 'M12 3h24v9h6v21h-9v9H15v-9H6V12h6V3Zm3 9h18V6H15v6Zm18 24H15v6h18v-6Zm3-3h6V15H9v18h3v-6h24v6Z',
  };

  const icon = d => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('width', '1em');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };

  // Clone the app's own Rename entry rather than guess at its classes: the popover
  // is react-aria, so the wrapper carries state attributes we want stripped.
  function menuItem(template, label, kind, onClick) {
    const item = template.cloneNode(true);
    item.removeAttribute('id');
    item.removeAttribute('data-key');
    item.removeAttribute('data-focused');
    item.removeAttribute('data-focus-visible');
    item.dataset.rmdl = kind;
    const button = item.querySelector('button');
    button.removeAttribute('value');
    button.dataset.testid = `FileOptionsPopover_${label}`;
    button.querySelector('svg').replaceWith(icon(ICONS[kind]));
    button.querySelector('span').textContent = label;
    button.addEventListener('click', onClick);
    return item;
  }

  function fillPopover(popover) {
    if (popover.querySelector('[data-rmdl]')) return;
    const trigger = document.getElementById(popover.getAttribute('aria-labelledby'));
    const href = trigger?.closest('tr')?.querySelector('a[href^="/document/"]')?.getAttribute('href');
    if (!href) return; // folders have no pages to render
    const id = href.split('/').pop();
    const rename = popover.querySelector('[data-testid="FileOptionsPopover_Rename"]')?.closest('[role="menuitem"]');
    if (!rename) return;
    popover.prepend(
      menuItem(rename, 'Download', 'download', () => run(id, 'download')),
      menuItem(rename, 'Print', 'print', () => run(id, 'print')),
    );
  }

  const openDocument = () =>
    location.pathname.startsWith('/document/') && location.pathname.split('/').pop();

  // The document view has no action bar of its own, only the title pill, so the
  // buttons sit beside it in the same shadow-box vocabulary.
  function fillHeader() {
    const bar = document.querySelector('button[aria-label="Close document"]')
      ?.closest('div.flex.items-center');
    const id = openDocument();
    if (!bar || !id) return;
    if (bar.querySelector('[data-rmdl]')) return;
    const wrap = document.createElement('div');
    wrap.dataset.rmdl = 'header';
    wrap.className = 'shadow-box w-fit p-4 flex items-center';
    for (const [kind, label] of [['download', 'Download PDF'], ['print', 'Print']]) {
      const b = document.createElement('button');
      b.className = 'ark-button ark-button--tertiary-neutral ark-button-small rounded! hover:bg-app-panel-hover!';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.append(icon(ICONS[kind]));
      b.addEventListener('click', () => run(id, kind));
      wrap.append(b);
    }
    bar.append(wrap);
  }

  // With a document open, ⌘P should print the document. Everywhere else the
  // browser's own print is the right answer, so leave it alone.
  addEventListener('keydown', e => {
    if (e.key?.toLowerCase() !== 'p' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const id = openDocument();
    if (!id) return;
    e.preventDefault();
    run(id, 'print');
  }, true);

  const sync = () => {
    document.querySelectorAll('[data-testid="FileOptionsPopover_Content"]').forEach(fillPopover);
    fillHeader();
  };
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true });
  sync();
  document.documentElement.dataset.remarkableDownload = '1.1';
})();
