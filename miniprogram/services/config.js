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
 * 👇 云函数代理开关（当前方案：手机 → wx.cloud.callFunction → aiFallback → DeepSeek）
 * 真机受微信 request 域名白名单限制，无法直连 api.deepseek.com，会报 url not in domain list；
 * 改走云函数后不校验外部域名，Key 只存在云函数环境变量里。
 * 临时要回到「游客 AppID + 直连模型」调试时，把它改回 true。
 */
const PREVIEW_NO_CLOUD = false;

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
const ADAPTER = 'cloudfn';
const MODEL_PROVIDER = 'deepseek'; // createModel() 的 provider 标识
const MODEL_NAME = 'deepseek-flash'; // 控制台可见的模型名

/* ------------------------------------------------------------------ *
 * 4. 时限（契约 §6.2 三条硬时限，超时一律降级，不许无限转圈）
 *    原值 12s / 15s。直连 DeepSeek 实测出卡 3-6s，
 *    留出网络抖动与换模型重试的余量，统一放到 25s。
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
  secCheck: true,
  // 出卡前是否先联网检索一次真实报价。
  // 开着：卡片能写真实价格区间，代价是多一次搜索往返（约 1-3 秒）。
  // 关掉：出卡快 1-3 秒，价格只能是 estimate（品类参考区间），不是实时报价。
  // 答辩现场网络差时，把这个改成 false 是最省事的减延迟开关。
  decideWebSearch: true,
  // 流式出卡（HTTP 云函数 aiStreamHTTP + callHTTPFunction + SSE）。
  // 打开前必须先把 cloudfunctions/aiStreamHTTP 部署为「HTTP 云函数」，
  // 否则会多一次失败尝试再回落（不影响结果，只是白花 0.3s）。
  // 开着的好处：标题/红线 1-2 秒就能看见，不用盯着转圈等整张卡。
  stream: false
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
// 流式通道：HTTP 云函数名（必须与 cloudfunctions/aiStreamHTTP 目录同名）。
// 注意：这个名字是「HTTP 云函数」，只能在云开发控制台新建时选类型，
// 命令行部署建出来的只会是普通事件函数，callHTTPFunction 会返回 400。
const STREAM_FN_NAME = 'aiStreamHTTP';
// 流式整条链路的兜底时限（含检索）。超过就直接回落普通通道。
const STREAM_TOTAL_MS = 25000;

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
  '2. 品类优先：先判定品类，知识库里同品类条目优先于横切条目（二手/平台/时机），',
  '   横切只做补充，不得抢占同品类规则的引用位。',
  '3. 知识优先：知识库有明确规则的，把条目 id 写进 knowledge_refs，不得编造。',
  '4. 出卡：recommendations 1-2 项，red_flags 1-3 条。红线是本产品核心价值，',
  '   宁可少推荐也必须写红线。',
  '',
  '# 硬约束（价格纪律）',
  '- price_source 分三档：kb / web = 有真实报价来源；estimate = 按品类行情估算的参考区间；null = 连品类都判断不出。',
  '- 默认必须给价格：只要大致知道品类，就必须写 price_expectation，把它当作给用户看的参考区间。',
  '- 有知识库数字或本轮检索到的报价时：用真实区间，price_source 填 kb 或 web。',
  '- 没有真实来源时：仍要按品类行情给一个大致范围（如千元机 900-1800元、入门蓝牙耳机 80-250元），',
  '  price_source 填 estimate，price_note 固定写「参考区间，按品类行情估算，非实时报价」。',
  '- 估算区间要给得宽（上下浮动三到五成），宁可宽一点，也不要给精确到个位的数字。',
  '- 只有连品类都判断不出时，price_source 才填 null、price_expectation 留空。',
  '- 无论哪一档，price_expectation 都必须写成「数字-数字元」，不许用「约」「左右」「起」。',
  '',
  '# 硬约束（实体核实）',
  '- 用户提到的具体商品名 / 角色名 / IP / 型号，不得默认真实存在。',
  '- 检索结果里有对应商品时 entity_status 填 "verified"；只有品类词、没有具体商品时填 "partial"；',
  '  用户说了具体名称但检索不到、或结果明显不相关时填 "unknown"。',
  '- entity_status="unknown" 时：unverified_entities 填用户提到的具体名称（1-3 个），',
  '  search_keyword 去掉该名称、只保留品类词，卡片只给品类通用避坑建议；',
  '  价格仍要给，但只能按同品类行情写参考区间，price_source 填 estimate。',
  '- 严禁根据名称字面联想编造型号、系列、角色或联名信息。',
  '',
  '# 硬约束（通用）',
  '- 不给任何购买链接，只给 search_keyword，且不得含 http。',
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
  '    "price_source": "kb|web|estimate|null",',
  '    "price_note": "≤60字；estimate 时写「参考区间，按品类行情估算，非实时报价」",',
  '    "entity_status": "verified|partial|unknown",',
  '    "unverified_entities": ["0-3个未被核实的名称"],',
  '    "recommendations": [{"type":"首选方案|备选方案","name":"","price_expectation":"200-280元（必填，实在判断不出才留空）","pros":"≤40字","cons":"≤40字"}],',
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
  '3. 优先采用有具体事实的结论（批次/型号/店铺/时间）；只有品类级口碑时也可汇总，但要注明是品类通用观察。',
  '4. 检索结果互相矛盾时，在 caution_alert 里点明矛盾，不要强行统一。',
  '',
  '# 输出',
  '只输出一个 JSON，用 <json></json> 包裹：',
  '{"status":"success","search_summary":{"recent_verdict":"≤80字","community_feedback":["≤60字"],"caution_alert":"≤80字","sources_hint":["来源类型标签，不是URL"]}}',
  'community_feedback 2-4 条。只有完全没有检索结果、或结果与关键词完全无关时，status 才填 "empty"，',
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
  '- price_expectation：有知识库数字或本轮联网报价时写真实区间（如 240-300元），price_source 填 kb/web；',
  '  没有真实来源时也要给「数字-数字元」的品类参考区间（如 800-1500元），price_source 填 estimate，',
  '  price_note 写「参考区间，按品类行情估算，非实时报价」。只有连品类都判断不出才留空、price_source=null。',
  '- card_title ≤20 字；tags 每个 ≤8 字、最多 4 个；',
  '  pros / cons 每条 ≤40 字；red_flags 每条 ≤40 字、1-3 条。',
  '- search_keyword ≤30 字，不得含 http 或任何形式的链接。',
  '- 直接输出 JSON 对象本身，不要 markdown 代码块，不要任何解释文字。'
].join('\n');

/** 已注入本地知识库检索结果时（直连 / 云函数通道 + services/knowledge.js） */
const PROMPT_PATCH_WITH_KB = [
  '',
  '# 通道附加约束（本次已注入本地知识库）',
  '- 下面 <knowledge> 里是本次从避坑知识库检索到的条目，每条以 [id] 开头。',
  '- 必须优先采用 <knowledge> 里的规则；knowledge_refs 只能填 <knowledge> 中出现过的 id，0-4 个。',
  '- 严禁编造 <knowledge> 之外的条目 id，不确定就不写。',
  '- <knowledge> 覆盖本次需求时 confidence 至少填 "medium"；明显不覆盖时才填 "low"，',
  '  并在首选方案的 cons 里说明「该品类掌握有限，建议多平台比价」。',
  '- budget_band 只能是纯数字区间（如 200-300），判断不出就写「未指定」。',
  '- price_expectation：有知识库数字或本轮联网报价时写真实区间（如 240-300元），price_source 填 kb/web；',
  '  没有真实来源时也要给「数字-数字元」的品类参考区间（如 800-1500元），price_source 填 estimate，',
  '  price_note 写「参考区间，按品类行情估算，非实时报价」。只有连品类都判断不出才留空、price_source=null。',
  '- card_title ≤20 字；tags 每个 ≤8 字、最多 4 个；',
  '  pros / cons 每条 ≤40 字；red_flags 每条 ≤40 字、1-3 条。',
  '- search_keyword ≤30 字，不得含 http 或任何形式的链接。',
  '- 直接输出 JSON 对象本身，不要 markdown 代码块，不要任何解释文字。'
].join('\n');

/** 有联网检索能力时（verifyWebSearch=true） */
const PROMPT_PATCH_VERIFY_SEARCH = [
  '',
  '# 通道附加约束',
  '- 优先采用检索结果里有实据的内容（型号 / 批次 / 店铺 / 时间）；只有品类级口碑时也可汇总，但要注明是品类通用观察。',
  '- 只有完全没有检索结果、或结果与关键词完全无关时，才把 status 填 "empty"；有内容就汇总，不要因为"不够具体"就丢弃。',
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
  STREAM_FN_NAME,
  STREAM_TOTAL_MS,
  DECIDE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  PROMPT_PATCH_NO_KB,
  PROMPT_PATCH_WITH_KB,
  PROMPT_PATCH_VERIFY_SEARCH,
  PROMPT_PATCH_VERIFY_NO_SEARCH,
  LLM
};
