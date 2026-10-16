# PLAN-AGENT-BACK-TO-PI：agent 模式回归 pi ＋ 安全加固

2026-10-15 用户定案。来源：独立世界书误删事故复盘（记忆 `liyuan-security-incident-and-sandbox-hardening`）与同日两轮讨论。
**整体方案：agent 模式回归 pi；命令黑名单、资料保护快照一并做。** 本文是执行入口，每刀动手前仍过铁律四三问。

## 〇、根因（两句）

1. **门设在表达层，效果发生在效果层**：四道门（业务门禁 `src/tools/gate.ts`、路径沙箱 `src/sandbox.ts`、跨项目 `isOtherChatPath`、harness 管理路径 `harnessManagedPath`）只覆盖梨园自己发行的工具；`bash` 是并行通道——批一次布尔（`卡.json` 的 `sandboxBash`）后完全静默，四道门一起作废。
2. **agent 模式的行为底座是一份手写散文**：`roleplay.ts:1259` 对 authoring/agent 轮**整份替换** system——pi 的内建层（工具清单 + 工具自己声明的 guidelines）一个字不进。pi 的形状是行为指导住在**工具声明**里（随工具上场下场）；梨园让手写散文说话，而铁律一禁止往散文里加句子 ⇒ 在散文这条路上行为永远补不回来。

循环层不用动：`engine.ts:1520` 走 `session.prompt()`，pi 的 agent loop 已经在跑。

## 一、agent 模式回归 pi

### 1.1 system 槽位：不再整份替换

- 现状：`roleplay.ts:1259` `if (activeStage.mode === "authoring") return { systemPrompt: activeStage.systemPrompt };`
- 改法：agent 轮的 system ＝ **pi 内建基座**（identity ＋ 工具清单 ＋ 工具 guidelines ＋ contextFiles ＋ skills ＋ cwd，即 `customPrompt` 为空时的形状）＋ 梨园的 agent 追加（`AGENT_APPEND_SYSTEM.md` ＋ 卡 `APPEND_SYSTEM.md` ＋ 卡 `AGENTS.md` ＋ 工作区事实）。
- 取内建基座：vendored pi 包根补一行导出 `buildSystemPrompt`（`packages/coding-agent/src/index.ts`，`core/system-prompt.ts:28` 已有实现；包 exports 只开了 `.`，没有子路径可绕），hook 里以 `buildSystemPrompt({ ...event.systemPromptOptions, customPrompt: undefined })` 取。
- 已知代价（认下）：内建基座带一行「You are an expert coding assistant operating inside pi」与一段 pi 文档路径——对写小说是噪音，且身份行与「你担任创作 agent」并存。梨园的追加在后、更具体，实测若有干扰再议（不许在梨园侧做字符串剥除——那是识别器）。
- 扮演轮不动：SYSTEM.md 骨架 ＋ 每拍运行时段，照旧。

> **2026-10-15 实测更正（`docs/FINDINGS-CLI-AGENT-SWEEP.md` §五）**：本节原诊断有两处错，改法不变但性质变了。
> 1. **agent 轮不是「整份替换」**。`roleplay.ts:1259` 整份替换判的是 `activeStage.mode === "authoring"`，而 `ConversationMode` 是 `roleplay | authoring | agent` 三个值——**agent 轮走 append 分支，pi 基座还在**。整份替换只发生在写卡（authoring）轮。
> 2. **工具清单与 guidelines 进不来，另一条原因**：SYSTEM.md 被当作 `customPrompt`，`buildSystemPrompt` 在 `system-prompt.ts:46-72` 直接 return，工具清单和 guidelines 根本没被构造。**这一条对所有模式一视同仁**（扮演/agent/写卡都拿不到），不是 agent 轮独有。
> 3. **收益比本节预想的小得多**：pi 那几条 guidelines 大半已在工具 schema 描述里（edit 四条里三条逐字都在），而 schema 走 function-calling 永远到得了模型；唯一没覆盖的 read/write 两条，描述的正是模型本来就在做的行为。实测：bash 读文件 0 次、`write` 全都用于新文件或整章重写、`edit` 三次都是一次调用带多条 `edits[]`。
> ⇒ **刀 4 的性质是「架构归位」（以后 pi 新增工具，guidelines 自动进来，梨园不维护），不是修 bug。**


