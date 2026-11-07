/**
 * services/config.js —— 常量与开关（契约 §5.1 依赖）
 * 归属：A 岗。C 只读，不得改。
 *
 * 🔴 红线：本文件不写任何 API Key。
 *    Key 只在 services/llm.js（直连预览用）或云函数环境变量（上线用）里。
 */

const LLM = require('./llm');

const APP_VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * 1. 云开发环境（👤 人工填：控制台 → 设置 → 环境 ID）
 * ------------------------------------------------------------------ */
const CLOUD_ENV_ID = 'cloud1-d6goz8wc570dd904d'; // 云开发环境 ID（控制台 → 设置 → 环境 ID）

/**
 * 云开发到底有没有真的开通。
 * 坑在这里：占位环境 ID 看着像真的，wx.cloud.init 也不会抛错（同步返回成功），
 * 但之后任何 callFunction 都会 -601034「没有权限，请先开通云开发或者云托管」。
 * 与其每次白打一发再吃一屏红字，不如在入口就判断掉。
 * 换真实环境 ID 后这个值自动变 true，云函数兜底和内容安全就一起复活。
 */
const CLOUD_ENV_OK = CLOUD_ENV_ID.indexOf('00000000000000') === -1;

/**
 * 👇 队友预览包专用开关（这一版是「游客 AppID + 直连模型」）
 * 游客身份不属于这个云环境，init 之后任何 callFunction 都会 -601034 刷一屏红字。
 * 所以整包不碰云开发：出卡走直连模型，内容安全 / 云函数兜底自动短路（代码里都有分支）。
 * 换成自己的 AppID 并开通云开发后，把它改回 false 就恢复全部云端能力。
 */
const PREVIEW_NO_CLOUD = true;

const CLOUD_ENABLED = !PREVIEW_NO_CLOUD && CLOUD_ENV_OK;

/* ------------------------------------------------------------------ *
 * 2. 两个 Agent 的 botId（👤 D2 控制台创建后填入）
 *    决策 Agent：挂知识库 / 联网 OFF / 温度 0.3
 *    查证 Agent：不挂库 / 联网 ON / 温度 0.5
 * ------------------------------------------------------------------ */
const BOT_ID_DECIDE = ''; // TODO 形如 'bot-xxxxxxxx'
const BOT_ID_VERIFY = ''; // TODO

/* ------------------------------------------------------------------ *
 * 3. 通道适配层（答辩话术：四条通道可切，切换不改业务代码）
 *    'auto'    按优先级探测：直连大模型 → Agent → createModel → 云函数
 *    'http'    强制直连大模型（services/llm.js，OpenAI 兼容协议）
 *    'bot'     强制 Agent（ai.bot.sendMessage）
 *    'model'   强制直连模型（createModel().streamText）
 *    'cloudfn' 强制云函数 aiFallback
 * ------------------------------------------------------------------ */
const ADAPTER = 'auto';
const MODEL_PROVIDER = 'deepseek'; // createModel() 的 provider 标识
const MODEL_NAME = 'deepseek-v3'; // 控制台可见的模型名

/* ------------------------------------------------------------------ *
 * 4. 时限（契约 §6.2 三条硬时限，超时一律降级，不许无限转圈）
 *    原值 12s / 15s。接上免费模型 glm-4.7-flash 后实测出卡 5-6s，
 *    但免费档有并发排队（1305），留出退避重试的余量，统一放到 20s。
 * ------------------------------------------------------------------ */
const DECIDE_TIMEOUT_MS = LLM.enabled ? LLM.timeoutMs : 12000;
const VERIFY_TIMEOUT_MS = LLM.enabled ? LLM.timeoutMs : 15000;

/* ------------------------------------------------------------------ *
 * 5. 功能开关
 * ------------------------------------------------------------------ */
