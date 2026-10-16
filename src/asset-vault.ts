/**
 * 资料保护：全局素材的快照仓 ＋ 回收站（docs/PLAN-AGENT-BACK-TO-PI.md §四）。
 *
 * 事故复盘（记忆 liyuan-security-incident-and-sandbox-hardening）：agent 越权写全局世界书、
 * 又用底层脚本 `os.remove` 硬删了 60+ 本。四道门都只覆盖梨园发行的工具，bash 是并行通道。
 * 这个模块是那类破坏的**兜底网**，两件东西住一处：
 *
 * - **快照仓**：内容寻址对象仓 ＋ 只增检查点清单，形状照 agent 模式的稿子仓
 *   （src/stage/story-history.ts，清单差也算它那份）。保护对象是全局素材目录
 *   （PROTECTED_ASSET_DIRS）。差在两处：素材是数十 MB 且含二进制（卡 PNG），
 *   所以多一层 mtime/size 缓存——没动过的文件不重算哈希、不重存对象；
 *   以及检查点留最近 KEEP_CHECKPOINTS 个，更早的连无人引用的对象一起回收（磁盘有界）。
 *
 * - **回收站**：用户明确删除的受保护文件不硬删，rename 进 assets/.回收站/，可还原。
 *   真删只由用户显式触发（purge）。
 *
 * 它是**本机的安全网，不是备份**：换机/灾备走 src/backup.ts 的整项目打包。
 * 这一层只管素材目录，卡与子项目的会话不在其中。
 *
 * 报错是中文原文（src/ 下不进 i18n 扫描根，与 src/backup.ts 同例）；面向界面的措辞在
 * server/rest.ts 里用 t() 包。
 */

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { insidePath } from "./paths.ts";
import { diffManifests, isEmptyChange, type ChangeSet, type Manifest } from "./stage/story-history.ts";

/** 受保护的全局素材目录（相对项目根；正斜杠）。这是这份清单唯一的主人。 */
export const PROTECTED_ASSET_DIRS = [
	"assets/lorebooks",
	"assets/presets",
	"assets/personas",
	"assets/skills",
	"assets/cards",
] as const;

export const VAULT_DIR = "assets/.vault";
export const TRASH_DIR = "assets/.回收站";
/** 对象仓与检查点清单（都在 .vault 下） */
const OBJECTS_SUBDIR = "对象";
const CHECKPOINT_LOG = "检查点.jsonl";
/** mtime/size 缓存：只有它说「变了」才重算哈希（丢了就是全量重算一次，不丢数据） */
const CACHE_FILE = "缓存.json";
/** 回收站清单：一条一个被软删的文件（另有同名文件落在 .回收站/ 里） */
const TRASH_LOG = "清单.jsonl";

/** 检查点保留条数：超出的连对象一起回收（磁盘有界，旧快照失效） */
export const KEEP_CHECKPOINTS = 50;
/** 定时兜底间隔（没有 OS 隔离时，这是唯一能覆盖 bash 直写的办法） */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export interface VaultCheckpoint {
	id: string;
	ts: number;
	/** 谁触发的：startup / timer / api / restore … */
	reason: string;
	/** 相对路径（正斜杠）→ sha256 */
	files: Manifest;
	changed: ChangeSet;
}

interface CacheEntry {
	sha: string;
	size: number;
	mtime: number;
}

/** 回收站里的一个文件（清单条目；文件本体在 .回收站/<file>） */
export interface TrashItem {
	/** 在回收站里的文件名（<时间戳>-<原名>） */
	file: string;
	/** 原来在哪（相对项目根，正斜杠） */
	from: string;
	ts: number;
	size: number;
}

export interface TrashItemView extends TrashItem {
	name: string;
	/** 文件本体还在不在回收站里（用户可能从盘上手动删了） */
	present: boolean;
}

const hashOf = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const toPosix = (p: string) => p.replace(/\\/g, "/");

/** 时间戳目录名：20261015-153012-345（毫秒级，够同一秒删多个文件不撞名） */
function stampOf(ms: number): string {
	const d = new Date(ms);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 读一行一条的 jsonl，坏行跳过（只增不改的日志，一行坏不该拖垮整仓） */
function readJsonl<T>(file: string, ok: (v: unknown) => v is T): T[] {
	if (!existsSync(file)) return [];
	const out: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line) as unknown;
			if (ok(v)) out.push(v);
		} catch {
			/* 坏行跳过 */
		}
	}
	return out;
}

