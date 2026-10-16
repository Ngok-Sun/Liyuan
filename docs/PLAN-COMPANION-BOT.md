# PLAN-COMPANION-BOT：幕后副编剧 Bot（工作模式拆除 · 主 agent 权限限制）

> 2026-10-16 立案。用户定案：**工作模式删除，主 agent 失去工作的能力**（「专注于扮演的主 agent 在能力上比不上 bot」）；bot 是职责完全不同的第二个 agent，与主 agent 共享工作空间、物理隔离；**先补 CLI 再做前端**（[[feedback-cli-before-frontend]]）。
> 本档三件事：①主 agent 权限的限制 ②工作模式的拆除 ③bot 的制作（提示词 / 工具权限 / 接口）。

---

## 〇、本质

**台前只演，幕后全包。** bot 是这一局扮演的幕后副编剧——用户随时唤出的第二个线程：读得到这局的一切（正文 / 账本 / 世界书 / 记忆 / 卡），改得动世界数据，但**绝不写正文、绝不进正史、主 agent 不知道它存在**。工作模式连同它的「电工身份」一并退场，能力改嫁 bot。

本窗口谈定、实施不得偏离的七条：

1. bot＝第二个 agent，完全不同的提示词；人设用户可编辑（毒舌之类），形态趋近 TG/QQ bot。
2. bot 看产物不看过程（主 agent 的工具过程本就不落树）。
3. 定点改原文：bot 只**发起**（说清改哪里、改成什么样），执行归主 agent（`previous_draft_edit`）或用户直接编辑。**bot 不写正文。**
4. 主 agent 不知道 bot 存在——见效果（世界数据变化），不见实体。
5. 不新增「bot 建议」注入通道；bot 的建议经用户拍板后走既有导演备注渠道。一句话：**bot 自动改世界（数据），绝不自动改指导（提示词）。**
6. 预设影响＝**按站订阅**：身份/破限整站进（卡级 APPEND_SYSTEM.md），其余全不进（AGENTS.md 写作块 / 拍法 / 停用协议 / after 段 / 预填 / 采样参数 / 作者正则）。
7. 能力边界由**工具面**执行，不靠提示词（没有 draft 工具＝不能写正文；没有 session 工具＝不能切会话）。

## 一、现状（落点，实查）

| 环节 | 现状 | 位置 |
|---|---|---|
| 模式三值 | roleplay / authoring / agent；authoring＝工作模式 | `src/conversation-mode.ts:5` |
| 工作模式身份 | 「你是主会话的创作者与维护者」；【写卡维护】进台前上下文 | `assets/AUTHORING.md`、`conversation-mode.ts:80,83` |
| 台上工具装配 | rpTools＝conversation_mode＋读族＋**写族**（世界书写族、记忆写族）＋draft＋媒体＋MCP | `src/stage/engine.ts:921-928` |
| 台上写入门禁 | 执行点＝扩展 tool_call 钩子；判据＝用户本轮原话信号 | `.liyuan/extensions/roleplay.ts:1315`、`src/tools/gate.ts` |
| 工作工具装配 | workTools＝card 族＋原生七工具（沙箱） | `engine.ts:930`、`src/stage/authoring.ts:14` |
| card_update | 只在 `"assistant"` 面（右栏助手删后**无消费者**，parked） | `src/tools/card.ts:196` |
| 预设站声明 | 模型声明一次→用户过目→数据；identity→卡 APPEND_SYSTEM.md | `src/preset-declare.ts:26-34` |
| 视野块先例 | agent 模式状态块（前情提要＋账本＋名录） | `src/stage/agent.ts:28-37` |
| 前情提要 | rp-summary 回读 | `src/stage/assemble.ts:68,142` |
| 存储先例 | DraftStore：会话目录下、懒创建 | `src/stage/draft-store.ts:13` |
| 会话删除挂点 | 宿主 deleteSession | `server/main.ts:2173` |
| CLI 拦截先例 | handlePrompt（/note 同套） | `server/main.ts:3074` |
| Web 模式开关 | 顶栏「扮演｜工作」 | `web/src/App.tsx:2338-2347` |
| 工具面 | stage / authoring / assistant / extension；assistant 面自 9/12 无消费者 | `src/tools/registry.ts:45` |

