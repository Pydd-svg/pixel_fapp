/**
 * services/parseAgentJSON.js —— JSON 五级容错（契约 §5.2 / v2 §7.1）
 * 归属：A 岗实现，B 岗在 eval/run.js 里直接复用（纯函数，无 wx 依赖）。
 *
 * 返回 { ok, data, level, error }
 *   level 0 = 原文直解
 *   level 1 = <json> 包裹
 *   level 2 = 剥 markdown fence
 *   level 3 = 截取首尾大括号
 *   level 4 = 脏数据修复（尾逗号 / 中文引号 / 全角符号 / 缺闭合）
 *   level 5 = 失败
 *
 * 设计原则：只做「格式修复」，绝不做「语义补全」。
 * 缺失字段、空数组、单一价格这类问题交给 schema.js 判废，让重试机制处理，
 * 不在解析层偷偷编数据 —— 否则答辩时无法解释数据来源。
 */

function tryJson(text) {
  if (typeof text !== 'string') return undefined;
  const s = text.trim();
  if (!s) return undefined;
  if (s[0] !== '{' && s[0] !== '[') return undefined; // 先挡掉纯文本，省一次异常
  try {
    return JSON.parse(s);
  } catch (e) {
    return undefined;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function ok(data, level) {
  return { ok: true, data, level, error: null };
}

function fail(error) {
  return { ok: false, data: null, level: 5, error };
}

function extractJsonTag(text) {
  const m = text.match(/<json>([\s\S]*?)<\/json>/i);
  return m ? m[1] : null;
}

function stripFence(text) {
  // ```json ... ``` / ```JSON ... ``` / ``` ... ```
  const m = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (m && m[1]) return m[1].trim();
  return text.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
}

function sliceBraces(text) {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i === -1) return null;
  if (j <= i) return text.slice(i); // 只截到开头：多半是被截断了，交给 balance 补
  return text.slice(i, j + 1);
}

/** L4 脏数据修复：只动符号，不动内容 */
function repair(text) {
  let s = String(text);

  // 0) 去掉 BOM / 零宽字符 / 控制字符
  s = s.replace(/^\uFEFF/, '').replace(/[\u200B-\u200F\uFEFF]/g, '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  // 1) 全角标点 → 半角（微信公众号/输入法场景高发）
  s = s
    .replace(/[\uFF5B]/g, '{')
    .replace(/[\uFF5D]/g, '}')
    .replace(/[\uFF3B]/g, '[')
    .replace(/[\uFF3D]/g, ']')
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0C]/g, ',');

  // 2) 中文引号 → 英文引号
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  // 3) 单引号键值与字符串 → 双引号（定点替换，避免误伤 don't 这类撇号）
  s = s.replace(/([{,]\s*)'([^'\\]{1,40})'\s*:/g, '$1"$2":');
  s = s.replace(/:\s*'([^'\\]*)'/g, ': "$1"');

  // 4) 未加引号的键名
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

  // 5) 尾逗号
  s = s.replace(/,\s*([}\]])/g, '$1');

  // 6) 引号收口：模型常在字符串里用「引号」做强调，
  //    统一成英文引号后会把字符串截断（"标"电竞本"多为..."），这里把
  //    「后面不是结构符号」的引号转义成内容，而不是当成闭合。
  s = requote(s);

  // 7) 缺闭合（模型输出被截断时的高发问题）
  s = balanceBrackets(s);

  return s;
}

/**
 * 把字符串内部的裸引号转义成 \"。
 * 判据：字符串中遇到的引号，若其后第一个非空字符是 : , } ] 或结尾，视为闭合，否则当内容。
 */
function requote(s) {
  let out = '';
  let inStr = false;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (inStr && ch === '\\') {
      out += ch + (s[i + 1] || '');
      i += 2;
      continue;
    }

    if (ch === '"') {
      if (!inStr) {
        inStr = true;
        out += ch;
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      const next = s[j];
      const isClosing = next === undefined || next === ':' || next === ',' || next === '}' || next === ']';
      if (isClosing) {
        inStr = false;
        out += ch;
      } else {
        out += '\\"';
      }
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** 补全未闭合的 } 与 ]，并把截断在字符串中间的位置收口 */
function balanceBrackets(s) {
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }

  if (inStr) out += '"';
  out = out.replace(/[:,]\s*$/, ''); // 悬空的冒号/逗号
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

/**
 * @param {string} raw Agent 原始返回文本
 * @returns {{ok:boolean, data:object|null, level:number, error:string|null}}
 */
function parseAgentJSON(raw) {
  if (raw === null || raw === undefined) return fail('EMPTY');
  if (typeof raw !== 'string') {
    // 有些 SDK 会直接返回对象
    if (isPlainObject(raw)) return ok(raw, 0);
    return fail('NOT_STRING');
  }

  const text = raw.trim();
  if (!text) return fail('EMPTY');

  // L0 原文直解
  let v = tryJson(text);
  if (isPlainObject(v)) return ok(v, 0);

  // L1 <json> 包裹
  const tagged = extractJsonTag(text);
  if (tagged) {
    v = tryJson(tagged);
    if (isPlainObject(v)) return ok(v, 1);
  }

  // L2 剥 fence
  const unfenced = stripFence(text);
  if (unfenced && unfenced !== text) {
    v = tryJson(unfenced);
    if (isPlainObject(v)) return ok(v, 2);
  }

  // L3 截大括号
  const base = unfenced || text;
  const sliced = sliceBraces(base);
  if (sliced) {
    v = tryJson(sliced);
    if (isPlainObject(v)) return ok(v, 3);

    // L4 脏数据修复
    const repaired = repair(sliced);
    v = tryJson(repaired);
    if (isPlainObject(v)) return ok(v, 4);
  }

  // 没有大括号 / 修复后仍失败 → 最后再试一次整文修复（应对全角括号等）
  const repairedAll = repair(base);
  v = tryJson(repairedAll);
  if (isPlainObject(v)) return ok(v, 4);

  // 走到这里：给一个可读的错误，便于 metrics 归因
  const hasBrace = base.indexOf('{') !== -1;
  return fail(hasBrace ? 'PARSE_FAILED' : 'NO_JSON');
}

module.exports = {
  parseAgentJSON,
  // 以下仅供单测/排查使用，业务代码不要调
  _internals: { repair, balanceBrackets, stripFence, sliceBraces }
};
