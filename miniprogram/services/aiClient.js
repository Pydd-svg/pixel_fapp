/**
 * services/aiClient.js —— 三条通道的统一封装（契约 §5.1）
 * 归属：A 岗。C 岗只调用，不改。
 *
 * 对外只有三个函数：decide / verify / onStageChange（外加 dev 用的 probe）。
 * 契约硬约束：decide 与 verify **永不 reject**，任何失败都返回合法对象。
 *
 * 通道优先级（config.ADAPTER='auto' 时自动探测）：
 *   直连大模型（wx.request → OpenAI 兼容端点，默认 glm-4.7-flash，零成本）
 *     → Agent（ai.bot.sendMessage，RAG + 0 成本）
 *       → createModel().streamText（云开发 AI SDK）
 *         → 云函数 aiFallback（Key 放服务端时的正规通道）
 *           → Demo / Fixture（离线，仅演示）
 */

const config = require('./config');
const C = require('./constants');
const { parseAgentJSON } = require('./parseAgentJSON');
const S = require('./schema');
const cache = require('./cache');
const metrics = require('./metrics');
const storage = require('./storage');

const STAGE = C.STAGE;
const DECIDE_TIMEOUT_MS = config.DECIDE_TIMEOUT_MS;
const VERIFY_TIMEOUT_MS = config.VERIFY_TIMEOUT_MS;

/* ============================== 阶段广播 ============================== */

let currentStage = 'idle';
const listeners = [];

function emit(stage, payload) {
  currentStage = stage;
  listeners.slice().forEach((cb) => {
    try {
      cb(stage, payload || {});
    } catch (e) {
      // 订阅方（C 的页面）抛错不能拖垮主链路
      console.warn('[aiClient] stage listener error', e);
    }
  });
}

/**
 * @param {(stage:string, payload?:object)=>void} cb
 * @returns {()=>void} 取消订阅
 */
function onStageChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.push(cb);
  return function off() {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function getStage() {
  return currentStage;
}

/* ============================== 小工具 ============================== */

function mkErr(code, msg, extra) {
  const e = new Error(msg || code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    return obj;
  }
}

function sanitizeInput(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw);
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, C.LIMIT.RAW_INPUT); // 超长截断，不报错（L3-14）
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  history.forEach((h) => {
    if (!h || typeof h !== 'object') return;
    const role = h.role === 'assistant' ? 'assistant' : h.role === 'user' ? 'user' : null;
    const content = String(h.content || '').trim().slice(0, 300);
    if (!role || !content) return;
    out.push({ role, content });
  });
  // 最多 6 轮 = 12 条
  return out.slice(-C.LIMIT.HISTORY_ROUNDS * 2);
}

function withTimeout(task, ms) {
  const token = { aborted: false };
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      token.aborted = true;
      reject(mkErr('E_TIMEOUT', 'timeout ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => task(token)), guard]).then(
    (v) => {
      if (timer) clearTimeout(timer);
      return v;
    },
    (e) => {
      if (timer) clearTimeout(timer);
      throw e;
    }
  );
}

function getAiSdk() {
  try {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.extend) return null;
    return wx.cloud.extend.AI || null;
  } catch (e) {
    return null;
  }
}

/** 云开发环境是否真的初始化成功（决定要不要浪费时间走云函数兜底） */
/** 云开发没配置 / 已经报过「没有权限」时，本次会话内不再尝试任何云函数 */
let cloudDead = false;

function cloudReady() {
  if (cloudDead) return false;
  if (config.CLOUD_ENABLED === false) return false;
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    return !!(app && app.globalData && app.globalData.envReady);
  } catch (e) {
    return false;
  }
}

/**
 * 云函数报「没开通 / 没权限 / 环境不存在」→ 记死，后面全部跳过。
 * 这类错一次就够说明问题了，反复重试只会把控制台刷满红字。
 */
function markCloudDead(err) {
  if (cloudDead) return;
  const msg = String((err && (err.errMsg || err.message)) || err || '');
  // 只认「环境级」错误：-6010xx（没开通/没权限）、环境不存在、云托管未开通。
  // 不能拿宽泛的「没有权限」去匹配——msgSecCheck 接口自己的权限错误也长这样，
  // 那只是某个接口不能用，不该把整条云函数通道判死。
  if (/-6010\d\d|-5010\d\d|请先开通云开发|云托管|环境不存在|env.*not.*exist|INVALID_ENV|FUNCTION_NOT_FOUND|云函数不存在/i.test(msg)) {
    cloudDead = true;
    console.warn('[aiClient] 云开发不可用（' + msg.slice(0, 60) + '…），本次会话内不再尝试云函数；直连模型不受影响');
  }
}

/** 直连通道是否可用（llm.js 开着 + 有 Key + 走 direct 模式） */
function httpReady() {
  const L = config.LLM;
  return !!(L && L.enabled && L.mode === 'direct' && L.apiKey && L.model && L.baseUrl);
}

/**
 * 适配层：把 SDK 差异关在这一个函数里。
 * 答辩话术：直连模型 / Agent / 云函数四条通道可切，切换不改业务代码。
 */
let adapterMemo = null;
function resolveAdapter(botId) {
  if (config.ADAPTER && config.ADAPTER !== 'auto') return config.ADAPTER;
  if (adapterMemo) return adapterMemo;

  const ai = getAiSdk();
  if (httpReady()) {
    // 预览包里没有云开发环境，但有大模型 Key —— 直连是唯一能真出卡的通道
    adapterMemo = 'http';
  } else if (!ai) {
    adapterMemo = 'cloudfn';
  } else if (ai.bot && typeof ai.bot.sendMessage === 'function' && botId) {
    adapterMemo = 'bot';
  } else if (typeof ai.createModel === 'function') {
    adapterMemo = 'model';
  } else {
    adapterMemo = 'cloudfn';
  }
  console.info('[aiClient] adapter =', adapterMemo, '· model =', orderedModels().join(' > '));
  return adapterMemo;
}

