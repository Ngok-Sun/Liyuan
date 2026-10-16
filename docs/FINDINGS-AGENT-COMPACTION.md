# FINDINGS-AGENT-COMPACTION：agent 模式的压缩（诊断与四刀修复，2026-10-16）

> 2026-10-16 立档。起因：用户报三条——①右下角上下文压缩后不变；②压缩过程没有进度；③压缩的摘要看不见。
> 本文只记**实测到的事实**与**改了什么**；没测到的单列一节。

---

## 一 诊断：agent 模式有两套压缩，用户看到的那套不动上下文

| | 压什么 | 何时 | 对上下文窗口的影响 |
|---|---|---|---|
| **前情压缩**（`engine.ts` → `#compact` → `planFileCompaction`） | `正文/` 章文件 → `rp-summary`（回读为【前情提要】） | 检查点后自动（keep＝`compactEveryNTurns ?? 30` 章）／手动 /compact（keep=6） | **零**——正文不在上下文里 |
| **讨论压缩**（`engine.ts` → `#compactDiscussion`） | 讨论历史（工具调用＋回执＋消息）→ `liyuan-discussion-summary` | 仅自动，拍末 | 唯一真正压上下文的 |

**用用户盘上的真实数据坐实**（`cards/淫天记·大夏皇朝` 的 agent 会话，401 条 / 549,052 token）：

- 讨论 924,058 字符（334 条工具过程记录）＋消息 195,056 字符 ⇒ 估算 279,779 token；**真实 prompt 已到 549,052**——**讨论压缩一次没跑过**（全库 0 条 `liyuan-discussion-summary`）。
- 前情压缩跑了 8 次，最大一次压掉 44 章 157,599 字 → 4,894 字摘要。

### 三条根因

1. **「压缩后上下文不变」**
   - 用户按的/看到的是前情压缩，按设计就不动上下文（且没有任何地方说明这一点）；
   - **讨论压缩的判据是死的**：`讨论估算 > 窗口−16k`，尺子是字符/4（对中文低估近一倍），1M 窗口 ⇒ 阈值 ≈98 万估算 token ≈190 万真实 token，**溢出永远先发生**；
   - `/compact` 在 agent 模式走 `compactNow → #compact`，压的是**文件**不是讨论——按钮接错了机制；
   - 指示器取自 pi 的「上一轮请求真实 usage」（`getContextUsage`），压缩条目是 custom entry、不改 pi 的消息列表 ⇒ 压完不动。
2. **「没有进度」**：压缩只有一行瞬时 activity 注记；自动压缩连 `compaction` 帧都不发（`server/main.ts` 只转发 pi 原生压缩事件，而 pi 原生压缩被 `roleplay.ts:1279` 取消）。
3. **「摘要看不见」**：摘要落在树上是 `rp-summary` / `liyuan-discussion-summary` 自定义条目，`branchMessages` 不投影它们。

### 顺带答：agent 会全量读正文吗？——不会

进上下文的只有三样：`【正文目录】`（**只有文件名/字数/时间**，`agent.ts:formatStoryIndex`）、`【前情提要】`（若有）、以及**经讨论进来的正文全文**——模型 `write` 写第 N 章时整章文本是工具调用参数，进了讨论历史（这就是 92 万字符的来源）。

---

## 二 四刀

| 刀 | 改法 | 落点 |
|---|---|---|
| 1 判据用真实 usage | `livePromptTokens(branch)`：最近一条带 usage 的 assistant 的 prompt 侧 token ＋其后估算补齐（与 pi `estimateContextTokens` 同法）；无 usage 才退估算 | `src/stage/discussion.ts`、`engine.ts#compactDiscussion` |
| 2 手动压缩压讨论 | agent 子项目 `/compact` → 讨论压缩（`force:true` ＋ 地板 `MANUAL_MIN_DISCUSSION_TOKENS=2000` 估算 token）；文件侧保持自动（检查点触发） | `engine.ts#compactNow`、`server/main.ts#hostCompact` |
| 3 指示器折算 | 压缩前/后各取一次讨论估算，`指示器 = 最近真实 usage × (estAfter/estBefore)`；下一拍真实 usage 落地即清 | `engine.ts`（`#ctxOverride` ＋ `contextUsage()`）、`server/main.ts#safeStats` |
| 4 可见化 | ①所有压缩（自动＋手动）经 `onCompaction` 发 `compaction` 帧（kind/detail/ok）；②前端在会话状态栏常驻「压缩中 Ns」＋完成 toast；③摘要投影成对话流内联卡片（`compaction` 通道，可展开读全文） | `engine.ts`/`compact.ts`（事件）、`server/wire.ts`、`web/`（Messages/App/StatusStrip） |

**文案分家**（选项 A，用户 2026-10-16 拍板）：正文侧改叫「**前情提要已刷新**：N 章 M 字 → 摘要 K 字」（它不压上下文，别再叫压缩）；讨论侧仍是「**讨论已压缩**：N 轮 → 摘要 M 字」。

