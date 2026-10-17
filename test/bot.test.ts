import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	appendBotThread,
	beatsOf,
	BOT_TOOL_EXCLUDED,
	buildBotSystemPrompt,
	buildBotView,
	botThreadPath,
	botTools,
	readBotPersona,
	readBotThread,
	renderBeats,
	runBotLoop,
	runBotTool,
	type BotAssistantMsg,
	type BotStreamEvent,
	type BotStreamFn,
	type BotThreadEntry,
} from "../src/stage/bot.ts";
import { defaultState } from "../src/state.ts";
import { formatState } from "../src/state.ts";
import type { StageToolDeps } from "../src/stage/tools.ts";

// ---------------- 拍与视野 ----------------

test("bot：beatsOf 按拍分组——开场白算一拍，连续正文并入同拍", () => {
	const beats = beatsOf([
		{ role: "assistant", text: "开场白" },
		{ role: "user", text: "我推门" },
		{ role: "assistant", text: "门开了。" },
		{ role: "assistant", text: "风灌进来。" },
		{ role: "user", text: "我坐下" },
		{ role: "assistant", text: "茶凉了。" },
	]);
	assert.equal(beats.length, 3);
	assert.deepEqual(beats[0], { user: "", assistant: "开场白" });
	assert.deepEqual(beats[1], { user: "我推门", assistant: "门开了。\n\n风灌进来。" });
	assert.deepEqual(beats[2], { user: "我坐下", assistant: "茶凉了。" });
});

test("bot：视野块＝前情提要（有才出）＋世界状态＋最近 K 拍；窗口截早", () => {
	const beats = Array.from({ length: 12 }, (_, i) => ({ user: `话${i + 1}`, assistant: `文${i + 1}` }));
	const view = buildBotView({ summary: "很久以前……", state: "时间：夜", beats });
	assert.match(view, /【前情提要】/);
	assert.match(view, /很久以前……/);
	assert.match(view, /【世界状态】\n时间：夜/);
	assert.match(view, /【最近剧情】（第 5–12 拍/);
	assert.doesNotMatch(view, /话4/);
	assert.match(view, /〔第 12 拍·用户〕话12/);
	const noSummary = buildBotView({ state: "", beats: [] });
	assert.equal(noSummary, "");
});

test("bot：story_read 按拍读（越界与默认值）", async () => {
	const beats = Array.from({ length: 10 }, (_, i) => ({ user: `话${i + 1}`, assistant: `文${i + 1}` }));
	const tools = [{ name: "story_read", description: "", parameters: {}, mode: "read" as const }];
	const deps = {} as StageToolDeps;
	const r = await runBotTool({ deps, tools, name: "story_read", args: { from: 2, count: 2 }, language: "中文", beats });
	assert.match(r.text, /【剧情·第 2–3 拍】/);
	assert.match(r.text, /〔第 2 拍·用户〕话2/);
	assert.doesNotMatch(r.text, /话4/);
	const far = await runBotTool({ deps, tools, name: "story_read", args: { from: 99 }, language: "中文", beats });
	assert.match(far.text, /只有 10 拍/);
	const empty = await runBotTool({ deps, tools, name: "story_read", args: {}, language: "中文", beats: [] });
	assert.match(empty.text, /还没有剧情/);
});

test("bot：未知工具回文本不抛", async () => {
	const r = await runBotTool({ deps: {} as StageToolDeps, tools: [], name: "nope", args: {}, language: "中文", beats: [] });
	assert.match(r.text, /未知工具 nope/);
});

// ---------------- system 与人设 ----------------

test("bot：system＝身份站在前、人设在后；宏展开；空段跳过", () => {
	const out = buildBotSystemPrompt({
		cardAppend: "本卡为{{char}}的世界。",
		persona: "你是{{user}}的副编剧。",
		macro: { charName: "阿离", userName: "客官" },
	});
	assert.equal(out, "本卡为阿离的世界。\n\n你是客官的副编剧。");
	assert.equal(buildBotSystemPrompt({ cardAppend: "", persona: "只有人设", macro: { charName: "x", userName: "y" } }), "只有人设");
});