## 二、主 agent 权限的限制

判据一条：**写「用户的持久资料」＝幕后；演出、剧情导航、演出界面＝台前。**

**随工作模式退场（台上本来就没有，自然消失）**：card_create / card_list / card_greetings / card_project、原生七工具（沙箱）、AUTHORING.md 身份、conversation_mode 工具。

**建议删（需你点头）——台上写侧两族**：

- 世界书写族（lorebook_write / update / delete / create）
- 记忆写族（memory_add / update / delete）

理由：①这两族写的是用户持久资料，bot 是更合适的执行者（你的判据：专注扮演的主 agent 能力比不上 bot）；②「记住这个」是最后一条「把戏外要求打进正文」的路，删掉它才算完成历史纯净（方向一）；③实现＝**撤依赖**——`engine.ts #toolDeps` 不再向台上注入写侧函数，工具走既有 availableSpecs 机制自然下架，**不加新过滤、不加新名单**。

影响与不动项：

- 用户中途想记东西 → 唤 bot（一次 `/bot`）。台上门禁自然空转；`gate.ts` 模块**保留**（扩展侧仍在用）；bot **不注入 gate、不经扩展钩子**（用户在与 bot 对话，请求即宣告）。
- **不动**：card_read（读）、worldline_store（剧情导航）、panel_write / close（演出界面）、draft 族、ask、媒体、MCP。

## 三、工作模式的拆除（清单）

引擎侧：

| 文件 | 动作 |
|---|---|
| `src/conversation-mode.ts` | **authoring 降为历史态**：值保留（旧会话要读得回来），入口全撤；`roleplayHistory` 的【写卡维护】维护段退场（新旧会话一律不再进台前上下文；世界数据不受影响）；`authoringHistory`（原始回放）退场 |
| `src/stage/engine.ts` | `setMode` 去 authoring 目标；rpTools 去 CONVERSATION_MODE_TOOL；workTools / workPrompt 分支删；`#turnMode` 的 authoring 置位删 |
| `src/stage/authoring.ts` | CONVERSATION_MODE_TOOL 删、authoringSystemPrompt 删；authoringTools / runAuthoringTool **留**（agent 模式与 bot 继续消费 card 族） |
| `assets/AUTHORING.md` | 删；全局/卡级 AUTHORING 覆盖槽退场（用户文件不动，不再被读） |
| `server/main.ts` | `authoring:` 宿主件**保留**（bot 接手，注释随刀内改）；conversation_mode WS case 删；onModeChanged 收窄 |
| 工具面 | **不动面名**（内部协议，最小改动）：`"assistant"` 面交给 bot（parked specs 本就在此），`"authoring"` 面继续供 card 族给 agent 与 bot |
| 测试 | 工作模式用例删/改；补一条「含 authoring 条目的旧会话」回归 |

Web 侧（刀 3）：顶栏开关删、conversation_mode 帧处理删、【写卡维护】渲染退场。

## 四、bot 的制作

### 4.1 装配（送模内容＝闭合集合，声明在此）

```
system   [卡级 APPEND_SYSTEM.md（宏展开）] → [BOT.md（卡级覆盖 ‖ 全局默认；宏展开）]
messages [每轮视野块（装配期虚拟物）：【前情提要】＋【世界状态】＋【最近 K 拍】]
         与用户这轮消息拼成同一条 user 消息（注入在前、原话最后）
         ＋ [bot 线程（只存用户原话与 bot 回复）]
         ＋ [本轮工具回执]
不装     全局 APPEND（拍法）、卡 AGENTS.md（写作块）、预设 after/深度段、预填、
         预设采样参数、作者正则
```

