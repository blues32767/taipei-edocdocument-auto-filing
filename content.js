/* content.js v2026.10.28.1306：新增快捷按鈕拉出、縮放、收回與面板狀態記憶。公文頁面浮動面板。收合時為快捷按鈕列；展開後為完整面板；結果以新視窗呈現。 */
(() => {
  'use strict';
  // 公文簽核小框（app=genpages）不顯示助手面板，避免遮擋簽核畫面
  if (new URLSearchParams(location.search).get('app') === 'genpages') return;
  if (window.__edocHelperLoaded) return;
  window.__edocHelperLoaded = true;

  const VERSION = '2026.10.30.1400';
  const MAX_UI_LOGS = 300;
  const SRC_HOOK = 'edoc-helper';
  const SRC_CONTENT = 'edoc-helper-content';const SRC_PASTE = 'edoc-helper-paste';
  const HOST_ID = 'edoc-helper-root';
  const PDFJS_FILE = 'vendor/pdf.mjs';
  const PDFJS_WORKER_FILE = 'vendor/pdf.worker.mjs';
  const MIN_CHARS = 30;
  const QUICK_KEYS = ['copyId','readCopy','plain','writeExplain','draftWrite','summary'];
  const QUICK_DEFAULT = ['copyId','readCopy','plain','writeExplain','draftWrite','summary'];
  const TX = window.EdocText;
  const log = EdocLog.create('UI');

  const state = {
    hookReady: false, blobs: new Map(), text: '', pages: 0, source: '', docNo: '',
    busy: false, uiLogs: [], settings: null, mode: 'bar', logsOpen: false,
    quick: QUICK_DEFAULT.slice(), defaults: {}
  };
  let host = null;
  let root = null;
  const sheetCtx = { base: 'gongwen', editable: false, original: '', meta: '' };

  /* ---------- 小工具 ---------- */
  const countChars = (s) => (s || '').replace(/\s/g, '').length;
  const isPdfInfo = (info) => /pdf/i.test((info && info.type) || '');
  const isPdfBuffer = (buf) => String.fromCharCode(...new Uint8Array(buf.slice(0, 5))) === '%PDF-';
  const short = (s, n = 28) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
  const extractDocNo = (t) => { const m = (t || '').match(/字第\s*([0-9]{6,})\s*號/); return m ? m[1] : ''; };
  async function isPdfBlob(blob) {
    try { return (await blob.slice(0, 5).text()) === '%PDF-'; } catch (_) { return false; }
  }
  function contextValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  EdocLog.configure({
    context: 'CONTENT',
    level: 'DEBUG',
    sink(entry) {
      state.uiLogs.push(entry);
      if (state.uiLogs.length > MAX_UI_LOGS) state.uiLogs.splice(0, state.uiLogs.length - MAX_UI_LOGS);
      renderLogs();
      if (contextValid()) chrome.runtime.sendMessage({ type: 'LOG', entry }).catch(() => {});
    }
  });
  window.addEventListener('error', (e) => log.error('全域錯誤事件（可能來自頁面本身）', { message: e.message, file: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => log.error('未處理的 Promise 拒絕', e.reason));

  /* ---------- pdf.js ---------- */
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      const t0 = performance.now();
      pdfjsPromise = import(chrome.runtime.getURL(PDFJS_FILE))
        .then((lib) => {
          if (typeof lib.getDocument !== 'function' || !lib.GlobalWorkerOptions) {
            throw new Error(`${PDFJS_FILE} 匯出內容不符，請確認是 pdf.js 官方 build/pdf.mjs`);
          }
          lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(PDFJS_WORKER_FILE);
          log.info('pdf.js 載入完成', { version: lib.version, ms: Math.round(performance.now() - t0) });
          return lib;
        })
        .catch((err) => {
          pdfjsPromise = null;
          log.error('pdf.js 載入失敗', { message: err.message });
          throw new Error(`無法載入 pdf.js：${err.message}`);
        });
    }
    return pdfjsPromise;
  }

  async function releasePdf(doc, task) {
    try { if (doc && typeof doc.destroy === 'function') await doc.destroy(); else if (task && task.destroy) await task.destroy(); }
    catch (e) { log.warn('釋放 pdf 資源失敗（已忽略）', { message: e.message }); }
  }

  // 依 pdf.js 的文字項目組出文字；每個 hasEOL 會換行，斷行由 textclean 統一修正
  async function extractPdfText(buf) {
    const done = log.time('PDF 文字擷取');
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
    let doc = null;
    try {
      doc = await task.promise;
      const parts = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        parts.push(tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
        if (typeof page.cleanup === 'function') { try { page.cleanup(); } catch (_) { /* 忽略 */ } }
      }
      done({ pages: doc.numPages });
      return { text: parts.join('\n'), pages: doc.numPages };
    } finally {
      await releasePdf(doc, task);
    }
  }

  /* ---------- Hook 與來源探測 ---------- */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin || !d || d.source !== SRC_HOOK) return;
    switch (d.type) {
      case 'HOOK_READY': state.hookReady = true; log.info('Hook 已就緒', { frame: d.frame }); break;
      case 'BLOB_CREATED': storeBlob(d.info, d.blob, d.frame); break;
      case 'BLOB_REVOKED': { const rec = state.blobs.get(d.url); if (rec) rec.revoked = true; break; }
      default: break;
    }
  });

  function storeBlob(info, blob, frame) {
    if (!info || !blob || state.blobs.has(info.url)) return;
    state.blobs.set(info.url, { blob, info, revoked: false });
    log.debug('收到 Blob', { type: info.type, size: info.size, frame, url: short(info.url, 24) });
    if (state.blobs.size > 30) state.blobs.delete(state.blobs.keys().next().value);
  }

  function readFrameText(frame) {
    try {
      const d = frame.contentDocument;
      return d && d.body ? (d.body.innerText || '').trim() : '';
    } catch (_) { return ''; }
  }

  function readPaperText() {
    const el = document.querySelector('#cpaper');
    return el ? (el.innerText || '').trim() : '';
  }

  async function locateSource() {
    const frames = [...document.querySelectorAll('iframe')];
    const blobFrame = frames.find((f) => (f.getAttribute('src') || '').startsWith('blob:'));
    const frameSrc = blobFrame ? blobFrame.getAttribute('src') : '';

    if (frameSrc && state.blobs.has(frameSrc)) {
      const rec = state.blobs.get(frameSrc);
      if (isPdfInfo(rec.info) || await isPdfBlob(rec.blob)) return { kind: 'pdf', source: 'hook-exact', blob: rec.blob };
    }
    const frameText = blobFrame ? readFrameText(blobFrame) : '';
    if (countChars(frameText) >= MIN_CHARS) return { kind: 'text', source: 'iframe-dom', text: frameText };

    if (frameSrc) {
      try {
        const res = await fetch(frameSrc);
        if (res.ok) {
          const b = await res.blob();
          if (await isPdfBlob(b)) return { kind: 'pdf', source: 'iframe-fetch', blob: b };
        }
      } catch (err) { log.warn('fetch iframe blob 失敗', { message: err.message }); }
    }
    const paperText = readPaperText();
    if (countChars(paperText) >= MIN_CHARS) return { kind: 'text', source: 'paper-dom', text: paperText };

    const candidates = [];
    for (const r of state.blobs.values()) if (isPdfInfo(r.info) || await isPdfBlob(r.blob)) candidates.push(r);
    candidates.sort((a, b) => b.info.at - a.info.at);
    if (candidates.length) return { kind: 'pdf', source: 'hook-latest', blob: candidates[0].blob };
    return null;
  }

  // 讀取目前公文：取得原文 → 去除裝訂線雜訊 → 修正斷行
  async function readDocument() {
    const src = await locateSource();
    if (!src) throw new Error('找不到公文內容。請確認正文已顯示在中間區域，並重新整理頁面後再試。');

    let raw = '';
    let pages = 0;
    if (src.kind === 'pdf') {
      const buf = await src.blob.arrayBuffer();
      if (!isPdfBuffer(buf)) throw new Error('取得的內容不是 PDF（檔頭不是 %PDF-）。');
      ({ text: raw, pages } = await extractPdfText(buf));
    } else {
      raw = src.text;
    }

    const text = TX.cleanOfficialText(raw);
    const chars = countChars(text);
    if (chars < MIN_CHARS) throw new Error(`僅擷取到 ${chars} 字，疑似掃描影像；本版不支援 OCR。`);

    const docNo = extractDocNo(text);
    log.info('公文讀取完成', { kind: src.kind, pages, chars, removedChars: countChars(raw) - chars, source: src.source, docNo });
    return {
      text, pages, docNo, chars, source: src.source, kind: src.kind,
      cautious: src.source === 'hook-latest' || src.source === 'paper-dom'
    };
  }

  /* ---------- 面板樣式與結構 ---------- */
  const PANEL_CSS = `
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
:host {
  all: initial;
  --bg: #f1f4f8; --surface: #ffffff; --ink: #1c2938; --muted: #5b6878; --line: #d3dbe5;
  --head1: #243444; --head2: #32475b; --accent: #23a19e; --accent-deep: #178480; --accent-soft: #e2f4f3;
  --ok: #13703f; --warn: #8a5300; --err: #b42318; --warn-bg: #fff4d6; --err-bg: #fdecea;
  --ai-bg: linear-gradient(135deg, #f4efff 0%, #e8efff 100%); --ai-line: #cdbff2; --ai-ink: #5b3fa6;
  --ai-solid: #6b4fc2; --ai-on: #ffffff;
  --shadow: 0 1px 2px rgba(20,30,45,.06), 0 20px 44px rgba(20,30,45,.20);
  --ring: rgba(35,161,158,.45);
}
:host([data-theme="dark"]) {
  --bg: #0b1014; --surface: #12181f; --ink: #e8eef5; --muted: #98a6b5; --line: #263241;
  --head1: #070a0d; --head2: #18222d; --accent: #3fc6c1; --accent-deep: #2aa9a4; --accent-soft: #112a2a;
  --ok: #6ee7a7; --warn: #facc6b; --err: #ff9b92; --warn-bg: #241d0c; --err-bg: #2a1412;
  --ai-bg: linear-gradient(135deg, #241a3d 0%, #142143 100%); --ai-line: #3f3170; --ai-ink: #d8ccff;
  --ai-solid: #9d86ec; --ai-on: #120c26;
  --shadow: 0 20px 50px rgba(0,0,0,.6); --ring: rgba(63,198,193,.4);
}
.wrap {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font: 14px/1.6 "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif; color: var(--ink);
}
.wrap.dragging, .wrap.dragging * { user-select: none !important; cursor: grabbing !important; }
.wrap:not([data-mode="min"]) .mini { display: none; }
.wrap:not([data-mode="bar"]) .bar { display: none; }
.wrap:not([data-mode="panel"]) .panel { display: none; }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
button:disabled { opacity: .45; cursor: not-allowed; }

/* 最小化：「助」圖示 */
.mini {
  width: 50px; height: 50px; border-radius: 50%; padding: 0; border: 1px solid rgba(255,255,255,.25);
  background: linear-gradient(135deg, var(--head2), var(--head1)); color: #fff;
  font-size: 20px; font-weight: 900; display: grid; place-items: center;
  box-shadow: var(--shadow); cursor: grab; touch-action: none;
  transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .3s ease;
  animation: rise .35s cubic-bezier(.2,.8,.2,1) both;
}
.mini:hover { transform: scale(1.07); }
.mini:active { transform: scale(.96); }
.mini.busy { box-shadow: 0 0 0 5px var(--warn-bg), var(--shadow); }


/* 邊框調整：右下角把手；整體大小由 --u 比例控制，元件自適應排列 */
.wrap { --u:1; }
.bar { width:min(calc(400px * var(--u)),calc(100vw - 40px)); }
.bar .chip { font-size:calc(13px * var(--u)); padding:calc(7px * var(--u)) calc(12px * var(--u)); }
.bar .brand-min { font-size:calc(12.5px * var(--u)); }
.bar .group-label { font-size:calc(11.5px * var(--u)); }
.panel { width: calc(384px * var(--u)); max-height: calc(100vh - 40px); display: flex; flex-direction: column; }
.panel .tile b { font-size:calc(13.5px * var(--u)); }
.panel .tile span { font-size:calc(12px * var(--u)); }
.panel .ph h1 { font-size:calc(15px * var(--u)); }
.grip-resize { position:absolute; right:3px; bottom:3px; width:14px; height:14px; cursor:nwse-resize; touch-action:none; opacity:.5; border-right:2px solid var(--muted); border-bottom:2px solid var(--muted); border-radius:0 0 3px 0; }
.grip-resize:hover { opacity:1; }
.bar.resizable, .panel.resizable { position:relative; }
.bar.resizing, .panel.resizing, .bar.resizing *, .panel.resizing * { cursor:nwse-resize!important; user-select:none!important; }

/* 收合：快捷列（分成「不用 AI」與「AI」兩組） */
.bar {
  width: min(400px, calc(100vw - 40px)); display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: color-mix(in srgb, var(--surface) 97%, transparent); border: 1px solid var(--line); border-radius: 18px;
  box-shadow: var(--shadow); backdrop-filter: blur(10px); cursor: grab; touch-action: none;
  animation: rise .35s cubic-bezier(.2,.8,.2,1) both;
}
.bar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 0 6px; }
.brand-min { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 800; color: var(--muted); white-space: nowrap; letter-spacing: .02em; }
.head-btns { display: flex; gap: 4px; }
.ghost {
  width: 28px; height: 28px; border-radius: 50%; padding: 0; border: 1px solid var(--line); background: var(--bg);
  color: var(--muted); font-size: 13px; line-height: 1; display: grid; place-items: center;
  transition: border-color .2s ease, background-color .2s ease, color .2s ease;
}
.ghost:hover { border-color: var(--accent); color: var(--accent-deep); background: var(--accent-soft); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex: 0 0 auto; transition: background .3s, box-shadow .3s; }
.dot.ok { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.dot.busy { background: var(--warn); }

.group { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px; border-radius: 14px; }
.group-plain { background: var(--bg); border: 1px solid var(--line); }
.group-ai { background: var(--ai-bg); border: 1px solid var(--ai-line); }
.group-label { font-size: 11.5px; font-weight: 800; color: var(--muted); letter-spacing: .02em; }
.group-ai .group-label { color: var(--ai-ink); }
.group-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface);
  font-weight: 700; font-size: 13px; white-space: nowrap;
  transition: transform .15s ease, background-color .2s ease, border-color .2s ease, color .2s ease;
}
.chip:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-deep); transform: translateY(-1px); }
.chip:active:not(:disabled) { transform: scale(.96); }
.group-ai .chip { background: color-mix(in srgb, var(--surface) 75%, transparent); border-color: var(--ai-line); color: var(--ai-ink); }
.group-ai .chip::before { content: "✦ "; font-size: 11px; }
.group-ai .chip:hover:not(:disabled) { background: var(--ai-solid); border-color: var(--ai-solid); color: var(--ai-on); }

/* 快捷列上方的提示（絕對定位，不影響版面） */
.bar { position: relative; }
.bar-tip {
  position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 1;
  padding: 4px 11px; border-radius: 999px; background: var(--head1); color: #fff; font-size: 11.5px; font-weight: 700;
  white-space: nowrap; display: flex; align-items: center; gap: 6px; pointer-events: none; box-shadow: var(--shadow); opacity: .92;
}
.tip-x {
  pointer-events: auto; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.18);
  color: #fff; font-size: 10px; line-height: 1; display: grid; place-items: center; cursor: pointer;
}
.tip-x:hover { background: rgba(255,255,255,.35); }
.tip-x:focus-visible { box-shadow: 0 0 0 2px #fff; outline: none; }
.bar-tip::after {
  content: ""; position: absolute; left: 50%; top: 100%; transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: var(--head1);
}

/* AI 引導提示（一次性） */
.ai-notice { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 12px; background: var(--warn-bg); color: var(--warn); font-size: 12px; line-height: 1.5; border: 1px solid var(--line); }
.ai-notice span { flex: 1 1 auto; }
.ai-notice .tip-x { flex: none; width: auto; height: auto; padding: 3px 9px; border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 11.5px; font-weight: 700; white-space: nowrap; }

/* 展開：完整面板 */
.panel {
  width: 384px; max-height: calc(100vh - 40px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow); overflow: hidden;
  animation: rise .4s cubic-bezier(.2,.8,.2,1) both;
}
.ph {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px;
  background: linear-gradient(135deg, var(--head1), var(--head2)); color: #fff; cursor: grab; touch-action: none;
}
.brand { display: flex; align-items: center; gap: 11px; }
.mark { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-weight: 800; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.28); }
.ph h1 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: .02em; }
.ph small { font-size: 11.5px; opacity: .78; }
.ph-actions { display: flex; gap: 6px; }
.icon { width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(255,255,255,.28); background: rgba(255,255,255,.08); color: #fff; display: grid; place-items: center; font-size: 14px; padding: 0; transition: background-color .2s ease; }
.icon:hover { background: rgba(255,255,255,.2); }
.pbody { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; min-height: 0; padding-bottom: 4px; }
.status {
  margin: 12px 14px 0; padding: 10px 12px; border-radius: 12px; background: var(--bg); color: var(--muted);
  font-size: 13px; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--line); min-height: 40px;
}
.status[data-kind="ok"] { color: var(--ok); border-left-color: var(--accent); }
.status[data-kind="err"] { color: var(--err); border-left-color: var(--err); background: var(--err-bg); }
.status[data-kind="busy"] { color: var(--warn); border-left-color: var(--warn); background: var(--warn-bg); }

.psec { padding: 0 14px; }
.psec-title { font-size: 12px; font-weight: 800; color: var(--muted); margin: 12px 0 6px; letter-spacing: .02em; }
.psec-title.ai { color: var(--ai-ink); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tile {
  text-align: left; display: grid; gap: 3px; padding: 11px 12px; border-radius: 14px; border: 1px solid var(--line);
  background: var(--surface); transition: transform .2s cubic-bezier(.2,.8,.2,1), border-color .2s ease, box-shadow .2s ease, background-color .2s ease;
}
.tile:last-child:nth-child(odd) { grid-column: span 2; }
.tile b { font-size: 14px; font-weight: 800; }
.tile span { font-size: 12px; color: var(--muted); line-height: 1.45; }
.tile:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 10px 22px rgba(20,30,45,.10); }
.tile:active:not(:disabled) { transform: translateY(0) scale(.98); }
.tile.ai { background: var(--ai-bg); border-color: var(--ai-line); }
.tile.ai b { color: var(--ai-ink); }
.tile.ai:hover:not(:disabled) { border-color: var(--ai-solid); }

.settings-btn {
  margin: 10px 14px; padding: 10px 12px; border-radius: 12px; border: 1px dashed var(--line); background: transparent;
  font-weight: 700; color: var(--accent-deep); width: calc(100% - 28px); transition: background-color .2s ease, border-color .2s ease;
}
.settings-btn:hover { background: var(--accent-soft); border-color: var(--accent); }

.sec { margin: 0 14px 10px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
.sec > summary { list-style: none; cursor: pointer; padding: 11px 14px; font-weight: 800; background: var(--bg); display: flex; justify-content: space-between; align-items: center; }
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary::after { content: "+"; color: var(--accent-deep); font-size: 17px; line-height: 1; transition: transform .25s ease; }
.sec[open] > summary::after { transform: rotate(45deg); }
.sec-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow: auto; }
.sec-body label { font-size: 12.5px; font-weight: 700; color: var(--muted); display: block; margin-bottom: 4px; }
.checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.checks label.chk { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; margin: 0; color: var(--ink); font-size: 13px; cursor: pointer; }
.checks input { accent-color: var(--accent); width: 16px; height: 16px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
input[type="number"], textarea {
  width: 100%; font: 13px/1.6 "Microsoft JhengHei", system-ui, sans-serif; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; transition: border-color .2s ease;
}
input[type="number"]:focus, textarea:focus { border-color: var(--accent); }
textarea { min-height: 84px; resize: vertical; }
.chkline { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--ink); }
.chkline input { accent-color: var(--accent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.row > button { flex: 1 1 auto; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-size: 12.5px; font-weight: 700; transition: border-color .2s ease, background-color .2s ease; }
.row > button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
.row > button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.row > button.primary:hover:not(:disabled) { background: var(--accent-deep); }
.logs { margin: 0; max-height: 200px; overflow: auto; font: 11px/1.5 ui-monospace, Consolas, monospace; color: var(--muted); background: var(--bg); border-radius: 10px; padding: 8px; white-space: pre-wrap; word-break: break-all; }
.fine { margin: 2px 14px 14px; font-size: 11.5px; color: var(--muted); }

/* 快捷列精簡版面：緊湊留白、按鈕集中、比例縮放（--u） */
.bar { width: min(calc(372px * var(--u)), calc(100vw - 40px)); padding: calc(8px * var(--u)); gap: calc(6px * var(--u)); border-radius: 16px; }
.bar-head { padding: 0 calc(2px * var(--u)) 0 calc(4px * var(--u)); }
.bar .ghost { width: calc(24px * var(--u)); height: calc(24px * var(--u)); font-size: calc(11px * var(--u)); }
.bar .group { padding: calc(6px * var(--u)) calc(8px * var(--u)); gap: calc(5px * var(--u)); border-radius: 12px; }
.bar .group-label { font-size: calc(10.5px * var(--u)); letter-spacing: .03em; }
.bar .group-btns { gap: calc(5px * var(--u)); }
.bar .chip { padding: calc(5px * var(--u)) calc(10px * var(--u)); font-size: calc(12.5px * var(--u)); line-height: 1.3; }
.bar .gear { width: calc(24px * var(--u)); height: calc(24px * var(--u)); }
.bar .ai-notice { padding: calc(6px * var(--u)) calc(8px * var(--u)); font-size: calc(11.5px * var(--u)); }
.bar .fine, .bar .bar-tip { display: none; }
.bar.resizing .group { border-color: var(--accent); }
/* 通知與文字視窗 */
.toast {
  position: fixed; left: 50%; bottom: 26px; z-index: 2147483002; transform: translate(-50%, 160%); opacity: 0;
  padding: 10px 18px; border-radius: 999px; background: var(--head1); color: #fff; font-weight: 700; font-size: 13px;
  box-shadow: var(--shadow); transition: transform .45s cubic-bezier(.2,.8,.2,1), opacity .3s ease; max-width: 90vw; text-align: center;
}
.toast.show { transform: translate(-50%, 0); opacity: 1; }
.toast[data-kind="ok"] { background: var(--accent-deep); }
.toast[data-kind="err"] { background: var(--err); }
.sheet-mask {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center; padding: 18px;
  background: rgba(8,14,22,.5); backdrop-filter: blur(4px); animation: fade .2s ease both;
}
.sheet {
  width: min(900px, 94vw); height: min(78vh, 760px); min-width: 360px; min-height: 300px;
  max-width: 98vw; max-height: 96vh; display: flex; flex-direction: column; background: var(--surface);
  border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow); overflow: hidden;
  resize: both; animation: rise .35s cubic-bezier(.2,.8,.2,1) both;
}
.sheet.maxed { width: 98vw; height: 94vh; }
  width: min(680px, 100%); max-width: 100%; max-height: 88vh; min-height: 0; display: flex; flex-direction: column; background: var(--surface);
  border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow); overflow: hidden; animation: rise .35s cubic-bezier(.2,.8,.2,1) both;
}
.sheet header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: linear-gradient(135deg, var(--head1), var(--head2)); color: #fff; }
.sheet h2 { margin: 0; font-size: 15px; font-weight: 800; }
.sheet .meta { margin: 0; padding: 10px 18px 0; font-size: 12.5px; color: var(--muted); }
.sheet textarea { display: block; flex: 1 1 0; width: auto; min-width: 0; min-height: 0; height: auto; margin: 10px 18px; font-size: 14px; line-height: 1.8; background: var(--bg); overflow-y: auto; overflow-wrap: anywhere; overscroll-behavior: contain; resize: none; }
.sheet footer { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; padding: 0 22px 14px 18px; }
.sheet footer button { padding: 9px 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-weight: 700; font-size: 13px; transition: border-color .2s ease; }
.sheet footer button:hover { border-color: var(--accent); }
.sheet footer button.left { margin-right: auto; color: var(--muted); }
.sheet footer button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sheet footer button.primary:hover { background: var(--accent-deep); }

/* 浮動快捷按鈕（可拉出、移動、縮放、收回） */
.float-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font: 14px/1.6 "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif; color: var(--ink); }
.fchip {
  --s: 1; position: fixed; left: 20px; top: 20px; pointer-events: auto; display: inline-flex; align-items: center;
  gap: calc(4px * var(--s)); padding: calc(4px * var(--s)); background: var(--surface); border: 1px solid var(--line);
  border-radius: 999px; box-shadow: var(--shadow); cursor: grab; touch-action: none; white-space: nowrap;
}
.fchip.dragging, .fchip.dragging * { cursor: grabbing !important; user-select: none !important; }
.fchip .chip { font-size: calc(13px * var(--s)); padding: calc(7px * var(--s)) calc(12px * var(--s)); line-height: 1.4; }
.fgrip { font-size: calc(14px * var(--s)); color: var(--muted); padding: 0 calc(2px * var(--s)); line-height: 1; user-select: none; }
.fback {
  width: calc(24px * var(--s)); height: calc(24px * var(--s)); min-width: 16px; min-height: 16px; border-radius: 50%; padding: 0;
  border: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: calc(12px * var(--s)); line-height: 1; display: grid; place-items: center;
}
.fback:hover { border-color: var(--accent); color: var(--accent-deep); }
.fresize {
  position: absolute; right: 2px; bottom: 2px; width: calc(10px * var(--s)); height: calc(10px * var(--s));
  border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); border-radius: 0 0 3px 0; cursor: nwse-resize; opacity: .6;
}
.fresize:hover { opacity: 1; }
@keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

  const PANEL_HTML = `
