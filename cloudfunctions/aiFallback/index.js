/**
 * 云函数 aiFallback —— 唯一后端（契约 §5.5）
 *
 * 两件事：
 *   1. action='secCheck'  调微信内容安全接口 security.msgSecCheck
 *   2. action='chat'     大模型兜底通道（Agent / 直连失败时接手）
 *
 * 入参：
 *   { action: 'secCheck', content: string, scene: 2 }
 *   { action: 'chat', messages: [{role, content}], temperature: number, expectJson: boolean }
 *
 * 出参：
 *   { code: 0, data: any }
 *   { code: 1001, msg: '内容不合规' }
 *   { code: 1002, msg: '上游超时' }
 *   { code: 1003, msg: '上游错误', detail: string }
 *   { code: 1004, msg: '额度耗尽' }
 *   { code: 1005, msg: '参数错误' }
 *
 * 🔴 Key 只放云函数环境变量（控制台 → 云函数 → 配置）：
 *   LLM_BASE_URL  默认 https://api.deepseek.com/v1
 *   LLM_API_KEY   必填
 *   LLM_MODEL     默认 deepseek-flash
 *   前端与仓库里不得出现任何 API Key。
 */

const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 云函数平台默认超时 20s，内部留 2s 余量，先于平台超时返回可读错误
const TIMEOUT_MS = 18000;

function ok(data) {
  return { code: 0, data };
}

function fail(code, msg, detail) {
  return { code, msg, detail: detail ? String(detail).slice(0, 300) : undefined };
}

/* ------------------------------ 内容安全 ------------------------------ */

async function secCheck(event, context) {
  const content = String(event.content || '').slice(0, 500);
  if (!content) return ok({ pass: true, empty: true });

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid: (context && context.OPENID) || '',
      scene: Number(event.scene) || 2,
      version: 2,
      content
    });
    const suggest = res && res.result && res.result.suggest;
    if (suggest === 'risky') return fail(1001, '内容不合规');
    return ok({ pass: true, suggest: suggest || 'pass', label: (res && res.result && res.result.label) || 100 });
  } catch (e) {
    const errCode = e && (e.errCode || e.code);
    const errMsg = String((e && (e.errMsg || e.message)) || '');
    if (errCode === 87014 || /87014/.test(errMsg)) return fail(1001, '内容不合规');
    // 安全检查本身不可用时不能阻断主流程（否则漏网风险变成不可用风险）
    console.warn('[aiFallback] msgSecCheck unavailable:', errCode, errMsg);
    return ok({ pass: true, degraded: true });
  }
}

/* ------------------------------ 联网检索（查口碑用） ------------------------------ */

const SEARCH_MAX_ITEMS = 6;

function stripNoise(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuery(messages) {
  const lastUser = (messages || []).filter((m) => m && m.role === 'user').pop();
  const raw = String((lastUser && lastUser.content) || '');
  const hit = /\[ADVANCED_SEARCH:\s*([^\]]+)\]/.exec(raw);
  return stripNoise(hit ? hit[1] : raw).slice(0, 60);
}

/** 按 Key 前缀猜服务商，避免只填了 Tavily key 却默认走 Serper 导致 401 */
function detectProvider(key) {
  const k = String(key || '');
  if (/^tvly-/i.test(k)) return 'tavily';
  if (/^BS-/i.test(k)) return 'brave';
  return null;
}

async function searchWeb(query) {
  const key = process.env.SEARCH_API_KEY;
  if (!key) return { ok: false, reason: 'SEARCH_API_KEY 未配置' };
  let provider = String(process.env.SEARCH_PROVIDER || '').toLowerCase();
  if (!provider) {
    provider = detectProvider(key) || 'serper';
    console.log('[search] SEARCH_PROVIDER 未配置，按 Key 前缀识别为', provider);
  }
  const pick = (list) => list
    .map((x) => stripNoise(x).slice(0, 240))
    .filter(Boolean)
    .slice(0, SEARCH_MAX_ITEMS);
  try {
    if (provider === 'tavily') {
      const res = await postJson(
        'https://api.tavily.com/search',
        {},
        { api_key: key, query, max_results: SEARCH_MAX_ITEMS, search_depth: 'basic', include_answer: false }
      );
      if (res.status >= 400) return { ok: false, reason: 'HTTP ' + res.status };
      const data = JSON.parse(res.body);
      const items = pick((data.results || []).map((x) => (x.title || '') + '：' + (x.content || '')));
      return items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
    }

    if (provider === 'bocha') {
      const res = await postJson(
        'https://api.bochaai.com/v1/web-search',
        { Authorization: 'Bearer ' + key },
        { query, freshness: 'noLimit', summary: true, count: SEARCH_MAX_ITEMS }
      );
      if (res.status >= 400) return { ok: false, reason: 'HTTP ' + res.status };
      const data = JSON.parse(res.body);
      const pages = ((data.data || {}).webPages || {}).value || [];
      const items = pick(pages.map((x) => (x.name || '') + '：' + (x.summary || x.snippet || '')));
      return items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
    }

    if (provider === 'brave') {
      const url =
        'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
        '&count=' + SEARCH_MAX_ITEMS + '&country=CN&search_lang=zh-hans&text_decorations=false';
      const res = await getJson(url, { 'X-Subscription-Token': key });
      if (res.status >= 400) return { ok: false, reason: 'HTTP ' + res.status };
      const data = JSON.parse(res.body);
      const web = (data.web && data.web.results) || [];
      const items = pick(web.map((x) => (x.title || '') + '：' + (x.description || '')));
      return items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
    }

    const res = await postJson(
      'https://google.serper.dev/search',
      { 'X-API-KEY': key },
      { q: query, gl: 'cn', hl: 'zh-cn', num: SEARCH_MAX_ITEMS }
    );
    if (res.status >= 400) return { ok: false, reason: 'HTTP ' + res.status };
    const data = JSON.parse(res.body);
    const items = pick((data.organic || []).map((x) => (x.title || '') + '：' + (x.snippet || '')));
    return items.length ? { ok: true, items } : { ok: false, reason: '检索结果为空' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '检索失败' };
  }
}

