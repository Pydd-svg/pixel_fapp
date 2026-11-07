/**
 * shared/constants.js —— 枚举值唯一真源（契约 §3.2）
 * 归属：A 岗维护，B/C 只引用。
 *
 * ⚠️ 打包约束：小程序只能打包 miniprogramRoot 内的文件，
 *    因此 miniprogram/services/constants.js 是本文件的「同内容副本」。
 *    两者必须逐字节一致 —— scripts/check-fixtures.js 会做一致性校验并 FAIL。
 *    改这里 = 必须同步改副本（或跑 node scripts/build-assets.js）。
 *
 * 模块格式：CommonJS。原因：同一份文件要被小程序（require）和 Node 脚本（require）共用，
 * ESM 在 Node 端需要 .mjs/type:module，会牵连 package.json 影响开发者工具。
 */

// 品类（7 个 key / 5 个品类组，超纲填 universal）
// 冻结版 v2.0（2026-11-07）：删除 snack（零食）、daily（日用品），新增 study（学习用品）。
// 号段与既有 id 前缀一律不变，B 岗的 84 条按原前缀入库。
const CATEGORY = ['laptop', 'digital', 'chao_wan', 'beauty', 'bed', 'study', 'universal'];

// 品类中文名（UI 展示 / 日志可读性）
const CATEGORY_LABEL = {
  laptop: '笔记本电脑',
  digital: '数码',
  chao_wan: '潮玩手办',
  beauty: '护肤美妆',
  bed: '床上用品',
  study: '学习用品',
  universal: '通用'
};

// 知识库作用域
const SCOPE = ['category', 'universal'];

// 严重度：high=红色警示 / medium=橙色 / low=灰色提示
const SEVERITY = ['high', 'medium', 'low'];

// 置信度
const CONFIDENCE = ['high', 'medium', 'low'];

// 响应状态（DecisionCard 用前三个；VerifyResult 四个都用）
const STATUS = ['success', 'empty', 'degraded', 'error'];

// 推荐方案类型：只允许这两个字符串，前端按此排序
const REC_TYPE = ['首选方案', '备选方案'];

// 错误码：贯穿 aiClient → metrics → UI 文案 → Eval 失败归因
const ERROR_CODE = {
  E_PARSE: '解析失败',
  E_TIMEOUT: '超时',
  E_QUOTA: '额度耗尽',
  E_NET: '网络不可用',
  E_CONTENT: '内容不合规',
  E_UNKNOWN: '未知错误',
  // 直连大模型通道新增：免费模型限流、Key 无效、模型无权限，分开归因才排得动障
  E_RATE: '触发限流',
  E_AUTH: '凭据无效',
  E_MODEL: '模型不可用'
};

// 错误码 → 用户可读文案（C 可直接用，别自己造）
const ERROR_TEXT = {
  E_PARSE: 'AI 这次没说人话，我换个说法再试一次',
  E_TIMEOUT: '等太久了，网络有点慢',
  E_QUOTA: '今天的次数用完了，明天再来',
  E_NET: '网络不太稳，检查一下 WiFi',
  E_CONTENT: '这句话我先不处理，换个说法？',
  E_UNKNOWN: 'AI 开小差了，先给你三条通用建议',
  E_RATE: '这会儿问的人太多，等两秒再试一次',
  E_AUTH: '模型 Key 没生效，检查一下 services/llm.js',
  E_MODEL: '这个模型暂时用不了，已自动换备用的'
};

// 交互阶段：C 用它驱动 loading / 打字机 / 骨架屏
const STAGE = ['idle', 'judging', 'generating', 'merging', 'verifying', 'done', 'degraded'];

// 固定免责文案（契约 §4.1，合规项，任何人不得改）
const DISCLAIMER = '内容由 AI 生成，仅供参考 · 不构成购买建议';

// 知识库 id 规范（契约 §3.1：{域}_{三位序号}）
// v2.0 冻结：既有前缀一个都没改，只新增 study。snack / daily 保留在正则里，
// 是为了让历史遗留数据仍能通过格式校验（内容层已删，不会再有新条目）。
const ID_PATTERN = /^(laptop|digital|chao_wan|beauty|bed|study|snack|daily|cross)_\d{3}$/;
const ID_PREFIXES = ['laptop', 'digital', 'chao_wan', 'beauty', 'bed', 'study', 'snack', 'daily', 'cross'];

// 字段长度上限（统一放这里，schema.js 与 prompt 共用一套数字）
const LIMIT = {
  RAW_INPUT: 200,
  FOLLOWUP: 100,
  CARD_TITLE: 20,
  TAG: 8,
  TAG_COUNT: 4,
  REC_COUNT: 2,
  PROS: 40,
  CONS: 40,
  RED_FLAG: 40,
  RED_FLAG_COUNT: 3,
  SEARCH_KEYWORD: 30,
  REFS_COUNT: 4,
  VERDICT: 80,
  FEEDBACK: 60,
  FEEDBACK_COUNT: 4,
  CAUTION: 80,
  SOURCES_COUNT: 4,
  HISTORY_ROUNDS: 6
};

module.exports = {
  CATEGORY,
  CATEGORY_LABEL,
  SCOPE,
  SEVERITY,
  CONFIDENCE,
  STATUS,
  REC_TYPE,
  ERROR_CODE,
  ERROR_TEXT,
  STAGE,
  DISCLAIMER,
  ID_PATTERN,
  ID_PREFIXES,
  LIMIT
};
