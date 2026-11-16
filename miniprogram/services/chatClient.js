const config = require('./config');
const streamClient = require('./streamClient');

const SEARCH_INTENT = /最新|近期|最近|今天|今日|昨天|明天|现在|实时|新闻|热搜|天气|汇率|股价|价格|多少钱|售价|报价|政策|规定|发布|上市|口碑|评价|评测|推荐|对比|哪个好|怎么样|值得买|搜一下|搜索|查一下|查询|资料|来源|官网|202[6-9]|20[3-9]\d|\b(?:news|weather|price|latest|search|review|compare)\b/i;
const FOLLOWUP = /^(?:那|它|这个|那个|这款|那款|还有|然后|继续|多少钱|怎么样|值得买吗)/;

function mkErr(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).trim().slice(0, 4000) }));
}

function needsWebSearch(input) {
  return SEARCH_INTENT.test(String(input || ''));
}

function buildSearchQuery(input, history) {
  const current = String(input || '').trim();
  const previous = cleanHistory(history).reverse().find((m) => m.role === 'user');
  const query = previous && FOLLOWUP.test(current) ? previous.content + '，' + current : current;
  return query.replace(/\s+/g, ' ').slice(0, 80);
}

async function secCheck(content) {
  if (!config.FEATURE.secCheck || typeof wx === 'undefined' || !wx.cloud ||
      !config.CLOUD_ENABLED || typeof wx.cloud.callFunction !== 'function') {
    return;
  }
  try {
    const r = await wx.cloud.callFunction({
      name: config.CLOUD_FN_NAME,
      data: { action: 'secCheck', content: String(content || '').slice(0, 500), scene: 2 }
    });
    const res = (r && r.result) || {};
    if (res.code === 1001 || res.code === 1000) throw mkErr('E_CONTENT', '内容不合规');
  } catch (err) {
    if (err && err.code === 'E_CONTENT') throw err;
    // 安全检查不可用时不阻断主问答，模型通道仍会返回可读错误。
  }
}

async function callFallback(params) {
  if (typeof wx === 'undefined' || !wx.cloud || !config.CLOUD_ENABLED ||
      typeof wx.cloud.callFunction !== 'function') {
    throw mkErr('E_NET', '云函数通道不可用');
  }
  let r;
  try {
    r = await wx.cloud.callFunction({
      name: config.CLOUD_FN_NAME,
      data: {
        action: 'chat',
        messages: params.messages,
        temperature: 0.5,
        expectJson: false,
        webSearch: params.webSearch,
        searchQuery: params.searchQuery,
        searchMode: 'chat'
      }
    });
  } catch (err) {
    throw mkErr('E_NET', (err && (err.errMsg || err.message)) || '云函数调用失败');
  }
  const res = (r && r.result) || {};
  if (res.code === 1001 || res.code === 1000) throw mkErr('E_CONTENT', res.msg || '内容不合规');
  if (res.code === 1002) throw mkErr('E_TIMEOUT', res.msg || '上游超时');
  if (res.code === 1004) throw mkErr('E_QUOTA', res.msg || '额度耗尽');
  if (res.code !== 0) throw mkErr('E_UNKNOWN', res.msg || '上游错误');
  const text = typeof res.data === 'string' ? res.data : '';
  if (!text.trim()) throw mkErr('E_PARSE', '回答为空');
  return text;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(mkErr('E_TIMEOUT', '聊天请求超时')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function send(options) {
  const params = options || {};
  const input = String(params.input || '').trim();
  if (!input) throw mkErr('E_BAD', '问题不能为空');
  const history = cleanHistory(params.history);
  const messages = history.slice(-9).concat([{ role: 'user', content: input.slice(0, 2000) }]);
  const webSearch = needsWebSearch(input);
  const request = {
    messages,
    webSearch,
    searchQuery: buildSearchQuery(input, history),
    temperature: 0.5,
    onStage: params.onStage,
    onPreview: params.onPreview
  };

  await secCheck(input);
  let streamError = null;
  if (streamClient.supported('chat')) {
    try {
      const text = await streamClient.chatStream(request);
      if (text.trim()) return { text: text.trim(), channel: 'stream' };
    } catch (err) {
      streamError = err;
      if (typeof params.onPreview === 'function') params.onPreview('');
    }
  }

  try {
    if (typeof params.onStage === 'function') {
      params.onStage({ stage: webSearch ? 'searching' : 'thinking' });
    }
    const text = await withTimeout(callFallback(request), config.CHAT_TIMEOUT_MS || 25000);
    if (typeof params.onPreview === 'function') params.onPreview(text);
    return { text: text.trim(), channel: 'cloudfn' };
  } catch (err) {
    if (streamError && err && err.code === 'E_NET') throw streamError;
    throw err;
  }
}

module.exports = { send, needsWebSearch, buildSearchQuery, cleanHistory };
