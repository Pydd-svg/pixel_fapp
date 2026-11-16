# 避坑导购 · AI 购物决策小助手

一个面向学生党的微信小程序：把「我想买 XX」翻译成**有预算、有红榜、有避坑点、有知识依据**的决策卡，而不是一份广告清单。

- 6 个品类：笔记本 / 数码配件 / 潮玩手办 / 护肤 / 宿舍床品 / 学习用品
- 80 条人工编写避坑规则，卡片依据可点开查看原文
- 缺信息先追问，信息够了才出卡；出卡后还能联网复核口碑
- 不抓实时价格、不给购买链接、不做全网比价假承诺

## 快速开始（云函数代理版）

1. 微信开发者工具导入本目录，AppID 用 `wx798448025439a338`，云环境 `cloud1-d6goz8wc570dd904d`。
2. 右键 `cloudfunctions/aiFallback` → **上传并部署：云端安装依赖**（不要上传本地 node_modules）。
3. 云开发控制台 → 云函数 → `aiFallback` → 配置：
   - 环境变量 `LLM_API_KEY`：必填，填 DeepSeek Key
   - 可选 `LLM_BASE_URL`（默认 `https://api.deepseek.com/v1`）、`LLM_MODEL`（默认 `deepseek-chat`，出卡 4-6 秒；换回 `deepseek-flash` 更慢，一张卡 12 秒起）
   - 查口碑功能：`SEARCH_API_KEY` 填搜索 Key，`SEARCH_PROVIDER` 可选 `serper`（默认）/ `tavily` / `bocha` / `brave`
   - 超时时间建议调到 **20 秒**（与客户端 20 秒对齐；云函数内部上游超时 18 秒）
4. 编译预览。手机走 `wx.cloud.callFunction`，不再受 request 域名白名单限制。

> `services/config.js` 已设 `ADAPTER = 'cloudfn'`、`PREVIEW_NO_CLOUD = false`，出卡只走云函数；Key 不再参与前端请求。
> 若想临时回到开发者工具直连调试，把 `PREVIEW_NO_CLOUD` 改回 `true`、`ADAPTER` 改回 `'auto'`。

## 目录结构

```
miniprogram/
  pages/            index 首页（两步入口）/ ask 第1步·问一句 / verify 第2步·全网搜索评价
                    result 决策卡 / archive 我的档案 / dev 开发设置
  components/       read-gate（使用前必读·故障溶解倒计时）、decision-card（决策卡，含依据展开）、verify-sheet、disclaimer、skeleton
  services/
    aiClient.js     决策 & 复核调用链（直连 / Agent / createModel / 云函数四通道 + 降级）
    knowledge.js    端侧 RAG：品类判定 + 80 条检索 + 依据校验
    config.js       提示词、开关、限制、适配器配置
    streamClient.js 流式出卡客户端（callHTTPFunction + 增量回调，失败自动回落）
    sseParser.js    SSE 分帧 / UTF-8 增量解码 / 半截 JSON 预览抽取
    schema.js       决策卡 / 复核结果归一化与判废
    parseAgentJSON.js  JSON 解析与四级修复
    secure.js       输入清洗（删链接、删价格、限长）
  knowledge/data.js 由脚本生成的 80 条（勿手改）
  demo/replay.js    离线演示卡
knowledge/          知识库源文件（L1 六品类 + L3 横切）
cloudfunctions/
  aiFallback/       事件型云函数：msgSecCheck + 大模型兜底 + health 体检
  aiStreamHTTP/         HTTP 云函数：DeepSeek SSE 流式出卡（可选，见「流式出卡」）
shared/
  schema/           三份 JSON Schema（契约对照）
  build/            合并版 knowledge.all.md / .json（上传云开发知识库用）
scripts/
  build-knowledge.js  校验 80 条 + 生成打包产物
  probe-api.js        上游 Key / 模型 / 搜索体检（0 token 探测）
eval/
  cases.js          20 条固定用例
  run.js            离线 / 联网跑批
```

## 核心链路

```
输入 → 清洗（删链接/价格、限长）→ 本地品类判定 → 【缺预算/新手/场景】追问
                                     ↓ 信息够
             本地 RAG 检索 4 条品类 + 2 条横切 → 注入 prompt → 模型出 JSON
                                     ↓
              schema 归一化 / 判废 → knowledge_refs 校验（只保留真实 id）
                                     ↓
             决策卡（可点开每条依据看知识库原文）→ 可选联网复核 → 存档
```

