/**
 * services/schema.js —— 校验与归一化（契约 §4）
 * 归属：A 岗。纯函数，无 wx 依赖，Node 脚本与小程序共用。
 *
 * 分工原则（很重要，别混）：
 *   normalize* = 只做「结构性修复」——补默认值、截断超长、数组化、去重、过滤非法 id。
 *   validate*  = 只做「契约判废」——缺字段、空数组、单一价格、含链接，一律判废。
 * 语义类错误（红线为空、价格是单值）**不在归一化里偷偷补**，
 * 判废后由 aiClient 重试一次，仍失败才降级 —— 否则数据来源无法自证。
 */

const C = require('./constants');

const L = C.LIMIT;

/* ------------------------------- 基础工具 ------------------------------- */

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '';
}

/** 按「字符」计长度，中文/emoji 都算 1 个，别用 .length */
function countChars(s) {
  return Array.from(String(s || '')).length;
}

function clamp(s, max) {
  const arr = Array.from(String(s || ''));
  if (arr.length <= max) return arr.join('');
  return arr.slice(0, max).join('');
}

function uniq(arr) {
  const seen = Object.create(null);
  const out = [];
  arr.forEach((x) => {
    if (!seen[x]) {
      seen[x] = 1;
      out.push(x);
    }
  });
  return out;
}

const PRICE_RE = /(\d+(\.\d+)?\s*元)|([¥￥]\s*\d+(\.\d+)?)|(价格\s*\d+)|(\d+(\.\d+)?\s*块钱)/;
const URL_RE = /(https?:\/\/|www\.)/i;

function containsPrice(text) {
  return PRICE_RE.test(String(text || ''));
}

function containsUrl(text) {
  return URL_RE.test(String(text || ''));
}

/** 按句剥掉含价格/链接的片段（用于 recent_verdict、caution_alert 这类长句字段） */
function stripRiskySegments(text, fallback) {
  const s = str(text);
  if (!s) return fallback || '';
  if (!containsPrice(s) && !containsUrl(s)) return s;
  const parts = s.split(/(?<=[。！？；!?;])/).map((x) => x.trim()).filter(Boolean);
  const kept = parts.filter((p) => !containsPrice(p) && !containsUrl(p));
  if (!kept.length) return fallback || '';
  return kept.join('');
}

/* --------------------------- DecisionCard 归一化 --------------------------- */

function normalizeBudgetBand(v) {
  let s = str(v).replace(/\s/g, '').replace(/元/g, '');
  s = s.replace(/[~～—－至到]/g, '-');
  if (/^\d+-\d+$/.test(s)) return s;
  // 单值不猜：契约要求形如 200-300，猜出来的区间会在答辩时说不清
  return '未指定';
}

function normalizeTags(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[,，、;；\s]+/);
  arr = arr.map((x) => clamp(str(x), L.TAG)).filter(Boolean);
  return uniq(arr).slice(0, L.TAG_COUNT);
}

function normalizePrice(v) {
  // 先剥掉空格与「元」，再统一各种区间连接符，最后补回「元」
  const s = str(v).replace(/\s/g, '').replace(/元/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)[-~至到—－](?:\d+(?:\.\d+)?)/);
  if (m) {
    // m[0] 形如 200-280；重新取两端，避免把连接符后的位数吃掉
    const nums = m[0].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) return nums[0] + '-' + nums[1] + '元';
  }
  return str(v); // 保持原样，交给 validate 判废
}

function normalizeRecommendations(v, errors) {
  if (!Array.isArray(v)) {
    errors.push('recommendations 不是数组');
    return [];
  }
  const out = v
    .filter(isObj)
    .map((r, i) => {
      let type = str(r.type);
      if (C.REC_TYPE.indexOf(type) === -1) type = i === 0 ? C.REC_TYPE[0] : C.REC_TYPE[1];
      return {
        type,
        name: clamp(str(r.name), 24),
        price_expectation: normalizePrice(r.price_expectation),
        pros: clamp(str(r.pros), L.PROS),
        cons: clamp(str(r.cons), L.CONS)
      };
    })
    .filter((r) => r.name);
  return out.slice(0, L.REC_COUNT);
}

