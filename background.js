/* background.js v0.3.0：服務工作者；設定、本地 cURL 套用、AI 呼叫（本地 / 網路 API）、擬辦、公文重點整理、快捷按鈕偏好、除錯紀錄 */
importScripts('lib/logger.js', 'lib/curl.js');

const VERSION = chrome.runtime.getManifest().version;
const LOG_KEY = 'edocHelperDebugLog';
const LOG_LIMIT = 800;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const QUICK_KEYS = ['copyId','readCopy','plain','writeExplain','draftWrite','summary'];

const DEFAULTS = {
  provider: 'local',
  presetId: 'lmstudio',
  localPort: 1234,
  customUrl: '',
  model: '',
  maxChars: 12000,
  timeoutSec: 60,
  draftMaxChars: 100,
  redact: true,
  debugLevel: 'DEBUG',
  promptTemplate: '',
  summaryPromptTemplate: '',
  quickButtons: QUICK_KEYS
};

// 擬辦預設提示詞；{{MAX_CHARS}} 會被替換成字數上限
const DEFAULT_PROMPT = [
  '你是台灣中小學承辦人的公文擬辦助手。請依下列公文內容，撰寫「擬辦」草稿。',
  '撰寫規則：',
  '1. 全文控制在 {{MAX_CHARS}} 字以內，能短則短，不要重述主旨與說明。',
  '2. 以「擬：」開頭，直接寫本校的處理作法，使用公文用語，例如「擬請…」「擬由…辦理」「擬於…前完成」。',
  '3. 若公文只是轉知、函知、周知或宣導，本校無須行動，擬辦只寫「擬：陳閱後存查。」',
  '4. 若本校需要處理，寫出具體事項、由哪類人員辦理及期限，最後一句加上「陳閱後存查。」',
  '5. 不得編造公文未載明的日期、金額、人名或法規。',
  '6. 除非有重大疑義，不要加註【待確認】或其他說明。',
  '7. 只輸出擬辦本文，不要前言、標題或條列符號。'
].join('\n');

// 公文重點整理預設提示詞（不寫入意見，僅供閱讀）
const DEFAULT_SUMMARY_PROMPT = [
  '你是台灣中小學承辦人的公文閱讀助手。請閱讀下列公文，整理成承辦人可快速掌握的重點。',
  '輸出格式：',
  '1. 主旨：一句話說明來文目的。',
  '2. 重點：條列來文要求、期限、金額或數字、應繳交的表件。',
  '3. 本校待辦：若來文要求本校處理，列出事項與期限；若僅為轉知或周知，寫「無須特別處理」。',
  '4. 全文約 200 字以內，使用繁體中文。',
  '5. 不得編造公文未載明的內容。'
].join('\n');

const REDACT_RULES = [
  { name: '身分證字號', re: /\b[A-Z][12]\d{8}\b/g, rep: '[身分證已遮蔽]' },
  { name: '手機', re: /\b09\d{2}-?\d{3}-?\d{3}\b/g, rep: '[手機已遮蔽]' },
  { name: 'Email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, rep: '[Email已遮蔽]' }
];

const log = EdocLog.create('BG');
let logBuffer = [];
let flushTimer = null;

function pushLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLogs, 300);
}

function flushLogs() {
  chrome.storage.local.set({ [LOG_KEY]: logBuffer }).catch((err) => {
    console.error('[EDOC-HELPER][BG] 寫入除錯紀錄失敗', err);
  });
}

EdocLog.configure({ context: 'BG', level: 'DEBUG', sink: pushLog });

const ready = (async () => {
  const { [LOG_KEY]: stored } = await chrome.storage.local.get(LOG_KEY);
  logBuffer = [...(Array.isArray(stored) ? stored : []), ...logBuffer].slice(-LOG_LIMIT);
  const s = await getSettings(false);
  EdocLog.configure({ level: s.debugLevel || 'DEBUG' });
  log.info('背景程序啟動', { version: VERSION, storedLogs: logBuffer.length, provider: s.provider });
})().catch((err) => console.error('[EDOC-HELPER][BG] 初始化失敗', err));

