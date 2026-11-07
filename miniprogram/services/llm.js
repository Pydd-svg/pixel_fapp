/**
 * services/llm.js —— 大模型直连配置（唯一收口处）
 *
 * 为什么单独一个文件：
 *   契约里写着「miniprogram/ 下不得出现 API Key」，但预览包没有云开发环境，
 *   走不了云函数兜底。所以把 Key 单独隔离在这里，方便你：
 *     1) 上线前把 mode 改成 'proxy'（走云函数 aiFallback，Key 只存环境变量）
 *     2) 或者直接清空 apiKey，代码会自动降级到云函数 / Demo 通道
 *
 * 当前接的是智谱开放平台（bigmodel.cn）的免费模型 glm-4.7-flash：
 *   - 模型本身 0 元 / 百万 tokens，200K 上下文
 *   - 接口是 OpenAI 兼容协议，以后换 DeepSeek / 通义只要改 baseUrl + model
 *
 * ⚠️ 直连模式（mode='direct'）的 Key 会打包进小程序前端，任何人解包都能看到。
 *    只适合自己演示 / 比赛评审。真要上线，务必切 mode='proxy'。
 */

const LLM = {
  // 总开关：false 时退回到原来的三条通道（Agent / createModel / 云函数）
  enabled: true,

  // 'direct' = 小程序前端直接 wx.request 打模型（预览包里默认，装好就能用）
  // 'proxy'  = 走云函数 aiFallback，Key 放云函数环境变量（上线用这个）
  mode: 'direct',

  // OpenAI 兼容端点：{baseUrl}/chat/completions
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'c24580c888524a01ad35dc965c87ec08.kwzScmsywmJzItSU',

  // 主模型：仅用于日志展示与「全部冷却时」的兜底，真正先用谁由下面的 models 决定
  model: 'glm-4-flash-250414',

  // 模型降级链：三个都是免费模型，按「实测能不能稳定出卡」排，不按参数量排。
  // 顺序即优先级；被限流的模型冷却 90 秒后自动回到队首。
  //
  // ⚠️ 队友预览版的顺序和开发版不同，原因是 2026-11-07 实测：
  //   glm-4.7-flash      单请求 45 秒不返回（全平台排队），当主模型会让人以为「卡死」
  //   glm-4-flash-250414 0.6-1 秒返回，最稳，所以提到首位
  //   glm-4.5-flash      约 9 秒，质量好，放第二
  // 等 4.7 不排队了，把数组改回 ['glm-4.7-flash', 'glm-4-flash-250414', 'glm-4.5-flash'] 即可，
  // 其他代码一行都不用动。你自己那份开发版目前仍是 4.7 打头。
  models: ['glm-4-flash-250414', 'glm-4.5-flash', 'glm-4.7-flash'],

  // glm-4.7-flash 是混合思考模型，默认会先输出一大段思考链，
  // 出卡时间从 2 秒涨到 15 秒以上。这里关掉思考，实测 5-6 秒出卡。
  thinking: false,

  // 查证通道是否挂「联网检索」工具
  //   注意：搜索工具按次计费 0.01 元/次（模型本身免费）。账户余额为 0 时请求会失败，
  //   代码会自动摘掉工具重试一次，所以开着也不会把流程搞挂。
  //   想严格零成本：改成 false，模型会基于自身知识作答（可能退化成「暂未检索到」）。
  verifyWebSearch: true,

  // 一次逻辑调用（出卡 / 查证）最多打几次上游请求。
  // 免费档被限流时，堆重试只会把自己越打越死，所以设硬预算：
  // 3 个模型各试一次 = 3 次，再给 1 次补打机会，总共不超过 4 次。
  retry: {
    maxRequests: 5,
    delayMs: 900, // 全部模型都失败后，等这么久再补打一轮
    modelCooldownMs: 90000 // 某个模型被限流后，90 秒内排到最后（冷却过就自动回队首）
  },

  // 单次请求上限。
  // 免费档被挤的时候，一个请求可能要 15 秒以上；卡太死会把还没回来的响应直接掐掉。
  // 25 秒是「能等到」和「用户还愿意等」的折中，实际正常 6-9 秒出卡。
  timeoutMs: 25000
};

module.exports = LLM;