/** 把各种 SDK 返回结构统一成纯文本 */
function pickText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (typeof res.text === 'string') return res.text;
  if (typeof res.content === 'string') return res.content;
  if (typeof res.answer === 'string') return res.answer;
  if (res.data) {
    if (typeof res.data === 'string') return res.data;
    if (typeof res.data.text === 'string') return res.data.text;
    if (typeof res.data.content === 'string') return res.data.content;
  }
  if (res.choices && res.choices[0]) {
    const m = res.choices[0].message || res.choices[0].delta || {};
    if (typeof m.content === 'string') return m.content;
  }
  if (res.result) return pickText(res.result);
  return '';
}

function chunkText(chunk) {
  if (chunk === null || chunk === undefined) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.content === 'string') return chunk.content;
  if (chunk.delta && typeof chunk.delta.content === 'string') return chunk.delta.content;
  if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
    return chunk.choices[0].delta.content || '';
  }
  return '';
}

/** 消费流式返回；token.aborted 时停止读取（超时后丢弃结果，不渲染） */
async function drainStream(stream, token) {
  let text = '';
  if (!stream) return text;

  const asAsync = typeof stream[Symbol.asyncIterator] === 'function';
  const it = asAsync ? stream[Symbol.asyncIterator]() : null;

  if (it) {
    for (;;) {
      if (token && token.aborted) break;
      const step = await it.next();
      if (!step || step.done) break;
      text += chunkText(step.value);
    }
    return text;
  }

  if (typeof stream.on === 'function') {
    // 兼容 EventEmitter 风格
    return new Promise((resolve, reject) => {
      stream.on('data', (c) => {
        if (token && token.aborted) return;
        text += chunkText(c);
      });
      stream.on('end', () => resolve(text));
      stream.on('error', (e) => reject(e));
    });
  }

  return pickText(stream);
}

async function sendViaBot(opts, token) {
  const ai = getAiSdk();
  const res = await ai.bot.sendMessage({
    botId: opts.botId,
    msg: opts.userMsg,
    messages: opts.messages,
    temperature: opts.temperature,
    stream: true
  });
  const stream = res && (res.textStream || res.stream);
  if (stream) {
    const text = await drainStream(stream, token);
    if (text) return text;
  }
  const direct = pickText(res);
  if (direct) return direct;
  throw mkErr('E_UNKNOWN', 'bot 返回结构无法识别');
}

async function sendViaModel(opts, token) {
  const ai = getAiSdk();
  const model = ai.createModel(config.MODEL_PROVIDER);
  const body = {
    model: config.MODEL_NAME,
    messages: opts.messages,
    temperature: opts.temperature
  };
  let res;
  try {
    res = await model.streamText({ data: body });
  } catch (e) {
    // 不同版本 SDK 的入参层级不同，这里做一次扁平化兜底
    res = await model.streamText(body);
  }
  const stream = res && (res.textStream || res.stream);
  if (stream) {
    const text = await drainStream(stream, token);
    if (text) return text;
  }
  const direct = pickText(res);
  if (direct) return direct;
  throw mkErr('E_UNKNOWN', 'model 返回结构无法识别');
}

/* ---------------------- 直连大模型通道（OpenAI 兼容） ---------------------- */

/** 联网检索工具：智谱按次计费（0.01 元/次），账户没钱时会 4xx，代码会自动摘掉重试 */
const WEB_SEARCH_TOOL = {
  type: 'web_search',
  web_search: { enable: true, search_result: true }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpEndpoint() {
  return String(config.LLM.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
}

/** 从上游错误体里抠一句人话（智谱是 {error:{code,message}}） */
function upstreamMessage(data, status) {
  if (data && typeof data === 'object') {
    const e = data.error || data;
    if (e && (e.message || e.msg)) return String(e.message || e.msg) + (e.code ? '（' + e.code + '）' : '');
  }
  if (typeof data === 'string' && data) return data.slice(0, 200);
  return 'HTTP ' + status;
}

function statusToCode(status, data) {
  const raw = JSON.stringify(data || '');
  // 1220 = 无权访问该模型；1211 = 模型不存在。这类只对「某个模型」无效，换模型就能救，
  // 不能当成 Key 失效（E_AUTH）直接放弃整条通道。
  if (/1220|1211|无权访问|模型不存在|model.*not.*(exist|found)/i.test(raw)) return 'E_MODEL';
  if (status === 401 || status === 403) return 'E_AUTH';
  // 1305 = 并发/访问量过大；1113 = 余额不足；1302 = 频率超限
  if (status === 429 || /1305|1302|rate|limit/i.test(raw)) return 'E_RATE';
  if (status === 408 || status === 504) return 'E_TIMEOUT';
  if (/1113|余额|balance/i.test(raw)) return 'E_QUOTA';
  return 'E_UNKNOWN';
}

/** 发一次请求，成功返回原始 payload，失败抛带 code 的 Error */
function httpOnce(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
      reject(mkErr('E_NET', 'wx.request 不可用'));
      return;
    }
    wx.request({
      url: httpEndpoint(),
      method: 'POST',
      timeout: timeoutMs,
      header: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.LLM.apiKey
      },
      data: body,
      success(res) {
        let data = res && res.data;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch (e) {
            /* 保留字符串，交给下面按状态码判 */
          }
        }
        const status = (res && res.statusCode) || 0;
        if (status >= 200 && status < 300) {
          resolve(data);
          return;
        }
        const code = statusToCode(status, data);
        const h = (res && res.header) || {};
        const ra = h['Retry-After'] || h['retry-after'] || h['Retry-after'];
        reject(mkErr(code, upstreamMessage(data, status), { status: status, retryAfter: ra ? Number(ra) * 1000 : 0 }));
      },
      fail(err) {
        const msg = (err && err.errMsg) || 'request:fail';
        if (/timeout/i.test(msg)) {
          reject(mkErr('E_TIMEOUT', msg));
        } else if (/domain|url not in|合法域名|not in domain list/i.test(msg)) {
          reject(mkErr('E_NET', '请求域名未配置：' + msg));
        } else {
          reject(mkErr('E_NET', msg));
        }
      }
    });
  });
}

