/**
 * services/knowledge.js —— 本地知识库检索（RAG 的端侧实现）
 *
 * 为什么放在端侧：
 *   预览包是「游客 AppID + 直连模型」，没有云开发知识库可用。
 *   把 80 条打包进小程序后，出卡前先本地检索、把命中条目注入 prompt，
 *   卡片里的 knowledge_refs 才能真正指回具体条目，并且点开能看到原文。
 *
 * 数据来源：knowledge/L1/*.json + knowledge/L3/cross.json
 * 打包产物：miniprogram/knowledge/data.js（由 scripts/build-knowledge.js 生成，勿手改）
 *
 * 检索策略（与云开发知识库的召回目标一致，不做花哨的向量检索）：
 *   1. 先按口语词判定品类（7 个 key，超纲归 universal）
 *   2. 品类条目 + 横切条目一起打分：关键词命中 > 标题命中 > 正文命中
 *   3. 取「品类 4 条 + 横切 2 条」，横切规则永远参与召回
 */

const DATA = require('../knowledge/data');
const C = require('./constants');

const ITEMS = (DATA && DATA.items) || [];
const BY_ID = Object.create(null);
ITEMS.forEach((it) => {
  BY_ID[it.id] = it;
});

/** 用户口语 → 品类。顺序即优先级，长的词先匹配，避免「笔记本」抢走学习用品。 */
const CATEGORY_HINTS = {
  laptop: ['笔记本电脑', '游戏本', '轻薄本', '笔记本', '电脑', '写代码', '编程', '剪辑', '显卡', '独显', '内存', '固态', '续航', '二手电脑'],
  digital: ['蓝牙耳机', '耳机', '充电宝', '充电器', '充电头', '数据线', '读卡器', '移动硬盘', '移动固态', 'u盘', 'U盘', '降噪', '存储卡'],
  chao_wan: ['手办', '潮玩', '粘土人', '景品', '盲盒', '一番赏', '立牌', '徽章', '痛包', '设定集', '画集', '二次元', '初音', '谷子'],
  beauty: ['护肤', '面霜', '洗面奶', '洁面', '水乳', '精华', '防晒', '面膜', '彩妆', '口红', '粉底', '眼影', '敏感肌', '化妆品'],
  bed: ['床垫', '被子', '被套', '床单', '床帘', '蚊帐', '枕头', '枕芯', '凉席', '四件套', '三件套', '宿舍床'],
  study: ['教材', '教辅', '课本', '文具', '中性笔', '打印', '装订', '真题', '复习资料', '笔记本纸']
};

/**
 * 明确不在本期范围的词：命中就直接按 universal 处理。
 * 不处理的话「平板电脑」会被「电脑」误判成 laptop，问出个答非所问的卡片。
 */
const OUT_OF_SCOPE = ['平板', '相机', '球鞋', '鞋', '洗衣液', '洗发水', '沐浴露', '零食', '家具', '乐器', '显示器', '手机'];

const STRONG_CAT_SCORE = 6; // 品类条目基础分
const UNIVERSAL_BASE = 2.5; // 横切条目基础分

function lower(s) {
  return String(s || '').toLowerCase();
}

