# FINDINGS-CLI-AGENT-SWEEP：CLI 落地 ＋ agent 模式全量实测（2026-10-15）

> 2026-10-15 立档。起因：用户定调「1.6.0 说好先做 CLI 再做前端，agent 模式赶鸭子上架背离了这个制作路径，得拨乱反正」，
> 并要求一次全盘调研：全量工具/接口、专项查「写入消耗注意力」、评估 answer-me-with-html 能否与梨园结合。
>
> **本档只记测到的事实。没测到的、测法有偏差的，单列一节，不混进结论。**
>
> 关联：`docs/PLAN-AGENT-BACK-TO-PI.md`（刀 1-4）、`docs/FINDINGS-PI-RETURN.md`（上一轮回归 pi 的问题底账）。

---

## 〇 方法与可复现性

- **被测对象**：`server/main.ts --cli`（本轮新落地，见 §一）。
- **隔离实例**：`E:\silly-agent\_k4-test`——新卡「沈砚」（原创）、agent 子项目、零世界书、提示词槽位与随包一致。
- **模型**：`cpa-my / gemini-3.8-flash-high`，思考档 high（用户指定）。
- **规模**：6 个批次、35 拍。脚本 `_k4-drive.mjs`（按脚本喂话 + 按策略应答选择卡）、`_k4-proxy.mjs`（捕获代理，录请求/响应/usage）、`_k4-analyze.ts`（转录→指标）。
- **证据**：`_k4-test/_runs/*.txt`（逐拍转录）、`_k4-test/_captured-system.txt`（agent 轮真实 system 全文）、`_k4-test/_proxy-log.jsonl`（逐调用 token）。
- **备份**：`E:\silly-agent\_k4-backup-20261015\`（数据闭包 zip ＋ 未提交改动 patch）。测试全程在隔离根，未碰用户数据。

---

## 一 CLI 落地：agent 模式现在可以从终端驱动

**问题**：仓库里唯一的 CLI 是 `node_modules/.bin/liyuan-agent` → vendored pi 自己的 CLI。而台上逻辑（`StageEngine`）只在 `server/main.ts:2554` 被 `new` 过一次——CLI 里没有引擎，`activeStage` 永远不被设置，`roleplay.ts` 的 `before_agent_start` 第一行就 `return undefined`，扩展整个空转。**所以 CLI 下拿到的是纯 pi，不是 agent 模式。**

**落地**（`server/main.ts` +215/−26，**引擎与扩展一行未动**）：

| 件 | 做法 |
|---|---|
| 入口 | `--cli` 分支在 `httpServer.listen` 之前；不启 HTTP/WS，不占端口 |
| 终端读线 | `readline` 队列，主循环与选择卡共用一条线 |
| 选择卡 | `askUser` 从 `askChoice`（WS 广播）换成终端问答（沙箱申请、`ask` 工具都走它） |
| 输出 | `events` 的 `onDelta/onNotify/onActivity/onTurnEnd` 加 `cli?.` 打印；非正文通道逐行带 `[思考]/[tool]/[result]` 前缀 |
| 分派 | 与 `handlePrompt` 收尾同一套判据：注册过的斜杠命令走 pi 命令通道，其余一律 `stage.performTurn` |

**尺寸之所以这么小**：`StageEngineDeps` 必填只有 5 个（`cwd`/`getSession`/`getModel`/`getAuth`/`sideStreamFn`），其余 26 个全可选且缺了自动降级（「未注入＝该工具恒返回无命中」「依赖缺失的工具不上清单」）；`engine.ts` 零 server 依赖；扩展侧不用改（`session_start` 自动 `connectStage`，bridge 连接表挂 `globalThis`）。

验证：全量 850 项 848 过（2 项既有实卡红）；11 拍／3 拍／7 拍三轮实跑全过。

---

## 二 全量工具扫描（35 个工具里的 24 个）

| 组 | 工具 | 结果 |
|---|---|---|
| pi 原生 | `read` `grep` `find` `ls` `bash` | ✓ |
| pi 原生 | `write` | ✓ 建新章、整章重写都对 |
| pi 原生 | `edit` | ✓ **三次实测都是一次调用带多条 `edits[]`**（1/2/3 条），oldText 大多 1 行 |
| 卡 | `card_read` `card_project` | ✓ |
| 世界书 | `create` `write` `files` `search` `list` `read` `update` `toggle` | ✓（`create` 自动挂载；盘上验过条目） |
| 记忆 | `list` `search` | ✓ 但 `sources` 全是 `disabled` |
| 记忆 | `add` | ✗ **「请先启用向量记忆」** |
| 面板 | `read` `write` `close` | ✓ |
| 世界状态 | `world_state_get` | ✓ |
| 交互 | `ask` | ✓ 选项成型，作答后接得住 |
| 展示 | `show_html` | ✓ 两次都把正文/示意图渲成了页 |
| 展示 | `screenshot` | ✗ **CLI 下永远不可能成功** |

**未覆盖**（不假装）：`lorebook_mount`（create 会自动挂）、`lorebook_delete`、`memory_read`/`memory_delete`、`card_create`、`show_image/audio/video`、`tts`。

---

## 三 「写入消耗注意力」专项实测

**待验假设**（来自上一个窗口）：把东西写进文件非常消耗模型注意力，使写作能力下降。

**设计**（只变载体，其他全不动）：同卡同模型同要求、每臂 3 次、禁止探索（否则 A 臂会多跑一圈读文件）、经捕获代理取真 usage。

```
A 落文件：每章 2 次主调用   输出 3214 token（思考 1559）  + 一次场记旁路
B 直出  ：每章 1 次主调用   输出 2227 token（思考 1284）
                        A/B = 1.44×
