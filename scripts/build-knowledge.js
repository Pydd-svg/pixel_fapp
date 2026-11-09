#!/usr/bin/env node
/**
 * scripts/build-knowledge.js —— 知识库校验 / 打包 / 生成上传版
 *
 * 用法：
 *   node scripts/build-knowledge.js            # 校验 + 生成 data.js + md
 *   node scripts/build-knowledge.js --strict   # 只校验，不写文件
 *   node scripts/build-knowledge.js --md       # 只生成上传版 md
 *
 * 产出：
 *   miniprogram/knowledge/data.js        小程序可直接 require 的 80 条
 *   shared/build/knowledge.all.json      合并后的条目
 *   shared/build/knowledge.all.md        云开发知识库上传版（标题必须含 [id]）
 *
 * 校验规则来自 docs/00_跨岗位对接契约.md §4.3 与 knowledge/README.md。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const OUT_DIR = path.join(ROOT, 'shared', 'build');
const MP_DATA = path.join(ROOT, 'miniprogram', 'knowledge', 'data.js');

const ID_PATTERN = /^(laptop|digital|chao_wan|beauty|bed|study|cross)_\d{3}$/;
const CATEGORY = ['laptop', 'digital', 'chao_wan', 'beauty', 'bed', 'study', 'universal'];
const SEVERITY = ['high', 'medium', 'low'];
const EXPECT_TOTAL = 80;

function readItems(dir) {
  const base = dir || KNOWLEDGE_DIR;
  const files = [
    ...['laptop', 'digital', 'chao-wan', 'beauty', 'bed', 'study'].map((n) =>
      path.join(base, 'L1', n + '.json')
    ),
    path.join(base, 'L3', 'cross.json')
  ];
  const items = [];
  const errors = [];
  const warnings = [];

  files.forEach((file) => {
    if (!fs.existsSync(file)) {
      errors.push('缺文件：' + path.relative(ROOT, file));
      return;
    }
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(path.relative(ROOT, file) + ' JSON 解析失败：' + e.message);
      return;
    }
    if (!Array.isArray(arr)) {
      errors.push(path.relative(ROOT, file) + ' 顶层必须是数组');
      return;
    }
    arr.forEach((it, i) => {
      const tag = path.relative(ROOT, file) + '[' + i + ']';
      if (!it || typeof it !== 'object') {
        errors.push(tag + ' 不是对象');
        return;
      }
      if (!ID_PATTERN.test(it.id || '')) errors.push(tag + ' id 非法：' + it.id);
      if (!CATEGORY.includes(it.category)) errors.push(tag + ' category 非法：' + it.category);
      if (!['category', 'universal'].includes(it.scope)) errors.push(tag + ' scope 非法：' + it.scope);
      if (it.scope === 'universal' && it.category !== 'universal') {
        errors.push(tag + ' scope=universal 时 category 必须为 universal');
      }
      if (!Array.isArray(it.keywords) || it.keywords.length < 3 || it.keywords.length > 6) {
        errors.push(tag + ' keywords 必须是 3-6 个');
      }
      const titleLen = String(it.title || '').replace(/\s/g, '').length;
      if (!it.title || titleLen > 16) errors.push(tag + ' title 必须 ≤16 字');
      const len = String(it.content || '').length;
      if (len < 60 || len > 120) warnings.push(tag + ' 正文 ' + len + ' 字（建议 60-120）');
      if (!SEVERITY.includes(it.severity)) errors.push(tag + ' severity 非法：' + it.severity);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.updated_at || '')) errors.push(tag + ' updated_at 非法');
      items.push(Object.assign({}, it, { _file: path.relative(ROOT, file) }));
    });
  });

  const seen = Object.create(null);
  const dups = [];
  items.forEach((it) => {
    if (seen[it.id]) dups.push(it.id);
    seen[it.id] = true;
  });

  const perCategory = {};
  items.forEach((it) => {
    perCategory[it.category] = (perCategory[it.category] || 0) + 1;
  });

  return { items, errors, warnings, dups, perCategory };
}

function toMd(items) {
  const head = [
    '# 避坑导购 · 知识库（上传版）',
    '',
    '> 由 `scripts/build-knowledge.js` 自动生成，请勿手改。',
    '> 共 ' + items.length + ' 条。每条标题行必须保留 [id]，否则模型无法返回 knowledge_refs。',
    ''
  ].join('\n');
  const body = items
    .map((it) =>
      [
        '## [' + it.id + '] ' + it.title,
        '分类：' + it.category + ' ｜ 严重度：' + it.severity + ' ｜ 关键词：' + it.keywords.join(', '),
        it.content,
        ''
      ].join('\n')
    )
    .join('\n');
  return head + '\n' + body;
}

function toDataModule(items) {
  const payload = {
    version: '1.1',
    updated_at: '2026-11-07',
    count: items.length,
    items: items.map((it) => ({
      id: it.id,
      scope: it.scope,
      category: it.category,
      keywords: it.keywords,
      title: it.title,
      content: it.content,
      severity: it.severity,
      updated_at: it.updated_at
    }))
  };
  return (
    '/**\n' +
    ' * ⚠️ 本文件由 scripts/build-knowledge.js 自动生成，请勿手改。\n' +
    ' * 源文件：knowledge/L1/*.json + knowledge/L3/cross.json\n' +
    ' * 生成时间：' + new Date().toISOString() + '\n' +
    ' */\n' +
    'module.exports = ' + JSON.stringify(payload, null, 2) + ';\n'
  );
}

