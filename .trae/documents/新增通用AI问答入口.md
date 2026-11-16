# Context

用户希望在首页底部“问一句”和“我的档案”之间增加“AI”入口。进入后可像豆包一样自由提问、连续对话、直接获得自然语言回答；联网搜索与回答不经过本地避坑知识库，也不受现有导购/查口碑 JSON schema 限制。

# 实施方案

1. **增加入口和聊天页面**
   - 修改 `miniprogram/pages/index/index.wxml`、`index.js`、`index.wxss`：底部导航中间加入“AI 助手”，使用 `wx.navigateTo` 进入新页面。
   - 在 `miniprogram/app.json` 注册 `pages/chat/chat`，新增 `chat.js/wxml/wxss/json`。
   - 页面采用用户/AI 消息气泡、滚动列表、底部多行输入和发送按钮；显示“正在联网搜索/正在思考”，支持失败后重试。
   - 回答使用 `<text user-select>` 和 `white-space: pre-wrap` 直接展示流式纯文本，不复用会反复重播的 `type-writer`，不引入 Markdown 渲染依赖。
   - 页面内保留对话，发送时只带最近 10 条消息；不写入避坑档案，不调用本地 `knowledge.retrieve()`。

2. **增加独立聊天客户端**
   - 新增 `miniprogram/services/chatClient.js`，提供 `send({ input, history, onStage, onPreview })`，返回 `{ text, channel }`。
   - 复用 `aiFallback` 的 `action='secCheck'` 做输入内容安全检查；空输入、发送中重复提交直接在页面拦截。
   - 自动联网：最新、新闻、价格、天气、政策、口碑、推荐、对比、搜索等时效或检索意图触发；普通聊天和常识问答直接由模型回答。追问检索时结合上一条用户问题补全检索词。
   - 修改 `streamClient.js`：增加独立 `chatStream`，复用 UTF-8/SSE 分帧和 150ms 节流，但 `onPreview` 直接返回累计纯文本，不做 JSON/标题/红线提取。
   - `config.js` 增加独立 `chatStream` 开关与聊天超时时长。流式不可用、失败、超时或空回答时，仅回退一次 `aiFallback`，回退前清掉半截预览，避免拼接两份答案。

3. **增加云端通用聊天通道**
   - `cloudfunctions/aiStreamHTTP/index.js` 增加 `POST /chat`；`cloudfunctions/aiFallback/index.js` 在现有 `action='chat'` 中识别 `searchMode='chat'`。
   - 两个通道使用同一套通用中文助手规则：直接、清晰地回答各类问题，按内容使用短段落/数字列表，不生成避坑卡，不声称掌握未获取的实时信息。
   - 聊天分支只接受 user/assistant 历史消息并由云端添加通用 system prompt；不得注入本地知识库、导购/口碑提示词、价格区间规则或 JSON 输出约束。
   - 联网继续复用 `aiStreamHTTP/search.js` 和 `aiFallback` 的 `searchWeb()`；搜索结果按不可信资料处理。聊天分支使用前端传来的补充后检索词，搜索失败仍回答，但不能伪造实时结果。
   - 保留现有 `/decide`、`/verify` 及普通 `decide/verify` 后备逻辑，不改其知识库、schema、缓存、配额和页面行为。

4. **异常与资源清理**
   - 发送期间禁止重复提交；最终失败显示错误消息和重试按钮，不把半截内容当成正式回答。
   - 页面卸载后使网络回调失效并清理计时器，避免返回首页后继续 `setData`。

# 验证

- 新增聊天客户端 mock 测试：自动联网判断、多轮历史截断、纯文本流式预览、非流式回退一次、空回答/超时/失败处理。
- 扩展 `scripts/test-stream-e2e.js`：覆盖 `/chat` 中文分片、上下文保留、纯文本拼接、检索词注入，并回归 `/decide` 与 `/verify`。
- 执行现有 `scripts/test-sse.js`、`eval/run.js` 和 JS 语法检查。
- 在微信开发者工具验证首页三入口、聊天滚动、连续追问、自动联网、重试和页面返回。
- 完成后需分别部署更新后的 `aiFallback` 与 `aiStreamHTTP` 云函数；未部署流式路由时自动走非流式后备通道。
