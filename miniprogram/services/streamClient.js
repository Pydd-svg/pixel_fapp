/**
 * services/streamClient.js —— 流式出卡客户端（HTTP 云函数 + SSE）
 *
 * 依赖：wx.cloud.callHTTPFunction（基础库 ≥ 3.15.1）+ 已部署的 aiStreamHTTP 云函数。
 * 任何一步不满足就返回 null，由 aiClient 回落到原来的 callFunction 通道 ——
 * 也就是说：没部署、没开开关、基础库不够，效果和现在完全一样，不会更差。
 *
 * 为什么不用 wx.request 直连：真机受 request 域名白名单限制，且会把 Key 暴露在前端。
 * HTTP 云函数走微信自己的通道，不校验外部域名，Key 留在云端。
 */

const config = require('./config');
const P = require('./sseParser');

/** 只在基础库支持 + 开关打开时才算可用 */
function supported() {
  return (
    typeof wx !== 'undefined' &&
    !!wx.cloud &&
    typeof wx.cloud.callHTTPFunction === 'function' &&
    !!config.FEATURE.stream
  );
}

function errOf(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

/**
 * 发起一次流式出卡。
 * @param {object} p
 * @param {Array}  p.messages     已拼好的 messages（system 里已含知识库约束）
 * @param {number} [p.temperature]
 * @param {boolean}[p.webSearch]
 * @param {string} [p.searchQuery]
 * @param {Function}[p.onStage]   ({stage}) 目前是 searching / writing
 * @param {Function}[p.onPreview] ({title, redFlags, names}) 增量可展示内容
 * @returns {Promise<string>} 拼好的完整模型输出文本（未解析）
 */
function decideStream(p) {
  const params = p || {};
  if (!supported()) return Promise.reject(errOf('E_UNSUPPORTED', 'stream 通道不可用'));

  const decoder = P.createUtf8Decoder();
  const parser = P.createSSEParser();
  const totalMs = config.STREAM_TOTAL_MS || 25000;

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
      const pv = P.extractPreview(acc, preview);
      const changed =
        !preview ||
        pv.title !== preview.title ||
        pv.redFlags.length !== preview.redFlags.length ||
        pv.names.length !== preview.names.length;
      if (!changed) return;
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
        path: '/decide',
        method: 'post',
        header: { 'Content-Type': 'application/json' },
        data: {
          messages: params.messages || [],
          temperature: typeof params.temperature === 'number' ? params.temperature : 0.3,
          webSearch: !!params.webSearch,
          searchQuery: params.searchQuery || ''
        },
        enableChunked: true,
        onHeadersReceived: () => {},
        onChunkedReceived: (res) => {
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

module.exports = { supported, decideStream };