- 视野块与导演备注同一纪律：**装配期虚拟物，不进线程、不进任何沉淀物**。
- K 默认 8 拍（验收时调）；更早剧情走 `story_read`。
- 前情提要走既有 rp-summary（`assemble.ts:68`）；视野块形态照 `agent.ts:28-37` 先例。

### 4.2 工具面（bot 面）

- **读**：lorebook_search / read / list / files、memory_search / read / list、card_read、world_state_get、panel_read、**story_read（新）**、MCP（用户自配的检索类 MCP 正是考据要用的；先挂上观察）。
- **写**：lorebook_write / update / delete / create / toggle / mount、memory_add / update / delete、card_update、card_create / card_list / card_greetings / card_project、原生七工具（沙箱）。
  > 2026-10-16 刀 1 修正：**原生七工具暂缓**——自建小循环拿不到 pi 原生工具的执行上下文（`ToolDefinition.execute` 要 ExtensionContext），刀 1 的 bot 面＝资料工具；文件工具的接法单独立项，**必须在刀 2（工作模式拆除）前落地**，否则代码级维护无处可去。
- **不给**：draft 族（不写正文）、ask、conversation_mode（退场）、worldline 族（用户点名不给 agent）、panel_write / close、媒体（tts / show_html——演出交付）。
- `story_read` 形态：按拍读（`from` / `count`），返回用户输入＋正文成对；默认视野只给最近 K 拍，工具用于读更早。
- 边界全部由工具面执行；提示词只写「它是谁、怎么说话」。

### 4.3 存储与生命周期

> 2026-10-16 刀 1 修正（以此为准）：线程落点＝**子项目级**（`<子项目>/副编剧.jsonl`），与账本/面板/世界线同级——「一局」是子项目不是会话文件；同一子项目里开第二个会话窗口继续聊，笔记本跟着走。删除子项目随目录整棵走，无需单独挂删除钩子。

- 位置：`<子项目>/副编剧.jsonl`（照 世界状态.json / 面板.json 的落点，`cardspace.ts` 的 chatDataPath 同层）。
- 懒创建（首次 /bot）；切子项目不带；删除子项目随删（整目录）。
- 串行：同会话 bot 与台前互斥（宿主层；Web 并发另议）。

### 4.4 人设文件（他的提示词）

- 双层：**全局**（agentDir，随包播种、用户可改）＋ **卡级覆盖**（`cards/<卡>/BOT.md`）——与 APPEND_SYSTEM.md 同形态。
- 默认内容两样：**身份**（本局扮演的幕后副编剧）＋**纪律**（「卡、世界书、剧情记忆都不在你的记忆里，它们在工具后面；你脑子里没有的东西，不要替卡作者发明」——bot 口吻，不抄台前那份拍法）。
- 界面编辑入口在刀 3；命名（产品名 / 文件名）刀 1 前定。

### 4.5 入口与接口

- **CLI**：`/bot <文本>`——每句落进持久线程（多轮连续），输入口默认仍属台前；与 `/note` 同套拦截（`server/main.ts:3074`）；进 `src/commands.ts`（mode: "roleplay"）；i18n 三条。无参＝帮助一行；agent 模式会话拒绝（「副编剧只服务扮演会话」）。
- **引擎**：新文件 `src/stage/bot.ts`（纯函数＋注入，可离线单测）——`buildBotSystemPrompt`、`buildBotView`、`botTools`、`runBotTool`、`runBotTurn`（自建小循环：模型流＋工具派发，上限 `MAX_BOT_ROUNDS＝8`；无稿纸、无场记、无压缩；不经 pi 的 tool_call 钩子）。
- **宿主接线**（`server/main.ts`）：模型流（与 stage 同一条注入）、工具依赖（读＋写全给，不注入 gate）、存储路径、互斥。
- **REST / WS**：刀 3（抽屉历史加载与流式帧）。
- **作用域**：刀 1 只开扮演会话；agent 模式会话另议。