<div class="wrap" id="wrap" data-mode="bar">
  <button class="mini" id="btnMini" type="button" title="展開公文助手（可拖曳移動）" aria-label="公文助手，點擊展開">助</button>

  <section class="bar resizable" id="bar" aria-label="快捷工具列（可拖曳移動）"><span class="grip-resize" id="gripBar" title="拖曳調整大小" aria-hidden="true"></span>
    <div class="bar-tip" id="barTip"><span>💡可拖曳拉出快捷按鈕至任意處</span><button class="tip-x" id="btnTipX" type="button" aria-label="關閉提示，不再顯示" title="關閉，不再顯示">✕</button></div>
    <div class="bar-head">
      <div class="brand-min"><span class="dot" id="dot"></span>公文助手</div>
      <div class="head-btns">
        <button class="ghost" id="btnResetBar" type="button" aria-label="還原預設版面" title="還原預設版面">↺</button>
 <button class="ghost" id="btnOpen" type="button" aria-expanded="false" aria-label="展開完整面板" title="展開完整面板">▴</button>
 <button class="ghost" id="btnMinBar" type="button" aria-label="最小化為「助」圖示" title="最小化">—</button>
        
        
      </div>
    </div>
    <div class="ai-notice" id="aiNotice" hidden><span>已隱藏 AI 功能。若需開啟，請點「▴」展開完整面板，至下方設定勾選「顯示 AI 功能」。</span><button class="tip-x" id="btnAiNoticeX" type="button">知道了</button></div>
    <div class="group group-plain" id="grpPlain">
      <span class="group-label">一般工具（不使用 AI）</span>
      <div class="group-btns">
        <button class="chip" type="button" data-q="copyId" title="組合「發文日期-發文字號-主旨」為檔名並複製">複製日期-文號-主旨</button><button class="gear" type="button" data-gear="copyId" title="設定「複製日期-文號-主旨」的順序與文字">⚙</button>
        <button class="chip" type="button" data-q="readCopy" title="將公文文字複製到剪貼簿">複製全文到剪貼簿</button>
        <button class="chip" type="button" data-q="plain" title="擷取公文內容，於文字視窗檢視、編輯、下載或複製">開啟純文字</button>
