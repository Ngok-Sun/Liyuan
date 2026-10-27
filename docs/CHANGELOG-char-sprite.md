# 变更点说明 — `feat/char-sprite`（个人 fork）

本分支是 `Ngok-Sun/Liyuan` 的个人 fork，基线为上游 `weidu12123/Liyuan` 的 **v1.6.5**（`e772387`）。
截至 `3128e30`：相对上游 **ahead 9 / behind 0**，19 个文件 `+961 / −466`。
本分支尚未合并上游，也未向上游提 PR。

回滚保险：分支 `backup/pre-rebase-0c58c51` 保留 rebase 前的旧历史（`0c58c51`）。

---

## 一、角色立绘（前端）

### `b80783a` feat(web): 主界面角色大立绘（顶栏开关）
- 顶栏新增「立绘」按钮（`aria-pressed` + `data-tip`，i18n 词条「立绘」/ "Character sprite"）。
- 开关状态存 `localStorage["liyuan.charSprite"]`，刷新不丢；默认关。
- 开启后角色卡头像悬浮在聊天列左侧空白区：`position:absolute`，宽度 `max(0px, calc((100% - var(--chat-w, 880px)) / 2))`，只吃正文栏左边的空白，窗口不够宽自动缩为 0。
- `pointer-events:none` 完全点击穿透，不挡正文操作；`760px` 以下整块隐藏；`prefers-reduced-motion` 时关闭入场动画。

### `5bbf793` style(web): 立绘 v2 — 左侧空白栏居中 + 顶边放大
- 立绘由「贴角小图」改为覆盖整列空白区（`absolute inset-0`），flex 居中。
- 图片改为顶边对齐的等比放大（后续由 `ab3c6e2` 修正为 contain 撑满）。

### `ab3c6e2` fix(web): 立绘顶边放大生效 — `img` 改 `width/height 100%` + `contain`
- 根因：原来用 `max-width/max-height` 只能限制不能放大，图片停留在原始尺寸。
- 改为 `width:100%; height:100%; object-fit:contain; object-position:center`，等比放大到宽或高顶到栏边为止。

### `1b5cdbe` style(web): 立绘底部渐隐 — `mask-image` 三段式
- `linear-gradient(to bottom, #000 72%, rgba(0,0,0,.55) 88%, transparent 99%)`：实 → 半透 → 透明，下缘融进背景。

### `3128e30` feat(web): agent 正文框立绘 — 立绘居左、正文居右，按比例自动放大
- 正文页 `StoryPane` 新增可选 `spriteUrl`：有值时外层加 `story-main-sprite`，立绘列在左、正文在右；历史页不显示。
- 立绘与滚动容器**平级**，正文滚动时立绘待在原地不被卷走；列宽 `clamp(220px, 45%, 520px)`，跟着正文框收放。
- 有立绘时正文整体靠右（`padding-right: clamp(24px, 3vw, 44px)`），窄屏隐藏立绘、正文回居中。

### `a68aa7b` fix(web): agent 面板挂 stage-col-right 渲染空白
- 根因：`renderPanel()` 的 switch 只认内置 `PanelId`，`agent:` 前缀的 agent 自建面板掉进去返回 `undefined`，整列空白。
- 修法：右栏遇到 `agent:` 前缀时照 `sidePanel()` 的 agent 分支走 `ArtifactPanel`，数据取 `worldState.panelData[name]`，保存走同一套回调（乐观更新，随后 WS panels 帧对齐）。

## 二、后端 / 沙箱

### `b821732` feat(sandbox): bash 命令免问档 — 非黑名单命令整条放行
- 新增配置项 `bashFreeRun`：`src/types.ts` 定义、`server/rest.ts` 加入可编辑集合并做布尔归一（脏值/字符串一律当关）。
- `sandboxScope()` 读入该开关；`sandboxVerdict()` 在命中 `BASH_DENYLIST.txt` 时先拒绝，未命中且 `bashFreeRun=true` 直接 `allow`（`cd … && grep …` 这类组合也整条执行），否则沿用「免问前缀 + 逐条申请」。
- 设置页「后端操控」下新增开关「命令免问（黑名单除外）」及说明；中英文词条齐备。
- 边界：仅在后端操控（`backendControl`）开启时有意义；缺省/false 保持原有逐条询问行为。

### `0532f48` fix(agent): 旁路条目 `thinkingLevelMap` 补回
- 根因：`modelsForRuntime()` 按 model id 收敛，同 id 多条目只留第一条；而「同 id、不同思考档」的差异（典型 `thinkingLevelMap: {"off": "none"}`）恰恰写在后几条上。投影后差异丢失，运行时 `reasoning:"off"` 被折成 `undefined`，请求里连 `reasoning_effort` 都不发，服务端按自己的默认继续思考。
- 修法：新增纯函数 `applyEntryThinkingMap(base, entry)`（不改入参，无 map 时原样返回），在 `server/main.ts` 的 `sideEntryOf()` 把**条目自己的** map 盖回运行时模型。新增 `test/agent-config.test.ts` 覆盖。

## 三、部署

### `2669806` feat(scripts): OMV 一键部署脚本 `scripts/deploy-omv.sh`
- fork 模式（默认）：按需 vite build → `rsync` 源码（不含 `.git/node_modules`）到 `OMV:<Video>/liyuan/fork/` → 生成 build 版 compose（项目名钉死 `liyuan`，命名卷与数据全部沿用）→ `docker compose build && up -d` → 健康检查。
- `--official`：一键切回官方 `ghcr` 镜像版（回滚路径）；`--yes` 跳过确认。
- 依赖本机 `ssh/scp/rsync` 免密到 OMV、远端 `sudo -n docker`；`OMV_HOST` 默认 `ngok@10.64.1.11`，`LIYUAN_PORT` 默认 `7620`。

---

## 验证记录（2026-10-26 本机实测）

- `node --test test/sandbox.test.ts test/agent-config.test.ts` → **26/26 通过**
- `npm run web:build` → **exit 0**，产物 `index-Cvzu_EF3.js` / `index-BnXKVESM.css`
- 产物内实测命中：`story-sprite` ×3、`story-main-sprite` ×4、`520px` ×4
- 已知上游既有问题（非本分支引入）：`web/` 下 `tsc --noEmit` 报 5 个错，其中 `pushToast("ok", …)` 两处（`App.tsx:1614/1631`）在 v1.6.5 源码中本就存在；vite build 不做类型检查，不影响打包。

## 与上游同步方式

```bash
git fetch upstream
git rebase upstream/master      # 冲突重点：web/src/App.tsx、web/src/i18n/en/*.ts、web/dist/
npm run web:build               # rebase 后统一重建一次，避免每提交各带一份 bundle
node --test test/sandbox.test.ts test/agent-config.test.ts
git push --force-with-lease origin feat/char-sprite
```
