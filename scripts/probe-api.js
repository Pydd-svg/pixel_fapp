#!/usr/bin/env node
/**
 * scripts/probe-api.js —— 大模型 / 搜索 API 本地体检（零依赖）
 *
 * 为什么要有这个脚本：
 *   云函数的自检页只能在小程序里点，且要重新部署云函数才生效。
 *   这个脚本直接在电脑上打上游 API，10 秒内回答三个问题：
 *     1) Key 是不是有效（模型侧用 /models 验证，不花 token）
 *     2) 目标模型在不在你的可用列表里（deepseek-chat / deepseek-flash 到底哪个能用）
 *     3) 搜索服务商能不能连通、召回几条、延迟多少
 *
 * 用法（Key 只走环境变量，别写进文件、别贴进聊天）：
 *   Windows Git Bash:
 *     DEEPSEEK_KEY=sk-xxx SEARCH_KEY=xxx SEARCH_PROVIDER=serper node scripts/probe-api.js
 *   PowerShell:
 *     $env:DEEPSEEK_KEY="sk-xxx"; $env:SEARCH_KEY="xxx"; node scripts/probe-api.js
 *
 * 可选环境变量：
 *   LLM_BASE_URL   默认 https://api.deepseek.com/v1
 *   LLM_MODELS     逗号分隔，默认 "deepseek-chat,deepseek-flash"
 */

const https = require('https');

const BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const LLM_KEY = process.env.DEEPSEEK_KEY || process.env.LLM_API_KEY || '';
const SEARCH_KEY = process.env.SEARCH_KEY || process.env.SEARCH_API_KEY || '';
const PROVIDER = String(process.env.SEARCH_PROVIDER || '').toLowerCase();
const MODELS = String(process.env.LLM_MODELS || 'deepseek-chat,deepseek-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const C = {
  g: process.stdout.isTTY ? '\x1b[32m' : '',
  r: process.stdout.isTTY ? '\x1b[31m' : '',
  y: process.stdout.isTTY ? '\x1b[33m' : '',
  d: process.stdout.isTTY ? '\x1b[2m' : '',
  n: process.stdout.isTTY ? '\x1b[0m' : ''
};

const mask = (k) => (!k ? '' : k.length <= 10 ? '****' : k.slice(0, 4) + '****' + k.slice(-4));
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function req(method, urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;
    const t0 = Date.now();
    const r = https.request(
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
        res.on('end', () => resolve({ status: res.statusCode, body: raw, ms: Date.now() - t0 }));
      }
    );
    r.on('error', reject);
    r.setTimeout(timeoutMs || 15000, () => {
      const e = new Error('TIMEOUT');
      r.destroy(e);
    });
    if (payload) r.write(payload);
    r.end();
  });
}

function line(title) {
  console.log('\n' + C.d + '── ' + title + ' ' + '─'.repeat(Math.max(0, 46 - title.length)) + C.n);
}

function verdict(ok, text) {
  return (ok ? C.g + 'PASS' : C.r + 'FAIL') + C.n + ' ' + text;
}

async function probeLLM() {
  line('大模型');
  if (!LLM_KEY) {
    console.log(C.y + 'SKIP' + C.n + ' 没设 DEEPSEEK_KEY / LLM_API_KEY');
    return;
  }
  console.log('端点  ' + BASE);
  console.log('Key   ' + mask(LLM_KEY));

  let models = null;
  try {
    const r = await req('GET', BASE + '/models', { Authorization: 'Bearer ' + LLM_KEY }, null, 8000);
    if (r.status === 200) {
      const d = JSON.parse(r.body || '{}');
      models = (d.data || []).map((x) => x.id).filter(Boolean);
      console.log(verdict(true, '/models ' + r.ms + 'ms  可用模型：' + (models.join(' / ') || '空')));
    } else if (r.status === 401 || r.status === 403) {
      console.log(verdict(false, 'Key 无效或过期（HTTP ' + r.status + '）'));
    } else {
      console.log(verdict(false, '/models HTTP ' + r.status + '  ' + String(r.body).slice(0, 100)));
    }
  } catch (e) {
    console.log(verdict(false, '/models 连不上：' + e.message));
  }

  // 逐个模型试一次最小生成，量「真实首个 token 延迟」
  for (const m of MODELS) {
    if (models && models.length && models.indexOf(m) === -1) {
      console.log(C.y + 'SKIP' + C.n + '  ' + pad(m, 18) + ' 不在 /models 列表里');
      continue;
    }
    try {
      const r = await req(
        'POST',
        BASE + '/chat/completions',
        { Authorization: 'Bearer ' + LLM_KEY },
        { model: m, messages: [{ role: 'user', content: '只回复 ok' }], max_tokens: 8, temperature: 0, stream: false },
        20000
      );
      if (r.status === 200) {
        const d = JSON.parse(r.body || '{}');
        const usage = d.usage || {};
        const txt = ((d.choices || [])[0] || {}).message || {};
        const out = (txt.content || txt.reasoning_content || '').slice(0, 12).replace(/\s+/g, ' ');
        console.log(
          verdict(true, pad(m, 18) + r.ms + 'ms  out=' + (usage.completion_tokens || 0) + 'tok  「' + out + '」')
        );
      } else {
        let hint = '';
        try {
          const d = JSON.parse(r.body || '{}');
          hint = (d.error && (d.error.message || d.error.code)) || '';
        } catch (e) {
          hint = String(r.body).slice(0, 80);
        }
        console.log(verdict(false, pad(m, 18) + 'HTTP ' + r.status + '  ' + hint));
      }
    } catch (e) {
      console.log(verdict(false, pad(m, 18) + e.message));
    }
  }
}