/**
 * 全局串行队列：免费档并发很低，两个请求同时在天上飞只会互相把对方挤掉，
 * 所以一次只放一个请求出去，后面的排队。代价是慢一点，换来的是不互相踩。
 */
let httpQueue = Promise.resolve();
function httpQueued(body, timeoutMs) {
  const run = httpQueue.then(() => httpOnce(body, timeoutMs), () => httpOnce(body, timeoutMs));
  httpQueue = run.then(() => undefined, () => undefined);
  return run;
}

/* 模型冷却表：被限流的模型先排到队尾，冷却期过了自动回队首。
   落盘一份：不然每次重新编译都先白打一枪 4.7，控制台又冒一条 429 红字。 */
const KEY_COOLDOWN = 'llm_cooldown_v1';
const modelCooldownUntil = (function loadCooldown() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return {};
    const v = wx.getStorageSync(KEY_COOLDOWN);
    if (!v || typeof v !== 'object') return {};
    const now = Date.now();
    const out = {};
    Object.keys(v).forEach((k) => {
      if (Number(v[k]) > now) out[k] = Number(v[k]);
    });
    return out;
  } catch (e) {
    return {};
  }
})();

function saveCooldown() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
      wx.setStorageSync(KEY_COOLDOWN, modelCooldownUntil);
    }
  } catch (e) {
    /* 存不进去也不影响功能，纯减少无效请求的优化项 */
  }
}
/* 账号级限流（1302）的冷却截止时间：换模型也一样被拦，只能等 */
let accountCoolUntil = 0;

/** 按「可用优先、冷却先后」排出的模型顺序 */
function orderedModels() {
  const list = config.LLM.models && config.LLM.models.length
    ? config.LLM.models.slice()
    : [config.LLM.model];
  const now = Date.now();
  const ready = list.filter((m) => !(modelCooldownUntil[m] > now));
  const cooling = list
    .filter((m) => modelCooldownUntil[m] > now)
    .sort((a, b) => modelCooldownUntil[a] - modelCooldownUntil[b]);
  return ready.concat(cooling);
}

function coolDownModel(model, ms) {
  if (!model) return;
  const conf = config.LLM.retry || {};
  modelCooldownUntil[model] = Date.now() + (ms || conf.modelCooldownMs || 90000);
  saveCooldown();
}

/** 这个错是不是「检索工具」的锅（而不是模型的锅） */
function isToolProblem(e) {
  const msg = String((e && e.message) || '');
  return /tool|web_search|1214|1261|检索|不支持/.test(msg);
}

/** 清掉模型冷却（自检页用：想强制回到主模型时点一下） */
function resetModelCooldown() {
  Object.keys(modelCooldownUntil).forEach((k) => delete modelCooldownUntil[k]);
  accountCoolUntil = 0;
  saveCooldown();
  return orderedModels();
}

/**
 * 直连一次对话
 * 设计要点（都是被免费档 1305 打出来的教训）：
 *   1) 模型降级链：一个模型限流就立刻换下一个，不原地死等
 *   2) 请求预算：一次逻辑调用最多打 maxRequests 枪，防「重试 × 换通道」叠成风暴
 *   3) 截止时间：所有尝试都卡在外层 withTimeout 之内，绝不留下飞出去的僵尸请求
 *   4) 检索工具失败才摘工具，限流不摘——摘了也要再排一次队，纯浪费
 * @param {{messages:Array, temperature?:number, timeoutMs?:number, webSearch?:boolean}} opts
 */
