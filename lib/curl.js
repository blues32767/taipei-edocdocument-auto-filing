/* lib/curl.js v0.3.0：解析使用者貼上的 cURL 指令（background / options / content 共用）
 * 支援：反斜線（\）或 ^ 換行、單引號、雙引號、-H/--header、-d/--data/--data-raw/--data-binary/--json、-X、--url、
 *       省略 curl 指令名稱、curl.exe。
 * 回傳 { raw, url, origin, method, headers, body, model, mode }
 *   mode = 'native'：LM Studio 原生 API（/api/v1/chat，使用 input / system_prompt）
 *   mode = 'openai'：OpenAI 相容 API（/v1/chat/completions，使用 messages）
 */
(function (global) {
  'use strict';

  const SKIP_HEADERS = ['host', 'content-length', 'connection', 'accept-encoding'];
  const DATA_FLAGS = ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'];
  // 這些參數會帶一個值，解析時需一併略過
  const VALUE_FLAGS = ['-o', '--output', '-u', '--user', '-b', '--cookie', '-e', '--referer',
    '-A', '--user-agent', '-m', '--max-time', '--connect-timeout', '-w', '--write-out',
    '-x', '--proxy', '-F', '--form', '--cacert'];

  function tokenize(src) {
    const s = String(src).replace(/\r\n/g, '\n').replace(/\\\n/g, ' ').replace(/\^\n/g, ' ');
    const out = [];
    let cur = '';
    let has = false;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new Error("cURL 內有未結束的單引號 '");
        cur += s.slice(i + 1, end);
        has = true;
        i = end + 1;
      } else if (c === '"') {
        has = true;
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.indexOf(s[i + 1]) >= 0) {
            cur += s[i + 1];
            i += 2;
          } else {
            cur += s[i];
            i++;
          }
        }
        if (i >= s.length) throw new Error('cURL 內有未結束的雙引號 "');
        i++;
      } else if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1];
        has = true;
        i += 2;
      } else if (/\s/.test(c)) {
        if (has) {
          out.push(cur);
          cur = '';
          has = false;
        }
        i++;
      } else {
        cur += c;
        has = true;
        i++;
      }
    }
    if (has) out.push(cur);
    return out;
  }

  function parseCurl(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('尚未貼上 cURL 指令');

    const tokens = tokenize(text);
    if (tokens.length && /^curl(\.exe)?$/i.test(tokens[0])) tokens.shift();
    if (!tokens.length) throw new Error('cURL 指令內容為空');

    let url = '';
    let method = '';
    let hasData = false;
    const dataParts = [];
    const headers = {};
    const valueOf = (i) => {
      if (i + 1 >= tokens.length) throw new Error(`cURL 的 ${tokens[i]} 缺少參數`);
      return tokens[i + 1];
    };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-H' || t === '--header') {
        const h = valueOf(i);
        i++;
        const idx = h.indexOf(':');
        if (idx > 0) {
          const name = h.slice(0, idx).trim();
          if (!SKIP_HEADERS.includes(name.toLowerCase())) headers[name] = h.slice(idx + 1).trim();
        }
      } else if (DATA_FLAGS.includes(t)) {
        dataParts.push(valueOf(i));
        i++;
        hasData = true;
      } else if (t === '-X' || t === '--request') {
        method = valueOf(i);
        i++;
      } else if (t === '--url') {
        url = valueOf(i);
        i++;
      } else if (VALUE_FLAGS.includes(t)) {
        i++;
      } else if (/^-/.test(t)) {
        // 其他開關（-s、-i、-k、--compressed 等）直接略過
      } else if (!url) {
        url = t;
      }
    }

    if (!url) throw new Error('cURL 中找不到網址，例如 curl http://localhost:1234/api/v1/chat');
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      throw new Error(`cURL 網址格式錯誤：${url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('cURL 網址必須為 http 或 https');
    if (!hasData) throw new Error('cURL 缺少 -d 或 --data-raw 的 JSON 內容');

    let body;
    try {
      body = JSON.parse(dataParts.join('&'));
    } catch (_) {
      throw new Error('cURL 的 -d 內容不是合法 JSON，請完整複製單引號內的內容，勿手動改寫');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('cURL 的 -d 內容必須是 JSON 物件');

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) throw new Error('cURL 的 JSON 內容缺少 "model" 欄位（例如 "qwen/qwen3.5-9b"）');

    const nativeHint = 'input' in body || 'system_prompt' in body || /\/api\/v1\/chat\/?$/.test(u.pathname);
    const mode = !('messages' in body) && nativeHint ? 'native' : 'openai';

    return {
      raw: text,
      url: u.href,
      origin: u.origin,
      method: (method || 'POST').toUpperCase(),
      headers,
      body,
      model,
      mode
    };
  }

  global.EdocCurl = { parseCurl };
})(typeof self !== 'undefined' ? self : window);