### 4.6 职责面（四场景）

| 场景 | 动作 | 落点 |
|---|---|---|
| 解惑 | 读世界书 / 记忆 / 账本 / 往前读剧情 → 答 | bot 线程 |
| 点评 | 读最近几拍正文＋账本 → 评（按需，非每拍自动） | bot 线程 |
| 执行任务 | 写世界书 / 记忆 / 卡字段 / 卡项目件 | 世界数据（台前经既有通道拿） |
| 提修订建议 | 说清改哪里、改成什么样 | 用户拍板 → 导演备注渠道 |

## 五、刀切分与验收

### 刀 1（引擎＋CLI：bot 立起来）

改：`src/stage/bot.ts`（新）、`server/main.ts`（宿主接线＋/bot 拦截＋删除挂点）、`src/commands.ts`、`src/i18n/en/server.ts`、`assets/BOT.md`（新）。

单测：装配（卡级/全局 BOT.md 覆盖、视野块位置、宏展开）；循环（工具轮终止、上限）；隔离（线程不含视野块）。

实弹（隔离实例 `--cli`＋捕获代理，照 [[ref-isolated-instance-testing]]）：

1. `/bot 师姐的师父是谁` → 查得到、答对；查不到如实说（观察项）。
2. `/bot 给玄天宗加一条叛徒支线：…` → 世界书写入 → `/lore 关键词` 命中 → 台前一拍抓包含该条。
3. **隔离**：bot 存在前后同一拍抓包逐字对比（台前请求零变化）；会话文件 0 条 bot 文字；场记 / 摘要 / 压缩无 bot 内容。
4. 线程：第二次 `/bot` 的请求带第一次对话；切会话为空；删会话随删。
5. 全量 `npm test`＋i18n-check。

### 刀 2（拆除＋权限限制，引擎侧；**必须在刀 1 验收后**）

见 §二、§三。

实弹：

1. 台上工具清单快照：无 conversation_mode、无 lore / memory 写族；有 card_read / worldline_store / panel_write / ask / draft 族 / 读族。
2. 送模文案对比：同会话同拍，拆除后 ≤ 拆除前（维护段与工具 schema 退场），其余逐字同。
3. 旧会话（含 authoring 条目）打开 / 续演 / 显示正常。
4. 全量 `npm test`＋i18n-check。

### 刀 3（Web）

bot 抽屉 / 浮窗（TG/QQ bot 形态）、线程渲染与流式、历史加载、人设编辑入口、REST / WS 帧、撤「扮演｜工作」开关与【写卡维护】渲染。

实弹：真浏览器（隔离实例）：唤出 / 收起、流式、刷新仍在、切会话清空、台前零变化。

## 六、铁律自检

- **律一**：bot 是**新角色**的自有提示词（新消费者的闭合声明，不动台前）；拆除让台前送模文案**变短**（维护段与工具 schema 退场）；台前请求在 bot 存在前后逐字不变。
- **律二**：不新增注入点——bot 的产出走世界数据（既有召回）；bot 的建议经用户拍板走既有导演备注；bot 的视野块是 bot 自己的消费者声明（与 agent 模式状态块同构），不进台前。
- **律三**：零新名单——bot 按站订阅（既有声明数据）；工具面用自家 ToolSurface；不给 bot 加任何「识别用户意图」的正则；台上写侧删除是名单收缩。
- **律四三问**：全集＝所有戏外需求（问 / 评 / 改 / 导）；负责人＝bot（新线程）＋数据面＋用户渠道；没见过的卡＝读站点产物与数据面，缺件自然跳过（无 APPEND→空段、无 BOT.md→全局默认、无世界书→工具少挂），与卡作者措辞零交互。

## 七、观察项（先记录，不预防）