self.addEventListener('unhandledrejection', (e) => log.error('背景未處理的 Promise 拒絕', e.reason));

const clampInt = (v, min, max, fb) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fb;
  return Math.min(max, Math.max(min, n));
};
const countZh = (s) => String(s || '').replace(/\s/g, '').length;

async function getSettings(includeKey) {
  const sync = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get({ apiKey: '', localCurl: '' });
  return {
    ...DEFAULTS,
    ...sync,
    localCurl: String(local.localCurl || ''),
    ...(includeKey ? { apiKey: local.apiKey } : {})
  };
}

function openOptions(source) {
  const url = chrome.runtime.getURL('options.html');
  log.info('開啟設定頁', { source });
  chrome.tabs.create({ url }, (tab) => {
    const err = chrome.runtime.lastError;
    if (err) log.error('開啟設定頁失敗（可能被瀏覽器政策封鎖）', { message: err.message });
    else log.debug('設定頁分頁已建立', { tabId: tab && tab.id });
  });
}

chrome.action.onClicked.addListener(() => openOptions('toolbar'));

/* ---------- 本地 cURL 與端點解析 ---------- */
// 若已儲存 cURL 且目前為本地模式，回傳解析結果；否則回傳 null
function activeCurl(s) {
  if (s.provider === 'cloud' || !String(s.localCurl || '').trim()) return null;
  return EdocCurl.parseCurl(s.localCurl);
}

function resolveEndpoint(s) {
  const curl = activeCurl(s);
  if (curl) return curl.url;
  if (s.provider === 'cloud') {
    return s.presetId === 'custom' ? String(s.customUrl || '').trim() : GEMINI_URL;
  }
  return `http://127.0.0.1:${clampInt(s.localPort, 1, 65535, 1234)}/v1/chat/completions`;
}

function parseEndpoint(s) {
  const raw = resolveEndpoint(s);
  if (!raw) throw new Error('請填寫自訂網路 API 網址');
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('端點網址格式錯誤'); }
  const isLocal = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (s.provider === 'cloud' && u.protocol !== 'https:') throw new Error('網路 API 端點必須為 https');
  if (!isLocal && u.protocol !== 'https:') throw new Error('端點必須為 https，或 127.0.0.1／localhost 的 http');
  return u;
}

// 本地 PORT、cURL 或自訂網址若非 localhost，需先在「完整設定頁」授權；Gemini 已列於 host_permissions
async function ensureOriginGranted(u) {
  const pattern = `${u.origin}/*`;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  log.debug('主機權限檢查', { pattern, granted });
  if (!granted) throw new Error(`尚未授權 ${u.origin}，請到「完整設定頁」按「儲存設定」並允許此端點`);
}

