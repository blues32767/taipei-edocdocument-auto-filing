(() => {
  'use strict';
  const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
  const config = { level: 'DEBUG', context: 'UNKNOWN', sink: null };
  const sensitive = /^(text|document|documentText|prompt|content|draft|apiKey|authorization|token|secret|password|responseBody)$/i;

  function sanitize(value, key = '', depth = 0) {
    if (sensitive.test(key)) return '[redacted]';
    if (value instanceof Error) return { name: value.name, message: value.message, stack: String(value.stack || '').split('\n').slice(0, 5).join('\n') };
    if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…(${value.length} chars)` : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 3) return '[depth-limit]';
    if (Array.isArray(value)) return value.slice(0, 30).map((v) => sanitize(v, '', depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k, depth + 1);
    return out;
  }

  function create(moduleName) {
    const emit = (level, message, data) => {
      if (levels[level] > levels[config.level]) return;
      const entry = { t: Date.now(), ctx: config.context, level, mod: moduleName, msg: message, data: sanitize(data) };
      const prefix = `[EDOC-HELPER][${entry.ctx}][${new Date(entry.t).toISOString()}][${level}][${moduleName}]`;
      const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      data === undefined ? fn(prefix, message) : fn(prefix, message, entry.data);
      try { if (typeof config.sink === 'function') config.sink(entry); } catch (_) {}
    };
    return {
      error: (m, d) => emit('ERROR', m, d), warn: (m, d) => emit('WARN', m, d),
      info: (m, d) => emit('INFO', m, d), debug: (m, d) => emit('DEBUG', m, d), trace: (m, d) => emit('TRACE', m, d),
      time(label) { const start = performance.now(); return (data) => emit('DEBUG', `${label} 完成`, { ms: Math.round(performance.now() - start), ...data }); }
    };
  }
  self.EdocLog = { create, configure: (options) => Object.assign(config, options || {}), levels };
})();
