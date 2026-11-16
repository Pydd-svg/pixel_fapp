/**
 * services/streamClient.js —— 流式出卡 / 查口碑 / 通用聊天客户端（HTTP 云函数 + SSE）
 *
 * 依赖：wx.cloud.callHTTPFunction（基础库 ≥ 3.15.1）+ 已部署的 aiStreamHTTP 云函数。
 * 任何一步不满足就 reject，由上层客户端回落到 callFunction 通道 ——
 * 没部署、没开开关、基础库不够时，既有出卡和查口碑行为保持不变。
 *
 * 为什么不用 wx.request 直连：真机受 request 域名白名单限制，且会把 Key 暴露在前端。
 * HTTP 云函数走微信自己的通道，不校验外部域名，Key 留在云端。
 */

const config = require('./config');
const P = require('./sseParser');

/** 只在基础库支持 + 对应业务开关打开时才算可用 */
function supported(mode) {
  const enabled = mode === 'verify'
    ? config.FEATURE.verifyStream
    : mode === 'chat'
      ? config.FEATURE.chatStream
      : config.FEATURE.stream;
  return (
    typeof wx !== 'undefined' &&
    !!wx.cloud &&
    typeof wx.cloud.callHTTPFunction === 'function' &&
    !!enabled
  );
}

function errOf(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

/**
 * 发起一次流式请求，完整文本用于最终解析，半截 JSON 只用于预览。
 * @param {object} p
 * @param {Array}  p.messages     已拼好的 messages（system 里已含知识库约束）
 * @param {number} [p.temperature]
 * @param {boolean}[p.webSearch]
 * @param {string} [p.searchQuery]
 * @param {Function}[p.onStage]   ({stage}) 目前是 searching / writing
 * @param {Function}[p.onPreview] 当前业务的增量可展示内容
 * @returns {Promise<string>} 拼好的完整模型输出文本（未解析）
 */
function streamChat(p) {
  const params = p || {};
  const mode = params.mode === 'verify' || params.mode === 'chat' ? params.mode : 'decide';
  if (!supported(mode)) return Promise.reject(errOf('E_UNSUPPORTED', 'stream 通道不可用'));

  const decoder = P.createUtf8Decoder();
  const parser = P.createSSEParser();
  const totalMs = (mode === 'chat' ? config.CHAT_TIMEOUT_MS : config.STREAM_TOTAL_MS) || 25000;

  return new Promise((resolve, reject) => {
    let acc = '';
    let preview = null;
    let settled = false;
    let lastPushAt = 0;
    let streamError = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(errOf('E_TIMEOUT', '流式超时'));
    }, totalMs);

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const pushPreview = () => {
      if (typeof params.onPreview !== 'function') return;
      const pv = mode === 'chat'
        ? acc
        : mode === 'verify'
          ? P.extractVerifyPreview(acc, preview)
          : P.extractPreview(acc, preview);
      const unchanged = mode === 'chat'
        ? pv === preview
        : preview && JSON.stringify(pv) === JSON.stringify(preview);
      if (unchanged) return;
      // 节流：setData 太频会卡渲染，150ms 一次足够跟手
      const now = Date.now();
      if (now - lastPushAt < 150) return;
      lastPushAt = now;
      preview = pv;
      params.onPreview(pv);
    };

    const handleFrame = (frame) => {
      if (frame.event === 'stage') {
        let stage = '';
        try {
          stage = JSON.parse(frame.data).stage;
        } catch (e) {
          stage = '';
        }
        if (stage && typeof params.onStage === 'function') params.onStage({ stage });
        return;
      }
      if (frame.event === 'delta') {
        let t = '';
        try {
          t = JSON.parse(frame.data).t || '';
        } catch (e) {
          t = '';
        }
        if (t) {
          acc += t;
          pushPreview();
        }
        return;
      }
      if (frame.event === 'error') {
        try {
          const d = JSON.parse(frame.data);
          streamError = errOf(d.code || 'E_UPSTREAM', d.msg || '流式错误');
        } catch (e) {
          streamError = errOf('E_UPSTREAM', '流式错误');
        }
        return;
      }
      // done 帧不需要处理，success 回调里统一收口
    };

    try {
      wx.cloud.callHTTPFunction({
        name: config.STREAM_FN_NAME,
        config: { env: config.CLOUD_ENV_ID },
        path: '/' + mode,
        method: 'post',
        header: { 'Content-Type': 'application/json' },
        data: {
          messages: params.messages || [],
          temperature: typeof params.temperature === 'number' ? params.temperature : 0.3,
          webSearch: !!params.webSearch,
          searchQuery: params.searchQuery || '',
          searchMode: mode
        },
        enableChunked: true,
        onHeadersReceived: () => {},
        onChunkedReceived: (res) => {
          if (settled) return;
          try {
            const bytes = res && res.data ? new Uint8Array(res.data) : null;
            if (!bytes || !bytes.length) return;
            const text = decoder.decode(bytes);
            if (!text) return;
            parser.feed(text).forEach(handleFrame);
          } catch (e) {
            console.warn('[streamClient] chunk 解析失败', e && e.message);
          }
        },
        success: () => {
          if (streamError) return done(reject, streamError);
          if (!acc) return done(reject, errOf('E_PARSE', '流式返回为空'));
          done(resolve, acc);
        },
        fail: (err) => {
          done(reject, errOf('E_NET', (err && (err.errMsg || err.message)) || 'callHTTPFunction 失败'));
        }
      });
    } catch (e) {
      done(reject, errOf('E_NET', (e && e.message) || 'callHTTPFunction 异常'));
    }
  });
}

function decideStream(p) {
  return streamChat(Object.assign({}, p || {}, { mode: 'decide' }));
}

function verifyStream(p) {
  return streamChat(Object.assign({}, p || {}, { mode: 'verify' }));
}

function chatStream(p) {
  return streamChat(Object.assign({}, p || {}, { mode: 'chat' }));
}

module.exports = { supported, decideStream, verifyStream, chatStream };