```

拆开看，多出来的 44% 是**两笔结构性开销**，各占一半：

1. **正文当 JSON 工具参数吐**：+22%
2. **写完还要再收一次尾**（工具回执之后再走一次主调用）：+22%

外加入 token 约 2×（多一次主调用要重放上下文），且**每写一次文件就触发一次检查点 → 一次场记旁路**。

**「写作能力下降」这一条没有证到。** 两臂成品都读过：A 的 `003-查簿.md`（2249 字）与 B 的 `003-纸上量水`（约 2500 字），文风、细节密度、人物习惯动作（拇指抹册页边）在同一水平，且**都超出要求的 1200 字**。没有观察到质量差异。

**反直觉发现**：直出时模型要**额外思考「这跟『正文必须落文件』的规矩冲突」**。B1 思考原文：

> The user's directive to directly output the chapter content contradicts the established file-based workflow... It's crucial to determine if this is a request for a draft review or a test of the predefined rules.

落文件时不做这层纠结。**冲突成本在直出这一侧。**

**结论**：落文件确实更贵，但贵在**工具往返的结构**，不在「注意力被写作吃掉」。

---

## 四 answer-me-with-html 结合评估

**是什么**：agent skill。模型只写一份 Markdown 草稿（frontmatter ＋ `##` 面板 ＋ 组件 `flow/er/sequence/tree/timeline/limits/annot/kv/callout/ask/表格/代码块`），自带 `am.mjs` 渲成单文件 HTML。作者 benchmark：同问题手写 HTML 4893 输出 token → 用 skill 612，**约 1/8**；31s → 12s。

**梨园对应物**：`show_html`（`details.rpHtml = {html, title?, scripts}`，沙箱 iframe 渲染在正文下方，上限 50 万字符）；面板 `kind: html`。其说明书原文是「**传完整 HTML**」——即直接让模型写版式，正是该 skill 要消灭的最贵路径。