<button class="chip" type="button" data-q="writeExplain" title="開啟文字視窗，貼上 Word 段落後自動分段寫入「說明」欄位">寫入說明內容</button>
      </div>
    </div>
    <div class="group group-ai" id="grpAi">
      <span class="group-label" id="aiGroupLabel">AI 功能（需設定模型）</span>
      <div class="group-btns">
        <button class="chip" type="button" data-q="draftWrite" title="依提示詞產生擬辦，並填入「我的意見」">AI 擬稿</button>
        <button class="chip" type="button" data-q="summary" title="依提示詞整理公文重點，於文字視窗顯示">AI重點摘要</button>
      </div>
    </div>
  </section>

  <section class="panel resizable" id="panel" aria-label="公文助手面板"><span class="grip-resize" id="gripPanel" title="拖曳調整大小" aria-hidden="true"></span>
    <header class="ph" id="ph">
      <div class="brand"><span class="mark" aria-hidden="true">文</span><div><h1>公文助手</h1><small>版本 ${VERSION}</small></div></div>
      <div class="ph-actions">
        <button class="icon" id="btnTheme" type="button" aria-pressed="false" aria-label="切換黑／白配色" title="切換黑／白配色">◐</button>
        <button class="icon" id="btnResetPanel" type="button" aria-label="還原預設版面" title="還原預設版面">↺</button>
        <button class="icon" id="btnClose" type="button" aria-label="收合為快捷列" title="收合為快捷列">▾</button>
        <button class="icon" id="btnMin" type="button" aria-label="最小化為「助」圖示" title="最小化">—</button>
      </div>
    </header>
    <div class="pbody">
      <div class="status" id="status" role="status" aria-live="polite" data-kind="">尚未處理公文</div>

      <div class="psec">
        <div class="psec-title">一般工具（不使用 AI）</div>
        <div class="grid">
          <button class="tile" type="button" data-q="copyId"><b>複製日期-文號-主旨</b><span>組合檔名並複製，例：1151019-北市…</span></button>
          <button class="tile" type="button" data-q="readCopy"><b>複製全文到剪貼簿</b><span>將公文文字複製到剪貼簿</span></button>
          <button class="tile" type="button" data-q="plain"><b>開啟純文字</b><span>另開視窗，可刪段、編輯、下載或複製</span></button>
