import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runPresetDeclaration, parseDeclareResponse, type DeclarePiece } from "../src/preset-declare.ts";
import { syncPresetTranslation } from "../server/rest.ts";

const pieces = ["a", "b"].map((id): DeclarePiece => ({ source: "block", id, name: id, text: `text-${id}`, role: "system", where: "before" }));
const full = JSON.stringify([{ id: 1, station: "identity" }, { id: 2, station: "writing" }]);

test("快速声明：单一数字编号映射回来源，off；漏项只补问一次", async () => {
 const calls: string[] = [];
 const result = await runPresetDeclaration(pieces, { preset: "test" }, async (_s, u, opts) => {
  assert.equal(opts.reasoning, "off"); calls.push(u);
  return JSON.stringify([{ id: 1, station: calls.length === 1 ? "identity" : "writing" }]);
 });
 assert.deepEqual(result.pending, []);
 assert.deepEqual(result.entries.map(e => [e.identifier, e.station]), [["a", "identity"], ["b", "writing"]]);
 assert.ok(result.entries.every(e => e.sourceHash));
 assert.equal(calls.length, 2); assert.ok(!calls[1].includes("text-a")); assert.ok(calls[1].includes("text-b"));
});

test("快速声明：无效协议整次拒收，不把兜底计为已声明", async () => {
 for (const response of ["not json",
  '[{"id":999,"station":"identity"}]',
  '[{"id":1,"station":"identity"},{"id":1,"station":"writing"}]',
  '[{"id":1,"station":"identity"},{"id":2,"station":"invalid"}]']) {
  let calls = 0;
  const r = await runPresetDeclaration(pieces, { preset: "test" }, async () => { calls++; return response; });
  assert.equal(calls, 2); assert.deepEqual(r.entries, []); assert.deepEqual(r.pending, ["a", "b"]); assert.ok(r.error);
  assert.equal(r.attempts[0].response, response);
 }
 const parsed = parseDeclareResponse('[{"id":1,"station":"invalid"}]', pieces);
 assert.equal(parsed.declared, 0); assert.deepEqual(parsed.defaulted, ["a", "b"]);
});

test("快速声明：兼容模型返回「片段1」等自然编号格式", async () => {
 const result = await runPresetDeclaration(pieces, { preset: "test" }, async () =>
  JSON.stringify([{ id: "片段1", station: "identity" }, { id: "片段2", station: "writing" }]));
 assert.deepEqual(result.pending, []);
 assert.deepEqual(result.entries.map(e => [e.identifier, e.station]), [["a", "identity"], ["b", "writing"]]);
});

test("快速声明：允许真实的全部writing；网络错误不立即重试", async () => {
 const writing = await runPresetDeclaration(pieces, { preset: "test" }, async () => '[{"id":1,"station":"writing"},{"id":2,"station":"writing"}]');
 assert.deepEqual(writing.pending, []); assert.equal(writing.attempts.length, 1);
 let calls = 0;
 const failure = await runPresetDeclaration(pieces, { preset: "test" }, async () => { calls++; throw new Error("offline"); });
 assert.equal(calls, 1); assert.equal(failure.error, "offline"); assert.deepEqual(failure.entries, []);
});

test("快速同步：旧缓存失效、内容指纹、失败留证与重装绕过退避", async (t) => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-quick-test-"));
 const previous = process.env.LIYUAN_CODING_AGENT_DIR;
 process.env.LIYUAN_CODING_AGENT_DIR = join(cwd, "agentDir");
 t.after(() => { if (previous === undefined) delete process.env.LIYUAN_CODING_AGENT_DIR; else process.env.LIYUAN_CODING_AGENT_DIR = previous; rmSync(cwd, { recursive: true, force: true }); });
 const json = (path: string, obj: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(obj), "utf8"); };
 const file = join(cwd, "assets/presets/test.json");
 const raw = { prompts: pieces.map(p => ({ identifier: p.id, name: p.name, role: p.role, content: p.text })), prompt_order: [{ character_id: 100001, order: pieces.map(p => ({ identifier: p.id, enabled: true })) }] };
 json(file, raw); json(join(cwd, "card.json"), { data: { name: "角色", description: "测试", first_mes: "你好" } });
 json(join(cwd, "liyuan.config.json"), { card: "card.json", userName: "用户", preset: "assets/presets/test.json", lorebooks: [] });
 writeFileSync(join(cwd, "AGENTS.md"), "# 用户档案\n\n保留我。\n", "utf8");
 const cache = join(cwd, "assets/presets/.liyuan/预设声明-test.json");
 json(cache, { version: 1, preset: "test", entries: pieces.map(p => ({ identifier: p.id, station: "writing" })) });
 let calls = 0;
 const replies: Array<string | { error: string }> = [full];
 const requests: string[] = [];
 const deps = { modelLabel: "test-model", runSideText: async (_s: string, u: string) => { calls++; requests.push(u); assert.ok(replies.length); return replies.shift()!; } };
 const read = () => JSON.parse(readFileSync(cache, "utf8"));
 const first = await syncPresetTranslation(cwd, deps);
 assert.equal(first.declared, 2); assert.equal(first.pending, 0); assert.equal(calls, 1);
 const oldHash = read().entries.find((e: any) => e.identifier === "b").sourceHash;
 assert.equal((await syncPresetTranslation(cwd, deps)).declared, 0); assert.equal(calls, 1);
 raw.prompts[1].content = "changed"; json(file, raw); replies.push('[{"id":1,"station":"output"}]');
 assert.equal((await syncPresetTranslation(cwd, deps)).declared, 1);
 assert.ok(!requests.at(-1)!.includes("text-a")); assert.notEqual(read().entries.find((e: any) => e.identifier === "b").sourceHash, oldHash);
 raw.prompts[1].content = "changed-again"; json(file, raw); replies.push("not-json", "not-json");
 const bad = await syncPresetTranslation(cwd, deps);
 assert.equal(bad.declared, 0); assert.equal(bad.pending, 1); assert.ok(bad.declareError);
 assert.deepEqual(read().entries.map((e: any) => e.identifier), ["a"]);
 const evidence = JSON.parse(readFileSync(cache.replace(/\.json$/, ".response.json"), "utf8"));
 assert.equal(evidence.attempts[0].response, "not-json");
 const before = calls; await syncPresetTranslation(cwd, deps); assert.equal(calls, before);
 replies.push(full); assert.equal((await syncPresetTranslation(cwd, deps, { reprocess: true })).pending, 0);
 assert.equal(calls, before + 1);
 assert.ok(readFileSync(join(cwd, "AGENTS.md"), "utf8").includes("保留我。"));
 replies.push({ error: "network" });
 const network = await syncPresetTranslation(cwd, deps, { reprocess: true });
 assert.equal(network.pending, 2); assert.equal(network.declared, 0); assert.equal(calls, before + 2);
 assert.deepEqual(read().entries, []);
});
