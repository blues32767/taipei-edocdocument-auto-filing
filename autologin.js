/**
 * 臺北市公文系統｜登入頁自動登入 (v2.2.0)
 * 僅於登入頁(同時存在 #pinCode 與 #pinLogin)啟動。
 *
 * 流程(開關開啟後，進入登入頁即自動執行，使用者不需點選任何欄位):
 *  1. 等待設定的秒數(預設 1 秒，讓頁面腳本初始化完成)。
 *  2. 模擬滑鼠點選 PinCode 欄位(focus + mousedown/mouseup/click 事件)。
 *  3. 填入已設定的 PinCode，並派發 input/change 事件讓頁面識別。
 *  4. 模擬點選[登入]按鈕送出。
 *
 * 安全機制:
 *  - 若使用者在等待期間以鍵盤輸入或刪除，立即取消自動登入。
 *  - 同一分頁 20 秒內只自動送出一次，避免 PinCode 錯誤時反覆嘗試
 *    (卡片多次錯誤可能被鎖定)。
 *  - 未設定 PinCode 時不會送出，僅顯示提示。
 */
(() => {
  'use strict';

  const pinInput = document.getElementById('pinCode');
  const pinButton = document.getElementById('pinLogin');
  if (!pinInput || !pinButton || window.__tcqbAutoLoginReady) return;
  window.__tcqbAutoLoginReady = true;

  const KEYS = { enabled: 'autoLoginEnabled', pin: 'autoLoginPin', delay: 'autoLoginDelay' , closeCheck: 'autoCloseCheckEnabled' };
  const DELAY_MIN = 0;
  const DELAY_MAX = 5;
  const DELAY_DEFAULT = 1;
  const GUARD_KEY = 'tcqbAutoLoginLastAttempt';
  const GUARD_MS = 20000;
  const CLICK_TO_SUBMIT_MS = 300;
  const MANUAL_KEYS = new Set(['Backspace', 'Delete']);

  const state = { enabled: false, pin: '', delay: DELAY_DEFAULT , closeCheck: true };
  let timers = [];
  let started = false;     // 本頁是否已執行過自動流程
  let cancelled = false;   // 使用者手動輸入而取消

  const clamp = (v) => Math.min(DELAY_MAX, Math.max(DELAY_MIN, Math.round(Number(v)))) || 0;

  /* ---------- 頁面端樣式：避免瀏覽器自動填入影響判斷 ---------- */
  /* ---------- Shadow DOM 浮動面板 ---------- */
  const host = document.createElement('div');
  host.id = 'tcqb-autologin-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      .card {
        position: fixed; right: 24px; bottom: 24px; width: 320px; z-index: 2147483000;
        font-family: 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans TC', Arial, sans-serif;
        color: #364250; background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%);
        border: 1px solid rgba(54, 66, 80, 0.12); border-radius: 18px; overflow: hidden;
        box-shadow: 0 24px 48px -16px rgba(54, 66, 80, 0.32), 0 2px 6px rgba(54, 66, 80, 0.06);
        animation: rise 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
        transition: border-color 0.3s, box-shadow 0.3s;
      }
      .card:hover { box-shadow: 0 30px 56px -18px rgba(54, 66, 80, 0.36), 0 2px 6px rgba(54, 66, 80, 0.06); }
      .card.on { border-color: rgba(101, 222, 199, 0.6); }
      @keyframes rise { from { opacity: 0; transform: translateY(16px) scale(0.98); } to { opacity: 1; transform: none; } }
      .accent { height: 4px; background: linear-gradient(90deg, #4a76a8, #65dec7); opacity: 0.3; transition: opacity 0.3s; }
      .card.on .accent { opacity: 1; }
      .head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px; }
      .badge {
        width: 40px; height: 40px; flex: none; border-radius: 12px; display: grid; place-items: center;
        background: linear-gradient(135deg, #364250, #4a76a8); color: #fff;
        box-shadow: 0 6px 14px -6px rgba(74, 118, 168, 0.7);
      }
      .badge svg { width: 20px; height: 20px; }
      .titles { flex: 1; min-width: 0; }
      .title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
      .status { font-size: 12px; color: #6b7785; margin-top: 3px; line-height: 1.45; }
      .card.on .status { color: #1a6e4d; }
      .switch {
        position: relative; flex: none; width: 46px; height: 26px; padding: 0; border: 0; border-radius: 999px;
        background: #cfd6dd; cursor: pointer; transition: background 0.25s;
      }
      .switch::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
        background: #fff; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2); transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .switch[aria-checked="true"] { background: linear-gradient(90deg, #4a76a8, #38b28f); }
      .switch[aria-checked="true"]::after { transform: translateX(20px); }
      button:focus-visible, input:focus-visible { outline: 2px solid #65dec7; outline-offset: 2px; }
      .bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 16px 14px; }
      .hint { font-size: 11px; color: #8a95a1; }
      .gear {
        border: 1px solid #d5dbe1; background: #f5f7f9; color: #495057; border-radius: 10px;
        padding: 6px 10px; font-size: 12px; cursor: pointer; transition: background 0.2s;
      }
      .gear:hover { background: #e9edf1; }
      .gear[aria-expanded="true"] { background: #e2e8ee; }
      .panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); }
      .panel.open { grid-template-rows: 1fr; }
      .panel > div { overflow: hidden; min-height: 0; }
      .inner { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; border-top: 1px solid #edf0f3; }
      .lbl { font-size: 12px; font-weight: 600; color: #555; display: flex; justify-content: space-between; align-items: baseline; }
      .field { position: relative; }
      .field input {
        width: 100%; padding: 9px 56px 9px 12px; border: 1px solid #cdd4db; border-radius: 10px;
        font-size: 14px; color: #364250; background: #fff; letter-spacing: 0.15em;
      }
      .field input::placeholder { letter-spacing: normal; color: #9aa5b1; font-size: 13px; }
      .field input:focus { border-color: #4a76a8; box-shadow: 0 0 0 3px rgba(74, 118, 168, 0.18); outline: none; }
      .eye {
        position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: 0; background: transparent;
        color: #4a76a8; cursor: pointer; padding: 4px 6px; font-size: 12px; font-weight: 600;
      }
      input[type="range"] { width: 100%; accent-color: #4a76a8; }
      .note {
        font-size: 11px; line-height: 1.6; color: #7a6a2c; background: #fff8e6;
        border: 1px solid #f3e2b0; border-radius: 10px; padding: 8px 10px;
      }
      .row { display: flex; gap: 8px; }
      .btn { flex: 1; border: 0; border-radius: 10px; padding: 9px 10px; font-size: 13px; font-weight: 700; cursor: pointer; transition: transform 0.15s, filter 0.2s, background 0.2s; }
      .btn:active { transform: scale(0.98); }
      .btn-primary { background: linear-gradient(135deg, #4a76a8, #364250); color: #fff; }
      .btn-primary:hover { filter: brightness(1.1); }
      .btn-ghost { background: #eef1f4; color: #495057; }
      .btn-ghost:hover { background: #e2e7ec; }
      .toast { font-size: 12px; min-height: 16px; color: #1a6e4d; }
      .toast.err { color: #c0392b; }
 .closechk { display:flex;align-items:center;gap:8px;padding:0 16px 12px;font-size:12px;color:#364250;cursor:pointer;}
 .closechk input { accent-color:#4a76a8;width:15px;height:15px;margin:0;}
      @media (prefers-reduced-motion: reduce) { .card, .panel, .switch, .switch::after { animation: none !important; transition: none !important; } }
    </style>
    <section class="card" id="card" role="region" aria-label="登入頁自動登入設定">
      <div class="accent"></div>
      <div class="head">
        <div class="badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
          </svg>
        </div>
        <div class="titles">
          <div class="title">自動登入</div>
          <div class="status" id="status" aria-live="polite">載入中…</div>
        </div>
        <button class="switch" id="switch" role="switch" aria-checked="false" aria-label="啟用自動登入"></button>
      </div>
      <div class="bar">
        <span class="hint">開啟後進入登入頁即自動登入</span>
        <button class="gear" id="gear" aria-expanded="false" aria-controls="panel">⚙ 細部設定</button>
      </div>
      <label class="closechk" for="closeCheck"><input type="checkbox" id="closeCheck" /> 自動關閉「公文管理環境檢測」（自動登入開啟時）</label>
 <div class="panel" id="panel">
        <div>
          <div class="inner">
            <label class="lbl" for="cfgPin"><span>卡片 PinCode</span><span class="hint">僅存於本機瀏覽器</span></label>
            <div class="field">
              <input id="cfgPin" type="password" autocomplete="off" maxlength="16" placeholder="請輸入卡片 PinCode" />
              <button class="eye" id="eye" type="button" aria-label="顯示或隱藏 PinCode">顯示</button>
            </div>
            <label class="lbl" for="cfgDelay"><span>登入前等待</span><span><b id="delayOut">1</b> 秒</span></label>
            <input id="cfgDelay" type="range" min="${DELAY_MIN}" max="${DELAY_MAX}" step="1" value="${DELAY_DEFAULT}" />
            <div class="note">⚠ PinCode 會以明碼保存在此瀏覽器的擴充功能儲存區，請勿於共用電腦開啟。PIN 錯誤時請勿連續重試，以免卡片被鎖定。</div>
            <div class="row">
              <button class="btn btn-ghost" id="clear" type="button">清除 PinCode</button>
              <button class="btn btn-primary" id="save" type="button">儲存設定</button>
            </div>
            <div class="toast" id="toast" role="status"></div>
          </div>
        </div>
      </div>
    </section>
  `;

  const $ = (id) => root.getElementById(id);
  const ui = {
 closeCheck:$('closeCheck'),
    card: $('card'), status: $('status'), sw: $('switch'), gear: $('gear'), panel: $('panel'),
    cfgPin: $('cfgPin'), cfgDelay: $('cfgDelay'), delayOut: $('delayOut'), eye: $('eye'),
    save: $('save'), clear: $('clear'), toast: $('toast')
  };

  let statusMsg = '';
  function renderStatus() {
    ui.card.classList.toggle('on', state.enabled);
    ui.sw.setAttribute('aria-checked', String(state.enabled));
    if (statusMsg) { ui.status.textContent = statusMsg; return; }
    if (!state.enabled) ui.status.textContent = '未啟用 · 維持手動登入';
    else if (!state.pin) ui.status.textContent = '已啟用 · 尚未設定 PinCode，請於「細部設定」輸入';
    else ui.status.textContent = `已啟用 · 進入登入頁將於 ${state.delay} 秒後自動登入`;
  }
  function setStatus(msg) { statusMsg = msg; renderStatus(); }

  let toastTimer = null;
  function showToast(msg, isErr = false) {
    ui.toast.textContent = msg;
    ui.toast.classList.toggle('err', isErr);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.textContent = ''; }, 2400);
  }

  function applySettings(raw) {
 state.closeCheck = raw[KEYS.closeCheck] !== false;
 if (ui.closeCheck) ui.closeCheck.checked = state.closeCheck;
    state.enabled = raw[KEYS.enabled] === true;
    state.pin = typeof raw[KEYS.pin] === 'string' ? raw[KEYS.pin] : '';
    state.delay = clamp(raw[KEYS.delay] ?? DELAY_DEFAULT);
    ui.cfgDelay.value = String(state.delay);
    ui.delayOut.textContent = String(state.delay);
    ui.cfgPin.placeholder = state.pin ? '已儲存（輸入新值可覆寫）' : '請輸入卡片 PinCode';
    renderStatus();
  }

  /* ---------- 計時器與取消 ---------- */
  function schedule(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
  function cancelAll() { timers.forEach(clearTimeout); timers = []; }

  /* ---------- 模擬使用者操作 ---------- */
  function fireMouse(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function setPinValue(value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(pinInput, value);
    pinInput.dispatchEvent(new Event('input', { bubbles: true }));
    pinInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 同一分頁短時間內只自動送出一次，避免 PIN 錯誤時連續重試
  function recentlyAttempted() {
    try {
      const last = Number(sessionStorage.getItem(GUARD_KEY) || 0);
      return Date.now() - last < GUARD_MS;
    } catch (e) { return false; }
  }
  function markAttempt() {
    try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch (e) { /* ignore */ }
  }

  function runAutoLogin(force = false) {
    if (!state.enabled || cancelled) return;
    if (!force && started) return;
    started = true;
    cancelAll();

    if (!state.pin) { setStatus('已啟用，但尚未設定 PinCode，無法自動登入'); return; }
    if (!force && recentlyAttempted()) { setStatus('為避免 PIN 錯誤次數過多，本次不重複自動登入'); return; }

    setStatus(`自動登入中…（${state.delay} 秒後執行）`);
    schedule(() => {
      if (cancelled || !state.enabled) return;
      // 1) 模擬點選 PinCode 欄位
      pinInput.focus();
      fireMouse(pinInput);
      // 2) 填入 PinCode
      setPinValue(state.pin);
      // 3) 模擬點選[登入]
      markAttempt();
      schedule(() => {
        if (cancelled || !state.enabled) return;
        fireMouse(pinButton);
        pinButton.click();
        setStatus('已送出登入');
      }, CLICK_TO_SUBMIT_MS);
    }, state.delay * 1000);
  }

  /* ---------- 面板事件 ---------- */
  ui.sw.addEventListener('click', () => {
    const next = !state.enabled;
    state.enabled = next;
    cancelled = false;
    started = false;
    cancelAll();
    statusMsg = '';
    chrome.storage.local.set({ [KEYS.enabled]: next }, () => {
      renderStatus();
      if (next) runAutoLogin(true);
    });
  });

ui.closeCheck.addEventListener('change',() => { state.closeCheck = ui.closeCheck.checked;chrome.storage.local.set({ [KEYS.closeCheck]:state.closeCheck });});
  ui.gear.addEventListener('click', () => {
    const open = ui.panel.classList.toggle('open');
    ui.gear.setAttribute('aria-expanded', String(open));
  });

  ui.eye.addEventListener('click', () => {
    const showing = ui.cfgPin.type === 'text';
    ui.cfgPin.type = showing ? 'password' : 'text';
    ui.eye.textContent = showing ? '顯示' : '隱藏';
  });

  ui.cfgDelay.addEventListener('input', () => { ui.delayOut.textContent = ui.cfgDelay.value; });

  ui.save.addEventListener('click', () => {
    const typed = ui.cfgPin.value.trim();
    if (typed && typed.length < 4) { showToast('PinCode 長度至少 4 碼', true); return; }
    const delay = clamp(ui.cfgDelay.value);
    const payload = { [KEYS.delay]: delay };
    if (typed) payload[KEYS.pin] = typed;
    chrome.storage.local.set(payload, () => {
      if (typed) state.pin = typed;
      state.delay = delay;
      ui.cfgPin.value = '';
      ui.cfgPin.type = 'password';
      ui.eye.textContent = '顯示';
      ui.cfgPin.placeholder = state.pin ? '已儲存（輸入新值可覆寫）' : '請輸入卡片 PinCode';
      statusMsg = '';
      renderStatus();
      showToast('設定已儲存，請重新整理頁面才會生效');
    });
  });

  ui.clear.addEventListener('click', () => {
    chrome.storage.local.remove(KEYS.pin, () => {
      state.pin = '';
      ui.cfgPin.value = '';
      ui.cfgPin.placeholder = '請輸入卡片 PinCode';
      statusMsg = '';
      renderStatus();
      showToast('已清除 PinCode');
    });
  });

  /* ---------- 使用者手動輸入即取消 ---------- */
  pinInput.addEventListener('keydown', (e) => {
    if (e.key.length !== 1 && !MANUAL_KEYS.has(e.key)) return;
    if (!timers.length) return;
    cancelled = true;
    cancelAll();
    setStatus('已取消自動登入（偵測到手動輸入）');
  }, true);

  /* ---------- 載入設定並啟動 ---------- */
  const SETTING_KEYS = [KEYS.enabled, KEYS.pin, KEYS.delay, KEYS.closeCheck];
  chrome.storage.local.get(SETTING_KEYS, (raw) => {
    applySettings(raw);
    if (state.enabled) runAutoLogin();
  });

  // 其他分頁修改設定時同步（不重新觸發自動登入）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SETTING_KEYS.some((k) => k in changes)) {
      chrome.storage.local.get(SETTING_KEYS, applySettings);
    }
  });
})();

/* ---------- 首頁：自動關閉「公文管理環境檢測」（需「自動登入」與本項同時開啟） ---------- */
(() => {
  'use strict';
  if (window.__tcqbCloseCheckReady) return;
  window.__tcqbCloseCheckReady = true;
  const K_LOGIN = 'autoLoginEnabled';
  const K_CLOSE = 'autoCloseCheckEnabled';
  let on = false;
  const handled = new WeakSet();
  function tryClose() {
    if (!on) return;
    const btn = document.getElementById('toSaveCheck');
    if (!btn || handled.has(btn)) return;
    if (btn.offsetParent === null) return;
    handled.add(btn);
    setTimeout(() => { if (on) btn.click(); }, 300);
  }
  function applyCloseSetting(raw) {
    on = raw[K_LOGIN] === true && raw[K_CLOSE] !== false;
    if (on) tryClose();
  }
  new MutationObserver(tryClose).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
  });
  chrome.storage.local.get([K_LOGIN, K_CLOSE], applyCloseSetting);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (K_LOGIN in changes || K_CLOSE in changes) chrome.storage.local.get([K_LOGIN, K_CLOSE], applyCloseSetting);
  });
})();