async function sendViaHttp(opts, token) {
  const conf = config.LLM.retry || {};
  const maxRequests = conf.maxRequests || 5;
  const baseDelay = conf.delayMs || 900;
  const timeoutMs = opts.timeoutMs || config.LLM.timeoutMs || 20000;
  // 给外层 withTimeout 留 1.2 秒收尾，避免被硬掐断后请求还在天上飞
  const deadline = Date.now() + Math.max(4000, timeoutMs - 1200);

  const base = {
    messages: opts.messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
    stream: false
  };
  // 混合思考模型默认先想一大段，关掉后 5-6 秒就能出卡
  if (config.LLM.thinking === false) base.thinking = { type: 'disabled' };

  let useTools = !!opts.webSearch;
  let toolStripped = false;
  let sent = 0;
  let rateHits = 0;
  let lastErr = mkErr('E_UNKNOWN', '直连通道未发出请求');

  for (let round = 0; round < 2 && sent < maxRequests; round++) {
    const models = orderedModels();
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      // 同一模型最多发两次：带检索工具失败 → 摘掉工具再发一次
      for (let t = 0; t < 2; t++) {
        if (sent >= maxRequests) break;
        if (token && token.aborted) throw mkErr('E_TIMEOUT', 'aborted');

        // 账号级限流（1302）时换模型也没用，先老实等一会儿
        if (Date.now() < accountCoolUntil) {
          const wait = Math.min(accountCoolUntil - Date.now(), Math.max(0, deadline - Date.now() - 2500));
          if (wait > 200) await sleep(wait);
        }

        const left = deadline - Date.now();
        if (left < 1500) throw lastErr.code && lastErr.code !== 'E_UNKNOWN' ? lastErr : mkErr('E_TIMEOUT', '排队超时');

        const body = Object.assign({}, base, { model: model });
        if (useTools) body.tools = [WEB_SEARCH_TOOL];

        sent += 1;
        try {
          // 单个请求不占满整个超时预算：留出至少一次换模型的机会。
          // 第一枪卡得更紧（9 秒）：主模型正常 6-8 秒就回，没回基本就是它在排队，
          // 与其干等 15 秒，不如立刻换那个实测 8 秒稳定的替补。
          const perTry = sent === 1
            ? Math.min(left, 9000)
            : Math.min(left, Math.max(9000, Math.round(timeoutMs * 0.6)));
          const payload = await httpQueued(body, perTry);
          const text = pickText(payload);
          if (!text) throw mkErr('E_PARSE', '模型返回内容为空');
          if (modelCooldownUntil[model]) {
            delete modelCooldownUntil[model];
            saveCooldown();
          }
          if (model !== config.LLM.model) {
            const why = modelCooldownUntil[config.LLM.model] > Date.now() ? '主模型冷却中' : '主模型不可用';
            console.info('[aiClient] ' + why + '，本次由', model, '出卡（第', sent, '枪）');
          } else {
            console.info('[aiClient] http ok', model, '第', sent, '枪');
          }
          return text;
        } catch (e) {
          lastErr = e;
          const msg = String(e.message || '');
          console.warn('[aiClient] http fail', model, e.code, msg);

          // Key 完全无效：换模型也救不了，直接抛，别再空打
          if (e.code === 'E_AUTH') throw e;

          // 检索工具不可用（没开通 / 余额不足 / 模型不支持）→ 摘掉工具，同模型再发一次
          const stripNow =
            useTools &&
            !toolStripped &&
            (isToolProblem(e) || e.code === 'E_UNKNOWN' || e.code === 'E_QUOTA');
          if (stripNow) {
            toolStripped = true;
            useTools = false;
            console.warn('[aiClient] web_search 不可用，改走纯模型推理：', msg);
            continue;
          }

          if (e.code === 'E_RATE') {
            rateHits += 1;
            if (/1305/.test(msg)) {
              // 1305：只有这个模型过载，换下一个立刻见效
              coolDownModel(model, e.retryAfter || conf.modelCooldownMs || 90000);
            } else {
              // 1302：整个账号的频率限制，换模型一样被拦，只能退避等待
              accountCoolUntil = Date.now() + Math.min(2000, 700 + 400 * rateHits);
              if (rateHits >= 3) throw e; // 连续被拦三次就别硬冲了，老实降级
            }
          } else if (e.code === 'E_MODEL') {
            coolDownModel(model, 600000); // 没权限的模型，10 分钟内别碰
          } else if (e.code === 'E_TIMEOUT') {
            coolDownModel(model, 30000);
          } else if (e.code === 'E_QUOTA') {
            throw e; // 账户欠费，换模型也不解决
          }
          break; // 这个模型这轮放弃，换下一个
        }
      }
    }

    // 一轮打完还没成功：等一会儿再补一轮（预算和时间都够才等）
    if (round === 0 && sent < maxRequests && Date.now() + baseDelay + 600 < deadline) {
      emit('merging', { channel: 'http', retry: true, wait_ms: baseDelay });
      await sleep(baseDelay + Math.floor(Math.random() * 400));
    } else {
      break;
    }
  }
  throw lastErr;
}

async function callCloudChat(opts) {
  if (!cloudReady()) throw mkErr('E_NET', '云开发未配置，云函数通道不可用');
  let r;
  try {
    r = await wx.cloud.callFunction({
      name: config.CLOUD_FN_NAME,
      data: {
        action: 'chat',
        messages: opts.messages,
        temperature: opts.temperature,
        expectJson: !!opts.expectJson
      }
    });
  } catch (e) {
    markCloudDead(e);
    throw mkErr('E_NET', (e && (e.errMsg || e.message)) || '云函数调用失败');
  }
  const res = (r && r.result) || null;
  if (!res || typeof res.code !== 'number') throw mkErr('E_UNKNOWN', '云函数无返回');

  if (res.code === 0) {
    const d = res.data;
    return typeof d === 'string' ? d : JSON.stringify(d);
  }
  if (res.code === 1001) throw mkErr('E_CONTENT', res.msg || '内容不合规');
  if (res.code === 1002) throw mkErr('E_TIMEOUT', res.msg || '上游超时');
  if (res.code === 1004) throw mkErr('E_QUOTA', res.msg || '额度耗尽');
  throw mkErr('E_UNKNOWN', (res.msg || '上游错误') + (res.detail ? '：' + res.detail : ''));
}

/** 按通道发一次请求，返回 {text, channel} */
async function invokeSource(source, opts) {
  const timeoutMs = opts.timeoutMs || DECIDE_TIMEOUT_MS;
  if (source === 'http') {
    return { text: await withTimeout((t) => sendViaHttp(opts, t), timeoutMs), channel: 'http' };
  }
  if (source === 'cloudfn') {
    return { text: await withTimeout(() => callCloudChat(opts), timeoutMs), channel: 'cloudfn' };
  }
  if (source === 'model') {
    return { text: await withTimeout((t) => sendViaModel(opts, t), timeoutMs), channel: 'model' };
  }
  return { text: await withTimeout((t) => sendViaBot(opts, t), timeoutMs), channel: 'agent' };
}

/* ============================ Demo / Fixture ============================ */

function loadDemo() {
  try {
    return require('../demo/replay.js');
  } catch (e) {
    return null;
  }
}

function loadMock() {
  try {
    return require('../mock/index.js');
  } catch (e) {
    return null;
  }
}