### 决策卡字段

`card_title` / `category` / `budget_band` / `tags` / `recommendations`（首选 + 备选）/ `red_flags`（1-3 条）/ `search_keyword` / `knowledge_refs` / `confidence` / `disclaimer`。

判废规则唯一收口在 `miniprogram/services/schema.js`：价格必须是 `数字-数字元` 区间、不得出现链接、卡片标题 ≤20 字、红榜 1-3 条等。

### 使用前必读（read-gate）

第 1 步页顶部的必读卡是 Hacknet 终端风：近黑底 + 扫描线 + 等宽荧光绿，右侧 11×11 像素笑脸随 12 秒倒计时逐点「故障溶解」，归零后错峰重组并解锁「生成避坑决策卡」按钮。

- 解锁态写 `getApp().globalData.readGatePassed`，同一次运行内不再重复计时；重启小程序会重新计一次。
- 演示模式（连点 logo 5 次）自动跳过计时。
- 手动跳过：长按倒计时方块。
- 文案在 `pages/ask/ask.js` 的 `READ_ITEMS`，样式在 `components/read-gate/index.wxss`，颜色走 `styles/tokens.wxss` 的 `--c-term-*`。

## 知识库与「可溯源」

- 源文件：`knowledge/L1/*.json` + `knowledge/L3/cross.json`，共 **80 条**。
- 修改后执行：

```bash
node scripts/build-knowledge.js          # 校验 + 生成全部产物
node scripts/build-knowledge.js --strict # 只校验，不写文件
# 契约 §5.6 的写法也支持：
node scripts/build-knowledge.js --in knowledge --out shared/build/knowledge.all.json --strict
node scripts/build-knowledge.js --in knowledge --out shared/build/knowledge.all.md --md
```

- 生成：`miniprogram/knowledge/data.js`（端侧检索用）、`shared/build/knowledge.all.md`（上传云开发知识库用，标题行保留 `[id]`）。
- 直连 / 云函数通道没有云端知识库，`services/knowledge.js` 会在出卡前做一次本地检索，把命中条目注入 prompt；模型返回的 `knowledge_refs` 只保留本次真正注入过的 id，模型漏写时用真实注入条目兜底。**卡片上每一条依据都能点开看到标题、正文、严重度和更新时间。**
- Agent 通道（`ai.bot.sendMessage`）由控制台挂载云端知识库，端侧不再重复注入。

## 云函数部署（上线前必做）

1. 在开发者工具里开通云开发；确认 `config.CLOUD_ENV_ID` 是真实环境 ID，并把 `config.PREVIEW_NO_CLOUD` 改为 `false`（`CLOUD_ENABLED` 会自动变 true）。
2. 右键 `cloudfunctions/aiFallback` → 上传并部署（云端安装依赖）。
3. 云函数环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 是 | 大模型 Key，**只放这里** |
| `LLM_BASE_URL` | 否 | 默认 `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 否 | 默认 `deepseek-chat`（快）；`deepseek-flash` 带推理链，一张卡约 12 秒 |
| `SEARCH_API_KEY` | 否 | 查口碑搜索 Key，不填则查证只能基于模型知识 |
| `SEARCH_PROVIDER` | 否 | `serper`（默认）/ `tavily` / `bocha` / `brave` |

4. 权限：`cloudfunctions/aiFallback/config.json` 已声明 `security.msgSecCheck`，需在云开发控制台确认已开通内容安全接口。
5. 把 `miniprogram/services/llm.js` 的 Key 删除、`config.js` 的 `ADAPTER` 改为 `'cloudfn'`，即可切到「前端不持有 Key」的上线形态。

### 流式出卡（可选，开了更快看到东西）

普通云函数 `wx.cloud.callFunction` 是「请求-响应」模型，**拿不到流式**；微信只有 HTTP 云函数 + `wx.cloud.callHTTPFunction` + `enableChunked` 才支持 SSE（基础库 ≥ 3.15.1，本项目 3.18.0 满足）。

现状：`aiStreamHTTP` 已建为 HTTP 云函数并部署代码，`/health` 与 SSE 帧均实测可通。还差两项控制台配置：

1. **超时必须改成 30 秒**（新建 HTTP 云函数默认 **3 秒**，实测 8 秒即被平台以 `code 433` 掐断；真实出卡约 4 秒，3 秒必挂）。位置：函数 → `aiStreamHTTP` → 函数配置 → 超时时间。
2. **环境变量**与 `aiFallback` 完全一致（`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `SEARCH_API_KEY` / `SEARCH_PROVIDER`），缺了会返回 `E_AUTH: LLM_API_KEY 未配置`。
3. 两项配好后，把 `config.js` 的 `FEATURE.stream` 改成 `true` 并重新编译。
4. 自检：函数内请求 `/health` 返回 `{"ok":true,"llmKey":true,...}`；`/health?sleep=8000` 仍能在 8 秒后返回，说明超时已放开。