<button class="tile" type="button" data-q="writeExplain"><b>寫入說明內容</b><span>貼上 Word 段落，自動分段寫入「說明」欄位；亦可於說明欄位右鍵選「貼上段落」</span></button>
        </div>
        <div class="psec-title ai" id="aiTitle">AI 功能（需設定模型）</div>
        <div class="grid">
          <button class="tile ai" type="button" data-q="draftWrite"><b>AI 擬稿</b><span>產生擬辦，並填入「我的意見」</span></button>
          <button class="tile ai" type="button" data-q="summary"><b>AI重點摘要</b><span>依提示詞整理重點，可下載或複製</span></button>
        </div>
      </div>

      <button class="settings-btn" id="btnSettings" type="button">⚙ 設定（開啟完整設定頁）</button>

      <details class="sec" id="secQuick">
 <summary>快捷按鈕設定</summary>
 <div class="sec-body">
 <div>
 <label>收合時顯示的快捷按鈕</label>
 <div class="checks" id="quickChecks">
 <label class="chk"><input type="checkbox" value="copyId"> 複製日期-文號-主旨</label>
 <label class="chk"><input type="checkbox" value="readCopy"> 複製全文到剪貼簿</label>
 <label class="chk"><input type="checkbox" value="plain"> 開啟純文字</label>
 <label class="chk"><input type="checkbox" value="writeExplain"> 寫入說明內容</label>
 <label class="chk"><input type="checkbox" value="draftWrite"> AI 擬稿</label>
 <label class="chk"><input type="checkbox" value="summary"> AI重點摘要</label>
 </div>
 <div class="row" style="margin-top:8px"><button type="button" id="btnQuickSave">儲存快捷按鈕</button></div>
 <p class="fine" style="margin:4px 0 0;padding:0">提示：在收合列按住按鈕往外拖曳，即可拉出成獨立按鈕；拖曳右下角可調整大小，按 ↺ 收回。</p>
 </div>
 </div>
 </details>

 <details class="sec" id="secAi">
 <summary>AI 工具設定</summary>
 <div class="sec-body">
 <label class="chkline" id="pShowAiWrap"><input id="pShowAi" type="checkbox"> 顯示 AI 功能（AI 擬稿、AI 重點摘要）</label>
 <div class="ai-setup" id="aiSetupGuide" hidden>
 <p>尚未設定 AI 連線，AI 功能目前已隱藏。</p>
 <button type="button" class="primary" id="btnGoAiSetup">前往設定 AI 連線</button>
 </div>
 <div class="pair">
 <div><label for="pDraft">擬辦字數上限</label><input id="pDraft" type="number" min="30" max="500" step="10"></div>
 <div><label for="pTimeout">逾時（秒）</label><input id="pTimeout" type="number" min="5" max="300"></div>
 </div>
 <div><label for="pMax">公文文字上限（字）</label><input id="pMax" type="number" min="1000" max="60000" step="500"></div>
 <label class="chkline"><input id="pRedact" type="checkbox"> 送出前遮蔽身分證、手機、Email</label>
 <div><label for="pPrompt">AI擬辦提示詞（{{MAX_CHARS}} 會換成字數上限）</label><textarea id="pPrompt" spellcheck="false"></textarea></div>
 <div><label for="pSum">AI重點摘要提示詞</label><textarea id="pSum" spellcheck="false"></textarea></div>
 <div class="row">
 <button type="button" id="btnPromptReset">還原擬辦提示詞</button>
 <button type="button" id="btnSumReset">還原重點提示詞</button>
 </div>
 <div class="row">
 <button type="button" id="btnLayoutReset">還原預設版面</button>
 <button class="primary" type="button" id="btnParamSave">儲存設定</button>
 <button type="button" id="btnDiag">診斷</button>
 </div>
 </div>
 </details>

 <details class="sec" id="secLog">
        <summary>執行紀錄</summary>
        <div class="sec-body">
          <pre class="logs" id="logs" aria-label="執行紀錄內容"></pre>
          <div class="row"><button type="button" id="btnLogClear">清除紀錄</button></div>
        </div>
      </details>
      <p class="fine">AI 結果僅供參考；本工具不會自動送出，也不會按下「執行」。</p>
      <p class="fine">開發者：blues32767（<a href="https://github.com/blues32767" target="_blank" rel="noopener">github.com/blues32767</a>）</p>
    </div>
  </section>
</div>

<div class="float-layer" id="floatLayer"></div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<div class="sheet-mask" id="explainMask" hidden>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="explainTitle" style="max-height:80vh">
<header>
<h2 id="explainTitle">寫入說明內容</h2>
<button class="icon" id="explainClose" type="button" aria-label="關閉視窗" title="關閉">✕</button>
</header>
<p class="meta">請先在公文編輯器的「說明」欄位點一下游標位置，再從 Word 複製內容貼到下方（Ctrl+V）。每一行會自動成為一段，寫入於游標處。也可不開此視窗：在「說明：」後方點一下游標，於紙面右鍵選「貼上段落」直接寫入。</p>
<textarea id="explainText" spellcheck="false" aria-label="要寫入說明的內容" placeholder="在此貼上 Word 內容（Ctrl+V）……"></textarea>
<footer>
<button class="left" type="button" id="explainClear">清空</button>
<button type="button" id="explainCancel">取消</button>
<button class="primary" type="button" id="explainWrite">寫入說明</button>
</footer>
</div>
</div>
<div class="sheet-mask" id="sheet" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <header>
      <h2 id="sheetTitle">結果</h2>
      <button class="icon" id="sheetMax" type="button" aria-label="放大或還原視窗" title="放大／還原">⤢</button>
      <button class="icon" id="sheetClose" type="button" aria-label="關閉視窗">✕</button>
    </header>
    <p class="meta" id="sheetMeta"></p>
    <textarea id="sheetText" spellcheck="false" aria-label="結果內容" readonly></textarea>
    <footer>
      <button class="left" type="button" id="sheetRestore" hidden>還原原文</button>
      <button type="button" id="sheetDownload">下載 .txt</button>
      <button class="primary" type="button" id="sheetCopy">複製全文</button>
    </footer>
  </div>
</div>`;

  const $ = (id) => root.getElementById(id);
  const MARGIN = 8;
  const DRAG_THRESHOLD = 5;
  const POS_KEY = 'uiPos';
  const MODE_KEY = 'uiMode';
  const FLOAT_KEY = 'uiFloat';
  const TIP_KEY = 'uiTipHidden';
  const SHOW_AI_KEY = 'uiShowAi';
  const AI_NOTICE_KEY = 'uiAiNoticeSeen';
  const AI_KEYS = ['draftWrite', 'summary'];
  let showAi = false;
let aiConfigured = false;
  let aiNoticeSeen = false;
  let storeLoaded = false;
  const MODES = ['min', 'bar', 'panel'];
  const FLOAT_MIN = 0.6;
  const FLOAT_MAX = 3;
  const CHIP_LABEL = { writeExplain:'寫入說明內容', copyId: '複製日期-文號-主旨', readCopy: '複製全文到剪貼簿', plain: '開啟純文字', draftWrite: 'AI 擬稿', summary: 'AI重點摘要' };
  // 已拉出的浮動按鈕：{ [key]: { x, y, s } }，x/y 為視窗座標，s 為縮放倍率
  let floatState = {};
  let pos = { right: 20, bottom: 20 }; // 以視窗右下角為錨點，拖曳與狀態切換都沿用

  function buildPanel() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.theme = 'light';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>${PANEL_HTML}`;
    document.body.appendChild(host);
    setInterval(() => {
      if (!document.getElementById(HOST_ID) && document.body && host) document.body.appendChild(host);
    }, 3000);
  }

  // ---------- 「複製日期-文號-主旨」格式設定 ----------
const COPY_TPL_KEY = 'copyIdTemplate';
const DEFAULT_COPY_TPL = '{date}-{docno}-{subject}';

async function loadCopyTemplate() {
  try {
    const r = await chrome.storage.local.get({ [COPY_TPL_KEY]: DEFAULT_COPY_TPL });
    return r[COPY_TPL_KEY] || DEFAULT_COPY_TPL;
  } catch (_) { return DEFAULT_COPY_TPL; }
}

function renderCopyTemplate(tpl, parts) {
  let out = String(tpl).replace(/\{(date|rocdate|docno|subject)\}/g, (_, k) => parts[k] || '');
  out = out.replace(/-{2,}/g, '-').replace(/^[-\s]+|[-\s]+$/g, '');
  return out.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

async function editCopyTemplate() {
  const cur = await loadCopyTemplate();
  const msg = '設定「複製日期-文號-主旨」的格式（留空則還原預設）。\n' +
    '可用代號：\n' +
    '{date}　　= 1151103（民國年月日）\n' +
    '{rocdate} = 115年11月3日\n' +
    '{docno}　 = 文號（簽若無文號則留空）\n' +
    '{subject} = 主旨\n' +
    '其餘文字照原樣保留，例如：\n' +
    '中華民國{rocdate}-公文字號：{docno}-主旨：{subject}';
  const next = window.prompt(msg, cur);
  if (next === null) return;
  const val = next.trim() || DEFAULT_COPY_TPL;
  try {
    await chrome.storage.local.set({ [COPY_TPL_KEY]: val });
    toast('已儲存複製格式', 'ok');
  } catch (e) { toast('儲存失敗：' + (e && e.message ? e.message : e), 'err'); }
}

const GEAR_CSS = '.gear{margin-left:4px;padding:2px 8px;border:1px solid var(--line,#ccc);border-radius:10px;background:transparent;cursor:pointer;font-size:14px;vertical-align:middle;}' +
  '[data-q="copyId"][hidden] + [data-gear]{display:none!important;}' +
  ':host([data-page="new-editor"]) [data-gear]{display:none!important;}';

function applyCopyGear() {
  if (!root.querySelector('#gearStyle')) {
    const st = document.createElement('style');
    st.id = 'gearStyle';
    st.textContent = GEAR_CSS;
    root.appendChild(st);
  }
  root.querySelectorAll('[data-gear="copyId"]').forEach((g) => {
    if (g.dataset.wired) return;
    g.dataset.wired = '1';
    g.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); editCopyTemplate(); });
  });
}

