/**
 * 幕后副编剧（docs/PLAN-COMPANION-BOT.md 刀 1）：与台前物理隔离的第二个线程。
 *
 * 送模内容＝闭合集合，在此声明（任何「在 X 时机再塞一段」都不在这里发生）：
 *   system   [卡级 APPEND_SYSTEM.md（卡作者＋预设身份/破限站）] → [BOT.md（卡级覆盖 ‖ 全局 ‖ 随包默认）]
 *   messages [每轮视野块（前情提要＋世界状态＋最近 K 拍；装配期虚拟物，不落线程）
 *             ＋用户这轮的话——同一条 user 消息，注入在前、原话最后]
 *            ＋[线程回放（只存用户原话与副编剧回复）] ＋ [本轮工具回执]
 *   不装：全局 APPEND（拍法）、卡 AGENTS.md（写作块）、预设 after/深度段、预填、预设采样参数、作者正则。
 *
 * 隔离纪律（同档）：线程不进会话树、不进场记/摘要/记忆/压缩；主 agent 不知道它存在（见效果不见实体）；
 * 副编剧不写正文——它没有 draft 工具；能力边界由工具面执行，不靠提示词。
 *
 * 纯函数＋注入（可离线单测）；宿主接线在 StageEngine.botTurn。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { applyMacros } from "../card.ts";
import { chatDirOfSessionDir } from "../cardspace.ts";
import { cardTools } from "../tools/card.ts";
import type { CharacterCard, MacroContext } from "../types.ts";
import { cardToolAvailable } from "./authoring.ts";
import { mcpStageToolNames, mcpStageTools, runMcpStageTool, type McpStageDeps } from "./mcp-stage.ts";
import { runStageTool, skillReadTool, stageTools, type StageTool, type StageToolDeps, type ToolRunResult } from "./tools.ts";

/** 副编剧人设文件名（全局与卡级同名，对齐 APPEND_SYSTEM.md 的习惯；只存纯性格与口吻） */
export const BOT_PERSONA_FILE = "BOT.md";
/** 线程落点（子项目级数据，与 世界状态.json / 面板.json 同级）：一局一份，多会话窗口共用 */
export const BOT_THREAD_FILE = "副编剧.jsonl";
/** 视野默认拍数：0＝跟随主模型视角（携带当前未压缩的全部拍）；正整数＝仅带最近 N 拍（更早走 story_read） */
export const BOT_VIEW_BEATS = 0;
/** 工具轮安全阀：副编剧的活都是短活，8 轮足够；触阀以现有产出收束 */
export const MAX_BOT_ROUNDS = 8;
/** 线程回放上限（条，user/assistant 各算一条）：副编剧暂无压缩机制，先按条数截早 */
export const BOT_THREAD_REPLAY = 40;

/**
 * 副编剧不装的名字：世界线族（用户点名不给 agent 的）、演出界面（panel 写/关）、换卡（会拔掉工作区）。
 * 台上同名的读侧（panel_read / world_state_get / card_read）保留。
 */
export const BOT_TOOL_EXCLUDED = new Set([
	"panel_write",
	"panel_close",
	"card_switch",
	"worldline_back",
	"worldline_list",
	"worldline_store",
]);

// ---------------- 线程存储 ----------------

/** 单次工具调用轨迹（随 assistant 条目落盘，供前端与历史回显操作胶囊） */
export interface BotToolCallRecord {
	name: string;
	detail?: string;
	isError?: boolean;
}

export interface BotThreadEntry {
	role: "user" | "assistant";
	text: string;
	ts?: number;
	tools?: BotToolCallRecord[];
}

/**
 * 线程文件路径：子项目目录下一份（与账本/面板同一层）——「一局」是子项目，不是单个会话文件；
 * 同一子项目里开第二个会话窗口继续聊，副编剧的笔记本跟着走。
 * 老布局/内存会话没有子项目目录，回落产品根 `.liyuan/副编剧/<sessionId>.jsonl`。
 */