const FEATURE = {
  // 本地样例通道：true 时所有网络调用短路，直接读 miniprogram/mock/index.js
  // 👤 C 灌样例数据排查样式时打开（契约 §6.3 第一行）
  useFixture: false,
  // 云端通道：Agent 失败后是否继续尝试云函数 aiFallback
  useFallback: true,
  // Demo 模式：首页连点 LOGO 5 次进入，纯本地回放，**全程不发网络请求**
  demoMode: false,
  // 每日限额（LIMIT.decidePerDay / verifyPerDay）。
  // 关掉后不再拦截，只保留用量计数（埋点还要用）。
  // 原设计是为了"把额度留给真正要买的那次"+ 防模型计费；
  // 现在走免费模型，自己也演示方便，默认关掉。
  // 要恢复答辩叙事里的"克制"，把它改回 true 即可。
  quota: false,
  // 内容安全检查（msgSecCheck）。关闭后 E_CONTENT 分支不会触发，
  // 只允许在额度紧张时临时关闭，提交前必须为 true
  secCheck: true
};

/* ------------------------------------------------------------------ *
 * 6. 限流与缓存（契约 P3-3.3 / P4-4.5）
 * ------------------------------------------------------------------ */
const LIMIT = {
  decidePerDay: 5,
  verifyPerDay: 3
};

const CACHE_TTL = {
  decide: 24 * 60 * 60 * 1000, // 需求指纹缓存 24h
  verify: 2 * 60 * 60 * 1000 // 查证结果缓存 2h
};

/* ------------------------------------------------------------------ *
 * 7. 云函数名
 * ------------------------------------------------------------------ */
const CLOUD_FN_NAME = 'aiFallback';

/* ------------------------------------------------------------------ *
 * 8. System Prompt（B 岗在控制台维护最终版；此处为代码侧兜底）
 *    改动提示：prompt 里出现的字段名与 shared/schema 必须一致，
 *    改字段 = 改契约，走契约 §9 变更流程。
 * ------------------------------------------------------------------ */
const DECIDE_SYSTEM_PROMPT = [
  '# Role',
  '你是「避坑导购」——懂行的学长/学姐，精通学生党高频消费品类：',
  '电脑、数码（耳机/充电宝/U盘存储）、潮玩手办、护肤美妆、床上用品、学习用品（教材/教辅/文具）。',
  '你还掌握横切规则：二手交易铁律、平台选择、价格时机。',
  '你的目标不是让用户买，而是让用户不买错。',
  '',
  '# 工作流',
  '1. 信息判定：检查三要素——品类 / 预算 / 使用场景。',
  '   - 缺 2 项以上：只输出一次追问，is_followup=true，decision_data=null。',
  '     追问一句问清 1-2 个问题，不超过 100 字。',
  '   - 缺 1 项：用合理假设补齐，在 tags 里加「按XX假设」，直接出卡。',
  '   - 齐全：直接出卡。',
  '2. 知识优先：知识库有明确规则的，把条目 id 写进 knowledge_refs，不得编造。',
  '3. 出卡：recommendations 1-2 项，red_flags 1-3 条。红线是本产品核心价值，',
  '   宁可少推荐也必须写红线。',
  '',
  '# 硬约束',
  '- 不给任何购买链接，只给 search_keyword，且不得含 http。',
  '- 不承诺实时价格：price_expectation 必须是「数字-数字元」的区间。',
  '- 知识库无覆盖时 confidence 填 low，cons 里明说「该品类掌握有限，建议多平台比价」。',
  '- 严禁编造型号、参数、认证编号。',
  '- 语调：懂行的朋友，短句，不用「亲」「宝子」。',
  '',
  '# 输出',
  '只输出一个 JSON 对象，用 <json></json> 包裹，不要任何其他文字。字段严格如下：',
  '{',
  '  "status": "success",',
  '  "error_code": null,',
  '  "is_followup": false,',
  '  "followup_question": "",',
  '  "decision_data": {',
  '    "card_title": "≤20字，含品类与预算特征",',
  '    "category": "laptop|digital|chao_wan|beauty|bed|study|universal",',
  '    "budget_band": "如 200-300，未知填 未指定",',
  '    "tags": ["0-4个，每个≤8字"],',
  '    "recommendations": [{"type":"首选方案|备选方案","name":"","price_expectation":"200-280元","pros":"≤40字","cons":"≤40字"}],',
  '    "red_flags": ["1-3条，每条≤40字"],',
  '    "search_keyword": "≤30字，不含链接",',
  '    "knowledge_refs": ["真实条目id，0-4个"],',
  '    "confidence": "high|medium|low",',
  '    "disclaimer": "内容由 AI 生成，仅供参考 · 不构成购买建议"',
  '  }',
  '}'
].join('\n');