### 1.2 行为指导回到工具声明

1.1 落地后，pi 收集的 `toolSnippets` / `promptGuidelines`（read「别用 cat/sed」、edit「一处调用多处修改、oldText 最小唯一」、write「只用于新文件或整份重写」）自然进 agent 轮 system——**梨园不加一句话、不维护一份文案**。工具下场，句子自动消失。

### 1.3 门挂回钩子

挂点已对（`engine.ts:1400` 的既有 `tool_call` 钩子）；改的是**政策**，见 §二 / §三。

## 二、命令黑名单

**数据**（`src/sandbox.ts`，与 `NATIVE_TOOL_ACCESS` 并列）：命令身份拒绝表，argv 首词（＋危险标志）→ 拒绝理由。

| 身份 | 判据 | 理由 |
|---|---|---|
| `rm` | `-[a-z]*[rf]` / `--recursive` / `--force` | 递归/强制删除 |
| `shred` | 一律 | 不可恢复的覆写删除 |
| `mkfs`（前缀） | 一律 | 格式化文件系统 |
| `dd` | 一律 | 块设备写入 |
| `fdisk` / `parted` / `wipefs` | 一律 | 分区/擦除 |
| `shutdown` / `reboot` / `halt` / `poweroff` | 一律 | 关机重启 |
| `del` | `/[sqf]` | Windows 删除 |
| `rd` / `rmdir` | `/s` | Windows 递归删除 |
| `format` / `diskpart` | 一律 | 磁盘操作 |
| `find` | `-delete` / `-exec rm` | 批量删除 |
| `xargs` | 后续含 `rm` / `shred` | 批量删除 |
| `cmd` / `powershell` / `pwsh` / `sh` / `bash` / `zsh`（经 bash 调用） | 一律**降级为问**（不拒） | 嵌套 shell 内部不再解析 |

**判定**（两个纯函数）：`splitSegments(command)` 按 `;` `&&` `||` `|` 与换行切段（不解析引号，宁可多切）；`denyCommand(command)` 每段取首词（剥 `sudo`/`env` 前缀、取 basename）比对表。

**落点**：`sandboxVerdict` 的 bash 分支（`src/sandbox.ts:190`）前置判定，deny 直接返回；`engine.ts:1400` 既有 gate 把理由当工具回执回给模型。零新管线、零新注入点。

**回执**（拒绝必须说话，与既有 deny 回执同形）：`已拦截：<命令> 属不可恢复操作，梨园不允许执行。需要删除请说明目标，走梨园提供的删除入口。`

**局限（明说，不宣称完备）**：拦不到 `$()`、反引号、脚本文件内部（本次事故的实际形态 `python cleanup.py` 就不在其中）。这一层管「直接打出来的破坏性命令」，脚本内部交给 §四的安全网。

**验收**：`test/sandbox.test.ts` 表驱动——每身份一拒一放（`rm file.txt` 放行 / `rm -rf dir` 拒 / `sudo rm -rf` 拒 / `ls && rm -rf x` 拒 / `echo "rm -rf"` 不误伤 / `find . -delete` 拒）。

## 三、bash 授权：工具常驻，权限逐命令

**工具常驻不变**——bash 一直在 agent 轮工具清单里，这是 coding agent 的正常形态。要改的是权限形态：

- `卡.json` 的 `sandboxBash: true`（布尔）→ **`sandboxBashAllow: string[]`**（用户自写的免问前缀，如 `"git status"`、`"npm test"`；空数组＝每条都问）。会话级同形。
- 选择卡选项：`允许一次｜以后不再问「<前缀>」（本卡）｜拒绝`。前缀默认取命令首词，用户可在 `卡.json` 里改窄（如 `git status`）。
- **黑名单永远优先**：deny 表命中即拒，任何授权不能越过。
- 迁移：老 `sandboxBash: true` 读时忽略（收缩，不迁移）。
- 会话级「本会话允许 bash」撤除（它等价于布尔，是同一形态）。