function writeOut(items, opts) {
  const o = opts || {};
  const clean = items.map((it) => {
    const copy = Object.assign({}, it);
    delete copy._file;
    return copy;
  });

  // 契约 §5.6 的 --out：指定单个产物路径，只写那一个
  if (o.out) {
    const outPath = path.resolve(ROOT, o.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (o.md || /\.md$/i.test(outPath)) {
      fs.writeFileSync(outPath, toMd(clean), 'utf8');
    } else {
      fs.writeFileSync(
        outPath,
        JSON.stringify({ version: '1.1', count: clean.length, items: clean }, null, 2),
        'utf8'
      );
    }
    return [outPath];
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(MP_DATA), { recursive: true });

  // 只生成上传版 md（B 岗同步云开发知识库时用）
  if (o.md) {
    const mdPath = path.join(OUT_DIR, 'knowledge.all.md');
    fs.writeFileSync(mdPath, toMd(clean), 'utf8');
    return [mdPath];
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'knowledge.all.json'),
    JSON.stringify({ version: '1.1', count: clean.length, items: clean }, null, 2),
    'utf8'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'knowledge.all.md'), toMd(clean), 'utf8');
  fs.writeFileSync(MP_DATA, toDataModule(clean), 'utf8');
  return [
    MP_DATA,
    path.join(OUT_DIR, 'knowledge.all.json'),
    path.join(OUT_DIR, 'knowledge.all.md')
  ];
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return '';
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const out = argValue('--out');
  const mdOnly = args.includes('--md') || (out ? /\.md$/i.test(out) : false);
  const inDir = argValue('--in') ? path.resolve(ROOT, argValue('--in')) : KNOWLEDGE_DIR;
  const r = readItems(inDir);

  console.log('源目录：' + path.relative(ROOT, inDir));
  console.log('条目：' + r.items.length + ' / 期望：' + EXPECT_TOTAL);
  console.log('分布：' + Object.keys(r.perCategory).map((k) => k + ' ' + r.perCategory[k]).join(' / '));

  if (r.dups.length) console.log('重复 id：' + r.dups.join(', '));
  if (r.warnings.length) {
    console.log('警告 ' + r.warnings.length + ' 条：');
    r.warnings.forEach((w) => console.log('  - ' + w));
  }
  if (r.errors.length) {
    console.log('schema 错误 ' + r.errors.length + ' 条：');
    r.errors.forEach((e) => console.log('  - ' + e));
  }

  const totalOk = r.items.length === EXPECT_TOTAL;
  const pass = !r.errors.length && !r.dups.length && totalOk;
  console.log(
    '结果：items: ' + r.items.length +
    ' / dup ids: ' + r.dups.length +
    ' / schema errors: ' + r.errors.length +
    ' => ' + (pass ? 'PASS' : 'FAIL')
  );

  if (!pass) process.exit(1);
  if (strict) return;

  const written = writeOut(r.items, { out, md: mdOnly });
  console.log('已生成：');
  written.forEach((p) => console.log('  ' + path.relative(ROOT, p)));
}

main();
