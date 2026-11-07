/* paste-main.js v3.7.0（MAIN world）
 * 寫入說明內容：依 Word 段落逐行寫入「說明」欄位。
 * 若游標不在說明段落，會先用 svg.textActions 移到「說明」段落（KDRichTextBlock_1_context）。
 * 每行流程：確認游標段落為空白 → input 寫入 → 確認段落文字正確
 *          → turnLine(段落文字長度) 換段 → 確認出現唯一新段落且游標移到新段落。
 * 緊急停用：localStorage.setItem('edocPasteSplitOff','1')；恢復：removeItem。
 */
(() => {
  'use strict';
  const TAG = '[EDOC-HELPER][PASTE]';
  if (window.__edocPasteSplit) return;
  window.__edocPasteSplit = { version: '3.7.0' };
  const SRC_CONTENT = 'edoc-helper-content';
  const SRC_PASTE = 'edoc-helper-paste';
  const EXPLAIN_ID = 'KDRichTextBlock_1_context';

  let busy = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 輪詢等待條件成立，逾時回傳 null
  async function waitFor(fn, timeout = 1000, step = 20) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function isDisabled() {
    try { return localStorage.getItem('edocPasteSplitOff') === '1'; } catch (e) { return false; }
  }

  function getCpaper() {
    try { return OA.common.Global.getApp().getController('OA.controller.Work').getCpaper(); } catch (e) { return null; }
  }

  function selEl(cp) {
    return (cp && cp._selectedElement) || null;
  }

  function selId(cp) {
    const el = selEl(cp);
    return (el && el.getAttribute && el.getAttribute('id')) || '';
  }

  // 條例段落 ID（不含 _context）清單
  function blockIds() {
    return [...document.querySelectorAll('[id^="KDRichTextBlock"]')]
      .map((n) => n.id).filter((id) => !id.endsWith('_context'));
  }

  // 「說明」段落：KDRichTextBlock_1_context 與其後新建的條例（-1001_context、-1001.1_context…）
  function isExplainId(id) {
    return /^KDRichTextBlock(_1_context|-\d+(\.\d+)*_context)$/.test(id || '');
  }

  function isBlank(s) {
    return String(s || '').replace(/[\s\u3000]/g, '') === '';
  }

  // 取得游標方法：優先 window._textActions，找不到則用 cp._svgPaper.textActions（已驗證可用）
  function textActions(cp) {
    if (window._textActions) return window._textActions;
    const svg = cp && cp._svgPaper;
    return (svg && svg.textActions) || null;
  }

  // ---------- 游標移到「說明」段落 ----------
  // ---------- Word 前處理 ----------
  const BULLET_RE = /^[•●○◦▪▫■□◆◇◎★☆※✓✔√\-–—·*・]+\s*/;
  const NUM_RES = [
    /^[一二三四五六七八九十百千]+[、．.]\s*/,
    /^[（(][一二三四五六七八九十百千\d]+[)）]\s*/,
    /^\d+[、)）]\s*/,
    /^\d+\.\s+/,
    /^[A-Za-z][)）]\s*/,
    /^[A-Za-z]\.\s+/
  ];

  function cleanWordLine(raw) {
    let s = String(raw || '').replace(/\u00a0/g, ' ').replace(/\t+/g, ' ').trim();
    let prev;
    do {
      prev = s;
      s = s.replace(BULLET_RE, '');
      for (const re of NUM_RES) s = s.replace(re, '');
      s = s.trim();
    } while (s !== prev);
    return s;
  }

  function cleanLines(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => cleanWordLine(line).replace(/^說明\s*[:：]\s*/, '').trim())
      .filter((s) => s.length > 0);
  }

  // ---------- 單行寫入 ----------
  async function insertLine(cp, ta, text) {
    const el = selEl(cp);
    if (!el || !isExplainId(el.getAttribute('id'))) {
      return { ok: false, reason: '游標不在「說明」段落上，已停止寫入。' };
    }
    if (!isBlank(el.textContent)) {
      return { ok: false, reason: '「說明」段落已有內容，請先清空說明欄位後再寫入。' };
    }
    ta.value = '';
    cp.editActions().input(text, ta);

    const ok = await waitFor(() => {
      const cur = selEl(cp);
      return cur && cur.textContent === text;
    }, 1000);
    if (!ok) {
      const cur = selEl(cp);
      return {
        ok: false,
        reason: `寫入「${text}」後段落內容不符，目前為：${JSON.stringify(cur ? cur.textContent : null)}`
      };
    }
    return { ok: true, reason: '' };
  }

  // ---------- 換段 ----------
  async function breakLine(cp) {
    const el = selEl(cp);
    if (!el) return { ok: false, reason: '換段前找不到游標段落。' };
    const len = el.textContent.length;
    const before = blockIds();

    try {
      cp.editActions().turnLine(len);
    } catch (e) {
      return { ok: false, reason: '換段時編輯器發生錯誤：' + (e && e.message ? e.message : e) };
    }

    const newId = await waitFor(() => {
      const added = blockIds().filter((x) => !before.includes(x));
      return added.length === 1 ? added[0] : null;
    }, 1000);
    if (!newId) return { ok: false, reason: '換段後未出現唯一的新段落。' };

    const moved = await waitFor(() => selId(cp) === newId + '_context', 1000);
    if (!moved) return { ok: false, reason: '換段後游標未移到新段落。' };

    return { ok: true, reason: '' };
  }

  // ---------- 逐行寫入 ----------
    // ---------- Word 階層判斷（保留層級；寫入時使用） ----------
  // level 0：一般段、「一、」主段 → 不縮排
  // level 1：「(一)」「（一）」等次段 → 縮排 1 層
  // level 2：「(1)」「（1）」「(a)」等再次段 → 縮排 2 層
  function parseWordLevel(raw) {
    const s0 = String(raw || '').replace(/\u00a0/g, ' ').replace(/\t+/g, ' ');
    const lead = (s0.match(/^ */) || [''])[0].length;
    const s = s0.trim();
    if (/^[(（][一二三四五六七八九十百千]+[)）]/.test(s)) return 1;
    if (/^[(（]\d+[)）]/.test(s)) return 2;
    if (/^[(（][a-zA-Z][)）]/.test(s)) return 2;
    if (lead >= 4) return 1;
    return 0;
  }

  

  function cleanLinesWithLevel(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((line) => ({
      text: cleanWordLine(line).replace(/^說明\s*[:：]\s*/, '').trim(),
      level: 0
    })).filter((x) => x.text.length > 0);
  }

  // 讓目前段落縮排到指定層級（以編輯器的 indent() 逐層調整）
  function applyLevel(cp, level) {
    for (let i = 0; i < level; i++) cp.editActions().indent();
  }

  async function writeLines(lines, cp, ta) {
    for (let i = 0; i < lines.length; i++) {
      const item = typeof lines[i] === 'string' ? { text: lines[i], level: 0 } : lines[i];
      const w = await insertLine(cp, ta, item.text);
      if (!w.ok) return { ok: false, done: i, reason: w.reason };
      if (item.level) {
        try { applyLevel(cp, item.level); await sleep(40); }
        catch (e) { return { ok: false, done: i + 1, reason: '縮排失敗：' + (e && e.message ? e.message : e) }; }
      }
      if (i < lines.length - 1) {
        const b = await breakLine(cp);
        if (!b.ok) return { ok: false, done: i + 1, reason: b.reason };
      }
    }
    return { ok: true, done: lines.length, reason: '' };
  }

  // 游標已在空白的說明段落時直接寫入；否則先自動移到說明段落
  async function runWrite(lines) {
    if (busy) return { ok: false, done: 0, reason: '上一次寫入尚未完成，請稍候。' };
    busy = true;
    try {
      const ta = document.getElementById('text');
      const cp = getCpaper();
      if (!ta || !cp) return { ok: false, done: 0, reason: '找不到公文編輯器，請確認在編輯畫面。' };

      const cur = selEl(cp);
      const curId = (cur && cur.getAttribute('id')) || '';
      if (!cur || !isExplainId(curId)) {
        return { ok: false, done: 0, reason: '請先點一下「說明：」後方產生游標，再執行本功能。' };
      }
      if (!isBlank(cur.textContent)) {
        return { ok: false, done: 0, reason: '「說明」欄位已有內容，請先清空後再寫入。' };
      }
      return await writeLines(lines, cp, ta);
    } catch (err) {
      console.error(TAG, '寫入失敗', err);
      return { ok: false, done: 0, reason: '編輯器寫入失敗：' + (err && err.message ? err.message : err) };
    } finally {
      busy = false;
    }
  }

  // ---------- 與 content.js 的訊息介面 ----------
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin || !d || d.source !== SRC_CONTENT || d.type !== 'EXPLAIN_WRITE') return;
    const reply = (p) => window.postMessage(
      Object.assign({ source: SRC_PASTE, type: 'EXPLAIN_WRITE_RESULT', total: 0, remaining: [] }, p),
      location.origin
    );

    const lines = cleanLinesWithLevel((Array.isArray(d.lines) ? d.lines : []).join('\n'));
    if (!lines.length) {
      return reply({ ok: false, done: 0, reason: '清除項目符號與編號後，沒有可寫入的內容。' });
    }

    const r = await runWrite(lines);
    console.log(TAG, '寫入結果', r, '說明共', lines.length, '段');
    reply({
      ok: r.ok,
      done: r.done,
      total: lines.length,
      remaining: lines.slice(r.done),
      reason: r.reason
    });
  });

  // ---------- Ctrl+V 貼上（游標已在說明段落、多行時） ----------
  document.addEventListener('paste', async (e) => {
    try {
      if (isDisabled()) return;
      const ta = document.getElementById('text');
      if (!ta || e.target !== ta) return;
      const cp = getCpaper();
      if (!cp || !isExplainId(selId(cp))) return;

      const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      const lines = cleanLinesWithLevel(raw);
      if (lines.length <= 1) return; // 單行交給編輯器原生貼上

      e.preventDefault();
      e.stopImmediatePropagation();
      const r = await runWrite(lines);
      if (!r.ok) {
        alert('寫入已停止：' + r.reason + '\n剩餘內容請手動處理：\n' + lines.slice(r.done).join('\n'));
      }
    } catch (err) {
      console.error(TAG, '貼上失敗', err);
      alert('貼上發生錯誤，請改用手動貼上。' + (err && err.message ? err.message : err));
    }
  }, true);

  // ---------- 右鍵「貼上段落」（獨立小選單，不改動 jQuery contextMenu） ----------
  // 不再把項目插入 jQuery contextMenu 的 <ul>（會造成 jquery.contextMenu 讀取未註冊項目而報錯）
  const PAGE_APP = new URLSearchParams(location.search).get('app');
  let pasteMenu = null;

  function hidePasteMenu() { if (pasteMenu) pasteMenu.style.display = 'none'; }

  function ensurePasteMenu() {
    if (pasteMenu) return pasteMenu;
    pasteMenu = document.createElement('div');
    pasteMenu.id = 'edocPasteMenu';
    pasteMenu.style.cssText = 'position:fixed;z-index:2147483647;display:none;background:#fff;border:1px solid #bbb;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);padding:4px 0;min-width:120px;font:14px "Microsoft JhengHei",sans-serif;';
    const btn = document.createElement('div');
    btn.textContent = '貼上段落';
    btn.style.cssText = 'padding:6px 16px;cursor:pointer;color:#222;';
    btn.addEventListener('mouseenter', () => { btn.style.background = '#e8f0fe'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePasteMenu();
      pasteParagraphsFromClipboard();
    });
    pasteMenu.appendChild(btn);
    document.body.appendChild(pasteMenu);
    return pasteMenu;
  }

  async function pasteParagraphsFromClipboard() {
    const cp = getCpaper();
    if (!cp || !isExplainId(selId(cp))) {
      alert('請先點一下「說明：」後方產生游標，再執行本功能。');
      return;
    }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      alert('無法讀取剪貼簿，請允許瀏覽器的剪貼簿權限後再試。\n' + (e && e.message ? e.message : e));
      return;
    }
    const lines = cleanLinesWithLevel(text);
    if (!lines.length) { alert('剪貼簿沒有可貼上的文字。'); return; }
    const r = await runWrite(lines);
    if (!r.ok) {
      alert('貼上已停止：' + r.reason + '\n剩餘內容請手動處理：\n' + lines.slice(r.done).join('\n'));
    }
  }

  // 只在「游標已在說明段落、且右鍵落在紙面上」時接管右鍵；其他情況保留原本選單
  document.addEventListener('contextmenu', (e) => {
    if (PAGE_APP === 'check') return;
    const cp = getCpaper();
    if (!cp || !isExplainId(selId(cp))) return;
    const t = e.target;
    const onPaper = t && t.closest && t.closest('svg, #svgroot');
    if (!onPaper) return;
    const m = ensurePasteMenu();
    m.style.left = e.clientX + 'px';
    m.style.top = 'auto';m.style.bottom = (window.innerHeight - e.clientY) + 'px';
    m.style.display = 'block';
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (pasteMenu && !pasteMenu.contains(e.target)) hidePasteMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePasteMenu(); }, true);

  console.log(TAG, '已安裝 v' + window.__edocPasteSplit.version);

})();