| 路线 | 判断 |
|---|---|
| A 原样装进 `skills/` | **结构上通**：`<cwd>/skills/<name>/SKILL.md` → pi 发现 → 进 system 的 `<available_skills>`（带 location）。**操作层三处挡路**：用 `${CLAUDE_SKILL_DIR}`（Claude Code 的变量）；页面落 `~/.answer-me-with-html/`（卡外）；还要开浏览器。 |
| B 原生移植渲染器 | 把「草稿→单文件 HTML」vendored 进梨园，出口复用 `show_html` / `panel_write`。不碰 bash、不碰卡外、不开浏览器。 |
| C 只借格式 | 没渲染器，草稿变不成页面。 |

**结论：现在不做。** 两条理由：

1. **它解决的问题本轮没被观察到**。§二的实测里，模型 `show_html` 手写页面**一次就成了**（正文渲染页、水关示意图各一次），没有失败、也不算贵。
2. **它会和 `panel_write` 形成第二套「结构化视觉」系统**（面板已有 `markdown/svg/html` 三档，且有 `data` 通道）。两套平行、互相追赶，正是铁律三点名的那类污染。

**触发条件**（出现即值得做）：拿到「模型手写 HTML/SVG 反复失败或明显更慢更贵」的实例，且「可视化解释页」被定为一等公民。届时走 B 路线。

---

## 五 两处诊断更正

1. **agent 轮不是「整份替换 system」，是 append。** `roleplay.ts:1259` 的整份替换判的是 `activeStage.mode === "authoring"`，而 `ConversationMode = "roleplay" | "authoring" | "agent"` 是三个值——**agent 轮走的是下面那条 append**。捕获到的真实 agent system（2374 字）＝ pi 基座（SYSTEM.md 身份句 ＋ skills 块 ＋ cwd 行）＋ 梨园追加（`AGENT_APPEND_SYSTEM.md` ＋ 卡 APPEND ＋ 卡 AGENTS ＋ 三行工作区事实）。全文见 `_captured-system.txt`。
2. **pi 的工具 guidelines 大半已在工具 schema 描述里**，而 schema 走 function-calling，**永远到得了模型**：

| pi 的 guideline（只在 system 里） | schema 描述里有没有 |
|---|---|
| edit：`oldText` 必须精确匹配 | ✓ |
| edit：多处改动用一次调用带多条 `edits[]` | ~ `edits` 本身就是数组 |
| edit：对照原文件匹配／不许重叠嵌套／就近合并 | ✓ **逐字都在** |
| edit：`oldText` 尽量小且唯一 | ~ 有 "must be unique" |
| read：别用 cat/sed | ✗ |
| write：只用于新文件或整份重写 | ✗ |

唯一真没覆盖的两条，描述的正是模型**本来就在做**的行为（§二实测：bash 读文件 0 次、write 全都用于新文件或整章重写）。

⇒ **刀 4 的收益比 plan 写的小得多**；它的性质是**架构归位**（以后 pi 新增工具，guidelines 自动进来，梨园不维护），不是修 bug。plan §一.1 的诊断要按此改写。

---

## 六 问题清单

