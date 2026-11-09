#!/usr/bin/env node
/**
 * eval/run.js —— 20 条固定用例跑批
 *
 * 用法：
 *   node eval/run.js            离线：知识库 80 条 + 检索召回 + 解析/schema 契约
 *   node eval/run.js --live     联网：20 条真实出卡，逐条校验，约 0.1-0.2 元
 *
 * 产出：eval/reports/eval-<YYYYMMDD-HHmm>.json
 * 口径（契约 §7.3）：解析成功率 ≥95%、追问准确 ≥80%、出卡可用 ≥85%。
 */

const fs = require('fs');
const path = require('path');
const { CASES } = require('./cases');

const ROOT = path.resolve(__dirname, '..');
const PARSER = require(path.join(ROOT, 'miniprogram/services/parseAgentJSON'));
const S = require(path.join(ROOT, 'miniprogram/services/schema'));
const KB = require(path.join(ROOT, 'miniprogram/services/knowledge'));
const CONFIG = require(path.join(ROOT, 'miniprogram/services/config'));
const DEMO = require(path.join(ROOT, 'miniprogram/demo/replay'));
const DATA = require(path.join(ROOT, 'miniprogram/knowledge/data'));

const ID_PATTERN = /^(laptop|digital|chao_wan|beauty|bed|study|cross)_\d{3}$/;

function nowTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* ---------------------------- 离线检查 ---------------------------- */

function checkBundle() {
  const errors = [];
  if (!DATA || !Array.isArray(DATA.items)) errors.push('data.js 未生成');
  else {
    if (DATA.items.length !== 80) errors.push('条目数 ' + DATA.items.length + ' ≠ 80');
    const ids = Object.create(null);
    DATA.items.forEach((it) => {
      if (!ID_PATTERN.test(it.id)) errors.push('非法 id：' + it.id);
      if (ids[it.id]) errors.push('重复 id：' + it.id);
      ids[it.id] = true;
    });
  }
  DEMO.replays.forEach((r) => {
    const refs = (r.card && r.card.decision_data && r.card.decision_data.knowledge_refs) || [];
    refs.forEach((id) => {
      if (!KB.getById(id)) errors.push('演示卡 ' + r.id + ' 的 ' + id + ' 不在本地知识库');
    });
  });
  return { name: '知识库 80 条 / id 合法 / 演示卡依据可回溯', pass: !errors.length, errors };
}

function checkRetrieval() {
  return CASES.map((c) => {
    const detected = KB.detectCategory(c.input);
    const r = KB.retrieve(c.input, detected);
    const expected = c.expect.category;
    const hit = r.items.filter((it) => it.category === expected).length;
    const categoryOk = detected === expected;
    const recallOk = hit >= (c.expect.refsMin || 0);
    const refs = r.items.map((it) => it.id);
    return {
      id: c.id,
      input: c.input,
      expected,
      detected,
      expectedRefs: c.expect.refsMin || 0,
      hit,
      categoryOk,
      recallOk,
      pass: categoryOk && recallOk,
      top3: refs.slice(0, 3)
    };
  });
}

function checkParserAndSchema() {
  const results = [];

  DEMO.replays.forEach((r) => {
    const raw = '```json\n' + JSON.stringify(r.card, null, 2) + '\n```';
    const parsed = PARSER.parseAgentJSON(raw);
    const norm = S.normalizeDecisionCard(parsed.data);
    results.push({
      id: 'demo:' + r.id,
      parseLevel: parsed.level,
      ok: norm.ok,
      errors: norm.errors,
      pass: parsed.ok && norm.ok && norm.errors.length === 0
    });
  });

  // 脏数据修复：围栏 + 前后废话 + 尾逗号
  const dirty = '好的，卡片来了：\n```json\n' + JSON.stringify(DEMO.replays[0].card).replace('}]', '},]') + '\n```\n希望有帮助';
  const parsedDirty = PARSER.parseAgentJSON(dirty);
  const normDirty = S.normalizeDecisionCard(parsedDirty.data);
  results.push({
    id: 'dirty:trailing-comma',
    parseLevel: parsedDirty.level,
    ok: normDirty.ok,
    errors: normDirty.errors,
    pass: !!normDirty.ok
  });

  // 追问卡
  const rawFollow = JSON.stringify({
    status: 'success',
    error_code: null,
    is_followup: true,
    followup_question: '预算大概多少？是第一次买吗？',
    decision_data: null
  });
  const parsedFollow = PARSER.parseAgentJSON(rawFollow);
  const normFollow = S.normalizeDecisionCard(parsedFollow.data);
  results.push({
    id: 'followup:valid',
    parseLevel: parsedFollow.level,
    ok: normFollow.ok,
    errors: normFollow.errors,
    pass: !!normFollow.ok && normFollow.card.is_followup === true
  });

  // 降级卡
  const degraded = S.buildDegradedCard('E_TIMEOUT');
  const normDeg = S.normalizeDecisionCard(degraded);
  results.push({
    id: 'degraded:E_TIMEOUT',
    parseLevel: 0,
    ok: normDeg.ok,
    errors: normDeg.errors,
    pass: !!normDeg.ok
  });

  return results;
}