- 身份站混演出指令 → bot 自称角色（修法在数据：重新声明 / 人设文件写清身份）。
- bot 拒绝（记录模型 / 内容 / 问法）。
- K＝8 拍窗口够不够（点评质量）。
- 台上失去写侧后，「记一下」类需求落回台上时模型如何应对——观察，不加句。
- MCP 挂给 bot 后是否被滥用。

## 八、未决（开工前拍板）

1. 台上写侧两族删除（§二建议）——需点头。
2. bot 全量继承文件工具＋沙箱（默认：是，与「拆除＝能力改嫁」一致）。
3. bot 的模型：默认跟主演条目（既有条目机制，不新增链路）。
4. 命名：产品名（副编剧？）与文件名（BOT.md？）。
5. K 拍窗口默认值（8）。
6. 发布节奏：刀 1＋2 同版本发（能力先有家再拆旧家）；刀 3 可随后。

## 九、状态

- 2026-10-16 立案，未开工。
- 2026-10-16 **刀 1 落地（引擎＋CLI），实弹验收全过（已随 `f106efb` 提交）**。
  - 改：`src/stage/bot.ts`（新：线程存储／装配／视野／工具面／小循环）、`assets/BOT.md`（新：默认人设，随包播种到 agentDir）、`src/stage/engine.ts`（`botTurn`＋`#botAbort`）、`src/stage/authoring.ts`（`cardToolAvailable` 导出）、`server/main.ts`（`/bot` 拦截＋`handleBotPrompt`＋`[end] mode=bot` 终端标记）、`src/commands.ts`（`/bot` 进补全）、`src/i18n/en/server.ts`（5 条）、`src/paths.ts`（BOT.md 播种）、`test/bot.test.ts`（14 条）。
  - 两处实现级修正（与 §四 原文不同，**以此为准**）：①线程落点＝子项目级 `<子项目>/副编剧.jsonl`（见 §4.3 注）；②原生七工具暂缓（见 §4.2 注，刀 2 前必须落）。
  - 单测 14 条；全量 873 项 871 过（2 项既有实卡红：cardfront-pipeline、mvu）；i18n-check 干净；对触及文件跑 tsc 无新增诊断。
  - **实弹**（隔离实例 `--cli`＋捕获代理→codex.weidu.my，模型 gemini-3.8-flash-high；新开扮演子项目，21 条抓包）：
    1. **解惑**：`/bot 沈砚的顶头上司叫什么？他有什么特征？` → 先读卡、查设定无命中、查记忆无命中、再查「巡夜司 司正 南岭」命中 3 条 → 答「司正裴矩」＋三条特征全部出自世界书（BOT.md 纪律「先查再说」在思考里明说生效）。
    2. **视野**：`/bot 刚才这一拍写到哪了？一句话说。` → 零工具调用直答（视野块在场），答对最新一拍落点。
    3. **执行任务**：`/bot 把这条设定写进世界书：…` → 先列世界书、查现状，再写「挂灯乌篷船」进《南岭夜禁》；条目落盘于书文件。
    4. **台前拿到新设定**：下一拍台前 `lorebook_search` 命中该条目，**正文直接采用**（「那是哑女的乌篷船」）。
    5. **隔离**（抓包＋树核）：副编剧请求 system＝BOT.md（491 字，**不含**台上拍法／卡 AGENTS；本卡无卡级 APPEND 故空段跳过）；台前请求（38 工具）**零副编剧文本**、system 无「副编剧」；会话树 0 条副编剧文字（「乌篷船」仅出现在台前自己的检索过程里）；副编剧工具面 21 件含 story_read／lorebook 写族／card_update，**无** worldline 族、无 draft 族；视野块与用户话同条消息（注入在前、原话最后）。
    6. **线程**：`<子项目>/副编剧.jsonl` 6 条（三问三答，只存原话与回复）；第二轮请求带第一轮对话。
  - 观察（实弹）：副编剧思考里出现过一次无关的「往局记忆」串味（card 级记忆在视野工具结果里），最终答复不受影响——记录，不处理。