/**
 * 「搬一个文件」：同卷 rename；跨卷 rename 会 EXDEV——Docker 里 assets/lorebooks 是 bind mount、
 * assets/.回收站 是命名卷，两者不是一个文件系统。整份拷过去再删源，语义仍是「搬」
 * （失败时源还在，重跑幂等）。与 src/cardspace.ts:172 同一手法。
 */
function moveFile(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "EXDEV" && code !== "EPERM") throw err;
		copyFileSync(from, to);
		rmSync(from, { force: true });
	}
}

/**
 * 整份重写（检查点回收、回收站清单、对象落仓）走临时文件 + rename：
 * 检查点清单是对象仓的唯一索引，对象又是一次写入、以后只读——写一半崩掉等于整仓失准。
 * 这层是最后一道网，不能这么丢。
 */
function writeFileAtomic(file: string, data: string | Buffer): void {
	const tmp = `${file}.tmp`;
	if (typeof data === "string") writeFileSync(tmp, data, "utf8");
	else writeFileSync(tmp, data);
	renameSync(tmp, file);
}

const isCheckpoint = (v: unknown): v is VaultCheckpoint => {
	const c = v as VaultCheckpoint;
	return !!c && typeof c.id === "string" && !!c.files && typeof c.files === "object" && Array.isArray(c.changed?.added);
};

const isTrashItem = (v: unknown): v is TrashItem => {
	const it = v as TrashItem;
	return !!it && typeof it.file === "string" && typeof it.from === "string" && typeof it.ts === "number";
};

/** 这个相对路径在受保护目录里吗（正斜杠） */
export function isProtectedPath(rel: string): boolean {
	const norm = toPosix(rel);
	return PROTECTED_ASSET_DIRS.some((d) => norm.startsWith(`${d}/`));
}

export class AssetVault {
	readonly cwd: string;
	constructor(cwd: string) {
		this.cwd = cwd;
	}

	private get vaultDir() { return join(this.cwd, VAULT_DIR); }
	private get objectsDir() { return join(this.vaultDir, OBJECTS_SUBDIR); }
	private get logFile() { return join(this.vaultDir, CHECKPOINT_LOG); }
	private get cacheFile() { return join(this.vaultDir, CACHE_FILE); }
	get trashDir() { return join(this.cwd, TRASH_DIR); }
	private get trashLog() { return join(this.trashDir, TRASH_LOG); }

	// ---------------- 快照仓 ----------------

	/** 受保护目录下的全部文件（相对项目根、正斜杠、已排序）。符号链接不算文件——不跟出去。 */
	private scanFiles(): string[] {
		const out: string[] = [];
		for (const dir of PROTECTED_ASSET_DIRS) {
			const root = join(this.cwd, dir);
			if (!existsSync(root)) continue;
			const stack = [root];
			while (stack.length) {
				const cur = stack.pop()!;
				let ents: ReturnType<typeof readdirSync>;
				try {
					ents = readdirSync(cur, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const e of ents) {
					const p = join(cur, e.name);
					if (e.isDirectory()) stack.push(p);
					else if (e.isFile()) out.push(toPosix(relative(this.cwd, p)));
				}
			}
		}
		return out.sort();
	}

	/** 全部检查点，按时间顺序 */
	list(): VaultCheckpoint[] {
		return readJsonl(this.logFile, isCheckpoint);
	}

	get(id: string): VaultCheckpoint | undefined {
		return this.list().find((c) => c.id === id);
	}

	/** 最近一条检查点：只看最后一行，不问全仓（快照路径上每次都调它） */
	latest(): VaultCheckpoint | undefined {
		if (!existsSync(this.logFile)) return undefined;
		const lines = readFileSync(this.logFile, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]!;
			if (!line.trim()) continue;
			try {
				const v = JSON.parse(line) as unknown;
				if (isCheckpoint(v)) return v;
			} catch {
				/* 坏行往前找 */
			}
		}
		return undefined;
	}

	/** 某检查点里一个文件的原文（二进制原样） */
	readObject(sha: string): Buffer {
		return readFileSync(join(this.objectsDir, sha));
	}

	private readCache(): Record<string, CacheEntry> {
		try {
			const j = JSON.parse(readFileSync(this.cacheFile, "utf8")) as Record<string, CacheEntry>;
			return j && typeof j === "object" ? j : {};
		} catch {
			return {}; // 没缓存/坏了＝全量重算一次，不丢数据
		}
	}

