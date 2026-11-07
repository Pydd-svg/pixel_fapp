/**
 * services/metrics.js —— 本地埋点环形缓冲（契约 P3-3.4 / P3-3.5）
 * 归属：A 岗。
 *
 * 只存本地，不上传。导出 JSON 可在 Excel 里直接打开（写入的是合法 JSON 数组）。
 * 字段固定：{ ts, action, stage, elapsed, status, error_code, cache_hit, channel }
 */

const KEY = 'metrics_ring_v1';
const CAP = 200;

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function load() {
  if (!hasStorage()) return [];
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function persist(list) {
  if (!hasStorage()) return;
  try {
    wx.setStorageSync(KEY, list);
  } catch (e) {
    /* 埋点失败绝不影响主流程 */
  }
}

/**
 * @param {object} entry
 * @param {'decide'|'verify'|'copy'|'save'|'share'|'report'|'secCheck'} entry.action
 * @param {string} [entry.stage]
 * @param {number} [entry.elapsed] 毫秒
 * @param {string} [entry.status] success|degraded|error|empty
 * @param {string} [entry.error_code]
 * @param {boolean} [entry.cache_hit]
 * @param {string} [entry.channel]
 * @param {number} [entry.parse_level]
 */
function record(entry) {
  const list = load();
  list.push({
    ts: Date.now(),
    action: entry.action || 'unknown',
    stage: entry.stage || '',
    elapsed: typeof entry.elapsed === 'number' ? entry.elapsed : 0,
    status: entry.status || '',
    error_code: entry.error_code || '',
    cache_hit: !!entry.cache_hit,
    channel: entry.channel || '',
    parse_level: typeof entry.parse_level === 'number' ? entry.parse_level : null
  });
  // 环形缓冲：超 200 条从头丢
  while (list.length > CAP) list.shift();
  persist(list);
  return list.length;
}

function list() {
  return load();
}

function clear() {
  persist([]);
  return [];
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 答辩要报的数字：直接出这张表（L4 性能级） */
function summary() {
  const all = load();
  const pick = (action) => all.filter((x) => x.action === action);
  const stats = (rows) => {
    const ok = rows.filter((r) => r.status === 'success' || r.status === 'empty');
    const hit = rows.filter((r) => r.cache_hit);
    const elapsed = rows.map((r) => r.elapsed).filter((n) => n > 0);
    return {
      count: rows.length,
      success: ok.length,
      cache_hit: hit.length,
      p50: percentile(elapsed, 50),
      p95: percentile(elapsed, 95),
      avg: elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0
    };
  };
  return {
    total: all.length,
    decide: stats(pick('decide')),
    verify: stats(pick('verify')),
    degrade: all.filter((r) => r.status === 'degraded').length
  };
}

/** 导出成 JSON 文本（dev 页一键复制，粘到文件里就是 eval 记录） */
function exportJSON() {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      summary: summary(),
      records: load()
    },
    null,
    2
  );
}

module.exports = { record, list, clear, summary, exportJSON, percentile, CAP };
