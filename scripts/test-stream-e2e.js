#!/usr/bin/env node
/**
 * scripts/test-stream-e2e.js —— 本地端到端联调（不动真 Key、不花 token）
 *
 * 起两个本地服务：
 *   9100  假 DeepSeek：按 SSE 吐一段「决策卡 JSON」，故意把中文拆到不同 chunk
 *   9200  真 aiStream：跑 cloudfunctions/aiStream/index.js，LLM_BASE_URL 指向 9100
 * 然后用 Node 当客户端，按微信 onChunkedReceived 的方式（ArrayBuffer 逐包）喂给
 * sseParser + extractPreview，检查：能收到 stage、能拼出完整 JSON、预览能提前出现。
 *
 * 用法：node scripts/test-stream-e2e.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const P = require('../miniprogram/services/sseParser');

const CARD = {
  status: 'success',
  error_code: null,
  is_followup: false,
  followup_question: '',
  decision_data: {
    card_title: '300 元内初音手办避坑',
    category: 'chao_wan',
    budget_band: '200-300',
    tags: ['手办', '正版'],
    price_source: 'kb',
    price_note: '知识库参考价',
    entity_status: 'partial',
    unverified_entities: ['初音未来 景品'],
    recommendations: [
      { type: '首选方案', name: '景品·正版散货', price_expectation: '180-260元', pros: '便宜、可接受瑕疵', cons: '无盒' },
      { type: '备选方案', name: '粘土人', price_expectation: '260-320元', pros: '可动、好玩', cons: '超预算' }
    ],
    red_flags: ['低于官方定价六折多为翻模', '「厂货」无盒说一不二'],
    search_keyword: '初音手办 避坑',
    knowledge_refs: [],
    confidence: 'medium',
    disclaimer: '仅供辅助决策'
  }
};

/* ---------------- 假 DeepSeek：SSE 上游 ---------------- */
function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!/\/chat\/completions/.test(req.url)) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.stream) {
          res.writeHead(400);
          res.end('{"error":"expect stream"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const text = JSON.stringify(CARD);
        // 按 17 个字符一段切开，保证汉字/引号被拆到不同 chunk
        const chunks = [];
        for (let i = 0; i < text.length; i += 17) chunks.push(text.slice(i, i + 17));
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            res.write('data: [DONE]\n\n');
            res.end();
            clearInterval(timer);
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] }) + '\n\n');
          i++;
        }, 8);
      });
    });
    server.listen(9100, () => resolve(server));
  });
}

/* ---------------- 客户端：模拟微信 onChunkedReceived ---------------- */
function postStream(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/decide', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const decoder = P.createUtf8Decoder();
        const parser = P.createSSEParser();
        const stages = [];
        let acc = '';
        let events = 0;
        let firstDeltaMs = null;
        let firstTitleMs = null;
        let firstFlagMs = null;
        const t0 = Date.now();
        let preview = null;

        res.on('data', (buf) => {
          // 微信给的是 ArrayBuffer，这里同样是 Buffer → 逐包解码 + 分帧
          const text = decoder.decode(Array.from(buf));
          parser.feed(text).forEach((f) => {
            events++;
            if (f.event === 'stage') {
              try {
                stages.push(JSON.parse(f.data).stage);
              } catch (e) {}
            } else if (f.event === 'delta') {
              const d = JSON.parse(f.data).t;
              acc += d;
              if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
              preview = P.extractPreview(acc, preview);
              if (firstTitleMs === null && preview.title) firstTitleMs = Date.now() - t0;
              if (firstFlagMs === null && preview.redFlags.length) firstFlagMs = Date.now() - t0;
            } else if (f.event === 'error') {
              reject(new Error('stream error: ' + f.data));
            }
          });
        });
        res.on('end', () => resolve({ stages, acc, events, firstDeltaMs, firstTitleMs, firstFlagMs, preview }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ---------------- 跑起来 ---------------- */
(async () => {
  const upstream = await startMockUpstream();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'cloudfunctions', 'aiStreamHTTP', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: '9200', LLM_API_KEY: 'sk-local-mock', LLM_BASE_URL: 'http://127.0.0.1:9100/v1', LLM_MODEL: 'deepseek-chat' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[aiStream] ' + d));

  await new Promise((r) => setTimeout(r, 600));

  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) {
      pass++;
      console.log('  PASS  ' + name + (extra ? '  ' + extra : ''));
    } else {
      fail++;
      console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
    }
  };

  try {
    const r = await postStream(9200, {
      messages: [{ role: 'system', content: '你是避坑导购' }, { role: 'user', content: '初音手办 300 以内' }],
      temperature: 0.3,
      webSearch: false
    });

    console.log('\n流式端到端：');
    ok('收到 stage 事件', r.stages.indexOf('writing') >= 0, JSON.stringify(r.stages));
    ok('首个 delta 很快到达', r.firstDeltaMs !== null && r.firstDeltaMs < 1500, (r.firstDeltaMs || 0) + 'ms');
    ok('标题早于完整 JSON 出现', r.firstTitleMs !== null && r.firstTitleMs <= (r.firstDeltaMs || 0) + 400, (r.firstTitleMs || 0) + 'ms');
    ok('红线也能提前显示', r.firstFlagMs !== null && r.firstFlagMs < (r.firstDeltaMs || 0) + 900, (r.firstFlagMs || 0) + 'ms');
    ok('拼出的文本是合法 JSON', (() => {
      try {
        const o = JSON.parse(r.acc);
        return o.decision_data.card_title === CARD.decision_data.card_title;
      } catch (e) {
        return false;
      }
    })());
    ok('中文没有被拆坏', r.acc.indexOf('初音手办') >= 0 && r.acc.indexOf('翻模') >= 0);
    ok('预览标题与最终一致', r.preview && r.preview.title === CARD.decision_data.card_title, r.preview && r.preview.title);
    ok('预览抽到 2 个推荐名', r.preview && r.preview.names.length === 2, r.preview && JSON.stringify(r.preview.names));
    ok('收到的事件数合理', r.events > 5, String(r.events));
  } catch (e) {
    fail++;
    console.log('  FAIL  端到端异常：' + e.message);
  } finally {
    child.kill();
    upstream.close();
    console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
