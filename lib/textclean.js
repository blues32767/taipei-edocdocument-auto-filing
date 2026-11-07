/* lib/textclean.js 2026.10.28.1305：公文文字整理（開發者 blues32767）
 * 1. 移除頁面雜訊：裝訂線、頁碼（第 N 頁，共 M 頁）、檔號／保存年限欄位、條碼、承辦章戳。
 * 2. 修正 PDF 逐行擷取造成的強制斷行：
 *    - 欄位標題（主旨、說明、發文日期…）一律另起一行。
 *    - 條列（一、(一) 1、（二）…）只有在上一行已結束句子或未填滿版心時才另起一行；
 *      跨行的日期如「（二），假…」不視為條列。
 *    - 句末標點且未填滿版心 → 段落結束；其餘皆接回上一行。
 */
(function (global) {
  'use strict';

  const NOISE_LINE = /^[\s.．。·…裝訂線定【】\[\]]+$/;
  const isNoise = (line) => line.trim() !== '' && NOISE_LINE.test(line);

  // 頁面雜訊：整行移除
  const FOOTER_RE = [
    /^第\s*\d+\s*頁\s*[，,]?\s*共\s*\d+\s*頁$/,
    /^檔\s*號\s*[:：]?\s*$/,
    /^保存年限\s*[:：]?\s*$/,
    /^\d*\*[A-Za-z0-9]+\*$/,        // 條碼文字，例：3*QAAA1156007484*
    /^\S{2,12}\s+\d{7}$/            // 承辦單位章戳，例：長安國中 1151027
  ];

  const END_RE = /[。！？；：:!?;」』）)】》”"]$/;

  // 強制另起一行的欄位標題
  const STRONG_RE = /^(?:主旨|說明|正本|副本|附件|受文者|發文日期|發文字號|速別|密等|承辦人|地址|電話|電子信箱|檔\s*號|保存年限|\*|[0-9]+\*)/;

  // 條列標記：「一、」「１、」「(一)」「（二）」；後接「，」「、」者（如「（二），假」）為日期接續，不算條列
  const WEAK_RE = /^(?:[（(]?[0-9０-９一二三四五六七八九十]+[)）](?![，,、])|[0-9０-９一二三四五六七八九十]+[、.．])/;

  function visualWidth(s) {
    let w = 0;
    for (const ch of s) w += /[\x00-\x7f]/.test(ch) ? 0.5 : 1;
    return w;
  }

  function joinLines(text) {
    const lines = String(text || '').split('\n')
      .map((l) => l.trim())
      .filter((l) => !FOOTER_RE.some((re) => re.test(l)));

    // 版心寬度（以中文字計，A4 公文每行約 30 字）。固定門檻，不依樣本推估，
    // 以免短文件的最長行被誤判為「已填滿」。
    const BODY_WIDTH = 30;
    const isFull = (s) => visualWidth(s) >= BODY_WIDTH * 0.85;

    const out = [];
    for (const line of lines) {
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      const prev = out.length ? out[out.length - 1] : '';
      const endedSentence = END_RE.test(prev) && !isFull(prev);
      const startsNew = !prev
        || STRONG_RE.test(line)
        || (WEAK_RE.test(line) && (END_RE.test(prev) || !isFull(prev)))
        || endedSentence;
      if (startsNew) {
        out.push(line);
        continue;
      }
      const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(line);
      out[out.length - 1] = prev + (needSpace ? ' ' : '') + line;
    }
    return out.join('\n').trim();
  }

  function cleanOfficialText(raw) {
    const kept = String(raw || '').replace(/\r/g, '').split('\n').filter((l) => !isNoise(l));
    return joinLines(kept.join('\n')).replace(/\n{3,}/g, '\n\n');
  }

  global.EdocText = { cleanOfficialText, joinLines, isNoise };
})(typeof window !== 'undefined' ? window : self);