/* ---------- 設定儲存 ---------- */
async function saveSettings(p) {
  const provider = p.provider === 'cloud' ? 'cloud' : 'local';
  const presetId = provider === 'cloud'
    ? (p.presetId === 'custom' ? 'custom' : 'gemini')
    : (p.presetId === 'ollama' ? 'ollama' : 'lmstudio');

  const cfg = {
    provider,
    presetId,
    localPort: clampInt(p.localPort, 1, 65535, 1234),
    customUrl: String(p.customUrl || '').trim(),
    model: String(p.model || '').trim(),
    maxChars: clampInt(p.maxChars, 1000, 60000, 12000),
    draftMaxChars: clampInt(p.draftMaxChars, 30, 500, 100),
    timeoutSec: clampInt(p.timeoutSec, 5, 300, 60),
    redact: !!p.redact
  };
  if (p.debugLevel) cfg.debugLevel = String(p.debugLevel);

  // cURL：有傳入欄位才更新。解析成功即改用本地模式，並以 cURL 內的 model 為準
  let curlRaw = null;
  let parsedCurl = null;
  // 網路API 模式不解析 cURL（即使欄位內仍有舊內容）
  if (p.localCurl !== undefined && provider === 'local') {
    curlRaw = String(p.localCurl || '').trim();
    if (curlRaw) parsedCurl = EdocCurl.parseCurl(curlRaw);
  }
  if (parsedCurl) {
    cfg.provider = 'local';
    if (cfg.presetId !== 'ollama') cfg.presetId = 'lmstudio';
    cfg.model = parsedCurl.model;
  }

  const storedCurl = curlRaw !== null
    ? curlRaw
    : (await chrome.storage.local.get({ localCurl: '' })).localCurl;
  const u = parseEndpoint({ ...cfg, localCurl: storedCurl });
  await ensureOriginGranted(u);

  // 只有傳入欄位才更新，避免設定頁存檔時覆蓋面板的提示詞
  if (p.promptTemplate !== undefined) {
    const raw = String(p.promptTemplate || '').trim();
    if (raw.length > 6000) throw new Error('提示詞過長（超過 6000 字），請精簡');
    cfg.promptTemplate = raw === DEFAULT_PROMPT.trim() ? '' : raw;
  }
  if (p.summaryPromptTemplate !== undefined) {
    const raw = String(p.summaryPromptTemplate || '').trim();
    if (raw.length > 6000) throw new Error('重點提示詞過長（超過 6000 字），請精簡');
    cfg.summaryPromptTemplate = raw === DEFAULT_SUMMARY_PROMPT.trim() ? '' : raw;
  }

  await chrome.storage.sync.set(cfg);
  if (curlRaw !== null) await chrome.storage.local.set({ localCurl: curlRaw });
  if (p.apiKey !== null && p.apiKey !== undefined) {
    await chrome.storage.local.set({ apiKey: String(p.apiKey) });
  }
  log.info('設定已儲存', {
    provider: cfg.provider, presetId: cfg.presetId, endpointOrigin: u.origin, model: cfg.model,
    maxChars: cfg.maxChars, draftMaxChars: cfg.draftMaxChars, timeoutSec: cfg.timeoutSec,
    redact: cfg.redact, localCurl: !!parsedCurl, curlApi: parsedCurl ? parsedCurl.mode : '',
    apiKeyChanged: p.apiKey !== null && p.apiKey !== undefined
  });
  return { ok: true };
}

// 快捷按鈕偏好（只接受已知的三個按鈕代碼）
async function saveQuickButtons(items) {
  const quickButtons = QUICK_KEYS.filter((k) => Array.isArray(items) && items.includes(k));
  await chrome.storage.sync.set({ quickButtons });
  log.info('快捷按鈕偏好已儲存', { quickButtons });
  return { ok: true, quickButtons };
}

async function settingsForUI() {
  const s = await getSettings(false);
  let endpoint = '';
  try { endpoint = parseEndpoint(s).href; } catch (_) { endpoint = ''; }
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  return {...s,aiModel:await verifiedModel(s,endpoint),quickButtons: Array.isArray(s.quickButtons) ? s.quickButtons : QUICK_KEYS,
    endpoint,
    hasApiKey: !!apiKey,
    defaultPrompt: DEFAULT_PROMPT,
    defaultSummaryPrompt: DEFAULT_SUMMARY_PROMPT
  };
}

/* ---------- AI 呼叫 ---------- */
function buildSystemPrompt(s) {
  const tpl = String(s.promptTemplate || '').trim() ? s.promptTemplate : DEFAULT_PROMPT;
  const body = tpl.split('{{MAX_CHARS}}').join(String(s.draftMaxChars));
  const fixed = [
    '【程式強制規定，優先於以上所有規則】',
    '一、只使用繁體中文輸出，禁止使用英文。',
    '二、禁止輸出思考過程、分析步驟或任何解釋，只輸出最終文字。',
    `三、全文不得超過 ${s.draftMaxChars} 個中文字。`,
    '四、擬辦以「擬：」開頭。'
  ].join('\n');
  return `${body}\n\n${fixed}`;
}

function buildSummaryPrompt(s) {
  const tpl = String(s.summaryPromptTemplate || '').trim() ? s.summaryPromptTemplate : DEFAULT_SUMMARY_PROMPT;
  return `${tpl}\n\n【程式強制規定】只使用繁體中文輸出，禁止英文、思考過程與前言。`;
}