CLI 注意事项：`cli cloud functions deploy` 只推代码，**不写超时、不写环境变量**（函数目录下 `config.json` 的 `timeout` 不生效）；函数名区分大小写，且由目录名推导，目录必须叫 `aiStreamHTTP`。

开关保持 `false` 时行为与之前完全一致。**超时仍是 3 秒前不要打开**——那会让每次出卡先白等 3 秒再回落，反而更慢。

效果：`stage`（检索中/写作中）与增量文本推进页面，**标题约 1-2 秒出现、红线跟着陆续出现**，完整卡片解析完成后再跳结果页。

### Agent 配置（可选，比赛答辩用）

| Agent | 用途 | 建议配置 |
| --- | --- | --- |
| 决策 Agent | 出决策卡 | 挂载云开发知识库；系统提示词用 `config.DECIDE_SYSTEM_PROMPT`；输出严格 JSON |
| 复核 Agent | 联网复核 | 开启联网检索；系统提示词用 `config.VERIFY_SYSTEM_PROMPT`；只返回口碑摘要，不返回价格和链接 |

把控制台生成的 bot id 填到 `config.js` 的 `BOT_ID_DECIDE` / `BOT_ID_VERIFY`。没填也不会阻塞，`ADAPTER: 'auto'` 会自动跳过不可用通道。

## 测试与评估

```bash
node eval/run.js          # 离线：80 条完整性 + 20 条检索召回 + 解析/schema 契约，0 token
node eval/run.js --live   # 联网：20 条真实出卡，逐条校验（会消耗 token）
node scripts/probe-api.js # 上游体检：Key 有效性、可用模型、首字延迟、搜索命中（0 token，仅探测）
node scripts/test-sse.js  # 流式解析单测：UTF-8 跨包、SSE 分帧、半截 JSON 预览
node scripts/test-stream-e2e.js # 流式端到端：本地假上游 + 真 aiStreamHTTP，验证增量链路
```

离线基线（2026-11-07）：知识库 80/80、检索 20/20、契约 6/6。报告写入 `eval/reports/`。

### 上游 API 体检（`scripts/probe-api.js`）

Key 只走环境变量，不写文件、不贴聊天：

```bash
# Git Bash
DEEPSEEK_KEY=sk-xxx SEARCH_KEY=xxx SEARCH_PROVIDER=serper node scripts/probe-api.js
# PowerShell
$env:DEEPSEEK_KEY="sk-xxx"; $env:SEARCH_KEY="xxx"; node scripts/probe-api.js
```

输出四件事：`/models` 是否 200（Key 有效）→ 可用模型清单（确认 `deepseek-chat` / `deepseek-flash` 谁在列表里）→ 每个模型一次 8 token 的最小生成耗时 → 搜索服务商命中条数与延迟。

同一个检查在小程序内也能点：开发设置页 →「模型 / 搜索体检（health）」，走云函数 `action=health`，Key 只回显前后 4 位。

## 合规与边界

- 不做实时价格承诺，不输出购买链接，不替代专业意见；卡片固定带免责声明。
- 内容安全：上线走云函数 `msgSecCheck`；本地预览保留输入清洗与敏感词兜底。
- 未覆盖品类（平板、相机、球鞋、洗衣液等）统一走 `universal`：只给通用避坑建议，并明确告知「该品类掌握有限」。
- 预览包把 Key 放在前端是为了「导入即跑」，**禁止把该包直接提审或公开分发**。

## 提交物对应

| 提交目录 | 本仓库位置 |
| --- | --- |
| `01_项目说明` | 本 README + 小程序「关于」页 |
| `02_技术文档` | `shared/schema/` + `services/` 源码注释 |
| `03_演示视频` / `04_截图` | 按演示回放脚本录制（首页 → 追问 → 出卡 → 点开依据 → 复核） |
| `05_源码` | `miniprogram/` + `cloudfunctions/` + `knowledge/` + `eval/` |
| `06_测试记录` | 运行 `node eval/run.js` 生成 `eval/reports/` 报告 |