| # | 问题 | 证据 |
|---|---|---|
| 1 | **`find`/`grep` 不给 `path` → 默认工程根 → 撞沙箱**（`sandboxTarget`：`input.path \|\| "."` → 工程根 → 卡外 → 申请）。一个省略参数的笔误换来一次申请；非交互场景整拍报废 | 写作实验 A1 零产出 |
| 2 | **`find` 依赖外部 `fd`，没有就运行期下载**（`ensureTool`）；下不到整个工具报废，模型退化成连打 7 次 `ls` | 首拍 2 次 find 全废 |
| 3 | **memory 五个工具常驻清单，默认功能关着**。`memory_add` 硬报错；`memory_list` 把「关着」说成「空的」。其他工具都遵守「依赖缺失不上清单」，这五个是例外 | 扫描 A 第 7、8 拍 |
| 4 | **`screenshot` 在 CLI 下必然失败**：`main.ts:2782` 无条件注入 dep → `engine.ts:909` 据此上清单，但 CLI 没有页面 | 扫描 A 第 10 拍（先试 screenshot 废一次，再改 show_html） |
| 5 | **`~/.agents/skills` 的陌生技能整段进 system**（`package-manager.ts:2397`）。写小说的 agent 读到「Pebrel 终端工作区」技能说明 | 捕获的 system 全文 |
| 6 | **模型会绕过死工具手改 harness 文件**：要它删剧情记忆，它 `edit` 了 `记忆/常驻摘要.md`、`记忆/记忆.md`、`记忆/局/*.md`；`.清单.json` 记账未同步。（那一处 `oldText` 18 行，是全部 5 次 edit 里唯一一次没保持最小） | 扫描 C 第 5 拍 |
| 7 | 让它「读文件」它**凭记忆答**（零工具调用）。这次内容恰好对（greeting 在会话里），但设计意图是「文件是真相」 | 扫描 C 第 1 拍 |
| 8 | 每拍结尾爱**用散文再问一句**（拿了 `ask` 的答案之后仍问「导演请指示」） | 扫描 A 第 11 拍 |
| 9 | agent 天然想往工程根探（`ls {"path":"."}`），第 1 拍即撞沙箱 | 首拍 |
| 10 | **展示类工具在 CLI 下落不到任何呈现面**：`show_html`/`show_image`/`show_audio`/`show_video` 回「已在对话中展示给用户」，终端只打一行回执；`screenshot` 更是必然失败（#4）。当诊断面无所谓；**若 CLI 要做第一等前端，这条要处理**（最省事：产物落成文件、终端打路径） | 扫描 A 第 10 拍、扫描 C 第 6 拍 |

---

## 七 这次测不到的（盲区，别把上面的「没问题」读成「没问题」）

这一轮本质是**工具冒烟测试**，不是压力测试。以下盲区是设计造成的，不是结论：

| 盲区 | 后果 |
|---|---|
| **只测 agent 模式** | 梨园主模式是**扮演**；记忆里的事故（状态栏写进稿件、格式块丢失）全在扮演路径上，一次没测 |
| **只用一个模型**（快模型 gemini-3.8-flash-high） | 失败面高度依赖模型；换 opus/深度思考档结论可能完全不同 |
| **没挂预设** | 预设拆层/marker 填充/after 段位置是最复杂的子系统，全程绕开 |
| **全是 1-2 拍短任务** | 长局的病（上下文腐坏、漂移、重复、`compactEveryNTurns` 压缩、讨论摘要、跨拍一致性）要 20-30 拍才现形，一拍没踩到压缩 |
| **全新空工程、2 章** | 用户真实数据是 56 本世界书、几十章、多卡 |
| **指令都清楚、单一、无冲突** | 真实指令含混、叠加、互相打架 |
| **每个工具只调一次** | 真问题常在**组合与重复**上（同一次 edit 连败、绕三圈、越改越远） |
| **测的是「工具通不通」** | 工具全通、产品照样难用 |

另：几个记为「摩擦」的现象，在长期高频使用里可能是**体感级的大问题**——`find`/`grep` 的申请、每拍结尾反问、首拍 8 分钟 15 次工具调用、「默认功能是关的」类断点（`memory_add`、`screenshot`）。单次看都是小事，乘上每天几十拍就是「它老停下来问我，不干活」。

---

## 八 下一步（待用户定）

- **问题 1-4 是小修、收益确定**：`find`/`grep` 无 path 时默认**当前子项目**而非工程根；找不回 `fd` 时把 `find` 从清单摘掉（与 memory 同一条规则）；CLI 下不注入 `screenshot`；memory 工具按开关上清单。
- **问题 5-6 需拍板**：`~/.agents/skills` 是否隔离；`记忆/` 是否该进 `harnessManagedPath`。
- **刀 4** 按「架构归位」重写，plan §一.1 诊断改掉。
- **answer-me-with-html** 记着，等触发条件。
- **要重新挖大问题，换测法**（不是把本轮放大）：同一模型下、**扮演模式**、**挂预设**、连续 20+ 拍；或者**换模型重跑同一批任务**看失败面怎么变。前提是先有出错形态——没有形态就只能测出「工具都通」。