function cleanDraft(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 只保留「擬：」起算的中文段落，去掉模型的英文思考
function extractDraft(raw) {
  const t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const lines = t.split(/\r?\n/);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*擬\s*[：:]/.test(lines[i])) { idx = i; break; }
  }
  const body = (idx >= 0 ? lines.slice(idx) : lines).filter((l) => /[\u4e00-\u9fff]/.test(l));
  return body.join('\n').replace(/\n{2,}/g, '\n').trim();
}

function redact(text) {
  const counts = {};
  let out = text;
  for (const rule of REDACT_RULES) {
    out = out.replace(rule.re, () => {
      counts[rule.name] = (counts[rule.name] || 0) + 1;
      return rule.rep;
    });
  }
  log.debug('個資遮蔽統計', counts);
  return out;
}

function prepText(s, text) {
  let t = String(text || '');
  if (!t.trim()) throw new Error('沒有公文文字可以送出');
  if (s.redact) t = redact(t);
  if (t.length > s.maxChars) {
    log.warn('公文文字超過上限，已截斷', { length: t.length, maxChars: s.maxChars });
    t = t.slice(0, s.maxChars);
  }
  return t;
}

async function prepareCtx() {
  const s = await getSettings(true);
  const curl = activeCurl(s);
  if (!curl && !s.model) throw new Error('尚未填寫模型名稱，請按「⚙ 設定」填寫');
  if (s.provider === 'cloud' && !s.apiKey) throw new Error('已選「網路API」，但尚未填入 API 金鑰');
  const u = parseEndpoint(s);
  await ensureOriginGranted(u);

  // cURL 的標頭直接沿用；若無 Content-Type 則補上；金鑰僅在 cURL 未指定 Authorization 時補上
  const headers = curl ? { ...curl.headers } : {};
  const hasH = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  if (!hasH('content-type')) headers['Content-Type'] = 'application/json';
  if (s.apiKey && !hasH('authorization')) headers.Authorization = `Bearer ${s.apiKey}`;

  log.debug('AI 端點已決定', {
    source: curl ? 'cURL' : (s.provider === 'cloud' ? 'cloud' : 'port'),
    api: curl ? curl.mode : 'openai',
    host: u.host,
    headerNames: Object.keys(headers)
  });
  return {
    s,
    ctx: {
      url: u.href,
      headers,
      model: curl ? curl.model : s.model,
      mode: curl ? curl.mode : 'openai',
      template: curl ? curl.body : null,
      timeoutSec: s.timeoutSec,
      host: u.host
    }
  };
}

async function postChat(url, headers, body, timeoutSec) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    return { res, raw };
  } catch (err) {
    log.error('AI 請求網路錯誤', { name: err.name, message: err.message });
    throw new Error(err.name === 'AbortError'
      ? `AI 請求逾時（${timeoutSec} 秒）`
      : `AI 請求失敗：${err.message}（請確認端點、PORT 與網路連線）`);
  } finally {
    clearTimeout(timer);
  }
}

// 依 API 形式組出請求內容；cURL 內的其他參數（如 temperature）會被保留
function buildRequest(ctx, roleMode, sys, user, maxTokens) {
  const tpl = ctx.template || {};
  if (ctx.mode === 'native') {
    // LM Studio 原生 API：/api/v1/chat 使用 input 與 system_prompt
    // LM Studio 原生 API 不一定接受 max_tokens 類欄位，此處不送，沿用 cURL 內容與伺服器預設
    const body = { ...tpl, model: ctx.model, input: user };
    delete body.messages;
    delete body.stream;
    if (sys) body.system_prompt = sys;
    else delete body.system_prompt;
    if (body.temperature === undefined) body.temperature = 0.2;
    return body;
  }
  const messages = roleMode === 'merged'
    ? [{ role: 'user', content: sys ? `${sys}\n\n${user}` : user }]
    : [...(sys ? [{ role: 'system', content: sys }] : []), { role: 'user', content: user }];
  const body = { ...tpl, model: ctx.model, messages, max_tokens: maxTokens };
  delete body.stream;
  delete body.input;
  delete body.system_prompt;
  if (body.temperature === undefined) body.temperature = 0.2;
  return body;
}

