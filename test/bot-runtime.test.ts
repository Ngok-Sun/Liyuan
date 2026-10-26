import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, estimateTokens } from "@liyuan/agent-runtime";
import { createAssistantMessageEventStream } from "@liyuan/ai";
import { fauxAssistantMessage, fauxToolCall } from "@liyuan/ai/providers/faux";
import { BotSessionStore, fitBotView, runBotSession } from "../server/bot-runtime.ts";
import type { BotSessionRun } from "../src/stage/bot-session-types.ts";

async function fixture(window = 32000) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-bot-runtime-"));
	const file = join(cwd, "project", "副编剧.jsonl");
	const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const requests: any[] = [];
	let answer: (context: any) => any = () => fauxAssistantMessage("完成");
	const stream = (model: any, context: any, options: any) => {
		requests.push({ model, context: JSON.parse(JSON.stringify(context)), options });
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => {
			try {
				const message = answer(context);
				Object.assign(message, { api: model.api, provider: model.provider, model: model.id });
				if (message.stopReason === "error" || message.stopReason === "aborted") events.push({ type: "error", reason: message.stopReason, error: message });
				else events.push({ type: "done", reason: message.stopReason, message });
				events.end(message);
			} catch (e) {
				const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: String(e) });
				events.push({ type: "error", reason: "error", error: message }); events.end(message);
			}
		});
		return events;
	};
	runtime.registerProvider("bot-test", { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "test", streamSimple: stream,
		models: [{ id: "large", name: "large", contextWindow: window, maxTokens: 2000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
	await runtime.setRuntimeApiKey("bot-test", "test");
	const model = runtime.getModel("bot-test", "large")!;
	const store = new BotSessionStore(file, cwd);
	const run = (patch: Partial<BotSessionRun> = {}) => runBotSession({ cwd, file, systemPrompt: "BOT_ONLY", userText: "请继续", tools: [],
		view: { state: "STATE_SENTINEL", beats: [{ user: "台前输入", assistant: "STORY_SENTINEL" }] },
		signal: new AbortController().signal, execute: async () => ({ text: "ok" }), ...patch,
	}, { agentDir, modelRuntime: runtime, resolveModel: () => ({ model, thinking: "off" }) });
	return { cwd, file, store, model, requests, run, answer: (f: typeof answer) => { answer = f; }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("Bot sessions: migrate legacy once, preserve source, manage independent sessions and project boundaries", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-bot-store-"));
	try {
		const legacy = join(cwd, "副编剧.jsonl");
		const raw = '{"role":"user","text":"旧问题"}\n{"role":"assistant","text":"旧回答","tools":[{"name":"read"}]}\n';
		writeFileSync(legacy, raw);
		const store = new BotSessionStore(legacy, cwd);
		const first = store.snapshot();
		assert.equal(first.messages.length, 2);
		assert.deepEqual(first.messages[1].tools, [{ name: "read" }]);
		assert.equal(first.sessions[0].firstMessage, "旧问题");
		assert.match(first.sessions[0].name, /^旧问题 · \d{2}-\d{2} \d{2}:\d{2}$/);
		const next = store.manage({ action: "new", name: "第二段讨论" });
		assert.notEqual(next.activeId, first.activeId); assert.equal(next.messages.length, 0);
		store.manage({ action: "model", model: { provider: "channel", entry: "model", thinking: "high" } });
		store.manage({ action: "rename", name: "设定讨论" });
		assert.equal(new BotSessionStore(legacy, cwd).snapshot().sessions[1].model?.thinking, "high");
		store.manage({ action: "open", id: first.activeId });
		assert.equal(store.snapshot().messages.length, 2);
		assert.throws(() => store.manage({ action: "open", id: "../escape" }));
		store.manage({ action: "delete", id: next.activeId });
		assert.equal(store.snapshot().sessions.length, 1);
		assert.equal(readFileSync(legacy, "utf8"), raw);
		assert.equal(new BotSessionStore(join(cwd, "other", "副编剧.jsonl"), cwd).snapshot().messages.length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Bot runtime: exact persona, no discovered tools/prompts, tool results survive restart and >40 messages", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.cwd, "AGENTS.md"), "NEVER_LOAD_THIS");
		const { manager } = f.store.current();
		for (let i = 0; i < 25; i++) {
			manager.appendMessage({ role: "user", content: `Q${i}`, timestamp: i });
			manager.appendMessage(fauxAssistantMessage(`A${i}`));
		}
		manager.flush();
		let calls = 0;
		f.answer(ctx => {
			assert.equal(ctx.systemPrompt, "BOT_ONLY");
			assert.deepEqual(ctx.tools.map((t: any) => t.name), ["save_note"]);
			assert.match(JSON.stringify(ctx.messages), /Q0/);
			return calls++ === 0 ? fauxAssistantMessage([fauxToolCall("save_note", { value: "42" })], { stopReason: "toolUse" }) : fauxAssistantMessage("已保存");
		});
		let writes = 0;
		const r = await f.run({ tools: [{ name: "save_note", mode: "write", description: "save", parameters: { type: "object", properties: { value: { type: "string" } } } }], execute: async () => { writes++; return { text: "WRITE_RECEIPT_42" }; } });
		assert.ok("text" in r, JSON.stringify(r)); assert.equal(writes, 1);
		const log = readFileSync(f.store.current().manager.getSessionFile()!, "utf8");
		assert.match(log, /WRITE_RECEIPT_42/); assert.match(log, /"value":"42"/);
		assert.doesNotMatch(log, /STORY_SENTINEL|STATE_SENTINEL|NEVER_LOAD_THIS/);
		f.answer(ctx => { assert.match(JSON.stringify(ctx.messages), /WRITE_RECEIPT_42/); return fauxAssistantMessage("记得操作结果"); });
		await f.run(); assert.equal(writes, 1);
		assert.equal(f.store.snapshot().status, "complete");
	} finally { f.cleanup(); }
});

test("Bot runtime: stop after a write retains the user, tool call and result; resuming does not repeat the write", async () => {
	const f = await fixture();
	try {
		const ac = new AbortController(); let writes = 0;
		f.answer(() => fauxAssistantMessage([fauxToolCall("write_once", {})], { stopReason: "toolUse" }));
		const r = await f.run({ signal: ac.signal, tools: [{ name: "write_once", mode: "write", description: "write", parameters: { type: "object", properties: {} } }], execute: async () => { writes++; ac.abort(); return { text: "ALREADY_WRITTEN" }; } });
		assert.ok("error" in r); assert.equal(writes, 1, JSON.stringify(r)); assert.equal(f.store.snapshot().status, "stopped");
		const log = readFileSync(f.store.current().manager.getSessionFile()!, "utf8"); assert.match(log, /ALREADY_WRITTEN/);
		f.answer(ctx => { assert.match(JSON.stringify(ctx.messages), /ALREADY_WRITTEN/); return fauxAssistantMessage("接着来"); });
		assert.ok("text" in await f.run()); assert.equal(writes, 1);
	} finally { f.cleanup(); }
});

test("Bot runtime: manual compression keeps originals and excludes external story from summary", async () => {
	const f = await fixture(12000);
	try {
		const { manager } = f.store.current();
		for (let i = 0; i < 18; i++) {
			manager.appendMessage({ role: "user", content: `NOTE_${i}: ${"abcdefgh ".repeat(110)}`, timestamp: i });
			manager.appendMessage(fauxAssistantMessage(`ANSWER_${i}: ${"abcdefgh ".repeat(110)}`));
		}
		manager.flush();
		f.answer(ctx => { assert.doesNotMatch(JSON.stringify(ctx), /STORY_SENTINEL|STATE_SENTINEL/); return fauxAssistantMessage("Summary: notes and completed changes retained."); });
		const r = await f.run({ compact: true });
		assert.ok("text" in r, JSON.stringify(r));
		assert.ok(f.store.current().manager.getBranch().some(e => e.type === "compaction"));
		assert.equal(f.store.snapshot().messages.length, 36);
		f.answer(ctx => { assert.match(JSON.stringify(ctx.messages), /Summary: notes/); assert.match(JSON.stringify(ctx.messages), /STORY_SENTINEL/); return fauxAssistantMessage("继续"); });
		assert.ok("text" in await f.run());
	} finally { f.cleanup(); }
});

test("Bot runtime: automatic compression on a smaller window occurs before request overflow", async () => {
	const f = await fixture(9000);
	try {
		const { manager } = f.store.current();
		for (let i = 0; i < 20; i++) {
			manager.appendMessage({ role: "user", content: "old ".repeat(350), timestamp: i });
			manager.appendMessage(fauxAssistantMessage("reply ".repeat(350)));
		}
		manager.flush();
		f.answer(ctx => fauxAssistantMessage(ctx.systemPrompt === "BOT_ONLY" ? "fits" : "Summary of completed work."));
		const r = await f.run(); assert.ok("text" in r, JSON.stringify({ r, context: f.store.snapshot().context, requests: f.requests.map(r => r.context.systemPrompt?.slice(0, 40)), compact: f.store.current().manager.getBranch().filter(e => e.type === "compaction") }));
		assert.ok(f.store.current().manager.getBranch().some(e => e.type === "compaction"));
		const request = f.requests.find(r => r.context.systemPrompt === "BOT_ONLY"); assert.ok(request);
		assert.ok(request.context.messages.reduce((n: number, m: any) => n + estimateTokens(m), 0) < 9000);
	} finally { f.cleanup(); }
});

test("Bot view: shrink complete beats to budget; fixed state too large fails explicitly", () => {
	const view = { state: "state", beats: Array.from({ length: 10 }, (_, i) => ({ user: `U${i}`, assistant: "word ".repeat(400) })) };
	const fitted = fitBotView(view, 1200);
	assert.ok(fitted.beats > 0 && fitted.beats < 10); assert.match(fitted.text, /U9/); assert.doesNotMatch(fitted.text, /U0/);
	assert.throws(() => fitBotView({ state: "x".repeat(10000), beats: [] }, 50));
});
