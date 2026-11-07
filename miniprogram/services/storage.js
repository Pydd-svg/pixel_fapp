/**
 * services/storage.js —— 档案存取与本地限额（契约 P2-2.9 / P3-3.3）
 * 归属：A 岗。
 *
 * 设计取舍：不做云数据库（v2 §4.3-③），用户数据全在端上。
 * 但端上有两个硬约束必须代码兜住：
 *   1. 单 key 建议 < 1MB，整体 10MB —— 卡片只存最近 20 条（FIFO）
 *   2. 单条超 8KB 时截掉 raw_input，避免一条长输入把存储撑爆
 */

const KEY_CARDS = 'my_cards_v1';
const KEY_USAGE = 'usage_daily_v1';
const KEY_DEMO = 'demo_mode_v1';
const MAX_CARDS = 20;
const MAX_RECORD_BYTES = 8 * 1024;

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function read(key, fallback) {
  if (!hasStorage()) return fallback;
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  if (!hasStorage()) return false;
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function newId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

/** 估算字符体积（中文一个字符按 1 计，够用；不需要精确字节） */
function sizeOf(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch (e) {
    return 0;
  }
}

/** 超限时按「先丢原文、再丢 meta、再截断长文案」的顺序瘦身 */
function shrink(record) {
  if (sizeOf(record) <= MAX_RECORD_BYTES) return record;
  const r = Object.assign({}, record);
  delete r.raw_input;
  if (sizeOf(r) <= MAX_RECORD_BYTES) return r;

  r.meta = { elapsed_ms: 0, channel: 'shrunk', cache_hit: false };
  if (sizeOf(r) <= MAX_RECORD_BYTES) return r;

  const d = r.card && r.card.decision_data;
  if (d) {
    d.red_flags = (d.red_flags || []).slice(0, 3);
    (d.recommendations || []).forEach((rec) => {
      rec.pros = String(rec.pros || '').slice(0, 20);
      rec.cons = String(rec.cons || '').slice(0, 20);
    });
  }
  return r;
}

function listCards() {
  const arr = read(KEY_CARDS, []);
  return Array.isArray(arr) ? arr : [];
}

/**
 * @param {object} card DecisionCard（整包，不是 decision_data）
 * @param {{rawInput?:string}} [opts]
 * @returns {{ok:boolean, id?:string, reason?:string}}
 */
function saveCard(card, opts) {
  if (!card || !card.decision_data) return { ok: false, reason: 'EMPTY_CARD' };
  const o = opts || {};
  const d = card.decision_data;
  const record = shrink({
    id: newId(),
    ts: Date.now(),
    title: d.card_title || '未命名决策卡',
    category: d.category || 'universal',
    confidence: d.confidence || 'low',
    status: card.status || 'success',
    raw_input: String(o.rawInput || '').slice(0, 200),
    card
  });

  const list = listCards();
  list.unshift(record);
  const kept = list.slice(0, MAX_CARDS); // FIFO：超 20 条丢最旧
  const ok = write(KEY_CARDS, kept);
  return ok ? { ok: true, id: record.id } : { ok: false, reason: 'STORAGE_FAIL' };
}

function getCard(id) {
  return listCards().filter((x) => x.id === id)[0] || null;
}

function removeCard(id) {
  const list = listCards().filter((x) => x.id !== id);
  return write(KEY_CARDS, list);
}

function clearCards() {
  return write(KEY_CARDS, []);
}

/* --------------------------- 每日限额（纯前端） --------------------------- */

function readUsage() {
  const u = read(KEY_USAGE, null);
  if (!u || u.date !== today()) return { date: today(), decide: 0, verify: 0 };
  return { date: u.date, decide: u.decide || 0, verify: u.verify || 0 };
}

/**
 * @param {'decide'|'verify'} action
 * @param {{decidePerDay:number, verifyPerDay:number}} limits 从 config.LIMIT 传进来
 */
function checkQuota(action, limits) {
  const u = readUsage();
  const cap = action === 'verify' ? limits.verifyPerDay : limits.decidePerDay;
  return { allowed: u[action] < cap, used: u[action], cap };
}

function bumpUsage(action) {
  const u = readUsage();
  u[action] = (u[action] || 0) + 1;
  write(KEY_USAGE, u);
  return u;
}

function resetUsage() {
  return write(KEY_USAGE, { date: today(), decide: 0, verify: 0 });
}

/* ------------------------------ Demo 标记 ------------------------------ */

function setDemoMode(on) {
  write(KEY_DEMO, !!on);
  return !!on;
}

function getDemoMode() {
  return !!read(KEY_DEMO, false);
}

module.exports = {
  listCards,
  saveCard,
  getCard,
  removeCard,
  clearCards,
  checkQuota,
  bumpUsage,
  resetUsage,
  readUsage,
  setDemoMode,
  getDemoMode,
  MAX_CARDS,
  MAX_RECORD_BYTES
};