function bigrams(text) {
  const s = lower(text).replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * 判定品类。
 * @returns {string} laptop|digital|chao_wan|beauty|bed|study|universal
 */
function detectCategory(query) {
  const q = lower(query);
  for (let i = 0; i < OUT_OF_SCOPE.length; i++) {
    if (q.indexOf(OUT_OF_SCOPE[i]) !== -1) return 'universal';
  }
  let best = 'universal';
  let bestScore = 0;
  Object.keys(CATEGORY_HINTS).forEach((cat) => {
    let score = 0;
    CATEGORY_HINTS[cat].forEach((word) => {
      if (q.indexOf(lower(word)) !== -1) score += word.length >= 3 ? 2 : 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  });
  return bestScore > 0 ? best : 'universal';
}

function keywordScore(item, q) {
  let score = 0;
  (item.keywords || []).forEach((k) => {
    const kw = lower(k);
    if (!kw) return;
    if (q.indexOf(kw) !== -1) score += kw.length >= 2 ? 3 : 2;
    else if (kw.length >= 2 && q.indexOf(kw.slice(0, 2)) !== -1) score += 1;
  });
  return score;
}

function titleScore(item, q) {
  const grams = bigrams(item.title);
  let hits = 0;
  grams.forEach((g) => {
    if (q.indexOf(g) !== -1) hits += 1;
  });
  return Math.min(hits * 0.6, 3);
}

function contentScore(item, q) {
  const grams = bigrams(q);
  if (!grams.length) return 0;
  let hits = 0;
  grams.forEach((g) => {
    if (lower(item.content).indexOf(g) !== -1) hits += 1;
  });
  return Math.min(hits * 0.15, 1.2);
}

/**
 * 检索知识库。
 * @param {string} query 用户原话
 * @param {string} [category] 已判定品类（不传则内部判定）
 * @param {{categoryLimit?:number, universalLimit?:number}} [opts]
 * @returns {{category:string, items:Array, scored:Array}}
 */
function retrieve(query, category, opts) {
  const o = opts || {};
  const q = lower(query);
  const cat = C.CATEGORY.indexOf(category) !== -1 ? category : detectCategory(query);

  const scored = ITEMS.map((item) => {
    let score = 0;
    if (item.category === cat) score += STRONG_CAT_SCORE;
    if (item.scope === 'universal') score += UNIVERSAL_BASE;
    score += keywordScore(item, q) + titleScore(item, q) + contentScore(item, q);
    if (item.severity === 'high') score += 0.3;
    return { item, score };
  }).sort((a, b) => b.score - a.score);

  const catLimit = typeof o.categoryLimit === 'number' ? o.categoryLimit : 4;
  const uniLimit = typeof o.universalLimit === 'number' ? o.universalLimit : 2;

  const catItems = cat === 'universal'
    ? []
    : scored.filter((s) => s.item.category === cat).slice(0, catLimit).map((s) => s.item);
  const uniItems = scored
    .filter((s) => s.item.scope === 'universal')
    .slice(0, cat === 'universal' ? catLimit + uniLimit : uniLimit)
    .map((s) => s.item);

  const items = catItems.concat(uniItems);

  return { category: cat, items, scored };
}

/** 注入模型上下文的文本块（id 必须留在标题行，模型才会引用） */
function buildContext(items) {
  if (!items || !items.length) return '';
  const body = items
    .map((it) => {
      return [
        '[' + it.id + '] ' + it.title,
        '分类：' + it.category + ' ｜ 严重度：' + it.severity + ' ｜ 关键词：' + (it.keywords || []).join(', '),
        it.content
      ].join('\n');
    })
    .join('\n\n');
  return '<knowledge>\n' + body + '\n</knowledge>';
}

function getById(id) {
  return BY_ID[lower(id)] || null;
}

function allIds() {
  return Object.keys(BY_ID);
}

/** 过滤模型返回的幻觉 id，只保留知识库里真实存在的 */
function filterRefs(refs, allowedIds) {
  const list = Array.isArray(refs) ? refs : [];
  const allowed = allowedIds ? Object.create(null) : null;
  if (allowedIds) allowedIds.forEach((id) => { allowed[id] = true; });
  const out = [];
  list.forEach((id) => {
    const key = lower(id);
    if (!BY_ID[key]) return;
    if (allowed && !allowed[key]) return;
    if (out.indexOf(key) === -1) out.push(key);
  });
  return out.slice(0, C.LIMIT.REFS_COUNT);
}

/** 卡片展示用：把 id 变成可展开的标题 + 原文 */
function refDetails(refs) {
  return (Array.isArray(refs) ? refs : []).map((id) => {
    const item = getById(id);
    if (!item) {
      return { id, title: '条目不可用', content: '这条依据已不在当前知识库中', severity: '', updated_at: '' };
    }
    return {
      id: item.id,
      title: item.title,
      content: item.content,
      severity: item.severity,
      updated_at: item.updated_at,
      keywords: item.keywords
    };
  });
}

function stats() {
  const per = {};
  ITEMS.forEach((it) => {
    per[it.category] = (per[it.category] || 0) + 1;
  });
  return { count: ITEMS.length, version: DATA.version, per };
}

module.exports = {
  detectCategory,
  retrieve,
  buildContext,
  getById,
  allIds,
  filterRefs,
  refDetails,
  stats,
  items: ITEMS
};