function applyPageMode() {
 const p = new URLSearchParams(location.search);
 const app = p.get("app");
 const status = p.get("status");
 let mode = "default";
 if (app === "check") mode = "check";
 else if (app === "editor" && status === "new") mode = "new-editor";
 host.dataset.page = mode;
 if (!root.querySelector("#pageModeStyle")) {
  const style = document.createElement("style");
  style.id = "pageModeStyle";
  style.textContent = ":host([data-page=\"new-editor\"]) [data-q=\"copyId\"],\n:host([data-page=\"new-editor\"]) [data-q=\"readCopy\"],\n:host([data-page=\"new-editor\"]) [data-q=\"plain\"],\n:host([data-page=\"new-editor\"]) [data-q=\"draftWrite\"],\n:host([data-page=\"new-editor\"]) [data-q=\"summary\"],\n:host([data-page=\"new-editor\"]) .group-label,\n:host([data-page=\"new-editor\"]) .psec-title,\n:host([data-page=\"new-editor\"]) #grpAi,\n:host([data-page=\"new-editor\"]) #aiTitle,\n:host([data-page=\"new-editor\"]) #aiGroupLabel,\n:host([data-page=\"check\"]) [data-q=\"writeExplain\"] { display: none !important; }";
  root.appendChild(style);
 }
}