let demoState = { id: null, step: 0 };

function isDemoMode() {
  return !!config.FEATURE.demoMode || storage.getDemoMode();
}

function setDemoMode(on) {
  config.FEATURE.demoMode = !!on;
  storage.setDemoMode(!!on);
  demoState = { id: null, step: 0 };
  return !!on;
}

function resetDemo() {
  demoState = { id: null, step: 0 };
}

function findReplay(input) {
  const demo = loadDemo();
  const list = (demo && demo.replays) || [];
  if (!list.length) return null;
  const text = String(input || '');
  let hit = list.filter((r) => (r.entryKeywords || []).some((k) => text.indexOf(k) !== -1))[0];
  if (!hit) hit = list[0];
  return hit;
}

function demoDecide(input) {
  const r = findReplay(input);
  if (!r) return null;
  // 演示要完整走「输入 → 追问 → 补充 → 出卡」，所以第一轮先给追问
  if (r.followup && demoState.id !== r.id) {
    demoState = { id: r.id, step: 1 };
    return followupCard(r.followup.question, 'demo');
  }
  demoState = { id: r.id, step: 2 };
  return clone(r.card);
}

function demoVerify(keyword) {
  const demo = loadDemo();
  const list = (demo && demo.replays) || [];
  const text = String(keyword || '');
  let hit = list.filter((r) => {
    const kw = r.card && r.card.decision_data ? r.card.decision_data.search_keyword : '';
    return kw && (kw.indexOf(text) !== -1 || text.indexOf(kw) !== -1);
  })[0];
  if (!hit) hit = list[0];
  return hit ? clone(hit.verify) : null;
}

function fixtureDecide(input) {
  const mock = loadMock();
  if (!mock || !mock.cards) return null;
  const cat = guessCategory(input);
  const key = mock.byCategory && mock.byCategory[cat] ? mock.byCategory[cat] : 'card-laptop';
  return clone(mock.cards[key] || mock.cards['card-laptop']);
}

function fixtureVerify() {
  const mock = loadMock();
  return mock && mock.verify ? clone(mock.verify.ok) : null;
}

/* ============================== 结果装配 ============================== */

const CATEGORY_HINTS = [
  [/(笔记本|电脑|轻薄本|游戏本|写代码|剪视频|显卡|cpu|内存条)/i, 'laptop'],
  [/(耳机|蓝牙|充电宝|移动电源|u盘|存储卡|固态|音箱|键盘|鼠标)/i, 'digital'],
  [/(手办|潮玩|盲盒|景品|粘土人|模型|谷子|吧唧|高达)/i, 'chao_wan'],
  [/(面霜|精华|水乳|防晒|口红|粉底|护肤|美妆|面膜|洗面奶)/i, 'beauty'],
  [/(被子|枕头|床垫|四件套|床单|凉席)/i, 'bed'],
  // 学习用品：教材/教辅/文具。/ 笔记本 / 已被上面的 laptop 先命中，
  // 所以这里用「教材/课本/练习册」这类无歧义词，避免把笔记本本体误判成文具。
  [/(教材|教辅|课本|练习册|真题|文具|中性笔|签字笔|打印|复印|装订)/i, 'study']
];

function guessCategory(input) {
  const text = String(input || '');
  for (let i = 0; i < CATEGORY_HINTS.length; i++) {
    if (CATEGORY_HINTS[i][0].test(text)) return CATEGORY_HINTS[i][1];
  }
  return 'universal';
}

function followupCard(question, channel, startedAt) {
  return {
    status: 'success',
    error_code: null,
    is_followup: true,
    followup_question: String(question || '').slice(0, C.LIMIT.FOLLOWUP),
    decision_data: null,
    meta: {
      elapsed_ms: startedAt ? Date.now() - startedAt : 0,
      channel: channel || 'local',
      cache_hit: false
    }
  };
}

function stamp(card, startedAt, channel, cacheHit) {
  const c = clone(card);
  c.meta = c.meta || {};
  c.meta.elapsed_ms = startedAt ? Date.now() - startedAt : c.meta.elapsed_ms || 0;
  c.meta.channel = channel;
  c.meta.cache_hit = !!cacheHit;
  return c;
}

function record(action, card, startedAt, extra) {
  const meta = (card && card.meta) || {};
  metrics.record({
    action,
    stage: currentStage,
    elapsed: startedAt ? Date.now() - startedAt : 0,
    status: card && card.status,
    // 查证降级时错误码挂在 meta 上（VerifyResult 顶层没有该字段）
    error_code: (card && (card.error_code || meta.error_code)) || '',
    cache_hit: !!meta.cache_hit,
    channel: meta.channel || '',
    parse_level: extra && extra.level
  });
}

/* ============================== 内容安全 ============================== */

async function secCheck(content) {
  if (!config.FEATURE.secCheck) return { ok: true, skipped: true };
  if (typeof wx === 'undefined' || !wx.cloud) return { ok: true, skipped: true };
  // 没配云开发环境时不要白等一次 callFunction（直连模式下这是最常见的状态）
  if (!cloudReady()) return { ok: true, skipped: true, error: 'CLOUD_NOT_READY' };
  try {
    const r = await wx.cloud.callFunction({
      name: config.CLOUD_FN_NAME,
      data: { action: 'secCheck', content: String(content || '').slice(0, 500), scene: 2 }
    });
    const res = (r && r.result) || {};
    if (res.code === 1001) return { ok: false, code: 'E_CONTENT' };
    return { ok: true };
  } catch (e) {
    // 安全检查不可用时不能阻断主流程（否则漏网风险转成不可用风险）
    markCloudDead(e);
    console.warn('[aiClient] secCheck skipped:', e && e.message);
    return { ok: true, error: 'SEC_CHECK_UNAVAILABLE' };
  }
}

