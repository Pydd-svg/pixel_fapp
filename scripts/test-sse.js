#!/usr/bin/env node
/**
 * scripts/test-sse.js —— 流式解析的离线单测（0 网络、0 token）
 *
 * 故意用「逐字节喂」这种最坏情况来测：
 *   · 一个汉字 3 字节被拆到 3 个 chunk
 *   · 一行 SSE 被拆到多个 chunk
 * 如果这里过了，真机上一个 chunk 里塞几十上百字节更不会出问题。
 */

const P = require('../miniprogram/services/sseParser');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
}

/* ---------- 1. UTF-8 跨包解码 ---------- */
{
  const text = '避坑导购：初音未来手办，300 元以内 😀';
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const d = P.createUtf8Decoder();
  let out = '';
  for (const b of bytes) out += d.decode([b]); // 一次一字节，最坏情况
  ok('UTF-8 逐字节解码还原中文/emoji', out === text, JSON.stringify(out));
}

/* ---------- 2. SSE 分帧（逐字节喂） ---------- */
{
  const frames = [
    'event: stage\ndata: {"stage":"searching"}\n\n',
    'event: delta\ndata: {"t":"{\\"status\\":\\"success\\"}"}\n\n',
    'event: delta\ndata: {"t":"多行"}\n\n'.replace('\n\n', '\r\n\r\n'),
    'event: delta\ndata: {"t":"结尾"}\n\n'
  ];
  const raw = frames.join('');
  const bytes = Array.from(Buffer.from(raw, 'utf8'));
  const d = P.createUtf8Decoder();
  const s = P.createSSEParser();
  const got = [];
  for (const b of bytes) {
    const txt = d.decode([b]);
    if (txt) got.push.apply(got, s.feed(txt));
  }
  ok('SSE 帧数（逐字节）', got.length === 4, 'got ' + got.length);
  ok('第一帧 event=stage', got[0] && got[0].event === 'stage', got[0] && got[0].event);
  ok('\\r\\n\\r\\n 分隔也能切', got.length === 4 && got[2].event === 'delta');
  ok('data 是完整 JSON 串', (() => {
    try {
      return JSON.parse(got[3].data).t === '结尾';
    } catch (e) {
      return false;
    }
  })());
}

/* ---------- 3. 心跳/注释行不产帧 ---------- */
{
  const s = P.createSSEParser();
  const f = s.feed(': keep-alive\n\n' + 'data: x\n\n');
  ok('注释行被忽略，只出 1 帧', f.length === 1 && f[0].data === 'x', JSON.stringify(f));
}

/* ---------- 4. 半截 JSON 渐进抽取 ---------- */
{
  const pieces = [
    '{"status":"success","is_followup":false,"decision_data":{"card_title":"300 元内初音手办避坑"',
    ',"category":"chao_wan","budget_band":"200-300","tags":["手办"]',
    ',"price_source":"kb","recommendations":[{"type":"首选方案","name":"景品·正版散货",',
    '"price_expectation":"180-260元","pros":"便宜"',
    '},{"type":"备选方案","name":"粘土人"',
    ',"price_expectation":"260-320元","pros":"可动"',
    '}],"red_flags":["低于官方定价六折多为翻模"',
    ',"「厂货」无盒说一不二"',
    '],"search_keyword":"初音手办 避坑"}}'
  ];
  let acc = '';
  let prev = null;
  let firstTitleAt = -1;
  let firstFlagAt = -1;
  let firstFlag = '';
  for (let i = 0; i < pieces.length; i++) {
    acc += pieces[i];
    const pv = P.extractPreview(acc, prev);
    prev = pv;
    if (firstTitleAt === -1 && pv.title) firstTitleAt = i;
    if (firstFlagAt === -1 && pv.redFlags.length) {
      firstFlagAt = i;
      firstFlag = pv.redFlags[0];
    }
  }
  ok('标题在第 1 片就能显示', firstTitleAt === 0, 'at ' + firstTitleAt);
  ok('标题内容正确', prev.title === '300 元内初音手办避坑', prev.title);
  ok('红线在数组开吐后即可显示', firstFlagAt === 6, 'at ' + firstFlagAt);
  ok('红线内容正确', firstFlag === '低于官方定价六折多为翻模', firstFlag);
  ok('推荐名抽到 2 个', prev.names.length === 2, JSON.stringify(prev.names));
  ok('推荐名是 name 而非 type', prev.names[0] === '景品·正版散货', prev.names[0]);
  ok('半截 JSON 能正常 JSON.parse（说明拼接无误）', (() => {
    try {
      const o = JSON.parse(acc);
      return o.decision_data.card_title === prev.title;
    } catch (e) {
      return false;
    }
  })());
}

/* ---------- 5. 未闭合的字符串不能被当成品 ---------- */
{
  const pv = P.extractPreview('{"card_title":"300 元内初音', null);
  ok('标题未闭合时不显示半句', pv.title === '', pv.title);
}

/* ---------- 6. 查口碑结果逐字段/逐条预览 ---------- */
{
  const pieces = [
    '{"status":"success","search_summary":{"recent_verdict":"整体口碑稳定"',
    ',"community_feedback":["降噪表现好"',
    ',"佩戴舒适"]',
    ',"caution_alert":"夏天长时间佩戴偏热","sources_hint":["评测"]}}'
  ];
  let acc = '';
  let prev = null;
  let firstFeedbackAt = -1;
  for (let i = 0; i < pieces.length; i++) {
    acc += pieces[i];
    prev = P.extractVerifyPreview(acc, prev);
    if (firstFeedbackAt === -1 && prev.feedback.length) firstFeedbackAt = i;
  }
  ok('口碑摘要先于完整 JSON 显示', prev.verdict === '整体口碑稳定', prev.verdict);
  ok('社区反馈首条提前显示', firstFeedbackAt === 1, 'at ' + firstFeedbackAt);
  ok('社区反馈最终抽到 2 条', prev.feedback.length === 2, JSON.stringify(prev.feedback));
  ok('注意事项随流式输出显示', prev.caution === '夏天长时间佩戴偏热', prev.caution);
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
