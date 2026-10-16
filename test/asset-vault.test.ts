import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { AssetVault, assetVault, isProtectedPath, KEEP_CHECKPOINTS, PROTECTED_ASSET_DIRS, TRASH_DIR, VAULT_DIR } from "../src/asset-vault.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "liyuan-asset-vault-")));
const write = (dir: string, name: string, text: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), text, "utf8");
};
const writeBytes = (dir: string, name: string, bytes: number[]) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), Buffer.from(bytes));
};

test("资料快照：受保护清单是那五个素材目录，路径判定按目录前缀", () => {
	assert.deepEqual([...PROTECTED_ASSET_DIRS], ["assets/lorebooks", "assets/presets", "assets/personas", "assets/skills", "assets/cards"]);
	assert.equal(isProtectedPath("assets/lorebooks/书.json"), true);
	assert.equal(isProtectedPath("assets/cards/卡.png"), true);
	assert.equal(isProtectedPath("assets/lorebooksX/书.json"), false, "前缀要落在目录边界上");
	assert.equal(isProtectedPath("liyuan.config.json"), false);
	assert.equal(isProtectedPath("cards/云澜/云澜.json"), false, "卡空间不在素材目录里");
});

test("资料快照：无变化不落、同内容不重存、mtime 没动不重算、改名识别", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		assert.equal(v.snapshot("startup"), undefined, "空目录没什么可落的");

		write(join(cwd, "assets", "lorebooks"), "甲.json", '{"a":1}');
		write(join(cwd, "assets", "lorebooks"), "乙.json", '{"a":1}');
		write(join(cwd, "assets", "presets"), "预设.json", "{}");
		const c1 = v.snapshot("startup")!;
		assert.deepEqual(c1.changed, { added: ["assets/lorebooks/乙.json", "assets/lorebooks/甲.json", "assets/presets/预设.json"], modified: [], renamed: [], removed: [] });
		assert.equal(readdirSync(join(cwd, VAULT_DIR, "对象")).length, 2, "同内容两个文件只有一个对象");

		assert.equal(v.snapshot("timer"), undefined, "什么都没动：不落条目");
		assert.equal(v.list().length, 1);
		// mtime 动过但内容没变（touch）：清单没差，仍不落
		const touched = join(cwd, "assets", "lorebooks", "甲.json");
		const later = new Date(Date.now() + 5000);
		utimesSync(touched, later, later);
		assert.equal(v.snapshot("timer"), undefined, "只 touch 不改内容：不落条目");

		write(join(cwd, "assets", "lorebooks"), "丙.json", '{"a":2}');
		const c2 = v.snapshot("api")!;
		assert.deepEqual(c2.changed, { added: ["assets/lorebooks/丙.json"], modified: [], renamed: [], removed: [] });
		assert.equal(v.list().length, 2);

		// 改名（内容不变 → 认出是改名而不是一增一删）
		renameSync(join(cwd, "assets", "lorebooks", "丙.json"), join(cwd, "assets", "lorebooks", "丁.json"));
		const c3 = v.snapshot("api")!;
		assert.deepEqual(c3.changed, { added: [], modified: [], renamed: [["assets/lorebooks/丙.json", "assets/lorebooks/丁.json"]], removed: [] });
		assert.equal(v.snapshot("api"), undefined, "改名之后没有别的差");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("资料快照：二进制（卡 PNG）原样进出，内容变即新对象", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f];
		writeBytes(join(cwd, "assets", "cards"), "卡.png", png);
		const c1 = v.snapshot("startup")!;
		assert.deepEqual(c1.changed.added, ["assets/cards/卡.png"]);
		const sha = c1.files["assets/cards/卡.png"]!;
		assert.deepEqual([...v.readObject(sha)], png, "对象仓存的是原字节");
		writeBytes(join(cwd, "assets", "cards"), "卡.png", [...png, 0x01]);
		const c2 = v.snapshot("api")!;
		assert.deepEqual(c2.changed.modified, ["assets/cards/卡.png"]);
		assert.equal(readdirSync(join(cwd, VAULT_DIR, "对象")).length, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("资料快照：按检查点写回；多出来的文件进回收站，不硬删", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const lore = join(cwd, "assets", "lorebooks");
		write(lore, "甲.json", "one");
		write(lore, "乙.json", "two");
		const c1 = v.snapshot("startup")!;

		// 事故形态：脚本硬删了一本 + 改了一本 + 多出一本
		rmSync(join(lore, "乙.json"));
		write(lore, "甲.json", "one-updated");
		write(lore, "丙.json", "three");
		const c2 = v.snapshot("timer")!;
		assert.deepEqual(c2.changed, { added: ["assets/lorebooks/丙.json"], modified: ["assets/lorebooks/甲.json"], renamed: [], removed: ["assets/lorebooks/乙.json"] });

		v.restore(c1.id);
		assert.equal(readFileSync(join(lore, "甲.json"), "utf8"), "one", "改过的写回原样");
		assert.equal(readFileSync(join(lore, "乙.json"), "utf8"), "two", "被删的从对象仓取回");
		assert.equal(existsSync(join(lore, "丙.json")), false, "多出来的不在原处");
		const trashed = v.trashList();
		assert.equal(trashed.length, 1);
		assert.equal(trashed[0]!.from, "assets/lorebooks/丙.json");
		assert.equal(readFileSync(join(cwd, TRASH_DIR, trashed[0]!.file), "utf8"), "three", "多出来的进了回收站，内容还在");

		// 还原之后落了一条新检查点（旧条目仍在）
		assert.equal(v.list().length, 3);
		assert.match(v.latest()!.reason, /^restore:/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("回收站：只收受保护素材；还原到原位；原位有同名文件就拒绝", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const lore = join(cwd, "assets", "lorebooks");
		write(lore, "书.json", "内容");
		assert.throws(() => v.trashAsset(join(cwd, "liyuan.config.json")), /不在受保护素材目录/);
		assert.throws(() => v.trashAsset(join(cwd, "cards", "云澜", "云澜.json")), /不在受保护素材目录/, "卡空间不进这个回收站");

		const item = v.trashAsset(join(lore, "书.json"));
		assert.equal(item.from, "assets/lorebooks/书.json");
		assert.equal(existsSync(join(lore, "书.json")), false);
		assert.equal(v.trashList()[0]!.name, "书.json");
		assert.equal(v.trashList()[0]!.present, true);

		// 原位又有同名文件（用户重建了一本）：拒绝覆盖
		write(lore, "书.json", "新建的");
		assert.throws(() => v.trashRestore(item.file), /原位置已有同名文件/);
		rmSync(join(lore, "书.json"));
		v.trashRestore(item.file);
		assert.equal(readFileSync(join(lore, "书.json"), "utf8"), "内容");
		assert.equal(v.trashList().length, 0, "还原后清单里不再有它");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("回收站：purge 真删；不指定 file 就是清空", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const lore = join(cwd, "assets", "lorebooks");
		write(lore, "甲.json", "a");
		write(lore, "乙.json", "b");
		const one = v.trashAsset(join(lore, "甲.json"));
		v.trashAsset(join(lore, "乙.json"));
		assert.equal(v.trashList().length, 2);

		assert.equal(v.trashPurge(one.file), 1);
		assert.equal(v.trashList().length, 1);
		assert.equal(existsSync(join(cwd, TRASH_DIR, one.file)), false);
		assert.throws(() => v.trashPurge(one.file), /回收站里没有这个文件/);

		assert.equal(v.trashPurge(), 1, "不给 file 就是清空");
		assert.equal(v.trashList().length, 0);
		assert.equal(readdirSync(join(cwd, TRASH_DIR)).filter((f) => f !== "清单.jsonl").length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("资料快照：留最近 KEEP 条，更早的连无人引用的对象一起回收", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const lore = join(cwd, "assets", "lorebooks");
		// 每条都换内容 → 每条都进一个新对象
		for (let i = 0; i < KEEP_CHECKPOINTS + 5; i++) {
			write(lore, "甲.json", `第 ${i} 版`);
			v.snapshot("api");
		}
		assert.equal(v.list().length, KEEP_CHECKPOINTS);
		const objects = readdirSync(join(cwd, VAULT_DIR, "对象"));
		// 保留窗口内的每一条各一个对象，加上现有的那版；更早的已回收
		assert.ok(objects.length <= KEEP_CHECKPOINTS + 1, `对象仓有界（实际 ${objects.length}）`);
		const kept = new Set(v.list().flatMap((c) => Object.values(c.files)));
		for (const o of objects) assert.ok(kept.has(o), `对象仓里没有孤儿：${o}`);
		// 回收后仍能照常快照与还原（缓存里那条 sha 已不在仓里 → 重存一次）
		assert.equal(v.snapshot("timer"), undefined, "内容没变：仍不落条目");
		const latest = v.latest()!;
		for (const [rel, sha] of Object.entries(latest.files)) assert.ok(existsSync(join(cwd, VAULT_DIR, "对象", sha)), `${rel} 的对象在仓里`);
		v.restore(latest.id);
		assert.equal(readFileSync(join(lore, "甲.json"), "utf8"), `第 ${KEEP_CHECKPOINTS + 4} 版`);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("资料快照：对象仓少了一块时写回先失败，盘上一动不动（不留半成品）", () => {
	const cwd = tmp();
	try {
		const v = new AssetVault(cwd);
		const lore = join(cwd, "assets", "lorebooks");
		write(lore, "甲.json", "v1");
		const c1 = v.snapshot("startup")!;
		write(lore, "甲.json", "v2");
		write(lore, "多出来的.json", "extra");
		v.snapshot("api");

		// 手动掏掉 v1 的对象（模拟对象仓被外力破坏）
		rmSync(join(cwd, VAULT_DIR, "对象", c1.files["assets/lorebooks/甲.json"]!));
		assert.throws(() => v.restore(c1.id), /内容已不在对象仓/);
		assert.equal(readFileSync(join(lore, "甲.json"), "utf8"), "v2", "内容没被改一半");
		assert.equal(existsSync(join(lore, "多出来的.json")), true, "也没先把多出来的挪走");
		assert.equal(v.trashList().length, 0, "回收站没被写进半截记录");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

/**
 * Docker 里 assets/lorebooks 是 bind mount、assets/.回收站 是命名卷——两者不是一个文件系统，
 * rename 会 EXDEV。把回收站钉到另一个卷上跑一遍，跨卷那条兜底没写就会抛 EXDEV。
 * 找不到另一个卷（单卷机器/权限不足）就跳过。
 */
function otherVolumeUnder(cwd: string): string | null {
	if (process.platform === "win32") {
		const same = cwd.slice(0, 2).toUpperCase();
		for (const letter of ["C:", "D:", "E:", "F:"]) {
			if (letter === same) continue;
			if (!existsSync(`${letter}\\`)) continue;
			try {
				return mkdtempSync(`${letter}\\liyuan-k3-`);
			} catch {
				/* 这个盘建不了临时目录，试下一个 */
			}
		}
		return null;
	}
	try {
		return mkdtempSync("/dev/shm/liyuan-k3-"); // tmpfs：与普通盘不是同一个文件系统
	} catch {
		return null;
	}
}

test("回收站：跨卷（素材是 bind mount、回收站是命名卷）照样搬得动", (t) => {
	const cwd = tmp();
	const else_ = otherVolumeUnder(cwd);
	if (!else_) {
		t.skip("本机只有一个卷");
		return;
	}
	try {
		const trash = join(cwd, TRASH_DIR);
		mkdirSync(dirname(trash), { recursive: true });
		try {
			symlinkSync(else_, trash, "junction");
		} catch {
			t.skip("本机建不了 junction");
			return;
		}
		const v = new AssetVault(cwd);
		write(join(cwd, "assets", "lorebooks"), "跨卷.json", "跨卷内容");
		const item = v.trashAsset(join(cwd, "assets", "lorebooks", "跨卷.json"));
		assert.equal(existsSync(join(cwd, "assets", "lorebooks", "跨卷.json")), false, "源已经搬走");
		assert.equal(readFileSync(join(else_, item.file), "utf8"), "跨卷内容", "落在另一个卷上的回收站里");
		v.trashRestore(item.file);
		assert.equal(readFileSync(join(cwd, "assets", "lorebooks", "跨卷.json"), "utf8"), "跨卷内容", "还原也要跨卷搬回来");
	} finally {
		rmSync(else_, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("资料快照：assetVault(cwd) 同一个项目共用一份", () => {
	const cwd = tmp();
	try {
		assert.equal(assetVault(cwd), assetVault(cwd));
		assert.notEqual(assetVault(cwd), assetVault(tmp()));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