/* ---------- 位置與拖曳 ---------- */
  // 確保浮動元件（任何狀態）都在視窗內
  function clampPos() {
    const w = $('wrap');
    if (!w) return;
    const rect = w.getBoundingClientRect();
    const maxR = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    const maxB = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    pos.right = Math.min(Math.max(pos.right, MARGIN), maxR);
    pos.bottom = Math.min(Math.max(pos.bottom, MARGIN), maxB);
    w.style.right = `${pos.right}px`;
    w.style.bottom = `${pos.bottom}px`;
  }

  function savePos() {
    if (!contextValid()) return;
    chrome.storage.local.set({ [POS_KEY]: { right: Math.round(pos.right), bottom: Math.round(pos.bottom) } }).catch(() => {});
  }

  // 拖曳：移動超過門檻才視為拖曳；拖曳結束後吞掉緊接的 click，避免誤觸按鈕
  function enableDrag(el) {
    let s = null;
    let moved = false;
    let swallow = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      swallow = false;
      if (e.target.closest && e.target.closest('[data-q]')) return; // 按鈕拖曳交由浮動按鈕處理
      s = { x: e.clientX, y: e.clientY, r: pos.right, b: pos.bottom, id: e.pointerId };
      moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        try { el.setPointerCapture(s.id); } catch (_) { /* 忽略 */ }
        $('wrap').classList.add('dragging');
      }
      pos.right = s.r - dx;
      pos.bottom = s.b - dy;
      clampPos();
    });
    const finish = () => {
      if (!s) return;
      const wasMoved = moved;
      s = null;
      moved = false;
      if (wasMoved) {
        swallow = true;
        $('wrap').classList.remove('dragging');
        savePos();
        log.debug('浮動視窗位置已更新', { right: Math.round(pos.right), bottom: Math.round(pos.bottom) });
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('click', (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
  }

  // 三種狀態：min（助）→ bar（快捷列）→ panel（完整面板）
  
/* ---------- 邊框調整大小（比例 --u，自動存檔） ---------- */
const UI_SCALE_KEY = 'uiScale';
const UI_SCALE_MIN = 0.7, UI_SCALE_MAX = 1.8;
function applyUiScale(u) {
  const v = clamp(Number.isFinite(u) ? u : 1, UI_SCALE_MIN, UI_SCALE_MAX);
  const wrapEl = $('wrap');if (wrapEl) wrapEl.style.setProperty('--u', String(v));
  return v;
}
function saveUiScale(u) {
  if (contextValid()) chrome.storage.local.set({ [UI_SCALE_KEY]: u }).catch(() => {});
}
function bindResizeGrip(gripId, targetId) {
  if (!root) return;
  const grip = $(gripId), target = $(targetId);
  if (!grip || !target) return;
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const wrapEl = $('wrap');const base = parseFloat(wrapEl ? getComputedStyle(wrapEl).getPropertyValue('--u') : '1') || 1;
    const w0 = target.getBoundingClientRect().width;
    if (w0 < 1) return;
    beginDrag(e, (ev) => {
      target.classList.add('resizing');
      try { grip.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      let last = base;
      return {
        move(dx) {
          // 以寬度變化換算比例：寬度隨 --u 線性變化
          last = applyUiScale(base * (w0 + dx) / w0);
        },
        end() {
          target.classList.remove('resizing');
          saveUiScale(last);
        }
      };
    });
  });
}

function setMode(mode, persist = true) {
    state.mode = mode;
    $('wrap').dataset.mode = mode;
    $('btnOpen').setAttribute('aria-expanded', String(mode === 'panel'));
    clampPos();
    if (persist && contextValid()) chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => {});
    log.debug('面板狀態', { mode });
  }

  /* ---------- 共用 UI ---------- */
  function setStatus(text, kind = '') {
    if (!root) return;
    $('status').textContent = text;
    $('status').dataset.kind = kind;
  }

  let toastTimer = null;
  function toast(text, kind = 'ok') {
    const el = $('toast');
    el.textContent = text;
    el.dataset.kind = kind;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function setBusy(flag, label) {
    state.busy = flag;
    if (label) setStatus(label, 'busy');
    root.querySelectorAll('[data-q]').forEach((b) => { b.disabled = flag; });
    $('dot').className = `dot ${flag ? 'busy' : state.text ? 'ok' : ''}`;
    $('btnMini').classList.toggle('busy', flag);
  }

  function renderLogs() {
    if (!root || !state.logsOpen) return;
    const pre = $('logs');
    pre.textContent = state.uiLogs.slice(-100).map((e) => {
      const extra = e.data !== undefined && e.level === 'ERROR' ? ` ${JSON.stringify(e.data).slice(0, 300)}` : '';
      return `${new Date(e.t).toLocaleTimeString('zh-TW', { hour12: false })} ${e.level.padEnd(5)} [${e.mod}] ${e.msg}${extra}`;
    }).join('\n');
    pre.scrollTop = pre.scrollHeight;
  }

  function applyTheme(t) {
    host.dataset.theme = t === 'dark' ? 'dark' : 'light';
    $('btnTheme').setAttribute('aria-pressed', String(t === 'dark'));
  }

  async function toggleTheme() {
    const next = host.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { await chrome.storage.local.set({ uiTheme: next }); } catch (_) { /* 忽略 */ }
    log.info('面板配色已切換', { theme: next });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      log.warn('Clipboard API 失敗，改用備援複製', { message: err.message });
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:0;';
    root.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------- 文字視窗（純文字可編輯；摘要與擬辦為唯讀） ---------- */
  function renderSheetMeta() {
    const n = countChars($('sheetText').value);
    $('sheetMeta').textContent = sheetCtx.editable
      ? `${sheetCtx.meta}｜目前約 ${n} 字（可直接編輯，刪除不需要的段落後再複製或下載）`
      : sheetCtx.meta;
  }

  function openSheet(o) {
    sheetCtx.base = o.base || 'gongwen';
    sheetCtx.editable = !!o.editable;
    sheetCtx.original = o.text || '';
    sheetCtx.meta = o.meta || '';
    $('sheetTitle').textContent = o.title || '結果';
    $('sheetText').value = sheetCtx.original;
    $('sheetText').readOnly = !sheetCtx.editable;
    $('sheetRestore').hidden = !sheetCtx.editable;
    renderSheetMeta();
    $('sheet').hidden = false;
    $('sheetText').scrollTop = 0;
    setTimeout(() => (sheetCtx.editable ? $('sheetText') : $('sheetCopy')).focus(), 30);
    log.info('開啟文字視窗', { title: o.title, chars: countChars(sheetCtx.original), editable: sheetCtx.editable });
  }

  // 文字視窗大小：可拖曳右下角調整；記住使用者設定（chrome.storage.local）
  const SHEET_SIZE_KEY = 'uiSheetSize';
  let sheetSaveTimer = null;
  function applySheetSize(size) {
    const el = root.querySelector('.sheet');
    if (!el || !size) return;
    el.style.width = `${Math.round(size.w)}px`;
    el.style.height = `${Math.round(size.h)}px`;
  }
  function toggleSheetMax() {
    const el = root.querySelector('.sheet');
    el.classList.toggle('maxed');
    const on = el.classList.contains('maxed');
    if (!on) applySheetSize(sheetCtx.savedSize);
    else { el.style.width = ''; el.style.height = ''; }
    $('sheetMax').setAttribute('aria-pressed', String(on));
  }
  function watchSheetResize() {
    const el = root.querySelector('.sheet');
    if (!el || typeof ResizeObserver !== 'function') return;
    new ResizeObserver(() => {
      if (el.classList.contains('maxed') || $('sheet').hidden) return;
      clearTimeout(sheetSaveTimer);
      sheetSaveTimer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        sheetCtx.savedSize = { w: r.width, h: r.height };
        if (contextValid()) chrome.storage.local.set({ [SHEET_SIZE_KEY]: sheetCtx.savedSize }).catch(() => {});
      }, 400);
    }).observe(el);
  }

  // 滾輪：頁面（公文系統 PDF 檢視器）可能攔截滾輪事件，因此文字框自行計算捲動量
  function handleSheetWheel(e) {
    const ta = $('sheetText');
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 22;
    else if (e.deltaMode === 2) dy *= ta.clientHeight;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max > 0) ta.scrollTop = Math.max(0, Math.min(max, ta.scrollTop + dy));
    e.preventDefault();
    e.stopPropagation();
  }

  function closeSheet(force) {
    const dirty = sheetCtx.editable && $('sheetText').value !== sheetCtx.original;
    if (!force && dirty && !window.confirm('內容已修改，尚未複製或下載。\n確定要關閉嗎？')) return;
    $('sheet').hidden = true;
  }

  function downloadTxt() {
    const blob = new Blob(['\ufeff', $('sheetText').value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sheetCtx.base}-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function docMeta(doc) {
    return `文號：${doc.docNo || '未辨識'}｜約 ${doc.chars} 字｜來源：${doc.source}${doc.cautious ? '（來源未完全對應，請核對文號）' : ''}`;
  }

  /* ---------- 設定（與背景程序通訊） ---------- */
  function sendToBG(message) {
    return new Promise((resolve, reject) => {
      if (!contextValid()) return reject(new Error('擴充套件已重新載入，請重新整理公文頁'));
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(`與背景程序通訊失敗：${err.message}`));
        resolve(resp);
      });
    });
  }

  async function loadSettings() {
    const res = await sendToBG({ type: 'GET_SETTINGS' });
    if (!res || !res.ok) throw new Error('無法讀取設定');
    const s = res.settings;
    state.settings = s;aiConfigured = hasAiConfig(s);
    state.defaults = { prompt: s.defaultPrompt || '', sum: s.defaultSummaryPrompt || '' };
    state.quick = Array.isArray(s.quickButtons) ? s.quickButtons.filter((k) => QUICK_KEYS.includes(k)) : QUICK_DEFAULT.slice();
    EdocLog.configure({ level: s.debugLevel || 'DEBUG' });
    fillParams(s);
    applyQuick();
    applyAiLabel(s.aiModel);
  }

  // 已連線成功時顯示模型名稱，否則維持「需設定模型」
  function applyAiLabel(model) {
    if (!root) return;
    const text = model ? `AI 功能（已載入 ${short(model, 40)} 模型）` : 'AI 功能（需設定模型）';
    $('aiGroupLabel').textContent = text;
    $('aiTitle').textContent = text;
  }

  async function refreshAiLabel() {
    try {
      const res = await sendToBG({ type: 'GET_SETTINGS' });
      if (res && res.ok) applyAiLabel(res.settings.aiModel);
    } catch (_) { /* 忽略 */ }
  }

  function hasAiConfig(s) {
  if (!s) return false;
  if (s.provider === 'cloud') return !!s.hasApiKey;
  return !!String(s.localCurl || '').trim() || !!s.presetId;
}
function fillParams(s) {
    $('pDraft').value = s.draftMaxChars || 100;
    $('pTimeout').value = s.timeoutSec || 60;
    $('pMax').value = s.maxChars || 12000;
    $('pRedact').checked = !!s.redact;
    $('pPrompt').value = s.promptTemplate || s.defaultPrompt || '';
    $('pSum').value = s.summaryPromptTemplate || s.defaultSummaryPrompt || '';
  }

  // 依設定顯示快捷按鈕；整組都隱藏時連同群組標題一起隱藏
  function applyQuick() {
    if (!root) return;
    root.querySelectorAll('.bar [data-q]').forEach((b) => { b.hidden = !state.quick.includes(b.dataset.q) || !!floatState[b.dataset.q]; });
    root.querySelectorAll('.fchip').forEach((el) => { el.hidden = !state.quick.includes(el.dataset.key); });
    ['grpPlain', 'grpAi'].forEach((id) => {
      const g = $(id);
      g.hidden = ![...g.querySelectorAll('[data-q]')].some((b) => !b.hidden);
    });
    root.querySelectorAll('#quickChecks input').forEach((i) => { i.checked = state.quick.includes(i.value); });
    applyAiVisibility();
  }

  // AI 功能預設隱藏；使用者於設定勾選後才顯示。一次性提示在按「知道了」後不再出現
  function applyAiVisibility() {
 if (!root) return;
 const visible = aiConfigured && showAi;
 $('aiSetupGuide').hidden = !storeLoaded || aiConfigured;
 $('pShowAiWrap').hidden = !storeLoaded || !aiConfigured;
 $('grpAi').hidden = !visible;
 root.querySelectorAll('.tile.ai').forEach((t) => { t.hidden = !visible; });
 $('aiTitle').hidden = !visible;
 root.querySelectorAll('.fchip').forEach((el) => {
 if (AI_KEYS.includes(el.dataset.key)) el.hidden = !visible || !state.quick.includes(el.dataset.key);
 });
 $('aiNotice').hidden = !storeLoaded || visible || aiNoticeSeen;
 $('pShowAi').checked = showAi;
}

  async function actionSaveQuick() {
    const picked = [...root.querySelectorAll('#quickChecks input')].filter((i) => i.checked).map((i) => i.value);
    try {
      const res = await sendToBG({ type: 'SAVE_QUICK_BUTTONS', payload: { quickButtons: picked } });
      if (!res || !res.ok) throw new Error((res && res.error) || '儲存失敗');
      state.quick = res.quickButtons;
      applyQuick();
      toast(picked.length ? `快捷按鈕已更新（${picked.length} 個）` : '已隱藏所有快捷按鈕', 'ok');
    } catch (err) {
      toast(`快捷按鈕儲存失敗：${err.message}`, 'err');
    }
  }

  async function actionSaveParams() {
    const s = state.settings;
    if (!s) return toast('尚未取得設定，請重新整理公文頁', 'err');
    // 只更新參數與提示詞；連線方式與 cURL 沿用已儲存值，不會被覆寫
    const payload = {
      provider: s.provider, presetId: s.presetId, localPort: s.localPort, customUrl: s.customUrl,
      model: s.model, apiKey: null, debugLevel: s.debugLevel,
      draftMaxChars: $('pDraft').value, timeoutSec: $('pTimeout').value, maxChars: $('pMax').value,
      redact: $('pRedact').checked,
      promptTemplate: $('pPrompt').value, summaryPromptTemplate: $('pSum').value
    };
    try {
      const res = await sendToBG({ type: 'SAVE_SETTINGS', payload });
      if (!res || !res.ok) throw new Error((res && res.error) || '儲存失敗');
      await loadSettings();
      log.info('參數與提示詞已儲存（面板）');
      toast('設定已儲存', 'ok');
    } catch (err) {
      log.error('參數儲存失敗', { message: err.message });
      toast(`儲存失敗：${err.message}`, 'err');
    }
  }

  async function actionOpenSettings() {
    try {
      const res = await sendToBG({ type: 'OPEN_OPTIONS' });
      if (!res || !res.ok) throw new Error((res && res.error) || '無回應');
      toast('已開啟完整設定頁', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------- 通用拖曳控制（浮動按鈕共用） ---------- */
  let drag = null;
  let swallowClick = false;
  function beginDrag(e, onStart) {
    if (e.button !== 0) return;
    swallowClick = false;
    drag = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, onStart, work: null };
  }
  function dragMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.work = drag.onStart(e) || null;
    }
    if (drag.work) drag.work.move(dx, dy);
  }
  function dragEnd(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      swallowClick = true;
      if (d.work && d.work.end) d.work.end();
    }
  }

  /* ---------- 浮動快捷按鈕：拉出、移動、縮放、收回 ---------- */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function sanitizeFloats(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of QUICK_KEYS) {
      const f = raw[k];
      if (f && Number.isFinite(f.x) && Number.isFinite(f.y)) {
        out[k] = { x: f.x, y: f.y, s: clamp(Number.isFinite(f.s) ? f.s : 1, FLOAT_MIN, FLOAT_MAX) };
      }
    }
    return out;
  }

  function saveFloats() {
    if (contextValid()) chrome.storage.local.set({ [FLOAT_KEY]: floatState }).catch(() => {});
  }

  // 將元件限制在視窗內（依目前大小計算）
  function keepInView(el, x, y) {
    const r = el.getBoundingClientRect();
    return {
      x: clamp(x, MARGIN, Math.max(MARGIN, window.innerWidth - r.width - MARGIN)),
      y: clamp(y, MARGIN, Math.max(MARGIN, window.innerHeight - r.height - MARGIN))
    };
  }

  function placeFloat(el, f) {
    el.style.left = `${Math.round(f.x)}px`;
    el.style.top = `${Math.round(f.y)}px`;
    el.style.setProperty('--s', String(f.s));
  }

  function floatEl(key) {
    return root.querySelector(`.fchip[data-key="${key}"]`);
  }

  function buildFloat(key) {
    const label = CHIP_LABEL[key];
    const el = document.createElement('div');
    el.className = 'fchip';
    el.dataset.key = key;
    el.innerHTML = `<span class="fgrip" aria-hidden="true" title="拖曳移動">⋮⋮</span>`
      + `<button class="chip" type="button" data-q="${key}" title="${label}">${label}</button>`
      + `<button class="fback" type="button" title="收回到快捷列" aria-label="收回到快捷列">↩</button>`
      + `<span class="fresize" title="拖曳調整大小" aria-hidden="true"></span>`;
    el.querySelector('.chip').addEventListener('click', () => { const fn = ACTIONS[key]; if (fn) fn(); });
    el.querySelector('.fback').addEventListener('click', () => reattachChip(key));
    el.addEventListener('pointerdown', (e) => floatPointerDown(e, key, el));
    el.querySelector('.fresize').addEventListener('pointerdown', (e) => resizeStart(e, key, el));
    $('floatLayer').appendChild(el);
    return el;
  }

  // 依 floatState 建立、更新或移除浮動按鈕
  function syncFloats() {
    root.querySelectorAll('.fchip').forEach((el) => { if (!floatState[el.dataset.key]) el.remove(); });
    for (const key of Object.keys(floatState)) {
      const el = floatEl(key) || buildFloat(key);
      const f = floatState[key];
      placeFloat(el, f);
      const p = keepInView(el, f.x, f.y);
      f.x = p.x;
      f.y = p.y;
      placeFloat(el, f);
    }
    applyQuick();
  }

  function clampAllFloats() {
    root.querySelectorAll('.fchip').forEach((el) => {
      const f = floatState[el.dataset.key];
      if (!f) return;
      const p = keepInView(el, f.x, f.y);
      f.x = p.x;
      f.y = p.y;
      placeFloat(el, f);
    });
  }

  function floatDragger(el, key, startX, startY) {
    const f = floatState[key];
    return {
      move(dx, dy) {
        const p = keepInView(el, startX + dx, startY + dy);
        f.x = p.x;
        f.y = p.y;
        placeFloat(el, f);
      },
      end() {
        el.classList.remove('dragging');
        saveFloats();
      }
    };
  }

  // 拖曳已拉出的按鈕（按鈕本身仍可點擊執行）
  function floatPointerDown(e, key, el) {
    beginDrag(e, (ev) => {
      const f = floatState[key];
      if (!f) return null;
      el.classList.add('dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      return floatDragger(el, key, f.x, f.y);
    });
  }

  // 在收合列按住按鈕往外拖曳，即從原位置拉出成獨立按鈕
  function chipPointerDown(e, chip) {
    const key = chip.dataset.q;
    const r = chip.getBoundingClientRect();
    beginDrag(e, (ev) => {
      if (floatState[key]) return null;
      const f = { x: r.left, y: r.top, s: 1 };
      floatState[key] = f;
      const el = buildFloat(key);
      placeFloat(el, f);
      applyQuick();
      el.classList.add('dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      log.info('快捷按鈕已拉出', { key });
      return floatDragger(el, key, f.x, f.y);
    });
  }

  // 右下角把手：拖曳調整大小，內部文字與內距等比縮放
  function resizeStart(e, key, el) {
    e.stopPropagation();
    const f = floatState[key];
    const w0 = el.getBoundingClientRect().width;
    if (!f || w0 < 1) return;
    const s0 = f.s;
    beginDrag(e, (ev) => {
      el.classList.add('dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      return {
        move(dx) {
          f.s = clamp(s0 * (w0 + dx) / w0, FLOAT_MIN, FLOAT_MAX);
          placeFloat(el, f);
          const p = keepInView(el, f.x, f.y);
          f.x = p.x;
          f.y = p.y;
          placeFloat(el, f);
        },
        end() {
          el.classList.remove('dragging');
          saveFloats();
        }
      };
    });
  }

  // 收回：移除浮動按鈕，快捷列重新顯示該按鈕
  function reattachChip(key) {
    delete floatState[key];
    const el = floatEl(key);
    if (el) el.remove();
    saveFloats();
    applyQuick();
    toast('已收回到快捷列', 'ok');
  }

  // 還原預設版面：面板位置與狀態、拉出的按鈕、文字視窗大小
  function resetLayout() {
    if (!window.confirm('確定還原為預設版面？\n（面板位置與展開狀態、拉出的按鈕位置與大小、文字視窗大小都會回到預設）')) return;
    pos = { right: 20, bottom: 20 };
    savePos();
    floatState = {};
    saveFloats();
    syncFloats();
    sheetCtx.savedSize = null;
    if (contextValid()) chrome.storage.local.remove(SHEET_SIZE_KEY).catch(() => {});
    const sh = root.querySelector('.sheet');
    if (sh) { sh.style.width = ''; sh.style.height = ''; sh.classList.remove('maxed'); }
    setMode('bar');
    toast('已還原為預設版面', 'ok');
    log.info('已還原預設版面');
  }

  /* ---------- 主要動作 ---------- */
  // 共用流程：忙碌鎖、錯誤呈現、紀錄耗時
  async function run(label, fn) {
    if (state.busy) return log.warn('忙碌中，忽略重複點擊', { label });
    setBusy(true, `${label}中…`);
    const done = log.time(label);
    try {
      await fn();
      done();
    } catch (err) {
      done();
      log.error(`${label}失敗`, { message: err.message });
      setStatus(`${label}失敗：${err.message}`, 'err');
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  // 由公文文字組出「發文日期-發文字號-主旨」檔名
  // 例：1151019-北市教專字第1156010644號-敦聘貴屬人員…請查照。
  // 由公文或「簽」文字組出檔名；簽無文號時文號留空，仍可複製日期與主旨
function buildFileName(text, tpl) {
  const t = text || '';
  // 判斷是否為「簽」：有「簽於…日」且沒有「發文日期」
  const isSign = /(^|\n)[ \t]*簽[ \t]*\n?/.test(t.slice(0, 200)) && !/發文日期[：:]/.test(t) && /簽於/.test(t);
  const dm = t.match(/發文日期[：:][ \t]*(?:中華民國[ \t]*)?(\d{2,3})[ \t]*年[ \t]*(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日/)
    || t.match(/簽於[ \t]*(?:中華民國[ \t]*)?(\d{2,3})[ \t]*年[ \t]*(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日/);
  // 文號：「簽」不使用文號；公文才擷取
  let no = '';
  if (!isSign) {
    const head = t.split(/\n[ \t]*說明[ \t]*[：:]/)[0];
    const nm = t.match(/發文字號[：:][ \t]*([^\n]+)/);
    no = nm ? nm[1].replace(/\s+/g, '') : '';
    if (!/字第\d+號/.test(no)) {
      const fm = head.match(/[^\s：:]*字第\s*\d+\s*號/);
      if (fm) no = fm[0].replace(/\s+/g, '');
    }
    if (!no) {
      const sl = head.match(/\b\d{2,3}\/\d{4,}\/\d+\b/);
      if (sl) no = sl[0];
    }
  }
  // 主旨：只取「主旨：」到「說明：」或「一、」之前；「說明」段內容不會混入
  const sm = t.match(/(?:^|\n)[ \t]*主旨[：:]\s*([\s\S]*?)(?=\n[ \t]*說明[ \t]*[：:]|\n[ \t]*(?:正本|副本|附件|擬辦|決行|承辦人|備註)[ \t]*[：:]|$)/);
  const subj = sm ? sm[1].split('\n').map((s) => s.trim()).filter(Boolean)
    .reduce((acc, cur) => (acc ? acc + (/[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(cur) ? ' ' : '') + cur : cur), '')
    .replace(/\s+/g, ' ').trim() : '';
  const missing = [];
  if (!dm) missing.push('發文日期（或簽於…日）');
  if (!subj) missing.push('主旨');
  if (!isSign && !no) missing.push('發文字號');
  if (missing.length) throw new Error('無法組合檔名，未辨識到：' + missing.join('、'));
  const parts = {
    date: dm[1] + dm[2].padStart(2, '0') + dm[3].padStart(2, '0'),
    rocdate: dm[1] + '年' + Number(dm[2]) + '月' + Number(dm[3]) + '日',
    docno: no,
    subject: subj
  };
  return renderCopyTemplate(tpl || DEFAULT_COPY_TPL, parts);
}

function actionCopyId() {
    return run('複製日期-文號-主旨', async () => {
      const doc = await readDocument();
      state.text = doc.text;
      state.docNo = doc.docNo;
      const tpl = await loadCopyTemplate();const name = buildFileName(doc.text, tpl);
      const ok = await copyText(name);
      if (ok) {
        setStatus(`已複製檔名：\n${name}\n\n${docMeta(doc)}`, 'ok');
        toast('已複製「日期-文號-主旨」', 'ok');
      } else {
        setStatus('自動複製未成功，已於視窗顯示檔名，請按「複製全文」。', 'err');
        openSheet({ title: '日期-文號-主旨', text: name, meta: docMeta(doc), base: 'filename' });
      }
    });
  }

  function actionCopy() {
    return run('複製全文到剪貼簿', async () => {
      const doc = await readDocument();
      state.text = doc.text;
      state.docNo = doc.docNo;
      const ok = await copyText(doc.text);
      if (ok) {
        setStatus(`已複製到剪貼簿（約 ${doc.chars} 字）\n${docMeta(doc)}`, 'ok');
        toast('已複製到剪貼簿', 'ok');
      } else {
        setStatus('自動複製未成功，已於視窗顯示全文，請按「複製全文」。', 'err');
        openSheet({ title: '公文內容', text: doc.text, meta: docMeta(doc), base: 'gongwen' });
      }
    });
  }

  function actionPlain() {
    return run('開啟純文字', async () => {
      const doc = await readDocument();
      state.text = doc.text;
      state.docNo = doc.docNo;
      openSheet({
        title: '公文純文字', text: doc.text, meta: docMeta(doc), base: `gongwen-${doc.docNo || 'plain'}`, editable: true
      });
      setStatus(`已轉為純文字（約 ${doc.chars} 字），可於視窗中編輯後複製或下載。`, 'ok');
    });
  }

  function actionSummary() {
    return run('AI重點摘要', async () => {
      const doc = await readDocument();
      state.text = doc.text;
      state.docNo = doc.docNo;
      const res = await sendToBG({ type: 'AI_SUMMARY', payload: { text: doc.text } });
      if (!res || !res.ok) throw new Error((res && res.error) || '背景程序無回應');
      openSheet({
        title: 'AI重點摘要', text: res.draft, meta: `${docMeta(doc)}｜僅供閱讀，未寫入意見`,
        base: `gongwen-summary-${doc.docNo || ''}`
      });
      setStatus(`AI重點摘要已於視窗顯示（約 ${res.chars} 字）。`, 'ok');
    });
  }

  function actionDraftWrite() {
    return run('AI 擬稿', async () => {
      const doc = await readDocument();
      state.text = doc.text;
      state.docNo = doc.docNo;
      const res = await sendToBG({ type: 'AI_DRAFT', payload: { text: doc.text } });
      if (!res || !res.ok) throw new Error((res && res.error) || '背景程序無回應');
      if (!writeToOpinion(res.draft)) {
        setStatus('找不到可見的「我的意見」欄位，擬辦已於視窗顯示，請複製後自行貼上。', 'err');
        openSheet({ title: '擬辦草稿', text: res.draft, meta: docMeta(doc), base: 'draft' });
        return;
      }
      setStatus(`擬辦已寫入「我的意見」（約 ${res.chars} 字，上限 ${res.limit} 字）。請於系統內人工確認後再送出。\n${docMeta(doc)}`,
        res.overLimit ? 'err' : 'ok');
    });
  }

  function actionDiagnose() {
    return run('診斷', async () => {
      let pdfjsStatus;
      try {
        const lib = await loadPdfJs();
        pdfjsStatus = { ok: true, version: lib.version };
      } catch (err) {
        pdfjsStatus = { ok: false, error: err.message };
      }
      log.info('診斷報告', {
        version: VERSION,
        path: location.pathname,
        readyState: document.readyState,
        extensionContext: contextValid(),
        hookReady: state.hookReady,
        pdfjs: pdfjsStatus,
        iframes: [...document.querySelectorAll('iframe')].map((f) => ({
          srcScheme: (f.getAttribute('src') || '').split(':')[0] || 'none',
          visible: f.getClientRects().length > 0,
          domChars: countChars(readFrameText(f))
        })),
        blobs: [...state.blobs.values()].map((r) => ({ type: r.info.type, size: r.info.size, revoked: r.revoked })),
        paperChars: countChars(readPaperText()),
        lastSource: state.source,
        lastDocNo: state.docNo
      });
      state.logsOpen = true;
      $('secLog').open = true;
      renderLogs();
      toast(pdfjsStatus.ok ? '診斷完成，pdf.js 已就緒' : 'pdf.js 載入失敗，請查看執行紀錄', pdfjsStatus.ok ? 'ok' : 'err');
    });
  }

  /* ---------- 寫入「我的意見」 ---------- */
  function writeTextarea(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    for (const type of ['input', 'change', 'keyup']) el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  // 回傳是否找到欄位並寫入
  function writeToOpinion(draft) {
    const visible = [...document.querySelectorAll('textarea[name="fieldNote"]')].filter((el) => el.getClientRects().length > 0);
    if (!visible.length) {
      log.warn('找不到可見的意見欄位');
      return false;
    }
    const el = visible[0];
    let value = draft;
    if (el.value.trim()) {
      const overwrite = window.confirm('「我的意見」已有內容。\n按「確定」＝覆蓋；按「取消」＝附加於既有內容之後。');
      value = overwrite ? draft : `${el.value.replace(/\s+$/, '')}\n${draft}`;
    }
    writeTextarea(el, value);
    setTimeout(() => {
      if (el.value !== value) toast('寫入後內容被系統改寫，請查看執行紀錄並回報。', 'err');
    }, 400);
    return true;
  }

  /* ---------- 寫入說明內容（貼上 Word 段落，自動分段寫入） ---------- */
let explainBusy = false;
function actionWriteExplain() {
 $('explainText').value = '';
 $('explainMask').hidden = false;
 setTimeout(() => $('explainText').focus(), 30);
 log.info('開啟寫入說明視窗');
}
function closeExplain() {
 if (explainBusy) return;
 $('explainMask').hidden = true;
}
function explainLines(text) {
 return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/\t+/g, ' ').trim()).filter(Boolean);
}
function waitExplainResult(timeoutMs) {
 return new Promise((resolve) => {
  const onMsg = (ev) => {
   const d = ev.data;
   if (ev.origin !== location.origin || !d || d.source !== SRC_PASTE || d.type !== 'EXPLAIN_WRITE_RESULT') return;
   clearTimeout(timer);
   window.removeEventListener('message', onMsg);
   resolve(d);
  };
  const timer = setTimeout(() => {
   window.removeEventListener('message', onMsg);
   resolve({ ok: false, done: 0, reason: '等待編輯器回應逾時，請確認編輯頁仍開啟後再試' });
  }, timeoutMs);
  window.addEventListener('message', onMsg);
 });
}

async function writeExplain() {
 const lines = explainLines($('explainText').value);
 if (!lines.length) { toast('請先貼上內容', 'err'); return; }
 if (explainBusy) return;
 explainBusy = true;
 $('explainWrite').disabled = true;
 try {
  const wait = waitExplainResult(15000 + lines.length * 2000);
  window.postMessage({ source: SRC_CONTENT, type: 'EXPLAIN_WRITE', lines: lines }, location.origin);
  const res = await wait;
  if (res.ok) {
   $('explainMask').hidden = true;
   $('explainText').value = '';
   setStatus('已寫入說明欄位，共 ' + res.total + ' 段。', 'ok');
   toast('已寫入 ' + res.total + ' 段', 'ok');
  } else {
   const done = res.done || 0;
   $('explainText').value = (res.remaining || lines.slice(done)).join('\n');
   setStatus('寫入中止：已寫入 ' + done + ' 段，剩餘內容保留在視窗中。' + (res.reason || ''), 'err');
   toast(res.reason || '寫入未完成，請查看狀態列', 'err');
  }
 } finally {
  explainBusy = false;
  $('explainWrite').disabled = false;
 }
}



const ACTIONS = {
 writeExplain:actionWriteExplain,copyId: actionCopyId, readCopy: actionCopy, plain: actionPlain, draftWrite: actionDraftWrite, summary: actionSummary
  };

  /* ---------- 事件繫結 ---------- */
  function wire() {
    $('btnMini').addEventListener('click', () => setMode('bar'));
    $('btnOpen').addEventListener('click', () => setMode('panel'));
    $('btnClose').addEventListener('click', () => setMode('bar'));
    $('btnMinBar').addEventListener('click', () => setMode('min'));
    $('pShowAi').addEventListener('change', () => {
      showAi = $('pShowAi').checked;
      if (contextValid()) chrome.storage.local.set({ [SHOW_AI_KEY]: showAi }).catch(() => {});
      applyAiVisibility();
      toast(showAi ? 'AI 功能已開啟' : 'AI 功能已隱藏', 'ok');
    });
    $('btnAiNoticeX').addEventListener('click', () => {
      aiNoticeSeen = true;
      if (contextValid()) chrome.storage.local.set({ [AI_NOTICE_KEY]: true }).catch(() => {});
      applyAiVisibility();
    });
    $('btnTipX').addEventListener('click', (e) => {
      e.stopPropagation();
      $('barTip').hidden = true;
      if (contextValid()) chrome.storage.local.set({ [TIP_KEY]: true }).catch(() => {});
      log.info('已關閉快捷按鈕提示');
    });
    $('btnMin').addEventListener('click', () => setMode('min'));
    $('btnResetBar').addEventListener('click', resetLayout);
    $('btnResetPanel').addEventListener('click', resetLayout);
    $('btnLayoutReset').addEventListener('click', resetLayout);
    root.querySelectorAll('.bar [data-q]').forEach((c) => c.addEventListener('pointerdown', (e) => chipPointerDown(e, c)));
    root.addEventListener('pointermove', dragMove);
    root.addEventListener('pointerup', dragEnd);
    root.addEventListener('pointercancel', dragEnd);
    // 拖曳結束後吞掉緊接的 click，避免拉出或移動時誤觸執行
    root.addEventListener('click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    $('btnTheme').addEventListener('click', toggleTheme);
    root.querySelectorAll('[data-q]').forEach((b) => {
      b.addEventListener('click', () => { const fn = ACTIONS[b.dataset.q]; if (fn) fn(); });
    });

    // 三種狀態皆可拖曳（面板只能從標題列拖曳，避免拖到輸入區）
    enableDrag($('btnMini'));
    enableDrag($('bar'));
    enableDrag($('ph'));
    window.addEventListener('resize', () => { clampPos(); clampAllFloats(); });

    $('btnSettings').addEventListener('click', actionOpenSettings);
$('btnGoAiSetup').addEventListener('click',actionOpenSettings);
    $('btnQuickSave').addEventListener('click', actionSaveQuick);
    $('btnParamSave').addEventListener('click', actionSaveParams);
    $('btnPromptReset').addEventListener('click', () => { $('pPrompt').value = state.defaults.prompt || ''; toast('已還原擬辦提示詞（尚未儲存）', 'ok'); });
    $('btnSumReset').addEventListener('click', () => { $('pSum').value = state.defaults.sum || ''; toast('已還原重點提示詞（尚未儲存）', 'ok'); });
    $('btnDiag').addEventListener('click', actionDiagnose);
    $('secLog').addEventListener('toggle', () => { state.logsOpen = $('secLog').open; renderLogs(); });
    $('btnLogClear').addEventListener('click', async () => {
      try { await sendToBG({ type: 'CLEAR_LOG' }); } catch (_) { /* 忽略 */ }
      state.uiLogs = [];
      renderLogs();
      toast('執行紀錄已清除', 'ok');
    });

    $('sheetClose').addEventListener('click', () => closeSheet(false));
$('explainClose').addEventListener('click', closeExplain);
$('explainCancel').addEventListener('click', closeExplain);

$('explainClear').addEventListener('click', () => { $('explainText').value = ''; $('explainText').focus(); });
$('explainWrite').addEventListener('click', writeExplain);
$('explainMask').addEventListener('click', (e) => { if (e.target === $('explainMask')) closeExplain(); });

    $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(false); });
    $('sheetDownload').addEventListener('click', downloadTxt);
    $('sheetText').addEventListener('input', renderSheetMeta);
    $('sheetRestore').addEventListener('click', () => {
      if (!window.confirm('確定要還原為原文？目前的編輯將被清除。')) return;
      $('sheetText').value = sheetCtx.original;
      renderSheetMeta();
      toast('已還原為原文', 'ok');
    });
    $('sheetCopy').addEventListener('click', async () => {
      const ok = await copyText($('sheetText').value);
      toast(ok ? '已複製到剪貼簿' : '複製未成功，請手動選取文字後 Ctrl+C', ok ? 'ok' : 'err');
    });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('explainMask').hidden) closeExplain();else if (!$('sheet').hidden) closeSheet(false);
      else if (state.mode === 'panel') setMode('bar');
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.uiTheme) applyTheme(changes.uiTheme.newValue);
      if (area === 'local' && changes.aiStatus) refreshAiLabel();
    });
  }

  function init() {
    buildPanel();bindResizeGrip('gripBar','bar');bindResizeGrip('gripPanel','panel');wire();
 applyPageMode();
 applyCopyGear();
    $('sheetText').addEventListener('wheel', handleSheetWheel, { passive: false });
const pb = root.querySelector('.pbody');if (pb) pb.addEventListener('wheel',(e) => { const max = pb.scrollHeight - pb.clientHeight; if (max <= 0) return; const before = pb.scrollTop; pb.scrollTop = Math.max(0, Math.min(max, before + e.deltaY)); if (pb.scrollTop !== before) e.preventDefault(); },{ passive:false });
    $('sheet').addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    $('sheetMax').addEventListener('click', toggleSheetMax);
    watchSheetResize();
    window.postMessage({ source: SRC_CONTENT, type: 'HOOK_PING' }, location.origin);
    log.info('內容腳本啟動', { version: VERSION, path: location.pathname });
    chrome.storage.local.get({ uiTheme: 'light',uiScale:1, [POS_KEY]: null, [SHEET_SIZE_KEY]: null, [MODE_KEY]: 'bar', [FLOAT_KEY]: null, [TIP_KEY]: false, [SHOW_AI_KEY]: false, [AI_NOTICE_KEY]: false })
      .then((r) => {
        applyTheme(r.uiTheme);applyUiScale(r.uiScale);
        $('barTip').hidden = !!r[TIP_KEY];
        showAi = !!r[SHOW_AI_KEY];
        aiNoticeSeen = !!r[AI_NOTICE_KEY];
        storeLoaded = true;
        applyAiVisibility();
        floatState = sanitizeFloats(r[FLOAT_KEY]);
        if (r[SHEET_SIZE_KEY]) { sheetCtx.savedSize = r[SHEET_SIZE_KEY]; applySheetSize(sheetCtx.savedSize); }
        const p = r[POS_KEY];
        if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) pos = { right: p.right, bottom: p.bottom };
        syncFloats();
        // 還原上次的狀態（最小化／快捷列／完整面板），不寫回儲存
        setMode(MODES.includes(r[MODE_KEY]) ? r[MODE_KEY] : 'bar', false);
        clampPos();
      })
      .catch(() => { applyTheme('light'); clampPos(); });
    loadSettings().catch((err) => log.warn('啟動時無法載入設定，將於操作時重試', { message: err.message }));
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