test("bot：人设读取——卡级覆盖全局，都缺退随包默认", () => {
	const root = mkdtempSync(join(tmpdir(), "bot-persona-"));
	try {
		const cardDir = join(root, "卡");
		const agentDir = join(root, "agent");
		mkdirSync(cardDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "BOT.md"), "全局人设", "utf8");
		assert.equal(readBotPersona(cardDir, agentDir), "全局人设");
		writeFileSync(join(cardDir, "BOT.md"), "卡级人设", "utf8");
		assert.equal(readBotPersona(cardDir, agentDir), "卡级人设");
		assert.match(readBotPersona(null, join(root, "不存在")), /副编剧/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------- 线程存储 ----------------

test("bot：线程路径＝子项目一份；老布局回落 .liyuan/副编剧", () => {
	const p = botThreadPath("E:/ws", join("E:/ws", "cards", "卡", "对话", "c1", "会话"), "s1");
	assert.equal(p, join("E:/ws", "cards", "卡", "对话", "c1", "副编剧.jsonl"));
	assert.equal(botThreadPath("E:/ws", undefined, "s1"), join("E:/ws", ".liyuan", "副编剧", "s1.jsonl"));
});

test("bot：线程读写——往返、坏行跳过、空文本不落", () => {
	const root = mkdtempSync(join(tmpdir(), "bot-thread-"));
	try {
		const file = join(root, "副编剧.jsonl");
		assert.deepEqual(readBotThread(file), []);
		const entries: BotThreadEntry[] = [
			{ role: "user", text: "师姐的师父是谁", ts: 1 },
			{ role: "assistant", text: "是玄机子。", ts: 2 },
		];
		appendBotThread(file, entries);
		appendBotThread(file, [{ role: "user", text: "   " }]);
		writeFileSync(file, `${readFileSync(file, "utf8")}坏行\n{"role":"x"}\n`, "utf8");
		assert.deepEqual(readBotThread(file), entries);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------- 工具面 ----------------

test("bot：工具面——资料写族与卡工程在，世界线/演出界面/换卡不在", () => {
	const deps = {
		getState: () => defaultState(),
		formatState: (s: ReturnType<typeof defaultState>) => formatState(s),
		writeLore: () => null,
		updateLore: () => null,
		deleteLore: () => false,
		listLore: () => [],
		fingerprint: () => "fp",
		listBooks: () => [],
		createBook: () => null,
		mountBook: () => true,
		toggleLore: () => 0,
		addMemory: async () => ({ added: 1, total: 1, chunks: 1 }),
		listMemory: () => [],
		readMemory: () => undefined,
		updateMemory: () => undefined,
		deleteMemory: () => true,
		readCard: () => null,
		updateCard: () => {},
		createCard: () => null,
		listCards: () => ({ cards: [], current: "" }),
		greetings: { list: () => [], add: () => 0, edit: () => {}, remove: () => {} },
		project: async () => ({}),
		loadPanels: () => ({}),
		writePanel: () => ({ ok: true, created: true, reopened: false, activeCount: 1, overLimit: false }),
		closePanel: () => ({ ok: true }),
		loadWorldline: () => ({ saves: [] }),
		storeSave: () => null,
	} as unknown as StageToolDeps;
	const names = botTools("中文", deps).map((t) => t.name);
	for (const want of ["lorebook_write", "lorebook_update", "lorebook_delete", "memory_add", "memory_update", "card_update", "card_read", "story_read", "world_state_get", "lorebook_search", "memory_search"]) {
		assert.ok(names.includes(want), `缺 ${want}`);
	}
	for (const name of names) {
		assert.ok(!BOT_TOOL_EXCLUDED.has(name), `不该出现 ${name}`);
		assert.ok(!name.startsWith("worldline_"), `不该出现 ${name}`);
		assert.ok(!name.startsWith("draft_"), `不该出现 ${name}`);
	}
});

// ---------------- 循环 ----------------

const asstMsg = (parts: Array<{ text?: string; tool?: { id: string; name: string; args?: Record<string, unknown> } }>): BotAssistantMsg => ({
	role: "assistant",
	content: parts.map((p) => (p.tool ? { type: "toolCall", id: p.tool.id, name: p.tool.name, arguments: p.tool.args ?? {} } : { type: "text", text: p.text ?? "" })),
	stopReason: "stop",
});

/** 按轮脚本应答的假流；contexts 记录每一轮收到的送模内容 */
const scripted = (rounds: BotAssistantMsg[][]): { stream: BotStreamFn; contexts: Array<{ systemPrompt?: string; messages: unknown[]; tools?: unknown[] }> } => {
	const contexts: Array<{ systemPrompt?: string; messages: unknown[]; tools?: unknown[] }> = [];
	let call = 0;
	const stream: BotStreamFn = (_model, context) => {
		// 深拷一份——循环随后会往同一个 messages 数组里 push（工具回执/下一轮）
		contexts.push({ ...context, messages: structuredClone(context.messages) } as { systemPrompt?: string; messages: unknown[]; tools?: unknown[] });
		const parts = rounds[Math.min(call++, rounds.length - 1)] ?? [];
		const message = parts[parts.length - 1] ?? asstMsg([{ text: "" }]);
		const events: BotStreamEvent[] = [
			...(message.content.some((c) => c.type === "text") ? [{ type: "text_delta", delta: message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") }] : []),
			{ type: "done", message },
		];
		const iter = (async function* () {
			for (const e of events) yield e;
		})();
		return Object.assign(iter, { result: async () => message });
	};
	return { stream, contexts };
};

const loopBase = {
	model: {},
	auth: {},
	systemPrompt: "SYS",
	thread: [] as BotThreadEntry[],
	userText: "师姐的师父是谁",
	view: "【世界状态】\n时间：夜",
	tools: [{ name: "lorebook_search", description: "d", parameters: {}, mode: "read" as const }],
	execute: async () => ({ text: "命中 1 条" }),
};

test("bot：原生工具进清单并派发；抛错回可读文本不打断这一轮；图片块随回执带走", async () => {
	const deps = {} as StageToolDeps;
	const seen: Array<{ args: Record<string, unknown> }> = [];
	const native = [
		{ name: "read", mode: "read" as const, description: "读文件", parameters: { type: "object" }, run: async (args: Record<string, unknown>) => { seen.push({ args }); return { text: `读了 ${args.path}`, images: [{ data: "AAA", mimeType: "image/png" }] }; } },
		{ name: "bash", mode: "write" as const, description: "跑命令", parameters: { type: "object" }, run: async () => { throw new Error("炸了"); } },
	];
	const tools = botTools("中文", deps, native);
	assert.ok(tools.some((t) => t.name === "read") && tools.some((t) => t.name === "bash"));
	const r = await runBotTool({ deps, tools, native, name: "read", args: { path: "卡.json" }, language: "中文", beats: [] });
	assert.equal(r.text, "读了 卡.json");
	assert.deepEqual(seen, [{ args: { path: "卡.json" } }]);
	const boom = await runBotTool({ deps, tools, native, name: "bash", args: {}, language: "中文", beats: [] });
	assert.equal(boom.isError, true);
	assert.match(boom.text, /炸了/);
	// 图片块经循环回填进 toolResult（read 读图片时走这条）
	const { stream } = scripted([
		[asstMsg([{ tool: { id: "c1", name: "read", args: { path: "立绘.png" } } }])],
		[asstMsg([{ text: "看过了。" }])],
	]);
	const looped = await runBotLoop({
		...loopBase, stream, tools,
		execute: (name, args) => runBotTool({ deps, tools, native, name, args, language: "中文", beats: [] }),
	});
	assert.deepEqual(looped, { text: "看过了。" });
});

test("bot：一轮直答——单次调用、返回文本、视野块与用户话同条消息", async () => {
	const { stream, contexts } = scripted([[asstMsg([{ text: "是玄机子。" }])]]);
	const r = await runBotLoop({ ...loopBase, stream });
	assert.deepEqual(r, { text: "是玄机子。" });
	assert.equal(contexts.length, 1);
	const msgs = contexts[0]!.messages as Array<{ role: string; content: Array<{ text?: string }> }>;
	const last = msgs[msgs.length - 1]!;
	assert.equal(last.role, "user");
	assert.equal(last.content[0]!.text, "【世界状态】\n时间：夜\n\n师姐的师父是谁");
});

test("bot：工具轮——回执进下一轮、文本取最后一轮、过程条上报", async () => {
	const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
	const activities: string[] = [];
	const { stream, contexts } = scripted([
		[asstMsg([{ text: "我查一下。" }, { tool: { id: "t1", name: "lorebook_search", args: { query: "师姐" } } }])],
		[asstMsg([{ text: "是玄机子。" }])],
	]);
	const r = await runBotLoop({
		...loopBase,
		stream,
		execute: async (name, args) => {
			seen.push({ name, args });
			return { text: "命中 1 条：玄机子", activity: "检索设定" };
		},
		onActivity: (d) => activities.push(d),
	});
	assert.deepEqual(r, { text: "是玄机子。" });
	assert.deepEqual(seen, [{ name: "lorebook_search", args: { query: "师姐" } }]);
	assert.deepEqual(activities, ["检索设定"]);
	const second = contexts[1]!.messages as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>;
	const result = second.find((m) => m.role === "toolResult")!;
	assert.equal(result.toolCallId, "t1");
	assert.equal(result.content[0]!.text, "命中 1 条：玄机子");
});

test("bot：触阀以现有产出收束；错误事件原样上报", async () => {
	const always = asstMsg([{ tool: { id: "t", name: "lorebook_search" } }]);
	const { stream } = scripted([[always]]);
	const r = await runBotLoop({ ...loopBase, stream, maxRounds: 3, execute: async () => ({ text: "又一条" }) });
	assert.deepEqual(r, { text: "" });
	const errStream: BotStreamFn = () => {
		const iter = (async function* () {
			yield { type: "error", error: { role: "assistant", content: [], errorMessage: "上游 500" } } as BotStreamEvent;
		})();
		return Object.assign(iter, { result: async () => asstMsg([]) });
	};
	const r2 = await runBotLoop({ ...loopBase, stream: errStream });
	assert.deepEqual(r2, { error: "上游 500" });
});

test("bot：线程回放进送模（历史各就各位）", async () => {
	const { stream, contexts } = scripted([[asstMsg([{ text: "接着答" }])]]);
	await runBotLoop({
		...loopBase,
		stream,
		thread: [
			{ role: "user", text: "第一问" },
			{ role: "assistant", text: "第一答" },
		],
	});
	const msgs = contexts[0]!.messages as Array<{ role: string; content: Array<{ text?: string }> }>;
	assert.equal(msgs.length, 3);
	assert.equal(msgs[0]!.role, "user");
	assert.equal(msgs[0]!.content[0]!.text, "第一问");
	assert.equal(msgs[1]!.role, "assistant");
	assert.equal(msgs[1]!.content[0]!.text, "第一答");
	assert.equal(msgs[2]!.role, "user");
});

test("bot：renderBeats 头尾（供视野与 story_read 共用版式）", () => {
	const beats = [{ user: "u", assistant: "a" }];
	assert.equal(renderBeats(beats, 0, 1), "〔第 1 拍·用户〕u\n\n〔第 1 拍·正文〕a");
});
