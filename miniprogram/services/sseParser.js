/**
 * services/sseParser.js —— SSE 分帧 + UTF-8 增量解码 + 半截 JSON 抽取
 *
 * 为什么单独拆出来：这三件事都有「跨包切断」的坑，而且是纯函数，
 * 可以脱离小程序在 Node 里跑测试（scripts/test-sse.js）。
 *   · 一个中文字符的 3 个字节可能被拆到两个 chunk 里
 *   · 一行 SSE 可能被拆到两个 chunk 里
 *   · JSON 只吐了一半，此时既不能解析也不能直接显示
 */

/** 增量 UTF-8 解码：跨 chunk 截断的字节留到下一包再拼 */
function createUtf8Decoder() {
  let rest = [];

  function decode(bytes) {
    const all = rest.concat(bytes);
    let out = '';
    let i = 0;
    while (i < all.length) {
      const b = all[i];
      let need = 0;
      if (b < 0x80) {
        out += String.fromCharCode(b);
        i += 1;
        continue;
      }
      if ((b & 0xe0) === 0xc0) need = 1;
      else if ((b & 0xf0) === 0xe0) need = 2;
      else if ((b & 0xf8) === 0xf0) need = 3;
      else {
        i += 1; // 非法首字节，丢掉
        continue;
      }
      if (i + need >= all.length) break; // 尾字节还没到齐，留到下一包
      let cp;
      if (need === 1) cp = ((b & 0x1f) << 6) | (all[i + 1] & 0x3f);
      else if (need === 2) cp = ((b & 0x0f) << 12) | ((all[i + 1] & 0x3f) << 6) | (all[i + 2] & 0x3f);
      else cp = ((b & 0x07) << 18) | ((all[i + 1] & 0x3f) << 12) | ((all[i + 2] & 0x3f) << 6) | (all[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    rest = all.slice(i);
    return out;
  }

  return { decode, reset: () => (rest = []) };
}

/**
 * SSE 分帧：喂文本进来，吐出完整帧 [{event, data}]。
 * 兼容 \n\n 与 \r\n\r\n，也兼容多行 data。
 */
function createSSEParser() {
  let buf = '';

  function feed(text) {
    buf += text;
    const frames = [];
    let idx = buf.search(/\r?\n\r?\n/);
    while (idx !== -1) {
      const raw = buf.slice(0, idx);
      const sep = buf.slice(idx).match(/^\r?\n\r?\n/)[0];
      buf = buf.slice(idx + sep.length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      idx = buf.search(/\r?\n\r?\n/);
    }
    return frames;
  }

  return { feed, flush: () => (buf = '') };
}

function parseFrame(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let event = 'message';
  const data = [];
  lines.forEach((line) => {
    if (!line || line.charAt(0) === ':') return; // 注释/心跳
    if (line.indexOf('event:') === 0) event = line.slice(6).trim();
    else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
  });
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/* ------------------------- 半截 JSON 的渐进抽取 ------------------------- */

function unescapeJson(s) {
  return String(s || '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 取某个 key 的**已闭合**字符串值；没闭合就返回空（还在吐） */
function pickString(text, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = re.exec(text);
  return m ? unescapeJson(m[1]) : '';
}

/** 取数组里已经吐完的前 N 个字符串 */
function pickStringArray(text, key, limit) {
  const start = new RegExp('"' + key + '"\\s*:\\s*\\[').exec(text);
  if (!start) return [];
  const tail = text.slice(start.index + start[0].length);
  const end = tail.indexOf(']');
  const scope = end === -1 ? tail : tail.slice(0, end);
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(scope)) && out.length < (limit || 3)) {
    out.push(unescapeJson(m[1]));
  }
  return out;
}

/** 取 recommendations 里已经吐完的 name（数组内按 name 键抽） */
function pickRecommendationNames(text, limit) {
  const start = /"recommendations"\s*:\s*\[/.exec(text);
  if (!start) return [];
  const tail = text.slice(start.index);
  const out = [];
  const re = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(tail)) && out.length < (limit || 2)) {
    out.push(unescapeJson(m[1]));
  }
  return out;
}

/**
 * 从半截 JSON 里抽「能立刻显示的东西」。
 * 只做展示预览，不参与任何校验 —— 最终仍然以完整 JSON 解析结果为准。
 */
function extractPreview(text, prev) {
  const base = prev || { title: '', redFlags: [], names: [] };
  const title = pickString(text, 'card_title') || base.title;
  const redFlags = pickStringArray(text, 'red_flags', 3);
  const names = pickRecommendationNames(text, 2);
  return {
    title,
    redFlags: redFlags.length ? redFlags : base.redFlags,
    names: names.length ? names : base.names
  };
}

module.exports = {
  createUtf8Decoder,
  createSSEParser,
  parseFrame,
  pickString,
  pickStringArray,
  pickRecommendationNames,
  extractPreview
};