/* ============================== 决策主流程 ============================== */

async function attemptDecide(messages, opts) {
  const o = opts || {};
  const primary = resolveAdapter(config.BOT_ID_DECIDE);
  // 直连通道内部已经做了模型降级 + 重试，外层再叠一次只会把请求数翻倍
  const plan = [{ source: primary, attempts: primary === 'http' ? 1 : 2 }];
  if (config.FEATURE.useFallback && primary !== 'cloudfn' && cloudReady()) {
    plan.push({ source: 'cloudfn', attempts: 1 });
  }

  let lastErr = mkErr('E_UNKNOWN', 'no channel');
  let lastLevel = null;

  for (let p = 0; p < plan.length; p++) {
    const step = plan[p];
    for (let i = 0; i < step.attempts; i++) {
      const isRetry = i > 0;
      emit(isRetry ? 'merging' : p === 0 ? 'generating' : 'merging', { channel: step.source, retry: isRetry });
      try {
        const res = await invokeSource(step.source, {
          botId: config.BOT_ID_DECIDE,
          userMsg: o.userMsg,
          messages: isRetry ? messages.concat([{ role: 'user', content: RETRY_HINT }]) : messages,
          temperature: isRetry ? 0 : o.temperature,
          expectJson: true,
          timeoutMs: o.timeoutMs || DECIDE_TIMEOUT_MS
        });

        const parsed = parseAgentJSON(res.text);
        lastLevel = parsed.level;
        if (!parsed.ok) throw mkErr('E_PARSE', '解析失败 level5:' + parsed.error, { level: 5 });

        emit('merging', { channel: res.channel, level: parsed.level });
        const norm = S.normalizeDecisionCard(parsed.data);
        if (!norm.ok) throw mkErr('E_PARSE', '判废：' + norm.errors.join('；'), { level: parsed.level });

        return { ok: true, card: norm.card, channel: res.channel, level: parsed.level };
      } catch (e) {
        lastErr = e;
        console.warn('[aiClient] decide attempt fail', step.source, i, e.code, e.message);
        // 内容不合规 / 额度耗尽 / Key 无效重试没有意义，直接换通道
        if (e.code === 'E_CONTENT' || e.code === 'E_QUOTA' || e.code === 'E_AUTH') break;
        if (e.code === 'E_TIMEOUT' && i === 0) continue; // 超时重试一次，仍超时就走下一个通道
      }
    }
  }
  return { ok: false, error: lastErr, level: lastLevel };
}

const RETRY_HINT =
  '上一次的输出无法解析或缺少必填字段。请只输出一个 <json></json> 包裹的 JSON 对象，' +
  '不要任何解释文字；必须包含 status / is_followup / followup_question / decision_data，' +
  'decision_data 必须含 card_title / category / budget_band / tags / recommendations / red_flags / ' +
  'search_keyword / knowledge_refs / confidence / disclaimer；recommendations 1-2 项、red_flags 1-3 条，' +
  'price_expectation 必须写成「数字-数字元」的区间。';

function mapErrorToCode(err) {
  if (!err) return 'E_UNKNOWN';
  if (err.code && C.ERROR_CODE[err.code]) return err.code;
  const msg = String(err.message || err.errMsg || '');
  if (/timeout|timed?\s*out/i.test(msg)) return 'E_TIMEOUT';
  if (/quota|limit|exceed|额度/i.test(msg)) return 'E_QUOTA';
  if (/network|net::|offline|fail.*request|域名/i.test(msg)) return 'E_NET';
  return 'E_UNKNOWN';
}

/**
 * 主决策接口（契约 §5.1）
 * @param {{rawInput:string, history?:Array, sessionId?:string}} p
 * @returns {Promise<object>} DecisionCard —— 永不 reject
 */