function normalizeRedFlags(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/\n|；|;/);
  return arr
    .map((x) => (isObj(x) ? str(x.text || x.content) : str(x)))
    .map((x) => clamp(x, L.RED_FLAG))
    .filter(Boolean)
    .slice(0, L.RED_FLAG_COUNT);
}

function normalizeKeyword(v, category) {
  let s = str(v).replace(/https?:\/\/\S+/gi, '').replace(/www\.\S+/gi, '');
  s = s.replace(/^["'「《]+|["'」》]+$/g, '').replace(/\s+/g, ' ').trim();
  s = clamp(s, L.SEARCH_KEYWORD).trim();
  if (!s) s = C.CATEGORY_LABEL[category] + ' 避坑 选购';
  return s;
}

function normalizeRefs(v) {
  if (!Array.isArray(v)) return [];
  const out = v
    .map((x) => str(x).toLowerCase())
    .filter((x) => C.ID_PATTERN.test(x));
  return uniq(out).slice(0, L.REFS_COUNT);
}

function normalizeDecisionData(raw, errors) {
  if (!isObj(raw)) return null;
  const category = C.CATEGORY.indexOf(str(raw.category)) !== -1 ? str(raw.category) : 'universal';
  const refs = normalizeRefs(raw.knowledge_refs);
  const recs = normalizeRecommendations(raw.recommendations, errors);
  let confidence = C.CONFIDENCE.indexOf(str(raw.confidence)) !== -1 ? str(raw.confidence) : 'medium';
  if (!refs.length) confidence = 'low'; // 契约 §4.1 硬约束

  return {
    card_title: clamp(str(raw.card_title), L.CARD_TITLE) || C.CATEGORY_LABEL[category] + '决策卡',
    category,
    budget_band: normalizeBudgetBand(raw.budget_band),
    tags: normalizeTags(raw.tags),
    recommendations: recs,
    red_flags: normalizeRedFlags(raw.red_flags),
    search_keyword: normalizeKeyword(raw.search_keyword, category),
    knowledge_refs: refs,
    confidence,
    // 合规项：固定文案，无论模型写什么一律覆盖
    disclaimer: C.DISCLAIMER
  };
}

/**
 * @param {object} raw Agent 解析后的对象
 * @returns {{ok:boolean, card:object|null, errors:string[]}}
 */
function normalizeDecisionCard(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, card: null, errors: ['返回值不是对象'] };

  let status = str(raw.status);
  if (['success', 'degraded', 'error'].indexOf(status) === -1) {
    if (isObj(raw.decision_data) || str(raw.followup_question)) {
      status = 'success'; // 结构性修复：字段齐但状态缺
    } else {
      return { ok: false, card: null, errors: ['status 缺失或非法'] };
    }
  }

  let question = str(raw.followup_question);
  let ddRaw = raw.decision_data;
  let isFollowup = typeof raw.is_followup === 'boolean' ? raw.is_followup : !!question && !isObj(ddRaw);

  // 状态自洽修复
  if (isFollowup && isObj(ddRaw)) ddRaw = null; // 契约：is_followup=true 时 decision_data 必须为 null
  if (isFollowup && !question && !isObj(ddRaw)) {
    return { ok: false, card: null, errors: ['is_followup=true 但 followup_question 为空'] };
  }
  if (!isFollowup && !isObj(ddRaw)) {
    return { ok: false, card: null, errors: ['非追问但 decision_data 缺失'] };
  }

  let decision = null;
  if (!isFollowup) {
    decision = normalizeDecisionData(ddRaw, errors);
  }

  let errorCode = raw.error_code === null || raw.error_code === undefined ? null : str(raw.error_code);
  if (status === 'success') errorCode = null;
  if (status !== 'success' && (!errorCode || !C.ERROR_CODE[errorCode])) errorCode = 'E_UNKNOWN';

  const metaRaw = isObj(raw.meta) ? raw.meta : {};
  const card = {
    status,
    error_code: errorCode,
    is_followup: isFollowup,
    followup_question: isFollowup ? clamp(question, L.FOLLOWUP) : '',
    decision_data: decision,
    meta: {
      elapsed_ms: typeof metaRaw.elapsed_ms === 'number' ? metaRaw.elapsed_ms : 0,
      channel: str(metaRaw.channel) || 'agent',
      cache_hit: !!metaRaw.cache_hit
    }
  };

  // 归一化后再跑一次完整校验，判废条件一处收口
  const v = validateDecisionCard(card);
  if (!v.ok) {
    return { ok: false, card: null, errors: v.errors.concat(errors) };
  }
  return { ok: true, card, errors };
}

/**
 * 契约 §4.1 判废条件的唯一实现。
 * @param {object} card
 * @param {{skipPriceCheck?:boolean}} [opts] 仅降级模板卡使用
 */
function validateDecisionCard(card, opts) {
  const options = opts || {};
  const errors = [];
  if (!isObj(card)) return { ok: false, errors: ['不是对象'] };

  if (['success', 'degraded', 'error'].indexOf(card.status) === -1) errors.push('status 非法');
  if (card.status === 'success' && card.error_code !== null) errors.push('success 时 error_code 必须为 null');
  if (card.status !== 'success' && !card.error_code) errors.push('非 success 时 error_code 必填');
  if (typeof card.is_followup !== 'boolean') errors.push('is_followup 必须是布尔');

  if (card.is_followup) {
    if (card.decision_data !== null) errors.push('is_followup=true 时 decision_data 必须为 null');
    if (!str(card.followup_question)) errors.push('followup_question 必填');
    if (countChars(card.followup_question) > L.FOLLOWUP) errors.push('followup_question 超过 ' + L.FOLLOWUP + ' 字');
    return { ok: errors.length === 0, errors };
  }

  if (card.decision_data === null || card.decision_data === undefined) {
    errors.push('decision_data 缺失');
    return { ok: false, errors };
  }

  const d = card.decision_data;
  if (!str(d.card_title)) errors.push('card_title 缺失');
  if (countChars(d.card_title) > L.CARD_TITLE) errors.push('card_title 超过 ' + L.CARD_TITLE + ' 字');
  if (C.CATEGORY.indexOf(d.category) === -1) errors.push('category 非法');
  if (!/^(\d+-\d+|未指定)$/.test(str(d.budget_band))) errors.push('budget_band 格式非法');
  if (!Array.isArray(d.tags) || d.tags.length > L.TAG_COUNT) errors.push('tags 必须是 0-' + L.TAG_COUNT + ' 个');
  (d.tags || []).forEach((t) => {
    if (countChars(t) > L.TAG) errors.push('tag 超过 ' + L.TAG + ' 字：' + t);
  });

  if (!Array.isArray(d.recommendations) || d.recommendations.length < 1 || d.recommendations.length > L.REC_COUNT) {
    errors.push('recommendations 必须是 1-' + L.REC_COUNT + ' 项');
  } else {
    d.recommendations.forEach((r, i) => {
      const at = 'recommendations[' + i + ']';
      if (C.REC_TYPE.indexOf(r.type) === -1) errors.push(at + '.type 非法');
      if (!str(r.name)) errors.push(at + '.name 缺失');
      if (!options.skipPriceCheck) {
        const p = str(r.price_expectation);
        const m = p.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元/);
        if (!m) errors.push(at + '.price_expectation 必须是区间（含 - 与 元）');
        else if (Number(m[1]) > Number(m[2])) errors.push(at + '.price_expectation 下限大于上限');
      }
      if (countChars(r.pros) > L.PROS) errors.push(at + '.pros 超过 ' + L.PROS + ' 字');
      if (countChars(r.cons) > L.CONS) errors.push(at + '.cons 超过 ' + L.CONS + ' 字');
    });
  }

  if (!Array.isArray(d.red_flags) || d.red_flags.length < 1 || d.red_flags.length > L.RED_FLAG_COUNT) {
    errors.push('red_flags 必须是 1-' + L.RED_FLAG_COUNT + ' 条');
  } else {
    d.red_flags.forEach((f) => {
      if (countChars(f) > L.RED_FLAG) errors.push('red_flag 超过 ' + L.RED_FLAG + ' 字：' + f);
    });
  }

  if (!str(d.search_keyword)) errors.push('search_keyword 缺失');
  if (countChars(d.search_keyword) > L.SEARCH_KEYWORD) errors.push('search_keyword 超过 ' + L.SEARCH_KEYWORD + ' 字');
  if (/http/i.test(str(d.search_keyword))) errors.push('search_keyword 不得含 URL');

  if (!Array.isArray(d.knowledge_refs) || d.knowledge_refs.length > L.REFS_COUNT) {
    errors.push('knowledge_refs 必须是 0-' + L.REFS_COUNT + ' 个');
  } else {
    d.knowledge_refs.forEach((id) => {
      if (!C.ID_PATTERN.test(id)) errors.push('knowledge_refs 非法 id：' + id);
    });
    if (!d.knowledge_refs.length && d.confidence !== 'low') errors.push('knowledge_refs 为空时 confidence 必须为 low');
  }

  if (C.CONFIDENCE.indexOf(d.confidence) === -1) errors.push('confidence 非法');
  if (d.disclaimer !== C.DISCLAIMER) errors.push('disclaimer 必须是固定文案');

  return { ok: errors.length === 0, errors };
}