const VERIFY_SYSTEM_PROMPT = [
  '# Role',
  '你是消费口碑核查员。收到 [ADVANCED_SEARCH: 关键词] 后：',
  '1. 联网检索该商品的真实评测、翻车吐槽、品控问题、售后体验。',
  '2. 严禁检索或输出任何价格信息、任何购买链接。',
  '3. 只保留有具体事实的结论（批次/型号/店铺/时间），丢弃泛泛而谈。',
  '4. 检索结果互相矛盾时，在 caution_alert 里点明矛盾，不要强行统一。',
  '',
  '# 输出',
  '只输出一个 JSON，用 <json></json> 包裹：',
  '{"status":"success","search_summary":{"recent_verdict":"≤80字","community_feedback":["≤60字"],"caution_alert":"≤80字","sources_hint":["来源类型标签，不是URL"]}}',
  'community_feedback 2-4 条。检索不到有效信息时 status 填 "empty"，',
  'recent_verdict 写「暂未检索到有效口碑」，community_feedback 为空数组。'
].join('\n');

/* ------------------------------------------------------------------ *
 * 8. 通道补丁 Prompt
 *    直连通道没有挂知识库 / 没有联网，prompt 里必须把这层「能力边界」讲清楚，
 *    否则模型会编 knowledge_refs 和具体批次。这些补丁只加约束，不改字段名，
 *    因此不影响 schema 契约。
 * ------------------------------------------------------------------ */

/** 无 RAG 的知识缺口说明（直连 / 云函数通道用） */
const PROMPT_PATCH_NO_KB = [
  '',
  '# 通道附加约束（必须遵守，违反即判废）',
  '- 当前没有接入知识库：knowledge_refs 一律输出空数组 []，confidence 一律填 "low"，',
  '  并在首选方案的 cons 里提醒「该品类掌握有限，建议多平台比价」。',
  '- budget_band 只能是纯数字区间（如 200-300），判断不出就写「未指定」。',
  '- price_expectation 必须严格写成「数字-数字元」，例如 240-300元；',
  '  不许出现「约」「左右」「起」之类修饰，两个数字用半角 - 连接。',
  '- card_title ≤20 字；tags 每个 ≤8 字、最多 4 个；',
  '  pros / cons 每条 ≤40 字；red_flags 每条 ≤40 字、1-3 条。',
  '- search_keyword ≤30 字，不得含 http 或任何形式的链接。',
  '- 直接输出 JSON 对象本身，不要 markdown 代码块，不要任何解释文字。'
].join('\n');

/** 有联网检索能力时（verifyWebSearch=true） */
const PROMPT_PATCH_VERIFY_SEARCH = [
  '',
  '# 通道附加约束',
  '- 优先采用检索结果里有实据的内容（型号 / 批次 / 店铺 / 时间），丢弃泛泛而谈。',
  '- recent_verdict ≤80 字；community_feedback 2-4 条、每条 ≤60 字；caution_alert ≤80 字。',
  '- 任何字段都不得出现价格数字和购买链接；sources_hint 只写来源类型标签。'
].join('\n');

/** 没有联网检索时（verifyWebSearch=false / 请求自动摘掉工具后） */
const PROMPT_PATCH_VERIFY_NO_SEARCH = [
  '',
  '# 通道附加约束',
  '- 当前没有联网检索能力：只写你有把握的通用事实，严禁编造型号、批次、店铺名。',
  '- 确实没有具体事实可讲时，status 填 "empty"，不要硬凑。',
  '- recent_verdict ≤80 字；community_feedback 2-4 条、每条 ≤60 字；caution_alert ≤80 字。',
  '- 任何字段都不得出现价格数字和购买链接。'
].join('\n');

module.exports = {
  APP_VERSION,
  CLOUD_ENV_ID,
  CLOUD_ENABLED,
  BOT_ID_DECIDE,
  BOT_ID_VERIFY,
  ADAPTER,
  MODEL_PROVIDER,
  MODEL_NAME,
  DECIDE_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  FEATURE,
  LIMIT,
  CACHE_TTL,
  CLOUD_FN_NAME,
  DECIDE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  PROMPT_PATCH_NO_KB,
  PROMPT_PATCH_VERIFY_SEARCH,
  PROMPT_PATCH_VERIFY_NO_SEARCH,
  LLM
};
