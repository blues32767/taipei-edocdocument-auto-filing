/* help.js：說明頁互動（由內嵌 script 移出，符合擴充套件 CSP） */
(() => {
  'use strict';
  const KEY = 'uiTheme';
  const $ = (id) => document.getElementById(id);
  function applyTheme(t) {
    const dark = t === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeLabel').textContent = dark ? '白色配色' : '黑色配色';
    $('btnTheme').setAttribute('aria-pressed', String(dark));
  }
  $('btnTheme').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await chrome.storage.local.set({ [KEY]: next });
  });
  chrome.storage.local.get({ [KEY]: 'light' }).then((r) => applyTheme(r[KEY]));
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c[KEY]) applyTheme(c[KEY].newValue); });

  // 目錄標示目前章節
  const links = [...document.querySelectorAll('.toc a')];
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === `#${e.target.id}`)));
    }
  }, { rootMargin: '-35% 0px -55% 0px' });
  document.querySelectorAll('.sec').forEach((s) => spy.observe(s));
})();
