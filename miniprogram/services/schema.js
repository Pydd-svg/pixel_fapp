/**
 * services/schema.js —— 校验与归一化（契约 §4）
 * 归属：A 岗。纯函数，无 wx 依赖，Node 脚本与小程序共用。
 *
 * 分工原则（很重要，别混）：
 *   normalize* = 只做「结构性修复」——补默认值、截断超长、数组化、去重、过滤非法 id。
 *   validate*  = 只做「契约判废」——缺字段、空数组、单一价格、含链接，一律判废。
 * 语义类错误（红线为空、价格是单值）**不在归一化里偷偷补**，
 * 判废后由 aiClient 重试一次，仍失败才降级 —— 否则数据来源无法自证。
 * 唯一例外：模型声称有价格来源却给不出任何可核验区间时，整卡降为 estimate
 * （保留/展开成品类参考区间），而不是让整张卡作废或整片价格清空 ——
 * 见 normalizeDecisionData。
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

function hasAnyPrice(recs) {
  if (!Array.isArray(recs)) return false;
  return recs.some((r) => !!str(r && r.price_expectation));
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

/**
 * 价格归一化：只负责「把模型写的各种区间写法收成 数字-数字元」。
 * 容错面要宽 —— 模型可能写：
 *   200-280元 / 200~280元 / 200 – 280 元 / 200至280元 / 1,200-1,500元 / 1.2万-1.5万
 * 这些都是同一个意思，不该因为连接符或千分位不同就判废整张卡。
 * 单值（约250元）：estimate 档展开成大致范围（±25%/30%），kb/web 档仍返回空串 ——
 * 真实来源却只给一个数，说明模型在含糊其辞，不能替它编区间。
 */
const PRICE_NUM_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;

/**
 * 单值 → 参考区间。按量级取整，避免出现 238.7-412.3 这种假精确。
 * 下浮 25%、上浮 30%，再对齐到量级步长（2000 以上按 200，500 以上按 100…）。
 */
function widenSingle(n) {
  const step = n >= 5000 ? 500 : n >= 2000 ? 200 : n >= 500 ? 100 : n >= 100 ? 20 : n >= 20 ? 5 : 1;
  const lo = Math.max(step, Math.round((n * 0.75) / step) * step);
  const hi = Math.max(lo + step, Math.round((n * 1.3) / step) * step);
  return [lo, hi];
}

function normalizePrice(v, allowSingle) {
  const raw = str(v);
  if (!raw) return '';
  const s = raw.replace(/\s/g, '');
  const perWan = /万/.test(s);
  const nums = (s.match(PRICE_NUM_RE) || [])
    .map((t) => Number(t.replace(/,/g, '')))
    .filter((n) => isFinite(n) && n > 0);
  if (!nums.length) return '';

  if (nums.length < 2) {
    if (!allowSingle) return '';
    const [lo, hi] = widenSingle(nums[0] * (perWan ? 10000 : 1));
    return lo + '-' + hi + '元';
  }

  const k = perWan ? 10000 : 1;
  let lo = Math.min(nums[0], nums[1]) * k;
  let hi = Math.max(nums[0], nums[1]) * k;
  if (!isFinite(lo) || !isFinite(hi) || hi <= 0) return '';
  // 去掉多余小数尾巴（2680.00 -> 2680）
  const fmt = (n) => String(Number(n.toFixed(2)));
  return fmt(lo) + '-' + fmt(hi) + '元';
}