async function decide(p) {
  const started = Date.now();
  const params = p || {};
  const input = sanitizeInput(params.rawInput);
  const history = normalizeHistory(params.history);
  emit('judging', { input });

  try {
    // 0) 空输入：直接追问，不浪费一次调用
    if (!input) {
      const card = followupCard('想买什么？大概预算多少？比如「初音手办 300 以内」。', 'local', started);
      emit('done', { followup: true });
      record('decide', card, started);
      return card;
    }

    // 1) Demo 模式：所有网络调用短路（飞行模式也能演示）
    if (isDemoMode()) {
      const demoCard = demoDecide(input);
      if (demoCard) {
        const card = stamp(demoCard, started, 'demo', false);
        emit(card.status === 'degraded' ? 'degraded' : 'done', { demo: true, followup: card.is_followup });
        record('decide', card, started);
        return card;
      }
    }

    // 2) 本地样例通道（C 查样式时用，契约 §6.3 责任边界第一条）
    if (config.FEATURE.useFixture) {
      const fx = fixtureDecide(input);
      if (fx) {
        const card = stamp(fx, started, 'fixture', false);
        emit('done', { fixture: true });
        record('decide', card, started);
        return card;
      }
    }

    // 3) 内容安全
    const sec = await secCheck(input);
    if (!sec.ok) {
      const card = S.buildDegradedCard('E_CONTENT', {
        title: '这句话我先不处理',
        recName: '换个说法再说一次',
        pros: '描述你想买的东西和预算就行，不用带其他内容',
        cons: '被内容安全策略拦截，未产生任何模型调用',
        tips: ['避免涉及违禁品、医疗功效、金融投资等表述', '直接说品类 + 预算最有效', '不确定就换个中性说法重试'],
        keyword: '学生党 避坑 选购指南',
        elapsed_ms: Date.now() - started
      });
      card.meta.elapsed_ms = Date.now() - started;
      emit('degraded', { error_code: 'E_CONTENT' });
      record('decide', card, started);
      return card;
    }

    // 4) 缓存（需求指纹 24h）
    const category = guessCategory(input);
    const fp = cache.fingerprint(input, category);
    const cached = cache.get(fp);
    if (cached) {
      const card = stamp(cached, started, 'cache', true);
      emit('done', { cache_hit: true, followup: card.is_followup });
      record('decide', card, started);
      return card;
    }

    // 5) 每日限额（纯前端，超额仍可看档案）
    //    FEATURE.quota=false 时整段跳过，只留用量埋点
    if (config.FEATURE.quota) {
      const quota = storage.checkQuota('decide', config.LIMIT);
      if (!quota.allowed) {
        const card = S.buildDegradedCard('E_QUOTA', {
          title: '今天的次数用完了',
          recName: '明天再来，先看我的档案',
          pros: '历史卡片都在「我的档案」里，随时能翻',
          cons: '本地限额，为的是把额度留给真正要买的那次',
          tips: ['每天 5 次决策、3 次查证', '档案页的历史卡片不消耗次数', '急用可在开发自检页重置计数'],
          keyword: '我的档案 历史决策卡',
          elapsed_ms: Date.now() - started
        });
        card.meta.elapsed_ms = Date.now() - started;
        emit('degraded', { error_code: 'E_QUOTA', quota });
        record('decide', card, started);
        return card;
      }
    }

    // 6) 主调用链
    //    直连 / 云函数通道没有挂知识库，必须补一段「能力边界」约束，
    //    否则模型会编 knowledge_refs 和具体批次（schema 会判废，白白多花一次调用）
    const primary = resolveAdapter(config.BOT_ID_DECIDE);
    const systemContent =
      config.DECIDE_SYSTEM_PROMPT + (primary === 'bot' ? '' : config.PROMPT_PATCH_NO_KB);
    const messages = [{ role: 'system', content: systemContent }]
      .concat(history.slice(-6))
      .concat([{ role: 'user', content: input }]);

    storage.bumpUsage('decide');
    emit('generating', { channel: primary });

    const result = await attemptDecide(messages, { userMsg: input, temperature: 0.3, timeoutMs: DECIDE_TIMEOUT_MS });

    if (result.ok) {
      const card = stamp(result.card, started, result.channel, false);
      // 只缓存成功结果，避免把降级卡污染 24 小时
      cache.set(fp, card, config.CACHE_TTL.decide);
      emit('done', { channel: result.channel, level: result.level, followup: card.is_followup });
      record('decide', card, started, { level: result.level });
      return card;
    }

    // 7) 全链路失败 → 降级模板卡（不是空白）
    const code = mapErrorToCode(result.error);
    const card = S.buildDegradedCard(code, { elapsed_ms: Date.now() - started });
    card.meta.elapsed_ms = Date.now() - started;
    emit('degraded', { error_code: code });
    record('decide', card, started, { level: result.level });
    return card;
  } catch (err) {
    // 兜底中的兜底：连降级卡都没造出来，也要返回合法对象
    const card = S.buildDegradedCard(mapErrorToCode(err), { elapsed_ms: Date.now() - started });
    card.meta.elapsed_ms = Date.now() - started;
    emit('degraded', { error_code: card.error_code });
    record('decide', card, started);
    return card;
  }
}

/* ============================== 查证流程 ============================== */

function degradedVerify(code, startedAt) {
  return {
    status: 'degraded',
    search_summary: {
      recent_verdict: '当前检索繁忙，先看基础决策',
      community_feedback: [],
      caution_alert: '',
      sources_hint: []
    },
    meta: {
      elapsed_ms: Date.now() - (startedAt || Date.now()),
      degraded: true,
      cache_hit: false,
      channel: 'degraded',
      error_code: C.ERROR_CODE[code] ? code : 'E_UNKNOWN'
    }
  };
}

/**
 * 进阶查证接口（契约 §5.1）
 * @param {{searchKeyword:string, cardTitle?:string}} p
 * @returns {Promise<object>} VerifyResult —— 永不 reject
 */