// 同時相容 OpenAI 格式（choices）與 LM Studio 原生格式（output）
function parseReply(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    const msg = choice.message || {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
      finish: choice.finish_reason
    };
  }
  const out = data && Array.isArray(data.output) ? data.output : [];
  let content = '';
  let reasoning = '';
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content) ? item.content.map((c) => (c && c.text) || '').join('') : '';
    if (item.type === 'reasoning') reasoning += text;
    else if (item.type === 'message' || item.type === undefined) content += text;
  }
  return {
    content,
    reasoning,
    finish: (data && (data.stop_reason || data.finish_reason)) || undefined
  };
}

// 若模型不接受 system 角色（HTTP 400），自動改為單一 user 訊息重試一次
async function callModel(ctx, sys, user, maxTokens, label) {
  let roleMode = ctx.mode === 'native' ? 'native' : 'system';
  let res;
  let raw;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = buildRequest(ctx, roleMode, sys, user, maxTokens);
    log.info('送出 AI 請求', { label, attempt, api: ctx.mode, roleMode, maxTokens, model: ctx.model, host: ctx.host });
    ({ res, raw } = await postChat(ctx.url, ctx.headers, body, ctx.timeoutSec));
    log.debug('AI 回應標頭', { label, attempt, status: res.status, ok: res.ok });
    if (res.status === 400 && roleMode === 'system' && attempt === 1) {
      log.warn('HTTP 400，改用合併訊息重試', { detail: raw.slice(0, 200) });
      roleMode = 'merged';
      continue;
    }
    break;
  }

  if (!res.ok) {
    log.error('AI 回應非 2xx', { label, status: res.status, detail: raw.slice(0, 300) });
    const hint = res.status === 401 ? '（金鑰錯誤或未填入，請檢查 API 金鑰或 cURL 內的標頭）'
      : res.status === 404 ? '（端點或模型名稱錯誤）' : '';
    throw new Error(`AI 回應錯誤 HTTP ${res.status}${hint}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    log.error('AI 回應不是 JSON', { label, bytes: raw.length, head: raw.slice(0, 120) });
    throw new Error('AI 回應格式錯誤（非 JSON），請確認端點是否正確（/v1/chat/completions 或 /api/v1/chat）');
  }

  const r = parseReply(data);
  log.debug('AI 回應內容概況', { label, contentChars: r.content.length, reasoningChars: r.reasoning.length, finish: r.finish });
  return { content: r.content, reasoning: r.reasoning, finish: r.finish, roleMode };
}

// 「已連線」狀態：連線測試或 AI 擬稿／摘要成功後記錄；設定（provider／模型／端點）變更後自動失效
function endpointOf(s) { try { return parseEndpoint(s).href; } catch (_) { return ''; } }
function aiSig(s, endpoint) { return [s.provider, s.presetId, s.model, endpoint].join('|'); }
async function verifiedModel(s, endpoint) {
  const { aiStatus } = await chrome.storage.local.get({ aiStatus: null });
  if (!aiStatus || !aiStatus.ok || !s.model) return '';
  return aiStatus.sig === aiSig(s, endpoint) ? s.model : '';
}
async function verified(promise) {
  try {
    const r = await promise;
    const s = await getSettings(false);
    await chrome.storage.local.set({ aiStatus: { ok: true, sig: aiSig(s, endpointOf(s)), model: s.model, at: Date.now() } });
    return r;
  } catch (err) {
    await chrome.storage.local.set({ aiStatus: { ok: false, at: Date.now() } }).catch(() => {});
    throw err;
  }
}

async function handleTest() {
  const { ctx } = await prepareCtx();
  const r = await callModel(ctx, '', '請只回覆「連線成功」四個字，不要其他文字。', 200, 'test');
  const reply = cleanDraft(r.content) || cleanDraft(r.reasoning);
  return { ok: true, draft: reply || '（模型無文字回覆）' };
}

async function handleDraft(text) {
  const done = log.time('AI 擬辦');
  const { s, ctx } = await prepareCtx();
  const body = prepText(s, text);
  const limit = s.draftMaxChars;
  const sys = buildSystemPrompt(s);
  const user = `請依下列公文內容撰寫擬辦草稿。\n\n----- 公文內容開始 -----\n${body}\n----- 公文內容結束 -----`;
  const maxTokens = Math.max(2048, limit * 12);

  const first = await callModel(ctx, sys, user, maxTokens, 'draft');
  let draft = extractDraft(first.content) || extractDraft(first.reasoning);
  if (!draft) throw new Error(`模型未輸出可用的中文擬辦（結束原因：${first.finish || '未知'}）。請確認模型已載入後重試。`);

  let retried = false;
  if (countZh(draft) > limit * 1.2) {
    log.warn('草稿超過字數上限，請模型精簡一次', { chars: countZh(draft), limit });
    const sys2 = `你是公文潤飾助手。請將下列擬辦改寫為不超過 ${limit} 個中文字的繁體中文正式公文用語，開頭保留「擬：」。若原文最後為「陳閱後存查。」須保留。只輸出改寫後的擬辦，禁止英文與任何說明。`;
    const second = await callModel(ctx, sys2, draft, maxTokens, 'shorten');
    const shorter = extractDraft(second.content) || extractDraft(second.reasoning);
    if (shorter && countZh(shorter) < countZh(draft)) { draft = shorter; retried = true; }
  }

  const chars = countZh(draft);
  const overLimit = chars > limit * 1.2;
  done({ draftChars: chars, limit, retried });
  return { ok: true, draft, chars, limit, overLimit, retried };
}

async function handleSummary(text) {
  const done = log.time('AI 重點整理');
  const { s, ctx } = await prepareCtx();
  const body = prepText(s, text);
  const sys = buildSummaryPrompt(s);
  const user = `請整理下列公文重點。\n\n----- 公文內容開始 -----\n${body}\n----- 公文內容結束 -----`;
  const r = await callModel(ctx, sys, user, 2048, 'summary');
  const out = cleanDraft(r.content) || cleanDraft(r.reasoning);
  if (!out) throw new Error('模型未輸出重點內容，請確認模型已載入後重試。');
  done({ chars: countZh(out) });
  return { ok: true, draft: out, chars: countZh(out) };
}

/* ---------- 訊息路由 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    log.warn('拒絕非本擴充套件的訊息', { senderId: sender && sender.id });
    sendResponse({ ok: false, error: '拒絕存取' });
    return false;
  }

  const type = msg && msg.type;
  if (type !== 'LOG') log.debug('收到訊息', { type, frameId: sender.frameId });

  (async () => {
    await ready;
    const payload = (msg && msg.payload) || {};
    switch (type) {
      case 'PING': return { ok: true, version: VERSION, pong: Date.now() };
      case 'LOG': pushLog(msg.entry); return { ok: true };
      case 'OPEN_OPTIONS': openOptions('panel'); return { ok: true };
      case 'OPEN_HELP':
        chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
        log.info('開啟說明頁', { source: 'panel' });
        return { ok: true };
      case 'SAVE_SETTINGS': return await saveSettings(payload);
      case 'SAVE_QUICK_BUTTONS': return await saveQuickButtons(payload.quickButtons);
      case 'GET_SETTINGS': return { ok: true, settings: await settingsForUI() };
      case 'AI_DRAFT':return await verified(handleDraft(payload.text));
      case 'AI_SUMMARY':return await verified(handleSummary(payload.text));
      case 'AI_TEST':return await verified(handleTest());
      case 'EXPORT_LOG': return { ok: true, logs: logBuffer };
      case 'CLEAR_LOG':
        logBuffer = [];
        await chrome.storage.local.remove(LOG_KEY);
        log.info('除錯紀錄已清除');
        return { ok: true };
      default:
        log.warn('未知訊息類型', { type });
        return { ok: false, error: `未知訊息類型：${type}` };
    }
  })()
    .then(sendResponse)
    .catch((err) => {
      log.error('訊息處理失敗', { message: err.message });
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});