## 四、资料保护快照 ＋ 软删除

**受保护清单**（数据，一处）：`assets/lorebooks`、`assets/presets`、`assets/personas`、`assets/skills`、`assets/cards`。

**新模块 `src/asset-vault.ts`**，照 `StoryHistory`（`src/stage/story-history.ts:126`）的形状：对象仓 `assets/.vault/对象/<sha256>` ＋ `assets/.vault/检查点.jsonl`。

```
snapshot(reason)          先比 mtime/size，变了才算 sha 入仓（省成本）；追加检查点
list()                    检查点列表
restore(id)               按清单写回；多出来的文件移回收站，不硬删
prune(keep)               对象仓 GC
```

**触发时机**（三个）：① 服务启动后一次；② 定时兜底（建议 10 分钟——没有 OS 隔离时这是唯一能覆盖 bash 直写的办法）；③ 每个经 API 的资产写/删之后。

**软删除**：`server/rest.ts:3827` 的 `unlinkSync(abs)` → `renameSync(abs, assets/.回收站/<时间戳>-<文件名>)`。新增 `GET /api/assets/trash`、`POST /api/assets/trash/restore`、`POST /api/assets/trash/purge`（真删只由用户显式触发）。UI：世界书面板加「回收站」区（文件名、删除时间、还原）。

**验收**：单测（去重/写回/改名/还原）＋隔离实例实跑（删一本书 → 回收站有 → 还原 → 列表回来）。

## 五、刀的切分与验收

| 刀 | 内容 | 落点 | 验收 |
|---|---|---|---|
| 1 | 命令黑名单 | `src/sandbox.ts` ＋ `test/sandbox.test.ts` | 表驱动单测；隔离实例真 bash 一拒一放 |
| 2 | bash 授权形态 | `src/sandbox.ts`、`src/cardspace.ts`、`src/types.ts` | 单测：免问前缀命中/未命中、deny 优先、老布尔忽略 |
| 3 | 资产快照＋软删除 | `src/asset-vault.ts`、`server/rest.ts`、面板 | 单测＋隔离实例实跑 |
| 4 | system 槽位回归 | `packages/coding-agent/src/index.ts`（一行导出）、`.liyuan/extensions/roleplay.ts:1259` | 隔离实例：agent 轮 system 含工具 guidelines、扮演轮不变 |

刀 1 最小、独立、先落。每刀按 `ref-isolated-instance-testing` 起隔离实例实跑，不碰用户数据。

## 六、铁律自检

- **铁律一**：不新增送模句子。刀 4 让 system 变长的是 pi 自己发行的工具声明（随工具上场下场），不是人写的催告；黑名单回执是拒绝的产物（与既有 deny 回执同形）。
- **铁律二**：不新增注入点。门走既有 `tool_call` 钩子；快照是数据机制。
- **铁律三**：黑名单枚举的是 **OS 命令身份**（OS 发行的稳定协议），不是第三方措辞；免问清单是**用户自写的数据**；快照不是名单。`sandboxBash` 布尔收缩删除。
- **铁律四**：全集＝任何卡、任何模式的 bash 与资产写删；负责人＝§二/§三（sandbox 一处）与 §四（asset-vault 一处）；没见过的卡＝规则只看命令身份与路径，不看卡内容，行为一致。

## 七、已拍板

1. 定时快照间隔＝**10 分钟**（2026-10-15 用户定）。
2. 对象仓检查点＝**自动留最近 50 个**，更早的连无人引用的对象一起回收（2026-10-15 用户定）。
3. 刀 4 的内建基座是否照单全收（含 coding 身份行）：**随刀 4 关闭而作废**（2026-10-15，见 §八 末条）。

## 八、状态