/* ----------------------------- 降级模板卡 ----------------------------- */

const DEGRADED_TIPS = [
  '下单前先录开箱视频，包装与快递单同框，售后才有据可依',
  '低于官方定价 6 折的「全新现货」，先怀疑是翻新或散货',
  '二手交易一律要求拍特写视频，别只看主图和文案'
];

/**
 * 降级模板卡：不是空白，是「AI 开小差了，先给你三条通用建议」+ 重试按钮。
 * 它不是模型输出，所以 price_expectation 用「不限价位」而非编造区间
 * （见接口报告「与契约的偏差」第 2 条）。
 */
function buildDegradedCard(errorCode, opts) {
  const o = opts || {};
  const code = C.ERROR_CODE[errorCode] ? errorCode : 'E_UNKNOWN';
  return {
    status: 'degraded',
    error_code: code,
    is_followup: false,
    followup_question: '',
    decision_data: {
      card_title: o.title || 'AI 开小差了',
      category: 'universal',
      budget_band: '未指定',
      tags: ['通用建议', '非实时结论'],
      recommendations: [
        {
          type: '首选方案',
          name: o.recName || '先按「三查一录」自查',
          price_expectation: '不限价位',
          pros: clamp(o.pros || '查店铺资质、查防伪、查历史价，下单前录开箱', L.PROS),
          cons: clamp(o.cons || '通用建议，未结合你的具体需求', L.CONS)
        }
      ],
      red_flags: (o.tips || DEGRADED_TIPS).slice(0, L.RED_FLAG_COUNT),
      search_keyword: o.keyword || '学生党 避坑 选购指南',
      knowledge_refs: [],
      confidence: 'low',
      disclaimer: C.DISCLAIMER
    },
    meta: {
      elapsed_ms: o.elapsed_ms || 0,
      channel: 'degraded',
      cache_hit: false
    }
  };
}