function runOffline() {
  const bundle = checkBundle();
  const retrieval = checkRetrieval();
  const contract = checkParserAndSchema();

  const retrievalPass = retrieval.filter((x) => x.pass).length;
  const contractPass = contract.filter((x) => x.pass).length;

  console.log('\n== 离线跑批 ==');
  console.log('[1] ' + bundle.name + ' => ' + (bundle.pass ? 'PASS' : 'FAIL'));
  bundle.errors.forEach((e) => console.log('    - ' + e));

  console.log('\n[2] 检索召回（品类判定 + 知识点命中）');
  retrieval.forEach((x) => {
    console.log(
      '  ' + (x.pass ? 'PASS' : 'FAIL') + ' ' + x.id +
      '  期望 ' + x.expected + ' / 实判 ' + x.detected +
      '  命中 ' + x.hit + '/' + x.expectedRefs +
      '  top3: ' + x.top3.join(', ')
    );
  });
  console.log('  检索通过：' + retrievalPass + '/' + retrieval.length);

  console.log('\n[3] 解析 + schema 契约');
  contract.forEach((x) => {
    console.log('  ' + (x.pass ? 'PASS' : 'FAIL') + ' ' + x.id + '  level=' + x.parseLevel + (x.errors && x.errors.length ? '  ' + x.errors.join('; ') : ''));
  });
  console.log('  契约通过：' + contractPass + '/' + contract.length);

  const report = {
    type: 'offline',
    generated_at: new Date().toISOString(),
    bundle: { pass: bundle.pass, errors: bundle.errors, count: DATA.items.length },
    retrieval: { pass: retrievalPass, total: retrieval.length, cases: retrieval },
    contract: { pass: contractPass, total: contract.length, cases: contract },
    summary: {
      pass: bundle.pass && retrievalPass === retrieval.length && contractPass === contract.length,
      retrieval_rate: retrievalPass / retrieval.length,
      contract_rate: contractPass / contract.length
    }
  };
  return report;
}

/* ---------------------------- 联网跑批 ---------------------------- */

function pickModel() {
  const chain = (CONFIG.LLM && CONFIG.LLM.models) || [];
  const first = chain[0];
  const model = typeof first === 'string' ? first : first && first.model;
  return model || (CONFIG.LLM && CONFIG.LLM.model) || 'deepseek-flash';
}

async function callModel(messages) {
  const baseUrl = String(CONFIG.LLM.baseUrl).replace(/\/+$/, '');
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + CONFIG.LLM.apiKey
    },
    body: JSON.stringify({
      model: pickModel(),
      messages,
      temperature: 0.3,
      stream: false
    }),
    signal: AbortSignal.timeout(CONFIG.LLM.timeoutMs || 25000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body.slice(0, 120));
  const json = JSON.parse(body);
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error('模型返回为空');
  return text;
}

async function runCase(c) {
  const category = KB.detectCategory(c.input);
  const kb = KB.retrieve(c.input, category);
  const system =
    CONFIG.DECIDE_SYSTEM_PROMPT +
    CONFIG.PROMPT_PATCH_WITH_KB +
    '\n\n' + KB.buildContext(kb.items);

  const started = Date.now();
  let raw;
  try {
    raw = await callModel([
      { role: 'system', content: system },
      { role: 'user', content: c.input }
    ]);
  } catch (e) {
    return { id: c.id, pass: false, reason: '调用失败：' + e.message, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const parsed = PARSER.parseAgentJSON(raw);
  if (!parsed.ok) return { id: c.id, pass: false, reason: '解析失败 L' + parsed.level, ms, raw: raw.slice(0, 200) };

  const norm = S.normalizeDecisionCard(parsed.data);
  if (!norm.ok) return { id: c.id, pass: false, reason: 'schema 失败：' + norm.errors.join('; '), ms };

  const card = norm.card;
  const checks = [];
  if (c.expect.followup) checks.push(['应追问', card.is_followup === true && !!card.followup_question]);
  else checks.push(['应出卡', card.is_followup === false && !!card.decision_data]);
  if (!c.expect.followup && card.decision_data) {
    checks.push(['品类', card.decision_data.category === c.expect.category]);
    checks.push(['至少1条红榜', card.decision_data.red_flags.length >= 1]);
    if (c.expect.refsMin > 0) {
      const refsOk = card.decision_data.knowledge_refs.length >= 1 && card.decision_data.knowledge_refs.every((id) => KB.getById(id));
      checks.push(['依据可追溯', refsOk]);
    }
  }

  const failed = checks.filter((x) => !x[1]).map((x) => x[0]);
  return {
    id: c.id,
    input: c.input,
    pass: failed.length === 0,
    reason: failed.join(' / '),
    parseLevel: parsed.level,
    category: card.decision_data ? card.decision_data.category : '-',
    refs: card.decision_data ? card.decision_data.knowledge_refs : [],
    ms
  };
}

async function runLive() {
  console.log('\n== 联网跑批（20 条，顺序调用）==');
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const r = await runCase(CASES[i]);
    results.push(r);
    console.log('  ' + (r.pass ? 'PASS' : 'FAIL') + ' ' + r.id + '  ' + (r.reason || (r.ms + 'ms')));
  }
  const pass = results.filter((r) => r.pass).length;
  console.log('\n通过率：' + pass + '/' + results.length + ' = ' + Math.round((pass / results.length) * 100) + '%');
  return {
    type: 'live',
    generated_at: new Date().toISOString(),
    model: pickModel(),
    summary: { pass, total: results.length, rate: pass / results.length },
    cases: results
  };
}

/* ---------------------------- 入口 ---------------------------- */

async function main() {
  const live = process.argv.includes('--live');
  const report = live ? await runLive() : runOffline();
  const dir = path.join(ROOT, 'eval', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'eval-' + nowTag() + (live ? '-live' : '-offline') + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n报告：' + path.relative(ROOT, file));
  if (!report.summary.pass) process.exit(1);
}

main().catch((e) => {
  console.error('跑批异常：', e);
  process.exit(1);
});