	/**
	 * 扫一遍受保护目录，变了就落一条检查点（没变返回 undefined）。
	 * 三层省成本：mtime/size 没动 → 不读文件不算哈希；哈希已在对象仓 → 不重存；清单没差 → 不落条目。
	 */
	snapshot(reason: string): VaultCheckpoint | undefined {
		const cache = this.readCache();
		const next: Record<string, CacheEntry> = {};
		const files: Manifest = {};
		for (const rel of this.scanFiles()) {
			const abs = join(this.cwd, rel);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(abs);
			} catch {
				continue; // 扫描途中被删掉：这一轮就当它不在
			}
			const size = st.size;
			const mtime = Math.round(st.mtimeMs);
			const prev = cache[rel];
			// 缓存命中还要求对象真在仓里——GC 之后它可能已经不在了，那就重存一次
			if (prev && prev.size === size && prev.mtime === mtime && existsSync(join(this.objectsDir, prev.sha))) {
				files[rel] = prev.sha;
				next[rel] = prev;
				continue;
			}
			let sha: string;
			try {
				const buf = readFileSync(abs);
				sha = hashOf(buf);
				const objAbs = join(this.objectsDir, sha);
				if (!existsSync(objAbs)) {
					mkdirSync(this.objectsDir, { recursive: true });
					writeFileAtomic(objAbs, buf);
				}
			} catch {
				continue; // 读不动（权限/竞态）：跳过，别让一次快照炸掉
			}
			files[rel] = sha;
			next[rel] = { sha, size, mtime };
		}

		const prevFiles = this.latest()?.files ?? {};
		const changed = diffManifests(prevFiles, files);
		this.writeCache(next);
		if (isEmptyChange(changed)) return undefined;