/* ---------------------------- VerifyResult ---------------------------- */

function normalizeVerifyResult(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, result: null, errors: ['返回值不是对象'] };

  let status = str(raw.status);
  if (C.STATUS.indexOf(status) === -1) status = 'success';

  const sum = isObj(raw.search_summary) ? raw.search_summary : {};
  let feedback = Array.isArray(sum.community_feedback) ? sum.community_feedback : [];
  feedback = feedback
    .map((x) => clamp(str(x), L.FEEDBACK))
    .filter(Boolean)
    .filter((x) => !containsPrice(x) && !containsUrl(x)) // 价格/链接直接删该条（P4-4.4 合规防线）
    .slice(0, L.FEEDBACK_COUNT);

  let verdict = stripRiskySegments(sum.recent_verdict, '');
  let caution = stripRiskySegments(sum.caution_alert, '');

  if (status === 'empty') {
    verdict = verdict || '暂未检索到有效口碑';
    feedback = [];
    caution = caution || '';
  } else if (status === 'success') {
    if (feedback.length < 2) {
      // 价格过滤后剩不到 2 条 → 归为 empty，不算失败
      status = 'empty';
      verdict = '暂未检索到有效口碑';
      feedback = [];
    } else {
      verdict = verdict || '近期口碑已汇总，见下方社区反馈。';
    }
  }

  const sources = (Array.isArray(sum.sources_hint) ? sum.sources_hint : [])
    .map((x) => clamp(str(x), 12))
    .filter((x) => x && !containsUrl(x))
    .slice(0, L.SOURCES_COUNT);

  const metaRaw = isObj(raw.meta) ? raw.meta : {};
  const result = {
    status,
    search_summary: {
      recent_verdict: clamp(verdict, L.VERDICT),
      community_feedback: feedback,
      caution_alert: clamp(caution, L.CAUTION),
      sources_hint: sources
    },
    meta: {
      elapsed_ms: typeof metaRaw.elapsed_ms === 'number' ? metaRaw.elapsed_ms : 0,
      degraded: status === 'degraded' ? true : !!metaRaw.degraded,
      cache_hit: !!metaRaw.cache_hit,
      channel: str(metaRaw.channel) || 'agent'
    }
  };

  const v = validateVerifyResult(result);
  if (!v.ok) return { ok: false, result: null, errors: v.errors.concat(errors) };
  return { ok: true, result, errors };
}