async function probeSearch() {
  line('联网搜索');
  if (!SEARCH_KEY) {
    console.log(C.y + 'SKIP' + C.n + ' 没设 SEARCH_KEY / SEARCH_API_KEY（不配也能出卡，只是没有真实报价）');
    return;
  }
  let provider = PROVIDER;
  if (!provider) {
    if (/^tvly-/i.test(SEARCH_KEY)) provider = 'tavily';
    else if (/^BS-/i.test(SEARCH_KEY)) provider = 'brave';
    else provider = 'serper';
  }
  console.log('Provider ' + provider + (PROVIDER ? '（显式）' : '（自动推断，可用 SEARCH_PROVIDER 覆盖）'));
  console.log('Key      ' + mask(SEARCH_KEY));

  const q = '初音未来 手办 价格 避坑';
  try {
    let r;
    if (provider === 'tavily') {
      r = await req('POST', 'https://api.tavily.com/search', {}, {
        api_key: SEARCH_KEY,
        query: q,
        max_results: 5,
        search_depth: 'basic',
        include_answer: false
      }, 10000);
    } else if (provider === 'bocha') {
      r = await req('POST', 'https://api.bochaai.com/v1/web-search', { Authorization: 'Bearer ' + SEARCH_KEY }, {
        query: q,
        freshness: 'noLimit',
        summary: true,
        count: 5
      }, 10000);
    } else if (provider === 'brave') {
      r = await req(
        'GET',
        'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) +
          '&count=5&country=CN&search_lang=zh-hans',
        { 'X-Subscription-Token': SEARCH_KEY },
        null,
        10000
      );
    } else {
      r = await req('POST', 'https://google.serper.dev/search', { 'X-API-KEY': SEARCH_KEY }, {
        q,
        gl: 'cn',
        hl: 'zh-cn',
        num: 5
      }, 10000);
    }

    if (r.status === 401 || r.status === 403) {
      console.log(verdict(false, 'HTTP ' + r.status + '  Key 不被该服务商接受（provider 是不是填错了？）'));
      return;
    }
    if (r.status >= 400) {
      console.log(verdict(false, 'HTTP ' + r.status + '  ' + String(r.body).slice(0, 120)));
      return;
    }

    const d = JSON.parse(r.body || '{}');
    let items = [];
    if (provider === 'tavily') items = (d.results || []).map((x) => x.title || '');
    else if (provider === 'bocha') items = (((d.data || {}).webPages || {}).value || []).map((x) => x.name || '');
    else if (provider === 'brave') items = ((d.web || {}).results || []).map((x) => x.title || '');
    else items = (d.organic || []).map((x) => x.title || '');

    if (!items.length) {
      console.log(verdict(false, '连通但 0 条结果（额度/配额或参数问题）'));
      return;
    }
    console.log(verdict(true, r.ms + 'ms  命中 ' + items.length + ' 条'));
    items.slice(0, 3).forEach((t, i) => console.log('  ' + C.d + (i + 1) + '. ' + String(t).slice(0, 60) + C.n));
    if (r.ms > 2000) console.log(C.y + '  提示：' + r.ms + 'ms 偏慢，出卡会明显被拖长，可考虑换 provider' + C.n);
  } catch (e) {
    console.log(verdict(false, e.message));
  }
}

(async () => {
  console.log(C.d + '避坑导购 · 上游 API 体检' + C.n);
  await probeLLM();
  await probeSearch();
  console.log('');
})();
