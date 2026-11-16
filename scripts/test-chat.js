const assert = require('assert');
const config = require('../miniprogram/services/config');
const streamClient = require('../miniprogram/services/streamClient');
const chatClient = require('../miniprogram/services/chatClient');

config.CLOUD_ENABLED = true;
let passed = 0;
let failed = 0;

function useCloud(handler) {
  global.wx = { cloud: { callFunction: handler } };
}

function reset() {
  config.FEATURE.secCheck = false;
  config.CHAT_TIMEOUT_MS = 100;
  streamClient.supported = () => false;
  streamClient.chatStream = async () => {
    const err = new Error('未配置流式 mock');
    err.code = 'E_UNSUPPORTED';
    throw err;
  };
  useCloud(async () => { throw new Error('未配置云函数 mock'); });
}

async function test(name, fn) {
  reset();
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL  ' + name + ' → ' + err.message);
  } finally {
    reset();
  }
}

(async () => {
  console.log('\n通用聊天客户端：');

  await test('自动联网意图与追问检索词', async () => {
    assert.strictEqual(chatClient.needsWebSearch('你好'), false);
    assert.strictEqual(chatClient.needsWebSearch('写一首关于春天的诗'), false);
    assert.strictEqual(chatClient.needsWebSearch('相对论是什么'), false);
    assert.strictEqual(chatClient.needsWebSearch('今天的 AI 新闻'), true);
    assert.strictEqual(chatClient.needsWebSearch('索尼耳机口碑怎么样'), true);
    const query = chatClient.buildSearchQuery('那最近价格呢', [
      { role: 'user', content: '索尼A5200' },
      { role: 'assistant', content: '你想了解哪方面？' }
    ]);
    assert.strictEqual(query, '索尼A5200，那最近价格呢');
  });

  await test('非流式通道只带最近十条消息', async () => {
    let payload;
    useCloud(async ({ data }) => {
      if (data.action === 'chat') payload = data;
      return { result: { code: 0, data: '后备回答' } };
    });
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'm' + i
    }));
    history.unshift({ role: 'system', content: '不得上传' });
    const previews = [];
    const res = await chatClient.send({
      input: '  你好  ',
      history,
      onPreview: (text) => previews.push(text)
    });
    assert.strictEqual(res.channel, 'cloudfn');
    assert.strictEqual(res.text, '后备回答');
    assert.strictEqual(payload.messages.length, 10);
    assert.strictEqual(payload.messages[0].content, 'm3');
    assert.strictEqual(payload.messages[9].content, '你好');
    assert.strictEqual(payload.webSearch, false);
    assert.strictEqual(payload.searchMode, 'chat');
    assert.ok(!payload.messages.some((m) => m.role === 'system'));
    assert.deepStrictEqual(previews, ['后备回答']);
  });

  await test('流式纯文本成功并携带自动检索参数', async () => {
    let request;
    streamClient.supported = () => true;
    streamClient.chatStream = async (req) => {
      request = req;
      req.onPreview('流式');
      req.onPreview('流式回答');
      return '  流式回答  ';
    };
    const previews = [];
    const res = await chatClient.send({
      input: '那最近价格呢',
      history: [{ role: 'user', content: '索尼A5200' }],
      onPreview: (text) => previews.push(text)
    });
    assert.strictEqual(res.channel, 'stream');
    assert.strictEqual(res.text, '流式回答');
    assert.strictEqual(request.webSearch, true);
    assert.strictEqual(request.searchQuery, '索尼A5200，那最近价格呢');
    assert.deepStrictEqual(previews, ['流式', '流式回答']);
  });

  await test('流式失败清空半截内容且只回退一次', async () => {
    let fallbackCalls = 0;
    streamClient.supported = () => true;
    streamClient.chatStream = async (req) => {
      req.onPreview('半截');
      const err = new Error('流式断开');
      err.code = 'E_NET';
      throw err;
    };
    useCloud(async ({ data }) => {
      if (data.action === 'chat') fallbackCalls += 1;
      return { result: { code: 0, data: '完整回答' } };
    });
    const previews = [];
    const res = await chatClient.send({
      input: '最新价格',
      onPreview: (text) => previews.push(text)
    });
    assert.strictEqual(res.channel, 'cloudfn');
    assert.strictEqual(fallbackCalls, 1);
    assert.deepStrictEqual(previews, ['半截', '', '完整回答']);
  });

  await test('流式空回答自动使用后备答案', async () => {
    streamClient.supported = () => true;
    streamClient.chatStream = async () => '   ';
    useCloud(async () => ({ result: { code: 0, data: '后备答案' } }));
    const res = await chatClient.send({ input: '你好' });
    assert.strictEqual(res.channel, 'cloudfn');
    assert.strictEqual(res.text, '后备答案');
  });

  await test('后备通道超时会返回可读错误', async () => {
    config.CHAT_TIMEOUT_MS = 20;
    useCloud(async () => new Promise(() => {}));
    await assert.rejects(chatClient.send({ input: '你好' }), (err) => err.code === 'E_TIMEOUT');
  });

  await test('内容安全拦截后不再请求模型', async () => {
    config.FEATURE.secCheck = true;
    let modelCalled = false;
    streamClient.supported = () => true;
    streamClient.chatStream = async () => {
      modelCalled = true;
      return '不应出现';
    };
    useCloud(async ({ data }) => {
      if (data.action === 'secCheck') return { result: { code: 1001, msg: '内容不合规' } };
      modelCalled = true;
      return { result: { code: 0, data: '不应出现' } };
    });
    await assert.rejects(chatClient.send({ input: '待检查内容' }), (err) => err.code === 'E_CONTENT');
    assert.strictEqual(modelCalled, false);
  });

  console.log('\n' + (failed ? '有失败' : '全部通过') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