async function verify(p) {
  const started = Date.now();
  const params = p || {};
  const keyword = String(params.searchKeyword || '').trim().slice(0, C.LIMIT.SEARCH_KEYWORD);
  const cardTitle = String(params.cardTitle || '').slice(0, 40);
  emit('verifying', { keyword });

  try {
    if (!keyword) {
      const r = degradedVerify('E_PARSE', started);
      r.search_summary.recent_verdict = '没有拿到可检索的关键词，回上一页重新出卡试试';
      record('verify', r, started);
      return r;
    }

    // Demo / Fixture 短路
    if (isDemoMode()) {
      const d = demoVerify(keyword);
      if (d) {
        d.meta = Object.assign({}, d.meta, { elapsed_ms: Date.now() - started, channel: 'demo', cache_hit: false });
        emit('done', { demo: true, status: d.status });
        record('verify', d, started);
        return d;
      }
    }
    if (config.FEATURE.useFixture) {
      const f = fixtureVerify();
      if (f) {
        f.meta = Object.assign({}, f.meta, { elapsed_ms: Date.now() - started, channel: 'fixture' });
        emit('done', { fixture: true });
        record('verify', f, started);
        return f;
      }
    }

    // 缓存 2h
    const ck = cache.fingerprint('verify:' + keyword, '');
    const cached = cache.get(ck);
    if (cached) {
      const r = clone(cached);
      r.meta = Object.assign({}, r.meta, { elapsed_ms: Date.now() - started, cache_hit: true, channel: 'cache' });
      emit('done', { cache_hit: true, status: r.status });
      record('verify', r, started);
      return r;
    }

    // FEATURE.quota=false 时跳过限额，只保留用量埋点
    if (config.FEATURE.quota) {
      const quota = storage.checkQuota('verify', config.LIMIT);
      if (!quota.allowed) {
        const r = degradedVerify('E_QUOTA', started);
        r.search_summary.recent_verdict = '今天的查证次数用完了，明天再来';
        record('verify', r, started);
        return r;
      }
    }

    const userMsg = '[ADVANCED_SEARCH: ' + keyword + ']' + (cardTitle ? '\n商品上下文：' + cardTitle : '');

    const primary = resolveAdapter(config.BOT_ID_VERIFY);
    // 直连通道可以挂联网检索（搜索工具按次计费，失败会自动摘掉降级）
    const wantSearch = !!(primary === 'http' && config.LLM && config.LLM.enabled && config.LLM.verifyWebSearch);
    const verifyPatch =
      primary === 'bot'
        ? ''
        : wantSearch
        ? config.PROMPT_PATCH_VERIFY_SEARCH
        : config.PROMPT_PATCH_VERIFY_NO_SEARCH;

    const messages = [
      { role: 'system', content: config.VERIFY_SYSTEM_PROMPT + verifyPatch },
      { role: 'user', content: userMsg }
    ];

    storage.bumpUsage('verify');

    // 直连通道内部已换模型重试过，这里不再重复打（否则 2×5 枪会把自己限流死）
    const plan = [{ source: primary, attempts: primary === 'http' ? 1 : 2 }];
    if (config.FEATURE.useFallback && primary !== 'cloudfn' && cloudReady()) {
      plan.push({ source: 'cloudfn', attempts: 1 });
    }

    let lastErr = null;
    for (let pi = 0; pi < plan.length; pi++) {
      for (let i = 0; i < plan[pi].attempts; i++) {
        try {
          const res = await invokeSource(plan[pi].source, {
            botId: config.BOT_ID_VERIFY,
            userMsg,
            messages: i > 0 ? messages.concat([{ role: 'user', content: '只输出 <json></json> 包裹的 JSON，不要解释文字。' }]) : messages,
            temperature: i > 0 ? 0 : 0.5,
            expectJson: true,
            webSearch: wantSearch && plan[pi].source === 'http' && i === 0,
            timeoutMs: VERIFY_TIMEOUT_MS
          });

          const parsed = parseAgentJSON(res.text);
          if (!parsed.ok) throw mkErr('E_PARSE', '解析失败 level5:' + parsed.error, { level: 5 });
          const norm = S.normalizeVerifyResult(parsed.data);
          if (!norm.ok) throw mkErr('E_PARSE', '判废：' + norm.errors.join('；'), { level: parsed.level });

          const r = norm.result;
          r.meta = {
            elapsed_ms: Date.now() - started,
            degraded: false,
            cache_hit: false,
            channel: res.channel
          };
          if (r.status !== 'degraded' && r.status !== 'error') cache.set(ck, r, config.CACHE_TTL.verify);
          emit('done', { status: r.status, channel: res.channel });
          record('verify', r, started, { level: parsed.level });
          return r;
        } catch (e) {
          lastErr = e;
          if (e.code === 'E_CONTENT' || e.code === 'E_QUOTA') break;
        }
      }
    }

    const code = mapErrorToCode(lastErr);
    const r = degradedVerify(code, started);
    // 说人话：让人知道是「模型排队」而不是「功能坏了」，等十几秒再点就有
    if (code === 'E_RATE' || code === 'E_TIMEOUT') {
      r.search_summary.recent_verdict = '模型正在排队，等十几秒再点一次「查口碑」就行';
    } else if (code === 'E_MODEL') {
      r.search_summary.recent_verdict = '备用模型都不可用，过几分钟再试';
    }
    emit('degraded', { error_code: code });
    record('verify', r, started);
    return r;
  } catch (err) {
    const r = degradedVerify(mapErrorToCode(err), started);
    emit('degraded', { error_code: r.meta.error_code });
    record('verify', r, started);
    return r;
  }
}

/* ============================== dev 自检 ============================== */

/**
 * 单次直调，不解析、不降级、不写缓存：把原始返回原样打出来。
 * 用途：D2 通道验证（P1-1.6）、抓 shared/fixtures/raw-sample-decision.txt
 */
async function probe(opts) {
  const o = opts || {};
  const input = sanitizeInput(o.rawInput || '想买个初音手办 300以内');
  const source = o.source || resolveAdapter(config.BOT_ID_DECIDE);
  const messages = [
    { role: 'system', content: config.DECIDE_SYSTEM_PROMPT + (source === 'bot' ? '' : config.PROMPT_PATCH_NO_KB) },
    { role: 'user', content: input }
  ];
  try {
    const res = await invokeSource(source, {
      botId: config.BOT_ID_DECIDE,
      userMsg: input,
      messages,
      temperature: 0.3,
      expectJson: true,
      timeoutMs: DECIDE_TIMEOUT_MS
    });
    const parsed = parseAgentJSON(res.text);
    return {
      ok: true,
      source,
      channel: res.channel,
      raw: res.text,
      raw_length: res.text.length,
      parse_ok: parsed.ok,
      parse_level: parsed.level,
      parse_error: parsed.error,
      preview: parsed.ok ? JSON.stringify(parsed.data).slice(0, 300) : ''
    };
  } catch (e) {
    return { ok: false, source, error: (e.code || 'E_UNKNOWN') + '：' + (e.message || ''), raw: '' };
  }
}

module.exports = {
  decide,
  verify,
  onStageChange,
  probe,
  getStage,
  setDemoMode,
  isDemoMode,
  resetDemo,
  STAGE,
  DECIDE_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  // 以下给 dev 页/排障用
  _internals: { guessCategory, resolveAdapter, secCheck, orderedModels, resetModelCooldown }
};
