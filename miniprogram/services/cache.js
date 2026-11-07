/**
 * services/cache.js —— 需求指纹缓存（契约 P2-2.3 / P4-4.5）
 * 归属：A 岗。
 *
 * 决策缓存：key = md5(rawInput.trim() + category)，TTL 24h
 * 查证缓存：key = md5('verify:' + searchKeyword)，TTL 2h
 *
 * 为什么自己实现 md5：小程序端没有 crypto，且脚本要求零依赖。
 * 这里只用它做「需求指纹」，不做安全用途。
 */

const D_KEY_PREFIX = 'bk_cache_v1:';
const MEM = Object.create(null); // storage 不可用时的内存兜底

/* ------------------------------- md5 ------------------------------- */

function add32(a, b) {
  return (a + b) & 0xffffffff;
}

function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md5cycle(x, k) {
  let a = x[0];
  let b = x[1];
  let c = x[2];
  let d = x[3];

  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);

  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);

  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);

  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}

function md5blk(s) {
  const md5blks = [];
  for (let i = 0; i < 64; i += 4) {
    md5blks[i >> 2] =
      s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
  }
  return md5blks;
}

function utf8Bytes(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

const HEX = '0123456789abcdef';
function rhex(n) {
  let s = '';
  for (let j = 0; j < 4; j++) {
    s += HEX.charAt((n >> (j * 8 + 4)) & 0x0f) + HEX.charAt((n >> (j * 8)) & 0x0f);
  }
  return s;
}

/** @param {string} input @returns {string} 32 位小写 hex */
function md5(input) {
  const bytes = utf8Bytes(input);
  const len = bytes.length;

  // UTF-8 字节转「伪 latin1 字符串」，复用按 16 位分块的实现
  let bin = '';
  for (let i = 0; i < len; i++) bin += String.fromCharCode(bytes[i]);

  const n = len;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= bin.length; i += 64) {
    md5cycle(state, md5blk(bin.substring(i - 64, i)));
  }

  bin = bin.substring(i - 64);
  const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < bin.length; i++) tail[i >> 2] |= bin.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);

  return state.map(rhex).join('');
}

/* ----------------------------- 缓存读写 ----------------------------- */

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function readRaw(key) {
  if (hasStorage()) {
    try {
      return wx.getStorageSync(key);
    } catch (e) {
      return MEM[key];
    }
  }
  return MEM[key];
}

function writeRaw(key, val) {
  MEM[key] = val;
  if (hasStorage()) {
    try {
      wx.setStorageSync(key, val);
    } catch (e) {
      // 存储满了：丢掉缓存不该影响主流程
    }
  }
}

function removeRaw(key) {
  delete MEM[key];
  if (hasStorage()) {
    try {
      wx.removeStorageSync(key);
    } catch (e) {
      /* noop */
    }
  }
}

/** 需求指纹：同句话 + 同品类 → 同一个 key */
function fingerprint(rawInput, category) {
  return md5(String(rawInput || '').trim() + '|' + String(category || ''));
}

function get(key) {
  const rec = readRaw(D_KEY_PREFIX + key);
  if (!rec || typeof rec !== 'object') return null;
  if (!rec.expire || rec.expire < Date.now()) {
    removeRaw(D_KEY_PREFIX + key);
    return null;
  }
  return rec.value;
}

function set(key, value, ttlMs) {
  writeRaw(D_KEY_PREFIX + key, {
    value,
    expire: Date.now() + (ttlMs || 0),
    ts: Date.now()
  });
}

function clear() {
  if (hasStorage()) {
    try {
      const info = wx.getStorageInfoSync();
      (info.keys || []).forEach((k) => {
        if (k.indexOf(D_KEY_PREFIX) === 0) wx.removeStorageSync(k);
      });
    } catch (e) {
      /* noop */
    }
  }
  Object.keys(MEM).forEach((k) => {
    if (k.indexOf(D_KEY_PREFIX) === 0) delete MEM[k];
  });
}

function count() {
  let n = 0;
  if (hasStorage()) {
    try {
      const info = wx.getStorageInfoSync();
      n = (info.keys || []).filter((k) => k.indexOf(D_KEY_PREFIX) === 0).length;
    } catch (e) {
      n = 0;
    }
  }
  if (!n) n = Object.keys(MEM).filter((k) => k.indexOf(D_KEY_PREFIX) === 0).length;
  return n;
}

module.exports = { md5, fingerprint, get, set, clear, count, PREFIX: D_KEY_PREFIX };