function normalizeRecommendations(v, errors, priceSource) {
  if (!Array.isArray(v)) {
    errors.push('recommendations 不是数组');
    return [];
  }
  // estimate（品类估算）允许把模型给的单值展开成范围；kb / web 只认真实区间
  const allowSingle = priceSource === 'estimate';
  const out = v
    .filter(isObj)
    .map((r, i) => {
      let type = str(r.type);
      if (C.REC_TYPE.indexOf(type) === -1) type = i === 0 ? C.REC_TYPE[0] : C.REC_TYPE[1];
      return {
        type,
        name: clamp(str(r.name), 24),
        // 没有价格来源时清空，前端提示「参考区间暂缺」
        price_expectation: priceSource ? normalizePrice(r.price_expectation, allowSingle) : '',
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

function normalizeEntities(v) {
  if (!Array.isArray(v)) return [];
  return uniq(
    v
      .map((x) => clamp(str(x), 16))
      .filter(Boolean)
  ).slice(0, 3);
}

function normalizeDecisionData(raw, errors) {
  if (!isObj(raw)) return null;
  const category = C.CATEGORY.indexOf(str(raw.category)) !== -1 ? str(raw.category) : 'universal';

  // 价格来源：kb / web = 真实报价，estimate = 品类行情估算，其余视为"没说"
  let priceSource = str(raw.price_source).toLowerCase();
  if (['kb', 'web', 'estimate'].indexOf(priceSource) === -1) priceSource = '';

  // 模型没标来源却写了价格：当作估算档保留 —— 用户要的是"大致范围"，
  // 因为一个字段没填就把整卡价格清空，是最差的处理
  const rawRecs = Array.isArray(raw.recommendations) ? raw.recommendations : [];
  if (!priceSource && rawRecs.some((r) => isObj(r) && str(r.price_expectation))) {
    priceSource = 'estimate';
  }

  let priceNote = clamp(str(raw.price_note), 60);
  if (priceSource === 'estimate' && !priceNote) {
    priceNote = '参考区间，按品类行情估算，非实时报价';
  }
  if (!priceSource) {
    priceNote = priceNote || '暂未取得该商品的参考区间，请以下单页价格为准';
  }

  // 实体核实：unknown 必须带具体名称，否则降级为 partial，避免空提示
  let entityStatus = str(raw.entity_status);
  if (['verified', 'partial', 'unknown'].indexOf(entityStatus) === -1) entityStatus = 'partial';
  const entities = normalizeEntities(raw.unverified_entities);
  if (entityStatus === 'unknown' && !entities.length) entityStatus = 'partial';
  // 具体商品没核实到：仍然给「同品类大致范围」，只是把来源锁死在 estimate
  if (entityStatus === 'unknown') {
    if (priceSource === 'kb' || priceSource === 'web') priceSource = 'estimate';
    if (!priceSource) priceSource = 'estimate';
    priceNote = '未核实到该商品，以下为同品类参考区间，非该型号实时报价';
  }

  const refs = normalizeRefs(raw.knowledge_refs);
  let recs = normalizeRecommendations(raw.recommendations, errors, priceSource);

  // 价格一致性兜底：模型声称有来源（kb/web），却一条可核验区间都给不出来时，
  // 不死判整卡，也不清空价格 —— 降到 estimate 用同一批原始数据重算一次，
  // 单值／「约250元」这类写法在估算档下会被展开成大致范围。
  if (priceSource === 'kb' || priceSource === 'web') {
    const priced = recs.filter((r) => !!str(r.price_expectation));
    if (!priced.length) {
      console.warn('[schema] price_source=' + priceSource + ' 但无可核验区间，降为 estimate');
      priceSource = 'estimate';
      priceNote = '未取得可核验报价，以下为同品类参考区间';
      const retry = normalizeRecommendations(raw.recommendations, [], 'estimate');
      if (retry.length) recs = retry;
    }
  }

  // 估算也给不出任何数字：退回无价格态，前端提示"参考区间暂缺"
  if (priceSource === 'estimate' && !recs.some((r) => !!str(r.price_expectation))) {
    priceSource = '';
    priceNote = '暂未取得可用的参考区间，请以下单页价格为准';
  }
  let confidence = C.CONFIDENCE.indexOf(str(raw.confidence)) !== -1 ? str(raw.confidence) : 'medium';
  if (!refs.length) confidence = 'low'; // 契约 §4.1 硬约束

  return {
    card_title: clamp(str(raw.card_title), L.CARD_TITLE) || C.CATEGORY_LABEL[category] + '决策卡',
    category,
    budget_band: normalizeBudgetBand(raw.budget_band),
    tags: normalizeTags(raw.tags),
    price_source: priceSource || null,
    price_note: priceNote,
    entity_status: entityStatus,
    unverified_entities: entities,
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
  // 降级卡是本地模板，price_expectation 写「不限价位」，不做区间硬校验
  const v = validateDecisionCard(card, { skipPriceCheck: status === 'degraded' });
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

  // 价格纪律：price_source=null 时必须没有任何价格；其余档位校验区间格式
  if (!(d.price_source === null || d.price_source === 'kb' || d.price_source === 'web' || d.price_source === 'estimate')) {
    errors.push('price_source 必须是 kb / web / estimate / null');
  }
  if (d.price_source === null && hasAnyPrice(d.recommendations)) {
    errors.push('price_source=null 时 price_expectation 必须为空');
  }

  if (['verified', 'partial', 'unknown'].indexOf(d.entity_status) === -1) errors.push('entity_status 非法');
  if (!Array.isArray(d.unverified_entities) || d.unverified_entities.length > 3) {
    errors.push('unverified_entities 必须是 0-3 个');
  } else {
    d.unverified_entities.forEach((x) => {
      if (countChars(x) > 16) errors.push('unverified_entity 超过 16 字：' + x);
    });
    if (d.entity_status === 'unknown' && !d.unverified_entities.length) {
      errors.push('entity_status=unknown 时 unverified_entities 至少 1 个');
    }
  }

  if (!Array.isArray(d.recommendations) || d.recommendations.length < 1 || d.recommendations.length > L.REC_COUNT) {
    errors.push('recommendations 必须是 1-' + L.REC_COUNT + ' 项');
  } else {
    // 有来源时：非空的价格必须合法，且至少 1 项给出可核验区间。
    // 允许个别方案空价（前端显示「暂无可靠报价」）—— 一条缺价不该让整张卡作废。
    let priced = 0;
    d.recommendations.forEach((r, i) => {
      const at = 'recommendations[' + i + ']';
      if (C.REC_TYPE.indexOf(r.type) === -1) errors.push(at + '.type 非法');
      if (!str(r.name)) errors.push(at + '.name 缺失');
      if (!options.skipPriceCheck && d.price_source !== null && str(r.price_expectation)) {
        const p = str(r.price_expectation);
        const m = p.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元/);
        if (!m) errors.push(at + '.price_expectation 格式非法（应为 数字-数字元）');
        else if (Number(m[1]) > Number(m[2])) errors.push(at + '.price_expectation 下限大于上限');
        else priced++;
      }
      if (countChars(r.pros) > L.PROS) errors.push(at + '.pros 超过 ' + L.PROS + ' 字');
      if (countChars(r.cons) > L.CONS) errors.push(at + '.cons 超过 ' + L.CONS + ' 字');
    });
    if (!options.skipPriceCheck && d.price_source !== null && priced === 0) {
      errors.push('price_source 非空时至少 1 项 price_expectation 必须是区间');
    }
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
      price_source: null,
      price_note: '通用建议，没有可核实的价格来源',
      entity_status: 'partial',
      unverified_entities: [],
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