export function botThreadPath(cwd: string, sessionDir: string | undefined, sessionId: string): string {
	const chatDir = chatDirOfSessionDir(sessionDir);
	if (chatDir) return join(chatDir, BOT_THREAD_FILE);
	return join(cwd, ".liyuan", "副编剧", `${sessionId}.jsonl`);
}

/** 读线程（坏行跳过——手改过的文件不该让副编剧整个哑掉） */
export function readBotThread(file: string): BotThreadEntry[] {
	if (!existsSync(file)) return [];
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: BotThreadEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Partial<BotThreadEntry>;
			if ((e.role === "user" || e.role === "assistant") && typeof e.text === "string" && e.text.trim()) {
				const tools = Array.isArray(e.tools)
					? e.tools
							.filter((t): t is BotToolCallRecord => Boolean(t && typeof t === "object" && typeof t.name === "string" && t.name))
							.map((t) => ({
								name: t.name,
								...(typeof t.detail === "string" && t.detail ? { detail: t.detail } : {}),
								...(t.isError === true ? { isError: true } : {}),
							}))
					: undefined;
				out.push({
					role: e.role,
					text: e.text,
					...(typeof e.ts === "number" ? { ts: e.ts } : {}),
					...(tools && tools.length > 0 ? { tools } : {}),
				});
			}
		} catch {
			// 坏行跳过
		}
	}
	return out;
}