**保留窗口折算**：`keepTarget = keepRecent / (真实/估算)`——阈值是真实单位而保留窗口是估算单位，不折算就等于「保留 40k 真实 token」，64k 窗口下压完仍在阈值之上（每拍触发一次却压不下去）。

---

## 三 实测（隔离实例，`E:\silly-agent\_c2-test`，窗口 60000 逼出压缩）

- **触发**：真实 47,481 > 60k−16.4k ⇒ 触发；同场景下旧判据（估算 ≈2 万）**不会**触发。
- **指示器**：压缩前那发 47,481 → 压完帧 **32,200**（下一拍真实实测 34,567 印证折算准）；无此折算则一直停在 47,481。
- **帧**：`compaction start/end` 带 kind 与 detail（自动与手动同一条）：
  `正在压缩讨论（1 轮 · 约 47481 token）…` / `讨论已压缩：1 轮 → 摘要 496 字`；
  `正在刷新前情提要（2 章 · 9198 字）…` / `前情提要已刷新：2 章 9198 字 → 摘要 2280 字`。
- **真浏览器**（Chrome，1440×900）：对话流出现卡片「讨论｜1 轮 · 14,123 字 → 摘要 496 字」，展开可读摘要全文（496 字）；状态栏 `8 条消息 · 累计 138k · 上下文 58%（35k / 60k）`。
- 单测：`test/agent-mode.test.ts` 加两条（真实 usage 触发；force/地板）；`test/wire.test.ts` 加一条（卡片投影）。全量 853 项 851 过（**2 项既有实卡红**：cardfront-pipeline、mvu）；`i18n-check` 干净；web typecheck 无新增诊断、构建过。

---

## 四 这次测不到的

- **大窗口实况**：只在 60k 窗口的隔离实例上验过。用户真实模型（1M）阈值 ≈98 万真实 token——**这条修完仍要跑到 98 万才自动压**；是否合意取决于用户对「1M 窗口要不要主动压」的取舍（本轮按「溢出前压」实现，未改阈值策略）。
- **扮演模式**：刀 3 的折算只覆盖 agent 讨论压缩；扮演的拍压缩（rp-summary）压完同样只等下一拍才更新（pi 数不变），本轮未动。
- **长局**：连续 20+ 拍、压缩与 swipe/rewind/切线并发、压缩中切模型，均未测。
- **CLI**：`onCompaction` 是可选 dep，CLI 只打一行 `[compaction]` 日志，未做终端进度。

---

## 五 扮演侧补齐（2026-10-16 追加）

用户问「扮演模式下是否仍存在那三个问题」。**逐条查证：两条已被刀 4 覆盖，只剩一条。**

| 用户报的 | 扮演下的实情 | 依据 |
|---|---|---|
| ①压缩没有进度 | **已覆盖**。`runCompaction` 对扮演拍压缩同样发 `onCompaction`（`kind:"story"`），前端不看 kind、通用处理 | `compact.ts:240/251/263/287`、`engine.ts:1753`、`server/main.ts:2937`、`web/App.tsx:1077` |
| ②上下文计算不会刷新 | **未覆盖 → 本次修**。`#ctxOverride` 只设在 `#compactDiscussion`（讨论层），扮演的 `#compact` 不设 | `engine.ts`（原 1713 只在讨论侧） |
| ③看不到压缩后的那份摘要 | **已覆盖**。投影层同时认 `rp-summary` 与 `liyuan-discussion-summary`，卡片按 kind 出「前情提要」 | `server/main.ts:876`、`server/wire.ts:630`、`web/Messages.tsx:722` |

**②的修法**（与讨论层同一条折算，只是换了装配来源）：

- `compact.ts` 加 `historyTokens(branch)`——`rebuildHistory` 装配后送模历史的估算占用（字符/4）。
- `discussion.ts` 把「取最近一次真实占用」抽成 `promptTokensOfMessages(messages)`，`livePromptTokens` 与扮演侧共用。
- `engine.ts#compact`：扮演拍压缩成功且非文件模式、非工作/agent 轮时，
  `#ctxOverride = real × estAfter/estBefore`（`real = promptTokensOfMessages(authoringHistory(branch))`）。
- **守卫 `lastUserMode`**：工作/agent 轮的装配（`authoringHistory`/`agentHistory`）**不吃 rp-summary**，
  那种情况下折算就是错值——只对扮演上下文（最后一条 user 消息无 `liyuanMode`）折算。

**验证**：`test/agent-mode.test.ts` 一条（`historyTokens` 压缩后变小）；
`test/stage-engine.test.ts` 一条（8 拍后 `compactNow()`，`contextUsage()` 出现折算值且 < pi 的压缩前值）。
全量 855 项 853 过（仍 2 项既有实卡红：cardfront-pipeline、mvu）。

**未做**：真浏览器端到端（扮演压缩后状态栏数字刷新）。UI 路径与讨论侧折算完全同源（同一 `#ctxOverride`
→ `contextUsage()` → `safeStats` → `StatusStrip`），讨论侧已在浏览器验过，本轮只在引擎层测。