- 2026-10-15：**刀 1、刀 2 落地（未提交）**。
  - **刀 1 命令黑名单**：`src/bash-denylist.ts`（归一化＋词边界 glob 匹配，纯函数）＋ 随包默认 `assets/BASH_DENYLIST.txt`（28 条，用户可见可改）＋ 启动播种（`server/main.ts` → `<agentDir>/BASH_DENYLIST.txt`）＋ `GET/PUT /api/bash-denylist` ＋ 设置入口（agent 行为 →「后端操控」下面）与中间栏编辑器 `web/src/components/BashDenylistCenter.tsx`。`sandboxVerdict` 的 bash 分支前置 deny——**任何授权越不过黑名单**。
  - **刀 2 bash 授权形态**：`卡.json` 的 `sandboxBash: boolean` → `sandboxBashAllow: string[]`（免问前缀，归一化形态）；选择卡改「允许一次｜以后不再问「<前缀>」（本卡）｜拒绝」；会话级布尔授权撤除（旧条目读时忽略，收缩不迁移）；匹配逐段（`cd x && 任意命令` 不会被 `cd` 一把带走）。
  - 验证：全量 840 项 838 过（2 项既有实卡失败）；`test/bash-denylist.test.ts` 6 项、`test/sandbox.test.ts` 10 项、`test/stage-engine.test.ts` 49 项全过（含真 pi 循环里「命中黑名单直接拒、不弹选择卡」）；隔离实例（7699）实测播种、GET/PUT 与 UTF-8 往返；真浏览器走通设置入口 → 中间栏编辑 → 保存 → 盘上落文件；前端 typecheck 无新增诊断、构建过。
  - 未做：刀 4（system 槽位回归 pi）。
  - 一处与 §二表格的偏离：原表里「经 bash 调用的嵌套 shell 一律降级为问」未实现——黑名单改成用户可见的文件后，该条无处安放（它是政策不是规则），且归一化剥引号后 `bash -c "rm -rf /"` 照样命中 `rm -rf /`。要恢复成一条规则，用户自己在文件里加即可。
- 2026-10-15：**刀 3 落地（未提交）**。
  - **快照仓**：`src/asset-vault.ts` 的 `AssetVault`（对象仓 `assets/.vault/对象/<sha256>` ＋ 只增检查点 `检查点.jsonl` ＋ mtime/size 缓存 `缓存.json`），清单差复用稿子仓的 `diffManifests`。受保护清单 `PROTECTED_ASSET_DIRS` 是该模块唯一一份（`src/backup.ts` 的全项目闭包是另一件事，不动）。三层省成本：mtime/size 没动不读文件、哈希已在仓不重存、清单没差不落条目。
  - **触发**：`server/main.ts` 的 listen 回调起一次（`startup`）＋ 10 分钟定时（`timer`，`unref` 过）＋ `server/rest.ts` 的 `handleApiRequest` 包一层：任何非 GET 请求之后 `snapshot("api")`（router 改名 `routeApiRequest`，逻辑一字未动）。
  - **回收站**：`assets/.回收站/<时间戳>-<原名>` ＋ `清单.jsonl`。`DELETE /api/lorebooks` 由硬删改 `trashAsset`；**同一机制一并套到 `DELETE /api/presets` 与删卡的卡本体/侧挂封面/配套世界书**（§四只点了世界书那一条，但受保护清单是五个目录、防线三写的是「所有删除行为」，只改一条即漏。卡工作空间 `cards/` 不在素材清单里，那里照旧硬删——它有自己「相关数据」语义）。
  - **端点**：`GET /api/assets/trash`、`POST /api/assets/trash/restore`、`POST /api/assets/trash/purge`（不给 `file` 必须显式 `all=true`）；另加了 `GET /api/assets/vault`、`POST /api/assets/vault/restore`——§四没列，但 `restore(id)` 无入口就是死代码，事故场景（bash 硬删 60 本）恰恰只有它救得回来。
  - **界面**：世界书面板底部「回收站」区（文件名/时间/大小/原位置、还原、真删、清空）＋ 可展开的「资料快照」（时间、来源、改动摘要、写回）。
  - **打包/部署**：`.gitignore`、`.dockerignore`、`pack-release.ps1`（`$xd` ＋ 泄漏自检 `forbidden_dirs`）三处排除这两个目录；两个 compose 各加 `liyuan-vault` / `liyuan-trash` 命名卷——`assets/` 下这两个目录不在任何既有卷里，不挂就是容器可写层，重建即丢。
  - 验证：`test/asset-vault.test.ts` 8 项（去重/二进制/写回/回收站/改名/touch/保留窗口 GC/单例）全过；全量 848 项 846 过（**2 项既有实卡失败**：cardfront-pipeline、mvu）；隔离实例（7697）实测——启动快照落条目 → 经 API 删书进回收站 → 还原一字不差 → `rm` 模拟硬删后按快照写回救回 → 写回时「多出来的」进回收站不硬删 → purge 无参会拒 → 每次改动后补快照；真浏览器走通渲染、还原、快照展开、还原冲突报错文案；`i18n-check` 干净；web typecheck 无新增诊断、构建过。
  - **已知相互作用**（不打算修）：经 API 删掉的文件进了回收站，之后又按快照把它写回来 —— 回收站那条成为陈旧副本（`present` 仍为 true），点「还原」会报「原位置已有同名文件」。两份内容未必相同（回收站那份可能更新），所以不自动清、也不自动覆盖，交给用户看提示决定。
  - 未做：刀 4（system 槽位回归 pi）。