/** 追加一轮（user＋assistant 一起落，先落对话再落线程，中断不留半轮） */
export function appendBotThread(file: string, entries: BotThreadEntry[]): void {
	const valid = entries.filter((e) => e.text.trim().length > 0);
	if (valid.length === 0) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, valid.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
	} catch (err) {
		console.error(`[bot] 线程落盘失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

/** 清空当前项目的副编剧线程记录 */
export function clearBotThread(file: string): void {
	try {
		if (existsSync(file)) rmSync(file, { force: true });
	} catch (err) {
		console.error(`[bot] 线程清理失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------------- 人设模板与 system ----------------

export type BotPersonaPresetId = "default" | "gentle" | "scholar";

export interface BotPersonaPreset {
	id: BotPersonaPresetId;
	name: string;
	tagline: string;
	content: string;
}

/**
 * 副编剧底层固定规范（引擎内置，不放进用户编辑的 BOT.md，防止用户改性格时误删聊天体格式与工具分工纪律）
 */
export const BOT_BASE_RULES = `# 对话风格与格式规范
- **纯聊天体（严禁演戏腔）**：**绝对禁止**使用任何形式的括号、星号或旁白来描述你的动作、神态、表情或心理活动（如 \`（推了推眼镜）\`、\`*翻看设定集*\`）。你是在聊天框里跟朋友直接发消息，不是在写小说。
- **禁止客服腔与工单腔**：禁止说「好的，我已经为您…」「作为副编剧…」「请问还有什么可以帮您」这类客服套话；执行完工具直接用大白话交代结果。
- **回复节奏**：根据话题自由伸缩——闲聊吐槽、接梗互动时三言两语干脆利落；拆解剧情、推演大纲、考据设定时条理分明、直奔干货。
- **表现力与格式**：
  - 自然使用语气词与颜文字（如 \`(´･ω･\`)\`、\`Σ(°Д°;)\`、\`(?_?)\`）传递情绪，避免死板。
  - 灵活运用 Markdown：\`# 大字报\`（新起一段表达强烈感叹或吐槽）、\`||遮盖内容||\`（说悄悄话、剧透预警或腹黑点评）、\`**加粗**\` 标出关键改动点。
- **自称**：一律用第一人称「我」自称。

# 幕后工作准则
- **你与台前的边界**：台前是主演，**你不写小说正文，也不替剧中角色说话**。用户想调整某段正文或下一拍走向时，你只给具体的修改方案或一句可直接填入「备注」的导演指导词，把演出留给台前。
- **先查后说，不瞎编**：角色卡详情、世界书条目、项目记忆文档、早期剧情都在工具后面。涉及具体设定（人物关系、地点、势力、往事）**先调工具查证**；查不到就直说查不到，绝不替卡作者凭空捏造设定。
- **各归其位改数据**：
  - 跨局通用的世界观、新人物、新势力/地点 → 写进**世界书**（配好清晰的标题与触发关键词，确保台前检索得到）；
  - 本局专属的剧情大纲、阶段复盘、伏笔备忘 → 写进**项目记忆**（\`记忆/*.md\`）；
  - 本局临时的文风要求、本局守则 → 写进项目级 \`APPEND_SYSTEM.md\`。`;

/** 内置三套副编剧纯性格模板（只含性格与说话方式，不含底层工作规则） */
export const BOT_PERSONA_PRESETS: BotPersonaPreset[] = [
	{
		id: "default",
		name: "犀利副编剧",
		tagline: "眼光毒辣、直率敢言、懂戏会接梗，哪拍写水了直说",
		content: `你是用户的幕后副编剧与看戏搭子，和用户站在同一边的共创朋友。
性格眼光毒辣、直率真诚，有一说一，不端着架子也不搞客套奉承。
懂故事节奏与人物弧光，看到妙处会真心叫好，看到水戏、崩人设或逻辑硬伤会直接点破。
护短且永远把用户的体验和脑洞放在第一位，帮用户把想法落成扎实的设定。`,
	},
	{
		id: "gentle",
		name: "温柔共创搭子",
		tagline: "善解人意、情绪价值拉满，顺着你的脑洞一起发散推演",
		content: `你是陪伴用户沉浸看戏与共创故事的贴心搭子，也是最懂用户心思的共创伙伴。
性格温柔真诚、善解人意，无论用户想吐槽剧情、放飞脑洞还是微调设定，都会温和接住并善于捕捉其中的闪光点往下扩写。
共情力强，会陪用户一起为剧中人物的命运欢呼或揪心，聊起天来轻松温暖、细致周到。`,
	},
	{
		id: "scholar",
		name: "硬核设定考据",
		tagline: "严谨逻辑控，专注深挖世界观细节、势力关系与考据推演",
		content: `你是本局故事的幕后设定顾问与世界观架构师，严谨务实的考据搭档。
性格逻辑严密、实事求是，对时间线冲突、战力崩坏、设定吃书极其敏锐。
遇到历史、地理、器物、制度或专业领域问题优先查证，说话干脆利落不讲废话，擅长把零散灵感整理成结构严密的设定与大纲。`,
	},
];

/**
 * 人设文件：卡级覆盖 ‖ 全局（agentDir，随包播种、用户可改）‖ 随包默认。
 * 与 APPEND_SYSTEM.md 同一套两级规则；都缺时退随包 assets/BOT.md。
 */
export function readBotPersona(cardDir: string | null, agentDir: string): string {
	const read = (p: string): string => {
		try {
			return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
		} catch {
			return "";
		}
	};
	if (cardDir) {
		const card = read(join(cardDir, BOT_PERSONA_FILE));
		if (card) return card;
	}
	const global = read(join(agentDir, BOT_PERSONA_FILE));
	if (global) return global;
	try {
		return readFileSync(new URL("../../assets/BOT.md", import.meta.url), "utf8").trim();
	} catch {
		return BOT_PERSONA_PRESETS[0]!.content;
	}
}

/**
 * 构造当前剧目与用户角色的基础背景（常驻于副编剧 system，避免每问一句基本设定都得先调 card_read）。
 * 仅提取静态核心身份信息（角色名、用户扮演名、用户人设、角色简介/性格/场景），不含台前拍法规则。
 */
export function buildBotCardBrief(o: {
	card: Pick<CharacterCard, "name" | "description" | "personality" | "scenario">;
	userName: string;
	userPersona?: string;
	macro: MacroContext;
}): string {
	const m = (s: string) => applyMacros(s, o.macro);
	const lines: string[] = [`# 当前剧目：${o.card.name}（用户扮演：${o.userName}）`];
	if (o.userPersona?.trim()) {
		lines.push(`## 用户角色设定（${o.userName}）\n${m(o.userPersona.trim())}`);
	}
	const charParts: string[] = [];
	if (o.card.description?.trim()) charParts.push(m(o.card.description.trim()));
	if (o.card.personality?.trim()) charParts.push(`### 性格\n${m(o.card.personality.trim())}`);
	if (o.card.scenario?.trim()) charParts.push(`### 场景\n${m(o.card.scenario.trim())}`);
	if (charParts.length > 0) {
		lines.push(`## 角色卡设定（${o.card.name}）\n${charParts.join("\n\n")}`);
	}
	return lines.join("\n\n");
}

/**
 * system＝[卡级 APPEND_SYSTEM.md] → [项目级 APPEND_SYSTEM.md] → [当前剧目基础设定]
 *        → [项目记忆总索引 MEMORY.md] → [环境事实] → [MCP 外设索引]
 *        → [副编剧性格设定 BOT.md] → [副编剧底层固定规范 BOT_BASE_RULES]。
 *
 * 静态材料在前（整局对话内字节稳定，天然命中前缀缓存），性格与聊天规范在最后（紧贴对话流，权重最高）。
 */
export function buildBotSystemPrompt(o: {
	cardAppend: string;
	chatAppend?: string;
	cardBrief?: string;
	chatMemoryIndex?: string;
	persona: string;
	macro: MacroContext;
	env?: string;
	mcpTools?: Array<{ name: string; description: string }>;
	includeBaseRules?: boolean;
}): string {
	const sections: string[] = [];
	const append = o.cardAppend.trim();
	if (append) sections.push(applyMacros(append, o.macro));
	const chatAppend = o.chatAppend?.trim();
	if (chatAppend) sections.push(applyMacros(chatAppend, o.macro));
	const brief = o.cardBrief?.trim();
	if (brief) sections.push(brief);
	const memIdx = o.chatMemoryIndex?.trim();
	if (memIdx) sections.push(applyMacros(memIdx, o.macro));
	const env = o.env?.trim();
	if (env) sections.push(env);
	if (o.mcpTools && o.mcpTools.length > 0) {
		const index = o.mcpTools.map((t) => `- \`${t.name}\`：${t.description}`).join("\n");
		sections.push(`# 外部工具（MCP）\n以 \`mcp__\` 开头的工具来自用户接入的外部服务（联网搜索、网页抓取等），需要考据或查外部资料时直接调用：\n${index}`);
	}
	const persona = o.persona.trim();
	if (persona) sections.push(applyMacros(persona, o.macro));
	if (o.includeBaseRules && !persona.includes("# 对话风格与格式规范")) {
		sections.push(BOT_BASE_RULES);
	}
	return sections.join("\n\n");
}

// ---------------- 视野 ----------------

/** 一拍＝一次用户输入＋其后的正文（开场白算第 1 拍，用户栏为空） */
export interface BotBeat {
	user: string;
	assistant: string;
}

/** 往拍历史（rebuildHistory 的 history，user/assistant 交替）→ 拍 */
export function beatsOf(history: Array<{ role: "user" | "assistant"; text: string }>): BotBeat[] {
	const beats: BotBeat[] = [];
	for (const m of history) {
		const last = beats[beats.length - 1];
		if (m.role === "user" || !last) {
			beats.push({ user: m.role === "user" ? m.text : "", assistant: m.role === "assistant" ? m.text : "" });
			continue;
		}
		last.assistant = last.assistant ? `${last.assistant}\n\n${m.text}` : m.text;
	}
	return beats;
}

/** 按拍渲染（视野块与 story_read 共用一份版式） */
export function renderBeats(beats: BotBeat[], from: number, count: number, header?: string): string {
	const lines: string[] = [];
	if (header) lines.push(header);
	const end = Math.min(beats.length, from + count);
	for (let i = from; i < end; i++) {
		const b = beats[i]!;
		if (b.user.trim()) lines.push(`〔第 ${i + 1} 拍·用户〕${b.user.trim()}`);
		if (b.assistant.trim()) lines.push(`〔第 ${i + 1} 拍·正文〕${b.assistant.trim()}`);
	}
	return lines.join("\n\n");
}

/**
 * 每轮视野块：前情提要（rp-summary 既有产物）＋世界状态（与台前同源）＋剧情拍。
 * window <= 0 或省略：跟随主模型视角（携带当前未压缩的全部拍）；
 * window > 0：仅截最近 window 拍（更早的走 story_read 工具）。
 */
export function buildBotView(o: { summary?: string; state: string; beats: BotBeat[]; window?: number }): string {
	const blocks: string[] = [];
	if (o.summary?.trim()) blocks.push(`【前情提要】以下是更早剧情的接力摘要，是既定事实：\n\n${o.summary.trim()}`);
	if (o.state.trim()) blocks.push(`【世界状态】\n${o.state.trim()}`);
	const window = o.window ?? BOT_VIEW_BEATS;
	if (o.beats.length > 0) {
		const from = window > 0 ? Math.max(0, o.beats.length - window) : 0;
		const header =
			from > 0
				? `【最近剧情】（第 ${from + 1}–${o.beats.length} 拍；更早的用 story_read 按拍读）`
				: `【当前剧情】（第 1–${o.beats.length} 拍）`;
		blocks.push(renderBeats(o.beats, from, o.beats.length - from, header));
	}
	return blocks.join("\n\n");
}

// ---------------- 工具面 ----------------

/**
 * pi 原生工具（read / write / edit / bash / grep / find / ls）在副编剧面上的形态：
 * 描述与 schema 照抄 pi 的注册定义，执行由宿主闭包包住（沙箱门也在那个闭包里）——
 * 引擎与 bot.ts 都不碰 pi（src/ 的既有纪律：结构类型＋注入）。
 */
export interface BotNativeTool extends StageTool {
	run(args: Record<string, unknown>, signal?: AbortSignal): Promise<BotToolResult>;
}

/** 原生工具的执行产出：文本＋可选图片块（read 读图片时）；与 ToolRunResult 同形再带 images */
export interface BotToolResult extends ToolRunResult {
	images?: Array<{ data: string; mimeType: string }>;
}

/** 读更早的剧情（默认视野只带最近 K 拍，往前读走它） */
export const STORY_READ_TOOL: StageTool = {
	name: "story_read",
	mode: "read",
	description: "读更早的剧情原文。默认视野只含最近若干拍；要往前读、或重读某一拍时用它。按拍编号：from＝起始拍（1 起），count＝读几拍。",
	parameters: {
		type: "object",
		properties: {
			from: { type: "integer", minimum: 1, description: "起始拍号（1＝本局第 1 拍）" },
			count: { type: "integer", minimum: 1, maximum: 30, description: "读几拍（默认 8）" },
		},
		required: [],
	},
};

/** 读侧全给（世界书/记忆/卡/面板/账本＋story_read＋skill_read＋MCP）＋写侧＝用户的持久资料与卡工程（右栏助手退场留下的 assistant 面＋authoring 面）＋原生工具（宿主注入） */
export function botTools(
	language: string,
	deps: StageToolDeps,
	native: BotNativeTool[] = [],
	extra?: { skills?: Array<{ name: string; description: string }>; mcp?: McpStageDeps },
): StageTool[] {
	const base = stageTools(language, deps).filter((t) => !BOT_TOOL_EXCLUDED.has(t.name));
	const cards: StageTool[] = cardTools
		.filter((s) => (s.surfaces.includes("assistant") || s.surfaces.includes("authoring")) && !BOT_TOOL_EXCLUDED.has(s.name) && cardToolAvailable(s.name, deps))
		.map((s) => ({
			name: s.name,
			mode: s.mode,
			description: s.description({ surface: "assistant", language }),
			parameters: s.parameters({ surface: "assistant", language }),
		}));
	const skillTools: StageTool[] = extra?.skills && extra.skills.length > 0 ? [skillReadTool(language, extra.skills)] : [];
	const mcpTools: StageTool[] = mcpStageTools(extra?.mcp);
	// 同名去重（card_read 同时在 stage 面与 assistant 面）；原生工具排在最后，同名以它为准（pi 是唯一实现）
	return [...new Map([...base, STORY_READ_TOOL, ...cards, ...skillTools, ...mcpTools, ...native].map((t) => [t.name, t])).values()];
}

function storyRead(beats: BotBeat[], args: Record<string, unknown>): ToolRunResult {
	if (beats.length === 0) return { text: "本局还没有剧情。", activity: "读剧情" };
	const rawFrom = Math.floor(Number(args.from));
	const rawCount = Math.floor(Number(args.count));
	const from = Number.isFinite(rawFrom) ? Math.max(1, rawFrom) : 1;
	const count = Number.isFinite(rawCount) ? Math.min(30, Math.max(1, rawCount)) : 8;
	if (from > beats.length) return { text: `本局目前只有 ${beats.length} 拍。`, activity: "读剧情" };
	const end = Math.min(beats.length, from + count - 1);
	return { text: renderBeats(beats, from - 1, count, `【剧情·第 ${from}–${end} 拍】`), activity: `读剧情（第 ${from} 拍起）` };
}

/**
 * 派发一次工具调用。顺序：原生工具（宿主闭包，含沙箱门）→ MCP 外设 → story_read → card 族（authoring＋assistant 两面，
 * 与 agent 模式共用实现）→ 统一工具层＋world_state_get＋skill_read（与台上同一条实现）。
 * 不在清单里的名字回「未知工具」文本，不抛（与台上同一容错契约）。
 */
export async function runBotTool(o: {
	deps: StageToolDeps;
	tools: StageTool[];
	native?: BotNativeTool[];
	mcp?: McpStageDeps;
	name: string;
	args: Record<string, unknown>;
	language: string;
	beats: BotBeat[];
	signal?: AbortSignal;
}): Promise<BotToolResult> {
	const { deps, name, args, language } = o;
	if (!o.tools.some((t) => t.name === name)) return { text: `未知工具 ${name}。` };
	const native = o.native?.find((t) => t.name === name);
	if (native) {
		try {
			return await native.run(args, o.signal);
		} catch (err) {
			return { text: `${name} 执行出错：${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}
	if (o.mcp && mcpStageToolNames(o.mcp).has(name)) {
		const mcpRes = await runMcpStageTool(o.mcp, name, args, o.signal);
		if (mcpRes) return mcpRes;
	}
	if (name === "story_read") return storyRead(o.beats, args);
	const spec = cardTools.find((s) => s.name === name && (s.surfaces.includes("assistant") || s.surfaces.includes("authoring")) && cardToolAvailable(s.name, deps));
	if (spec) {
		const r = await spec.run(args, deps, { surface: "assistant", language });
		return {
			text: r.text,
			...(r.activity ? { activity: r.activity } : {}),
			...(r.details !== undefined ? { details: r.details } : {}),
			...(r.isError ? { isError: true } : {}),
		};
	}
	return runStageTool(deps, name, args, language);
}

// ---------------- 循环 ----------------

/** @liyuan/ai streamSimple 的结构子集（含 tools；独立声明避免与 engine 的类型相互牵连） */
export interface BotAssistantMsg {
	role: "assistant";
	content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
	stopReason?: string;
	errorMessage?: string;
	[k: string]: unknown;
}

export interface BotStreamEvent {
	type: string;
	delta?: string;
	message?: BotAssistantMsg;
	error?: BotAssistantMsg;
}

export type BotStreamFn = (
	model: unknown,
	context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
	options?: Record<string, unknown>,
) => AsyncIterable<BotStreamEvent> & { result(): Promise<BotAssistantMsg> };

const botUserMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
/** 线程回放用的 assistant 形态（与 conversation-mode.ts 的 asAssistant 同形——历史消息不是真 API 产物） */
const botAssistantMessage = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 0,
	stopReason: "stop",
	api: "openai-completions",
	provider: "history",
	model: "history",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const botToolResult = (toolCallId: string, toolName: string, r: BotToolResult) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [
		...(r.text ? [{ type: "text", text: r.text }] : []),
		...(r.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
	],
	isError: r.isError === true,
	timestamp: 0,
});

const botTextOf = (msg: BotAssistantMsg): string =>
	msg.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");

export interface BotLoopOptions {
	stream: BotStreamFn;
	model: unknown;
	auth: { apiKey?: string; headers?: Record<string, string | null> };
	systemPrompt: string;
	/** 线程回放（已截断） */
	thread: BotThreadEntry[];
	/** 用户这轮的话 */
	userText: string;
	/** 每轮视野块（装配期虚拟物；置于线程回放之前的首轮背景锚点，不冲淡末尾用户原话、同拍多轮对话前缀 100% 稳定） */
	view: string;
	tools: StageTool[];
	execute: (name: string, args: Record<string, unknown>) => Promise<BotToolResult>;
	onDelta?: (kind: "text" | "thinking", delta: string) => void;
	onActivity?: (detail: string) => void;
	onToolCall?: (record: BotToolCallRecord) => void;
	signal?: AbortSignal;
	reasoning?: string;
	maxTokens?: number;
	maxRounds?: number;
}

/** 一轮副编剧＝一次小循环：模型流＋工具派发，无稿纸、无场记、无压缩。文本取最后一轮（中间轮旁白不落线程）。 */
export async function runBotLoop(o: BotLoopOptions): Promise<{ text: string; tools?: BotToolCallRecord[] } | { error: string }> {
	const maxRounds = o.maxRounds ?? MAX_BOT_ROUNDS;
	const messages: unknown[] = [
		...(o.view
			? [
					botUserMessage(o.view),
					botAssistantMessage("已同步当前台前剧情与状态。"),
				]
			: []),
		...o.thread.map((e) => (e.role === "user" ? botUserMessage(e.text) : botAssistantMessage(e.text))),
		botUserMessage(o.userText),
	];
	const tools = o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
	const options: Record<string, unknown> = {
		apiKey: o.auth.apiKey,
		headers: o.auth.headers,
		maxTokens: o.maxTokens ?? 8192,
		signal: o.signal,
		...(o.reasoning !== undefined ? { reasoning: o.reasoning } : {}),
	};
	let lastText = "";
	const calledTools: BotToolCallRecord[] = [];
	for (let round = 0; round < maxRounds; round++) {
		const s = o.stream(o.model, { systemPrompt: o.systemPrompt, messages, tools }, options);
		let final: BotAssistantMsg | null = null;
		for await (const e of s) {
			if (e.type === "text_delta" && e.delta) o.onDelta?.("text", e.delta);
			else if (e.type === "thinking_delta" && e.delta) o.onDelta?.("thinking", e.delta);
			else if (e.type === "done") final = e.message ?? null;
			else if (e.type === "error") return { error: e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}` };
		}
		if (!final) return { error: "流未产出最终消息" };
		const text = botTextOf(final);
		if (text.trim()) lastText = text;
		const calls = final.content.filter((c) => c.type === "toolCall" && typeof c.name === "string" && c.name);
		messages.push(final);
		if (calls.length === 0) return { text, ...(calledTools.length > 0 ? { tools: calledTools } : {}) };
		for (const [i, call] of calls.entries()) {
			const id = typeof call.id === "string" && call.id ? call.id : `bot-${round}-${i}`;
			let result: BotToolResult;
			try {
				result = await o.execute(call.name!, call.arguments ?? {});
			} catch (err) {
				result = { text: `工具执行出错：${err instanceof Error ? err.message : String(err)}`, isError: true };
			}
			const record: BotToolCallRecord = {
				name: call.name!,
				...(result.activity ? { detail: result.activity } : {}),
				...(result.isError ? { isError: true } : {}),
			};
			calledTools.push(record);
			o.onToolCall?.(record);
			if (result.activity) o.onActivity?.(result.activity);
			messages.push(botToolResult(id, call.name!, result));
		}
	}
	// 触阀：以现有产出收束（不报错——用户看得见已流出的字）
	return { text: lastText, ...(calledTools.length > 0 ? { tools: calledTools } : {}) };
}