function validateVerifyResult(result) {
  const errors = [];
  if (!isObj(result)) return { ok: false, errors: ['不是对象'] };
  if (C.STATUS.indexOf(result.status) === -1) errors.push('status 非法');
  const s = result.search_summary;
  if (!isObj(s)) {
    errors.push('search_summary 缺失');
    return { ok: false, errors };
  }
  if (!str(s.recent_verdict)) errors.push('recent_verdict 缺失');
  if (countChars(s.recent_verdict) > L.VERDICT) errors.push('recent_verdict 超过 ' + L.VERDICT + ' 字');
  if (!Array.isArray(s.community_feedback)) errors.push('community_feedback 必须是数组');
  else {
    if (s.community_feedback.length > L.FEEDBACK_COUNT) errors.push('community_feedback 超过 ' + L.FEEDBACK_COUNT + ' 条');
    if (result.status === 'success' && s.community_feedback.length < 2) errors.push('success 时 community_feedback 至少 2 条');
    if (result.status === 'empty' && s.community_feedback.length !== 0) errors.push('empty 时 community_feedback 必须为空');
    s.community_feedback.forEach((f) => {
      if (countChars(f) > L.FEEDBACK) errors.push('feedback 超过 ' + L.FEEDBACK + ' 字');
      if (containsPrice(f) || containsUrl(f)) errors.push('feedback 含价格或链接：' + f);
    });
  }
  if (countChars(s.caution_alert) > L.CAUTION) errors.push('caution_alert 超过 ' + L.CAUTION + ' 字');
  if (!Array.isArray(s.sources_hint) || s.sources_hint.length > L.SOURCES_COUNT) errors.push('sources_hint 必须是 0-' + L.SOURCES_COUNT + ' 个');
  else s.sources_hint.forEach((x) => {
    if (containsUrl(x)) errors.push('sources_hint 不得是 URL');
  });
  if (!isObj(result.meta) || typeof result.meta.elapsed_ms !== 'number' || typeof result.meta.degraded !== 'boolean') {
    errors.push('meta.elapsed_ms / meta.degraded 必填');
  }
  return { ok: errors.length === 0, errors };
}

