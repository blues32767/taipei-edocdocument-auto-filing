/* options.js 2026.11.06.1300：選項頁。AI 連線合併為三種模式：cURL 指令（預設）／常用服務（進階）／網路 API。
 * 貼上 cURL 後，網址、埠號與模型 ID 會自動帶入；清空 cURL 後回到手動欄位。 */
(() => {
  'use strict';
  EdocLog.configure({ context: 'OPTIONS', level: 'DEBUG' });
  const log = EdocLog.create('OPTIONS');
  const $ = (id) => document.getElementById(id);
  const THEME_KEY = 'uiTheme';
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  // 常用服務（進階）：僅本地服務；Ollama 與 LM Studio 皆需手動填 PORT 與模型 ID
  const SERVICES = [
    { id: 'lmstudio', label: 'LM Studio（預設 PORT 1234）', port: 1234 },
    { id: 'ollama', label: 'Ollama（預設 PORT 11434）', port: 11434 }
  ];

  // mode：curl ｜ service ｜ cloud
  const state = { mode: 'curl', defaults: {} };

  /* ---------- 小工具 ---------- */
  const toastEl = $('toast');
  let toastTimer = null;
  function show(msg, kind = 'info') {
    toastEl.textContent = msg;
    toastEl.dataset.kind = kind;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), kind === 'err' ? 6500 : 3200);
  }
  function clampInt(v, min, max, fb) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fb;
    return Math.min(max, Math.max(min, n));
  }
  const isLoopback = (u) => ['127.0.0.1', 'localhost'].includes(u.hostname);
  function parseCurlSafe(raw) {
    if (!String(raw || '').trim()) return null;
    try { return EdocCurl.parseCurl(raw); } catch (err) { return { error: err.message }; }
  }
  function markDirty(sectionId) {
    const sec = $(sectionId);
    if (sec) sec.dataset.dirty = 'true';
  }
  function clearDirty() {
    document.querySelectorAll('.sec').forEach((s) => { s.dataset.dirty = 'false'; });
  }

  /* ---------- cURL 解析結果：自動帶入 PORT 與模型 ID ---------- */
  // 回傳解析後的 cURL（無效或空白則為 null）
  function activeCurl() {
    const c = parseCurlSafe($('localCurl').value);
    return c && !c.error ? c : null;
  }

  function renderCurlStatus() {
    const info = $('curlInfo');
    const raw = $('localCurl').value;
    const c = parseCurlSafe(raw);
    if (!c) {
      info.textContent = '尚未貼上 cURL。貼上後，網址、埠號與模型 ID 會自動帶入。';
      info.style.color = '';
      return null;
    }
    if (c.error) {
      info.textContent = `cURL 格式有誤：${c.error}`;
      info.style.color = 'var(--err)';
      return null;
    }
    const api = c.mode === 'native' ? 'LM Studio 原生 API' : 'OpenAI 相容 API';
    info.textContent = `已解析成功：${c.url}\n${api}｜埠號 ${new URL(c.url).port || '（預設）'}｜模型 ${c.model}`;
    info.style.color = 'var(--ok)';
    return c;
  }

  // 模式 A 有解析成功的 cURL 時，把埠號與模型 ID 顯示在「常用服務」欄位（唯讀，與 cURL 同步）
  function syncFromCurl() {
    const c = activeCurl();
    if (!c) return;
    const u = new URL(c.url);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    $('localPort').value = port;
    $('model').value = c.model;
    $('localPort').readOnly = true;
    $('model').readOnly = true;
    $('localPort').setAttribute('aria-describedby', 'curlSyncNote');
    $('curlSyncNote').hidden = false;
  }

  function unlockServiceFields() {
    $('localPort').readOnly = false;
    $('model').readOnly = false;
    $('curlSyncNote').hidden = true;
  }

  function endpointPreview() {
    if (state.mode === 'cloud') {
      return $('cloudPreset').value === 'custom'
        ? ($('customUrl').value.trim() || '（請填寫自訂網址）')
        : GEMINI_URL;
    }
    if (state.mode === 'curl') {
      const c = activeCurl();
      return c ? c.url : '（請貼上 cURL 指令）';
    }
    const port = clampInt($('localPort').value, 1, 65535, 1234);
    return `http://127.0.0.1:${port}/v1/chat/completions`;
  }

  /* ---------- 畫面渲染 ---------- */
  function renderMode() {
    const m = state.mode;
    $('modeCurl').setAttribute('aria-pressed', String(m === 'curl'));
    $('modeService').setAttribute('aria-pressed', String(m === 'service'));
    $('modeCloud').setAttribute('aria-pressed', String(m === 'cloud'));
    $('panelCurl').hidden = m !== 'curl';
    $('panelService').hidden = m !== 'service';
    $('panelCloud').hidden = m !== 'cloud';
    $('rowCustom').hidden = !(m === 'cloud' && $('cloudPreset').value === 'custom');
    $('lblKey').textContent = m === 'cloud'
      ? 'API 金鑰（網路 API 必填；留空表示不變更）'
      : 'API 金鑰（本地通常可留空）';

    // 常用服務下拉選單
    const sel = $('preset');
    if (!sel.options.length) {
      for (const sv of SERVICES) {
        const o = document.createElement('option');
        o.value = sv.id;
        o.textContent = sv.label;
        sel.appendChild(o);
      }
    }
    if (m === 'curl') {
      renderCurlStatus();
      if (activeCurl()) syncFromCurl(); else unlockServiceFields();
    } else {
      unlockServiceFields();
    }
    $('preview').textContent = `實際端點：${endpointPreview()}`;
  }

  function setMode(m) {
    state.mode = m;
    if (m === 'service') {
      const sv = SERVICES.find((x) => x.id === $('preset').value) || SERVICES[0];
      if (!$('localPort').value) $('localPort').value = sv.port;
    }
    if (m === 'cloud' && !$('model2').value) $('model2').value = 'gemini-flash-latest';
    markDirty('secConn');
    renderMode();
  }

  // 「常用服務」切換時，依服務帶入預設埠號
  function onPresetChange() {
    const sv = SERVICES.find((x) => x.id === $('preset').value) || SERVICES[0];
    $('localPort').value = sv.port;
    markDirty('secConn');
    renderMode();
  }

  /* ---------- 配色（黑 / 白） ---------- */
  function applyTheme(t) {
    const dark = t === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeLabel').textContent = dark ? '白色配色' : '黑色配色';
    $('btnTheme').setAttribute('aria-pressed', String(dark));
  }
  async function loadTheme() {
    const { [THEME_KEY]: t } = await chrome.storage.local.get({ [THEME_KEY]: 'light' });
    applyTheme(t);
  }
  async function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await chrome.storage.local.set({ [THEME_KEY]: next });
    log.info('配色已切換', { theme: next });
  }

  /* ---------- 載入 / 收集 ---------- */
  async function load() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!res || !res.ok) throw new Error((res && res.error) || '無法讀取設定');
    const s = res.settings;
    state.defaults = s;

    // 決定預設模式：有 cURL 或 provider=local → cURL；網路 API → cloud；本地但無 cURL → service
    if (s.provider === 'cloud') state.mode = 'cloud';
    else if (s.localCurl) state.mode = 'curl';
    else state.mode = 'curl';

    $('preset').value = s.presetId === 'ollama' ? 'ollama' : 'lmstudio';
    $('localPort').value = s.localPort || 1234;
    $('model').value = s.model || '';
    $('localCurl').value = s.localCurl || '';
    $('cloudPreset').value = s.presetId === 'custom' ? 'custom' : 'gemini';
    $('customUrl').value = s.customUrl || '';
    $('model2').value = s.provider === 'cloud' ? (s.model || 'gemini-flash-latest') : 'gemini-flash-latest';
    $('apiKey').value = '';
    $('apiKey').placeholder = s.hasApiKey ? '已儲存金鑰（留空不變更）' : '尚未填寫';
    $('prompt').value = s.promptTemplate || s.defaultPrompt || '';
    $('summaryPrompt').value = s.summaryPromptTemplate || s.defaultSummaryPrompt || '';
    $('draftChars').value = s.draftMaxChars || 100;
    $('maxChars').value = s.maxChars || 12000;
    $('timeoutSec').value = s.timeoutSec || 60;
    $('redact').checked = !!s.redact;
    $('debugLevel').value = s.debugLevel || 'DEBUG';
    renderMode();
    clearDirty();
    log.debug('選項頁載入設定', { mode: state.mode, presetId: s.presetId, hasApiKey: !!s.hasApiKey });
  }

  // 依目前模式收集要儲存的欄位；未使用的模式不覆寫對方設定
  function collect() {
    const key = $('apiKey').value.trim();
    const m = state.mode;
    const payload = {
      provider: m === 'cloud' ? 'cloud' : 'local',
      presetId: m === 'cloud' ? $('cloudPreset').value : $('preset').value,
      localPort: $('localPort').value,
      customUrl: $('customUrl').value.trim(),
      model: m === 'cloud' ? $('model2').value.trim() : $('model').value.trim(),
      apiKey: key || null,
      promptTemplate: $('prompt').value,
      summaryPromptTemplate: $('summaryPrompt').value,
      draftMaxChars: $('draftChars').value,
      maxChars: $('maxChars').value,
      timeoutSec: $('timeoutSec').value,
      redact: $('redact').checked,
      debugLevel: $('debugLevel').value
    };
    // cURL 模式：送出 cURL（空白則清除，回到手動欄位）；其他模式不送，保留已存 cURL
    if (m === 'curl') payload.localCurl = $('localCurl').value;
    return payload;
  }

  /* ---------- 權限與儲存 ---------- */
  function grantPattern() {
    if (state.mode === 'cloud') {
      if ($('cloudPreset').value !== 'custom') return null;
      try { return `${new URL($('customUrl').value.trim()).origin}/*`; } catch (_) { return null; }
    }
    if (state.mode !== 'curl') return null;
    const raw = $('localCurl').value.trim();
    if (!raw) return null;
    try {
      const u = new URL(EdocCurl.parseCurl(raw).url);
      return isLoopback(u) ? null : `${u.origin}/*`;
    } catch (_) {
      return null;
    }
  }

  // chrome.permissions.request 必須在使用者點擊的同步流程中呼叫，因此這裡不可先 await
  function requestGrant() {
    const pattern = grantPattern();
    if (!pattern) return Promise.resolve(true);
    return chrome.permissions.request({ origins: [pattern] }).then((ok) => {
      if (!ok) throw new Error(`未允許 ${pattern} 的存取權限，設定未儲存`);
      return true;
    });
  }

  async function saveSettingsFromUI(btn) {
    const pending = requestGrant();
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    try {
      await pending;
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: collect() });
      if (!res || !res.ok) throw new Error((res && res.error) || '儲存失敗');
      await load();
      log.info('設定已儲存（選項頁）', { mode: state.mode });
      show('設定已儲存。重新整理公文頁後，面板與設定才會生效。', 'ok');
      return true;
    } catch (err) {
      log.error('儲存失敗', { message: err.message });
      show(`儲存失敗：${err.message}`, 'err');
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  /* ---------- 事件 ---------- */
  $('modeCurl').addEventListener('click', () => setMode('curl'));
  $('modeService').addEventListener('click', () => setMode('service'));
  $('modeCloud').addEventListener('click', () => setMode('cloud'));
  $('preset').addEventListener('change', onPresetChange);
  $('cloudPreset').addEventListener('change', () => { markDirty('secConn'); renderMode(); });
  $('localPort').addEventListener('input', () => { markDirty('secConn'); renderMode(); });
  $('model').addEventListener('input', () => { markDirty('secConn'); renderMode(); });
  $('customUrl').addEventListener('input', () => { markDirty('secConn'); renderMode(); });
  $('localCurl').addEventListener('input', () => { markDirty('secConn'); renderMode(); });
  $('btnCurlClear').addEventListener('click', () => {
    $('localCurl').value = '';
    markDirty('secConn');
    renderMode();
    show('已清空 cURL（尚未儲存）。儲存後埠號與模型 ID 改為手動填寫。', 'info');
  });
  $('btnResetPrompt').addEventListener('click', () => {
    $('prompt').value = state.defaults.defaultPrompt || '';
    markDirty('secPrompt');
    show('已還原擬辦提示詞（尚未儲存）。', 'info');
  });
  $('btnResetSummary').addEventListener('click', () => {
    $('summaryPrompt').value = state.defaults.defaultSummaryPrompt || '';
    markDirty('secPrompt');
    show('已還原重點提示詞（尚未儲存）。', 'info');
  });

  // 變更追蹤：使用者輸入即標示所在區塊為「未儲存」
  const SECTION_OF = {
    prompt: 'secPrompt', summaryPrompt: 'secPrompt', draftChars: 'secParam', maxChars: 'secParam',
    timeoutSec: 'secParam', redact: 'secParam', debugLevel: 'secDebug',
    model: 'secConn', model2: 'secConn', apiKey: 'secConn', localPort: 'secConn', customUrl: 'secConn',
    preset: 'secConn', cloudPreset: 'secConn', localCurl: 'secConn'
  };
  document.addEventListener('input', (e) => { if (SECTION_OF[e.target.id]) markDirty(SECTION_OF[e.target.id]); });
  document.addEventListener('change', (e) => { if (SECTION_OF[e.target.id]) markDirty(SECTION_OF[e.target.id]); });

  // 每個區塊右下角的「儲存設定」
  document.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveSettingsFromUI(btn));
  });

  $('btnTest').addEventListener('click', async () => {
    const ok = await saveSettingsFromUI(null);
    if (!ok) return;
    show('測試中…', 'info');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AI_TEST' });
      show(res && res.ok ? `連線成功，回覆：${res.draft}` : `連線失敗：${res && res.error}`, res && res.ok ? 'ok' : 'err');
    } catch (err) {
      show(`測試失敗：${err.message}`, 'err');
    }
  });

  $('btnExport').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'EXPORT_LOG' });
    const payload = { exportedAt: new Date().toISOString(), count: res.logs.length, logs: res.logs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `edoc-helper-debug-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    show(`已匯出 ${res.logs.length} 筆紀錄。`, 'ok');
  });
  $('btnClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
    show('除錯紀錄已清除。', 'ok');
  });
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnHelp').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
    log.info('開啟說明與疑難排解頁');
  });

  // 目錄自動標示目前區塊（Scroll-spy）
  const tocLinks = [...document.querySelectorAll('.toc a')];
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      tocLinks.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === `#${e.target.id}`)));
    }
  }, { rootMargin: '-35% 0px -55% 0px' });
  document.querySelectorAll('.sec').forEach((s) => spy.observe(s));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) applyTheme(changes[THEME_KEY].newValue);
  });

  Promise.all([loadTheme(), load()]).catch((err) => {
    log.error('載入選項失敗', { message: err.message });
    show(`載入失敗：${err.message}`, 'err');
  });
})();