- 2026-10-15（追加）：**CLI 拨乱反正（`server/main.ts --cli`，+215/−26，引擎与扩展一行未动）＋ 全量实测**，详见 `docs/FINDINGS-CLI-AGENT-SWEEP.md`。
  - 起因：用户定调「1.6.0 说好先做 CLI 再做前端，agent 模式背离了这个制作路径」。查到 `StageEngine` 只在 `server/main.ts:2554` 被 `new` 过一次，**CLI 下扩展完全空转、拿到的是纯 pi**；补上引导层后 `--cli` 可从终端驱动 agent 模式（必填 dep 只 5 个，其余 26 个缺了自动降级）。
  - 实测：24 个工具实跑（健康表见 findings §二）；「写入消耗注意力」专项 n=3×2（落文件比直出贵 1.44× 输出 token，但**未证到质量下降**）；answer-me-with-html 评估（**暂不做**，理由与触发条件见 findings §四）。
  - 新问题 9 条（`find`/`grep` 无 path 默认工程根撞沙箱、`fd` 运行期下载、memory 五工具默认关着仍上清单、CLI 下 `screenshot` 必然失败、`~/.agents/skills` 泄漏进 system……）见 findings §六。
  - **§一.1 的诊断已按实测更正**（见该节 2026-10-15 更正块）。
- 2026-10-15（追加）：**刀 4 已评估，不做（关闭）**。
  - 诊断已推翻：agent 轮走 append 分支，pi 基座本来就在（§一.1 更正块）；「行为指导住在工具声明里」这个形状梨园自己早已在走——StageTool.description 直接进 function-calling schema。
  - 收益实测为零：pi 的 guidelines 大半逐字已在工具 schema 描述里（`edit.ts:50` 最实质一条逐字在）；没进 schema 的只有 read「别用 cat/sed」、write「只用于新文件或整份重写」两条，而这两条正是模型实测本来就在做的行为。findings §六 十条问题没有一条是刀 4 能修的。
  - 代价为真：每拍多约 2200 字符送模（按 `system-prompt.ts:128-145` 计：coding 身份行＋Available tools 清单＋Guidelines＋pi 文档路径段）；清单只列 pi 原生工具（自定义工具无 `promptSnippet` 不进清单，`extensions/types.ts:458`），梨园二十来个工具一个都不在；且 SYSTEM.md 是 customPrompt——换基座＝把「全局系统提示词」编辑器从 agent 轮摘掉（它与扮演轮环境底座是同一份文件，2e52067 最小化过）。
  - 触发条件（出现即重新评估）：某模型上出现 schema 描述修不了的 read/write 类工具误用（大量 cat/sed 读文件、write 做局部改），且确认原因是「缺 guidelines」而非别处。