/* ------------------------------ 大模型兜底 ------------------------------ */

function postJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          headers
        )
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      const err = new Error('UPSTREAM_TIMEOUT');
      err.code = 'UPSTREAM_TIMEOUT';
      req.destroy(err);
    });
    req.write(payload);
    req.end();
  });
}

function getJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: Object.assign({ Accept: 'application/json' }, headers)
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      const err = new Error('UPSTREAM_TIMEOUT');
      err.code = 'UPSTREAM_TIMEOUT';
      req.destroy(err);
    });
    req.end();
  });
}

async function chat(event) {
  console.log('[aiFallback] chat 被调用，action=chat, webSearch=', !!event.webSearch, 'searchMode=', event.searchMode || 'decide', 'messages=', (event.messages || []).length);
  const key = process.env.LLM_API_KEY;
  if (!key) {
    return fail(1003, '上游错误', 'LLM_API_KEY 未配置：请在云函数环境变量里设置');
  }

  const messages = Array.isArray(event.messages) ? event.messages : [];
  if (!messages.length) return fail(1005, '参数错误', 'messages 不能为空');
  if (messages.length > 12) return fail(1005, '参数错误', 'messages 最多 12 条');

  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'deepseek-flash';

  const modelMessages = messages.map((m) => ({
    role: m && m.role ? String(m.role) : 'user',
    content: String((m && m.content) || '')
  }));

  // 查口碑时先联网检索，再把结果注入 system prompt；检索失败则明确告知模型按无联网规则作答
  if (event.webSearch) {
    const mode = event.searchMode === 'verify' ? 'verify' : 'decide';
    const query = extractQuery(messages);
    const search = query ? await searchWeb(query) : { ok: false, reason: '检索词为空' };
    console.log('[search]', JSON.stringify({
      query,
      mode,
      ok: search.ok,
      reason: search.reason || '',
      count: search.ok ? search.items.length : 0
    }));
    const rules = mode === 'verify'
      ? [
          '优先采用有具体事实的内容（型号 / 批次 / 店铺 / 时间）；如果只有品类级口碑，也可以汇总，但要在 recent_verdict 里注明是品类通用观察。',
          '只有完全没有检索结果、或结果与关键词完全无关时，才把 status 填 "empty"；有内容就填 status="success" 并汇总，不要因为"不够具体"就丢弃。',
          '输出里不得出现任何 URL、价格数字；sources_hint 只写来源类型标签。'
        ]
      : [
          '价格可以用检索结果里的真实报价，但只能写成「数字-数字元」区间，不得出现 URL、不得写单值。',
          '检索结果里没有报价时：price_source 填 null，price_expectation 一律填空字符串，禁止用品类经验编造价格。',
          '若结果里没有用户提到的具体商品、或结果明显不相关：entity_status 填 "unknown"，',
          '把该名称写入 unverified_entities，search_keyword 去掉该名称只保留品类词。',
          'entity_status="unknown" 时 price_source 必须为 null、price_expectation 一律为空。'
        ];
    const note = search.ok
      ? [
          '# 联网检索结果（实时，共 ' + search.items.length + ' 条，仅供参考）',
          search.items.map((x, i) => (i + 1) + '. ' + x).join('\n')
        ].concat(rules).join('\n')
      : [
          '# 联网检索不可用（' + search.reason + '）',
          mode === 'verify'
            ? '没有拿到检索结果。严格按无联网规则：没有具体事实就把 status 填 "empty"，禁止编造型号、批次、店铺名。'
            : '没有拿到检索结果。price_source 填 null、price_expectation 填空字符串；',
          mode === 'decide' ? '涉及具体商品名时 entity_status 填 "unknown" 并写入 unverified_entities，只给品类通用建议。' : ''
        ].filter(Boolean).join('\n');
    if (modelMessages[0] && modelMessages[0].role === 'system') {
      modelMessages[0] = { role: 'system', content: modelMessages[0].content + '\n\n' + note };
    } else {
      modelMessages.unshift({ role: 'system', content: note });
    }
  }

  const body = {
    model,
    messages: modelMessages,
    temperature: typeof event.temperature === 'number' ? event.temperature : 0.3,
    stream: false
  };

  let res;
  try {
    res = await postJson(
      baseUrl + '/chat/completions',
      { Authorization: 'Bearer ' + key },
      body
    );
  } catch (e) {
    if (e && (e.code === 'UPSTREAM_TIMEOUT' || /timeout/i.test(String(e.message || ''))) ) {
      return fail(1002, '上游超时');
    }
    return fail(1003, '上游错误', (e && e.message) || '网络异常');
  }

  if (res.status === 429 || res.status === 402) return fail(1004, '额度耗尽', '上游返回 ' + res.status);
  if (res.status === 401 || res.status === 403) return fail(1003, '上游错误', '鉴权失败，检查 LLM_API_KEY');
  if (res.status >= 400) return fail(1003, '上游错误', 'HTTP ' + res.status + ' ' + res.body);

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return fail(1003, '上游错误', '上游返回不是 JSON');
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!text) return fail(1003, '上游错误', '上游返回内容为空');
  return ok(text);
}

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event, context) => {
  const e = event || {};
  switch (e.action) {
    case 'secCheck':
      return secCheck(e, context);
    case 'chat':
      return chat(e);
    default:
      return fail(1005, '参数错误', '未知 action：' + e.action);
  }
};
