/* hook-main.js：MAIN world，document_start 執行；攔截 createObjectURL 以取得 PDF Blob */
(() => {
  'use strict';
  const TAG = '[EDOC-HELPER][HOOK]';
  const SRC = 'edoc-helper';
  const SRC_CONTENT = 'edoc-helper-content';
  const MAX_KEEP = 10;

  if (window.__edocHelperHook) return;
  window.__edocHelperHook = { installedAt: Date.now() };

  const known = new Map(); // url -> { info, blob }

  function post(payload) {
    try {
      const target = window.top || window;
      target.postMessage(
        { source: SRC, frame: window === window.top ? 'top' : 'child', ...payload },
        location.origin
      );
    } catch (err) {
      console.error(TAG, 'postMessage 失敗', err);
    }
  }

  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    try {
      if (typeof Blob !== 'undefined' && obj instanceof Blob) {
        const info = { url, type: obj.type || '', size: obj.size, at: Date.now(), revoked: false };
        known.set(url, { info, blob: obj });
        if (known.size > MAX_KEEP) known.delete(known.keys().next().value);
        console.log(TAG, 'createObjectURL', { type: info.type, size: info.size, url: url.slice(0, 24) + '…' });
        post({ type: 'BLOB_CREATED', info, blob: obj });
      }
    } catch (err) {
      console.error(TAG, 'hook 處理失敗', err);
    }
    return url;
  };

  URL.revokeObjectURL = function (url) {
    const key = String(url);
    const rec = known.get(key);
    if (rec) rec.info.revoked = true;
    console.log(TAG, 'revokeObjectURL', key.slice(0, 24) + '…', { tracked: !!rec });
    post({ type: 'BLOB_REVOKED', url: key });
    return origRevoke.apply(this, arguments);
  };

  // 內容腳本可能晚於 Blob 建立才載入，這裡提供重送機制
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin || !d || d.source !== SRC_CONTENT) return;
    if (d.type === 'HOOK_PING') {
      console.log(TAG, '收到 HOOK_PING，重送已擷取的 Blob', { count: known.size });
      post({ type: 'HOOK_READY', readyState: document.readyState, replay: true });
      for (const rec of known.values()) post({ type: 'BLOB_CREATED', info: rec.info, blob: rec.blob });
    }
  });

  post({ type: 'HOOK_READY', readyState: document.readyState });
  console.log(TAG, '已安裝', { href: location.pathname, readyState: document.readyState });
})();