/* ---------------------------- KnowledgeItem ---------------------------- */

const CONTENT_BANNED = ['据说', '好像', '网友表示', '听说'];

/**
 * 契约 §4.3 校验。B 岗每次入库后由 scripts/build-knowledge.js 调用。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
function validateKnowledgeItem(item) {
  const errors = [];
  const warnings = [];
  if (!isObj(item)) return { ok: false, errors: ['不是对象'], warnings };

  const id = str(item.id);
  if (!C.ID_PATTERN.test(id)) errors.push('id 不符合 {域}_{三位序号}：' + id);
  if (C.SCOPE.indexOf(item.scope) === -1) errors.push('scope 非法');
  if (C.CATEGORY.indexOf(item.category) === -1) errors.push('category 非法');
  if (item.scope === 'universal' && item.category !== 'universal') errors.push('scope=universal 时 category 必须是 universal');

  if (!Array.isArray(item.keywords)) errors.push('keywords 必须是数组');
  else {
    if (item.keywords.length < 3 || item.keywords.length > 6) errors.push('keywords 必须是 3-6 个');
    item.keywords.forEach((k) => {
      if (countChars(k) > 8) errors.push('keyword 超过 8 字：' + k);
    });
  }

  const title = str(item.title);
  if (!title) errors.push('title 缺失');
  if (countChars(title) > 16) errors.push('title 超过 16 字');
  if (/[？?]$/.test(title)) warnings.push('title 像话题名而不是规则名：' + title);

  const content = str(item.content);
  const clen = countChars(content);
  if (clen < 60 || clen > 120) errors.push('content 必须 60-120 字，当前 ' + clen + ' 字');
  CONTENT_BANNED.forEach((w) => {
    if (content.indexOf(w) !== -1) warnings.push('content 含不确定表述「' + w + '」，建议改为可执行规则');
  });
  if (/https?:\/\//i.test(content)) errors.push('content 不得含链接');
  if (/\d+\s*元/.test(content) && !/\d+\s*-\s*\d+/.test(content)) {
    warnings.push('content 出现单一价格，建议改成区间');
  }

  if (C.SEVERITY.indexOf(item.severity) === -1) errors.push('severity 非法');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(item.updated_at))) errors.push('updated_at 必须是 YYYY-MM-DD');

  const keys = Object.keys(item);
  const allowed = ['id', 'scope', 'category', 'keywords', 'title', 'content', 'severity', 'updated_at'];
  keys.forEach((k) => {
    if (allowed.indexOf(k) === -1) errors.push('多余字段：' + k);
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** 知识库 id 前缀与号段一致性检查（B 岗防撞号） */
function checkIdRange(item) {
  const id = str(item.id);
  const m = id.match(/^([a-z_]+)_(\d{3})$/);
  if (!m) return '格式错误';
  const prefix = m[1];
  const num = Number(m[2]);
  const ranges = {
    laptop: [1, 12],
    digital: [1, 12],
    chao_wan: [1, 12],
    beauty: [1, 12],
    bed: [1, 10],
    study: [1, 8],
    cross: [1, 18]
  };
  const r = ranges[prefix];
  if (!r) return '未知前缀：' + prefix;
  if (num < r[0] || num > r[1]) return prefix + ' 号段应为 ' + r[0] + '-' + r[1];
  return null;
}

module.exports = {
  normalizeDecisionCard,
  validateDecisionCard,
  normalizeVerifyResult,
  validateVerifyResult,
  validateKnowledgeItem,
  checkIdRange,
  buildDegradedCard,
  // 工具（组件/prompt 也复用）
  countChars,
  clamp,
  containsPrice,
  containsUrl,
  stripRiskySegments
};