		const c: VaultCheckpoint = {
			id: `${Date.now().toString(36)}-${hashOf(Buffer.from(JSON.stringify(files) + Math.random(), "utf8")).slice(0, 6)}`,
			ts: Date.now(),
			reason,
			files,
			changed,
		};
		mkdirSync(this.vaultDir, { recursive: true });
		appendFileSync(this.logFile, `${JSON.stringify(c)}\n`, "utf8");
		this.prune(KEEP_CHECKPOINTS);
		return c;
	}

	private writeCache(cache: Record<string, CacheEntry>): void {
		try {
			mkdirSync(this.vaultDir, { recursive: true });
			writeFileAtomic(this.cacheFile, `${JSON.stringify(cache)}\n`);
		} catch {
			/* 缓存写不动只影响下次的全量重算，不该让快照失败 */
		}
	}

	/**
	 * 只留最近 keep 条检查点，其余连对象一起回收。返回丢掉的条数。
	 * 当前盘上的文件一定在最后一条里（每条都是全量清单），所以现用对象不会被回收。
	 */
	prune(keep = KEEP_CHECKPOINTS): number {
		const all = this.list();
		if (all.length <= keep) return 0;
		const survivors = all.slice(all.length - keep);
		const live = new Set<string>();
		for (const c of survivors) for (const sha of Object.values(c.files)) live.add(sha);
		let dropped = 0;
		try {
			for (const name of readdirSync(this.objectsDir)) {
				if (live.has(name)) continue;
				rmSync(join(this.objectsDir, name), { force: true });
				dropped++;
			}
		} catch {
			/* 对象仓不存在＝本来就没有对象 */
		}
		writeFileAtomic(this.logFile, `${survivors.map((c) => JSON.stringify(c)).join("\n")}\n`);
		return all.length - keep;
	}

	/**
	 * 按检查点把受保护目录写回当时的样子：多出来的文件移回收站（不硬删），缺的/不一样的在原对象仓里取回。
	 * 变了就落一条新检查点（写回后状态与上一条相同＝没变，不落）。
	 *
	 * 先把整份清单的对象**全部取齐**再动盘：写到一半发现某个对象已过保留窗口，
	 * 会留下一个改了一半的素材库——那比不写回更糟。
	 */
	restore(id: string): VaultCheckpoint | undefined {
		const target = this.get(id);
		if (!target) throw new Error("没有这个快照。");
		const contents: Array<[string, Buffer]> = [];
		for (const [rel, sha] of Object.entries(target.files)) {
			try {
				contents.push([rel, this.readObject(sha)]);
			} catch {
				throw new Error(`快照里的 ${rel} 内容已不在对象仓（早于保留窗口），本次不写回。`);
			}
		}
		for (const rel of this.scanFiles()) {
			if (!(rel in target.files)) this.trashAsset(rel);
		}
		for (const [rel, buf] of contents) {
			const abs = join(this.cwd, rel);
			if (existsSync(abs)) {
				try {
					if (readFileSync(abs).equals(buf)) continue;
				} catch {
					/* 读不动就照写 */
				}
			}
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, buf);
		}
		return this.snapshot(`restore:${id}`);
	}

	// ---------------- 回收站 ----------------

	/**
	 * 把一个受保护文件移进回收站（唯一入口：用户明确删除、以及快照写回时清掉多出来的文件）。
	 * 只收受保护目录里的东西——这样还原端点写回去的位置必然是素材目录，不会被人改清单指到别处。
	 */
	trashAsset(target: string): TrashItem {
		const abs = isAbsolute(target) ? target : join(this.cwd, target);
		const rel = toPosix(relative(this.cwd, abs));
		if (!isProtectedPath(rel)) throw new Error(`不在受保护素材目录里，不进回收站：${rel}`);
		if (!insidePath(this.cwd, abs)) throw new Error(`路径越出项目根：${rel}`);
		const st = statSync(abs);
		mkdirSync(this.trashDir, { recursive: true });
		const stamp = stampOf(Date.now());
		const name = basename(abs);
		let file = `${stamp}-${name}`;
		for (let i = 2; existsSync(join(this.trashDir, file)); i++) file = `${stamp}-${i}-${name}`;
		moveFile(abs, join(this.trashDir, file));
		const item: TrashItem = { file, from: rel, ts: Date.now(), size: st.size };
		appendFileSync(this.trashLog, `${JSON.stringify(item)}\n`, "utf8");
		return item;
	}

	trashList(): TrashItemView[] {
		return readJsonl(this.trashLog, isTrashItem)
			.map((it) => ({ ...it, name: basename(it.from), present: existsSync(join(this.trashDir, it.file)) }))
			.sort((a, b) => b.ts - a.ts);
	}

	private writeTrashLog(items: TrashItem[]): void {
		mkdirSync(this.trashDir, { recursive: true });
		writeFileAtomic(this.trashLog, items.length ? `${items.map((i) => JSON.stringify(i)).join("\n")}\n` : "");
	}

	/** 还原一个回收站文件到原位（原位已有同名文件就拒绝，不覆盖用户现在的东西）。 */
	trashRestore(file: string): TrashItem {
		const items = readJsonl(this.trashLog, isTrashItem);
		const item = items.find((i) => i.file === file);
		if (!item) throw new Error("回收站里没有这个文件。");
		if (!isProtectedPath(item.from)) throw new Error(`回收站条目指向素材目录之外，拒绝还原：${item.from}`);
		const src = join(this.trashDir, file);
		if (!existsSync(src)) throw new Error("回收站里的文件本体已不在（可能被手动删了）。");
		const dest = join(this.cwd, item.from);
		if (existsSync(dest)) throw new Error(`原位置已有同名文件：${item.from}`);
		mkdirSync(dirname(dest), { recursive: true });
		moveFile(src, dest);
		this.writeTrashLog(items.filter((i) => i.file !== file));
		return item;
	}

	/** 真删（只由用户显式触发）。不给 file 就是清空回收站。返回删掉的文件数。 */
	trashPurge(file?: string): number {
		const items = readJsonl(this.trashLog, isTrashItem);
		const targets = file ? items.filter((i) => i.file === file) : items;
		if (file && targets.length === 0) throw new Error("回收站里没有这个文件。");
		for (const it of targets) {
			try {
				rmSync(join(this.trashDir, it.file), { force: true });
			} catch {
				/* 已经不在盘上了：照样把清单条目去掉 */
			}
		}
		this.writeTrashLog(file ? items.filter((i) => i.file !== file) : []);
		return targets.length;
	}
}

/** 一个项目一份（无状态、状态全在盘上；共用一份省得各处各 new 一个） */
const instances = new Map<string, AssetVault>();

export function assetVault(cwd: string): AssetVault {
	let v = instances.get(cwd);
	if (!v) {
		v = new AssetVault(cwd);
		instances.set(cwd, v);
	}
	return v;
}
