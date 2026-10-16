import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { matchDenylist, normalizeCommand, parseDenylist, readDenylistRules } from "../src/bash-denylist.ts";

/** 名单读 <agentDir>/BASH_DENYLIST.txt：本文件把 agentDir 指到临时目录，不读用户本机 */
const AGENT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "liyuan-denylist-")));
process.env.LIYUAN_CODING_AGENT_DIR = AGENT_DIR;
after(() => rmSync(AGENT_DIR, { recursive: true, force: true }));

test("黑名单归一化：剥引号、`\\/` 还原、折叠空白、小写、短选项排序合并", () => {
	const base = normalizeCommand("rm -rf /");
	assert.equal(base, "rm -fr /");
	for (const form of ["rm -fr /", "rm -r -f /", "rm -f -r /", 'rm -rf "/"', "RM -RF  /", "rm -rf \\/"]) {
		assert.equal(normalizeCommand(form), base, form);
	}
	assert.equal(normalizeCommand("  ls   -la  "), "ls -al");
});

test("黑名单匹配：词边界——`rm -rf /` 拦得住，`rm -rf /var/log` 不误伤", () => {
	const rules = parseDenylist("rm -rf /");
	assert.equal(matchDenylist("rm -rf /", rules)?.raw, "rm -rf /");
	assert.equal(matchDenylist("sudo rm -rf /", rules)?.raw, "rm -rf /", "前缀词不影响");
	assert.equal(matchDenylist("ls && rm -rf /", rules)?.raw, "rm -rf /", "复合命令里的那一段照样命中");
	assert.equal(matchDenylist('rm -rf "/"', rules)?.raw, "rm -rf /", "引号归一化");
	assert.equal(matchDenylist("rm -rf /var/log", rules), undefined);
	assert.equal(matchDenylist("echo rm -rf /var/log", rules), undefined);
	assert.equal(matchDenylist("", rules), undefined);
});

test("黑名单通配：`*` 可跨空白（mkfs…/dev/… 与 dd…of=/dev/…）", () => {
	const rules = parseDenylist("mkfs*/dev/*\ndd*of=/dev/*");
	assert.ok(matchDenylist("mkfs.ext4 /dev/sda1", rules));
	assert.ok(matchDenylist("sudo mkfs -t ext4 /dev/nvme0n1p1", rules));
	assert.equal(matchDenylist("which mkfs", rules), undefined, "只是提及不算");
	assert.equal(matchDenylist("man mkfs", rules), undefined);
	assert.ok(matchDenylist("dd if=/dev/zero of=/dev/sda", rules));
	assert.equal(matchDenylist("dd if=backup.img of=restore.img", rules), undefined);
});

test("黑名单：注释与空行跳过；删光规则＝不拦", () => {
	const rules = parseDenylist("# 注释\n\n  \nrm -rf /\n# 尾注\n");
	assert.deepEqual(rules.map((r) => r.raw), ["rm -rf /"]);
	assert.deepEqual(parseDenylist("# 全注释\n\n"), []);
	assert.equal(matchDenylist("rm -rf /", parseDenylist("")), undefined);
});

test("黑名单：随包默认名单拦灾难、放日常", () => {
	const rules = readDenylistRules();
	assert.ok(rules.length >= 20, `随包默认名单非空（实际 ${rules.length} 条）`);
	const blocked = [
		"rm -rf /etc",
		"rm -rf /usr",
		"rm -rf --no-preserve-root /",
		"rm -rf /",
		"mkfs.ext4 /dev/sda1",
		"dd if=/dev/zero of=/dev/sda",
		":(){ :|:& };:",
		"rd /s /q C:\\",
		"Remove-Item -Force -Recurse C:\\",
		"format C:",
		"vssadmin delete shadows /all",
		"diskpart /s wipe.txt",
	];
	for (const command of blocked) assert.ok(matchDenylist(command, rules), command);
	const allowed = [
		"rm file.txt",
		"rm -rf /var/log",
		"ls -la",
		"git status",
		"npm run test",
		"python scripts/build.py",
		"which mkfs",
		"cat /etc/hosts",
		"Remove-Item old.txt",
	];
	for (const command of allowed) assert.equal(matchDenylist(command, rules), undefined, command);
});

test("黑名单：用户自写的规则生效（文件在则文件说了算）", () => {
	writeFileSync(join(AGENT_DIR, "BASH_DENYLIST.txt"), "# 我的\nrm -rf cards/*\n", "utf8");
	try {
		const rules = readDenylistRules();
		assert.deepEqual(rules.map((r) => r.raw), ["rm -rf cards/*"]);
		assert.ok(matchDenylist("rm -rf cards/云澜", rules));
		assert.equal(matchDenylist("rm -rf /etc", rules), undefined, "文件说了算：随包默认不再生效");
	} finally {
		rmSync(join(AGENT_DIR, "BASH_DENYLIST.txt"), { force: true });
	}
});
