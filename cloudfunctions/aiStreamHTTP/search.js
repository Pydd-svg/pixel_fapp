/**
 * cloudfunctions/aiStreamHTTP/search.js —— 联网检索（与 aiFallback 同源的精简副本）
 *
 * ⚠️ 云函数是各自独立的部署单元，没法共享目录，所以这里是复制品。
 *    改检索策略（服务商、字段、超时）时，两个文件要一起改：
 *      cloudfunctions/aiFallback/index.js 的 searchWeb
 *      cloudfunctions/aiStreamHTTP/search.js
 */

const https = require('https');

const SEARCH_MAX_ITEMS = 6;
const SEARCH_TIMEOUT_MS = 6000;
const CACHE_TTL = 5 * 60 * 1000;
const CACHE = new Map();

function stripNoise(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectProvider(key) {
  const k = String(key || '');
  if (/^tvly-/i.test(k)) return 'tavily';
  if (/^BS-/i.test(k)) return 'brave';
  return null;
}

function req(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;
    const lib = url.protocol === 'http:' ? require('http') : https;
    const r = lib.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: Object.assign(
          { Accept: 'application/json' },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          headers
        )
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    r.on('error', reject);
    r.setTimeout(SEARCH_TIMEOUT_MS, () => {
      const e = new Error('SEARCH_TIMEOUT');
      e.code = 'UPSTREAM_TIMEOUT';
      r.destroy(e);
    });
    if (payload) r.write(payload);
    r.end();
  });
}

async function searchWeb(query) {
  const key = process.env.SEARCH_API_KEY;
  if (!key) return { ok: false, reason: 'SEARCH_API_KEY 未配置' };
  const provider = String(process.env.SEARCH_PROVIDER || '').toLowerCase() || detectProvider(key) || 'serper';

  const ck = provider + '|' + query;
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.value;

  const pick = (list) =>
    list
      .map((x) => stripNoise(x).slice(0, 240))
      .filter(Boolean)
      .slice(0, SEARCH_MAX_ITEMS);

  let ret;
  try {
    if (provider === 'tavily') {
      const r = await req('POST', 'https://api.tavily.com/search', {}, {
        api_key: key,
        query,
        max_results: SEARCH_MAX_ITEMS,
        search_depth: 'basic',
        include_answer: false
      });
      if (r.status >= 400) ret = { ok: false, reason: 'HTTP ' + r.status };
      else {
        const items = pick((JSON.parse(r.body).results || []).map((x) => (x.title || '') + '：' + (x.content || '')));
        ret = items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
      }
    } else if (provider === 'bocha') {
      const r = await req('POST', 'https://api.bochaai.com/v1/web-search', { Authorization: 'Bearer ' + key }, {
        query,
        freshness: 'noLimit',
        summary: true,
        count: SEARCH_MAX_ITEMS
      });
      if (r.status >= 400) ret = { ok: false, reason: 'HTTP ' + r.status };
      else {
        const pages = ((JSON.parse(r.body).data || {}).webPages || {}).value || [];
        const items = pick(pages.map((x) => (x.name || '') + '：' + (x.summary || x.snippet || '')));
        ret = items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
      }
    } else if (provider === 'brave') {
      const r = await req(
        'GET',
        'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
          '&count=' + SEARCH_MAX_ITEMS + '&country=CN&search_lang=zh-hans&text_decorations=false',
        { 'X-Subscription-Token': key }
      );
      if (r.status >= 400) ret = { ok: false, reason: 'HTTP ' + r.status };
      else {
        const items = pick(((JSON.parse(r.body).web || {}).results || []).map((x) => (x.title || '') + '：' + (x.description || '')));
        ret = items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
      }
    } else {
      const r = await req('POST', 'https://google.serper.dev/search', { 'X-API-KEY': key }, {
        q: query,
        gl: 'cn',
        hl: 'zh-cn',
        num: SEARCH_MAX_ITEMS
      });
      if (r.status >= 400) ret = { ok: false, reason: 'HTTP ' + r.status + ' ' + stripNoise(r.body).slice(0, 60) };
      else {
        const items = pick((JSON.parse(r.body).organic || []).map((x) => (x.title || '') + '：' + (x.snippet || '')));
        ret = items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
      }
    }
  } catch (e) {
    ret = { ok: false, reason: (e && e.message) || '检索失败' };
  }

  if (ret.ok) {
    if (CACHE.size > 50) CACHE.clear();
    CACHE.set(ck, { ts: Date.now(), value: ret });
  }
  return ret;
}

module.exports = { searchWeb, stripNoise };
