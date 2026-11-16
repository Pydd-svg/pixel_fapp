/**
 * services/llm.js —— 大模型直连配置（唯一收口处）
 *
 * 为什么单独一个文件：
 *   契约里写着「miniprogram/ 下不得出现 API Key」。
 *   当前走云函数代理：Key 只在云函数环境变量 LLM_API_KEY，本文件 apiKey 已清空。
 *     1) 本文件只保留端点与模型链，直连模式不再使用
 *     2) 若临时要用直连调试，才需要临时填 Key（真机仍会被域名白名单拦）
 *
 * 当前接的是 DeepSeek 官方 API（OpenAI 兼容协议）：
 *   - 端点 https://api.deepseek.com/v1
 *   - 主模型 deepseek-flash，失败自动退到 deepseek-chat
 *
 * ⚠️ 不要把 Key 写回本文件：小程序包可被解包，前端持有 Key 等于公开。
 */

const LLM = {
  // 总开关：false 时退回到原来的三条通道（Agent / createModel / 云函数）
  enabled: true,

  // 'direct' = 小程序前端直接 wx.request 打模型（真机会被域名白名单拦）
  // 'proxy'  = 走云函数 aiFallback，Key 放云函数环境变量（当前使用这个）
  mode: 'proxy',

  // OpenAI 兼容端点：{baseUrl}/chat/completions
  baseUrl: 'https://api.deepseek.com/v1',
  // 已清空：Key 只存在云函数环境变量 LLM_API_KEY，前端不再持有
  apiKey: '',

  // 主模型：日志展示与「全部冷却时」的兜底，真正先用谁由下面的 models 决定
  model: 'deepseek-flash',

  // 模型降级链：顺序即优先级；被限流的模型冷却 90 秒后自动回到队首。
  // deepseek-flash 为主；若该模型名在当前账号下不可用，自动退到官方稳定模型 deepseek-chat。
  models: ['deepseek-flash', 'deepseek-chat'],

  // 查证是否挂「联网检索」
  //   DeepSeek 官方 API 不提供 web_search 工具，所以检索放在云函数里做：
  //   云函数先调 Serper/Tavily 搜索，再把结果注入 prompt，最后交给 DeepSeek 总结。
  //   直连模式没有这层能力，会自动退回纯模型知识的提示词。
  verifyWebSearch: true,

  // 一次逻辑调用（出卡 / 查证）最多打几次上游请求。
  // 被限流时，堆重试只会把自己越打越死，所以设硬预算：
  // 2 个模型各试一次 = 2 次，再给一轮补打机会，总共不超过 4 次。
  retry: {
    maxRequests: 5,
    delayMs: 900, // 全部模型都失败后，等这么久再补打一轮
    modelCooldownMs: 90000 // 某个模型被限流后，90 秒内排到最后（冷却过就自动回队首）
  },

  // 单次请求上限。
  // 出卡慢的大头是「模型逐字吐 JSON」+ flash 的推理链（实测 12 秒起），
  // 云端上游硬超时 18 秒，这里给 20 秒：既能覆盖正常出卡，
  // 又不会让人对着转圈干等到 30 秒。超时后统一走降级卡。
  timeoutMs: 20000
};

module.exports = LLM;
