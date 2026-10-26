/**
 * 角色卡面板（两层结构）：第一层卡库列表 ⇄ 第二层当前卡详情（含角色卡工坊入口与右扩世界书选择）。
 * 点卡即切换并进详情；若卡含内嵌世界书，弹窗询问是否另存为独立世界书并挂载（ST 式配套导入）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiGetCacheClear,
	apiPost,
	apiPut,
	importCard,
	normalizeActiveLorebooks,
	type CardLibItem,
	type CardResponse,
	type CardsResponse,
	type LorebooksResponse,
	type RpConfigView,
} from "../api.ts";
import { IconBack, IconClose, IconEdit, IconGrid, IconList, IconLorebook, IconStar, IconUploads } from "./icons.tsx";
import { bumpWatchPanels, ConfirmButton, Field, PanelStatus, SearchInput, useAction, usePanelData } from "./kit.tsx";
import { t } from "../i18n/index.ts";

type CardSort = "recent" | "name" | "fav";
type CardView = "grid" | "list";

const cardImgUrl = (path: string) => `/api/cards/image?path=${encodeURIComponent(path)}`;

/** 刚导入、尚未回答「是否挂载内嵌世界书」的卡路径（再导入会重新标记） */
const LORE_PENDING_KEY = "liyuan.cards.lorePending";

function getLorePending(): Set<string> {
	try {
		const raw = JSON.parse(localStorage.getItem(LORE_PENDING_KEY) || "[]") as unknown;
		return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function setLorePending(paths: Set<string>) {
	localStorage.setItem(LORE_PENDING_KEY, JSON.stringify([...paths]));
}

function markLorePending(path: string) {
	const s = getLorePending();
	s.add(path);
	setLorePending(s);
}

function clearLorePending(path: string) {
	const s = getLorePending();
	if (!s.has(path)) return;
	s.delete(path);
	setLorePending(s);
}

function isLorePending(path: string) {
	return getLorePending().has(path);
}

// ---------- 详情视图：可编辑字段 ----------

function EditableSection({
	title,
	text,
	editable,
	onSave,
	open,
}: {
	title: string;
	text: string;
	editable: boolean;
	onSave: (v: string) => void;
	open?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	if (!text.trim() && !editable) return null;
	if (!text.trim() && !editing) {
		return (
			<button
				type="button"
				className="card-empty-field-btn"
				onClick={() => {
					setDraft("");
					setEditing(true);
				}}
				title={t("填写{title}", { title })}
			>
				{t("＋ {title}", { title })}
			</button>
		);
	}
	return (
		<details className="legacy-group" open={open || editing}>
			<summary>
				{title}
				{text ? t("（{n} 字）", { n: text.length }) : t("（空）")}
			</summary>
			{editing ? (
				<div className="skill-edit">
					<textarea className="panel-search ta" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
					<div className="panel-row">
						<button
							className="drawer-btn"
							onClick={() => {
								onSave(draft);
								setEditing(false);
							}}
						>
							{t("保存")}
						</button>
						<button className="drawer-btn" onClick={() => setEditing(false)}>
							{t("取消")}
						</button>
					</div>
				</div>
			) : (
				<>
					{text.trim() && <div className="longtext">{text}</div>}
					{editable && (
						<button
							className="act"
							onClick={() => {
								setDraft(text);
								setEditing(true);
							}}
						>
							{t("编辑")}
						</button>
					)}
				</>
			)}
		</details>
	);
}

function GreetingCard({
	index,
	label,
	text,
	selected,
	busy,
	total,
	onSelect,
	onSave,
	onDelete,
	onMove,
	canDelete,
}: {
	index: number;
	label: string;
	text: string;
	selected: boolean;
	busy: boolean;
	total: number;
	onSelect: () => void;
	onSave: (text: string) => void;
	onDelete: () => void;
	onMove: (delta: -1 | 1) => void;
	canDelete: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	useEffect(() => {
		if (!editing) setDraft(text);
	}, [text, editing]);

	const preview = text.trim() || t("（空）");
	const lines = preview.split("\n");
	const previewBlock = lines.slice(0, 3).join("\n") + (lines.length > 3 || preview.length > 180 ? "…" : "");
	const canUp = index > 0;
	const canDown = index < total - 1;

	return (
		<div className={`greeting-card ${selected ? "current" : ""} ${open ? "open" : ""}`}>
			<div className="greeting-card-head">
				<button type="button" className="greeting-pick" disabled={busy} onClick={onSelect} title={t("选为新会话开场白")}>
					<span className={`radio ${selected ? "on" : ""}`} />
					<span className="greeting-label">{label}</span>
					{selected && <span className="chip chip-cap">{t("选用")}</span>}
				</button>
				<span className="greeting-card-acts">
					<button
						type="button"
						className="act"
						disabled={busy || !canUp}
						title={t("上移")}
						aria-label={t("上移开场白")}
						onClick={() => onMove(-1)}
					>
						↑
					</button>
					<button
						type="button"
						className="act"
						disabled={busy || !canDown}
						title={t("下移")}
						aria-label={t("下移开场白")}
						onClick={() => onMove(1)}
					>
						↓
					</button>
					<button
						type="button"
						className="act"
						disabled={busy}
						onClick={() => {
							setOpen((v) => !v);
							setEditing(false);
						}}
					>
						{open ? t("收起") : t("展开")}
					</button>
					<button
						type="button"
						className="act"
						disabled={busy}
						onClick={() => {
							setOpen(true);
							setEditing(true);
							setDraft(text);
						}}
					>
						{t("编辑")}
					</button>
					{canDelete && (
						<ConfirmButton className="act" disabled={busy} confirmText={t("确认删除")} onConfirm={onDelete}>
							{t("删除")}
						</ConfirmButton>
					)}
				</span>
			</div>
			{!open && (
				<pre className="greeting-preview" onClick={() => setOpen(true)} title={t("点击展开")}>
					{previewBlock}
				</pre>
			)}
			{open && !editing && (
				<div className="greeting-body">
					<pre className="greeting-full">{text || t("（空）")}</pre>
				</div>
			)}
			{open && editing && (
				<div className="greeting-body">
					<textarea
						className="panel-search ta greeting-ta"
						rows={8}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						spellCheck={false}
					/>
					<div className="panel-row">
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy}
							onClick={() => {
								onSave(draft);
								setEditing(false);
							}}
						>
							{t("保存")}
						</button>
						<button
							type="button"
							className="drawer-btn"
							disabled={busy}
							onClick={() => {
								setDraft(text);
								setEditing(false);
							}}
						>
							{t("取消")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

type CardFrontInfo = {
	enabled: boolean;
	hasSkin: boolean;
	rules: unknown[];
	charName: string;
	userName: string;
};

function CardDetail({
	toast,
	cardPath,
	onBack,
	libItem,
	onDelete,
	onFrontChange,
	onOpenStudio,
	lorePickerOpen,
	onToggleLorePicker,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	cardPath: string | null;
	onBack: () => void;
	libItem: CardLibItem | undefined;
	onDelete: () => void;
	onFrontChange?: () => void;
	onOpenStudio?: () => void;
	lorePickerOpen?: boolean;
	onToggleLorePicker?: () => void;
}) {
	const cardUrl = cardPath ? `/api/card?path=${encodeURIComponent(cardPath)}` : "/api/card";
	const { data, error, loading, reload } = usePanelData(() => apiGet<CardResponse>(cardUrl), { cacheKey: cardUrl });
	const config = usePanelData(() => apiGet<{ config: RpConfigView }>("/api/config"), { cacheKey: "/api/config" });
	const lorebooks = usePanelData(() => apiGet<LorebooksResponse>("/api/lorebooks"), {
		cacheKey: "/api/lorebooks",
		watchAgent: true,
	});
	const activeLoreCount = useMemo(() => normalizeActiveLorebooks(lorebooks.data?.active ?? null).length, [lorebooks.data?.active]);
	const lockedLoreForCard = Boolean(lorebooks.data?.lockedForCard);
	const { busy, run } = useAction(toast);
	const fieldEditable = true;
	const [front, setFront] = useState<CardFrontInfo | null>(null);
	const frontPath = data?.path ? `/api/cardfront?card=${encodeURIComponent(data.path)}` : null;

	const [editingDisplay, setEditingDisplay] = useState(false);
	const [displayDraft, setDisplayDraft] = useState("");
	useEffect(() => {
		if (config.data) {
			setDisplayDraft(config.data.config.displayName ?? "");
		}
	}, [config.data]);

	useEffect(() => {
		if (!frontPath) {
			setFront(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const r = await apiGet<CardFrontInfo>(frontPath);
				if (!cancelled) setFront(r);
			} catch {
				if (!cancelled) setFront(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [frontPath, data?.name]);

	const toggleFront = (enabled: boolean) =>
		run(async () => {
			await apiPut<{ ok: boolean; enabled: boolean }>("/api/cardfront", { enabled });
			setFront((f) => (f ? { ...f, enabled } : f));
			onFrontChange?.();
		}, enabled ? t("已开启原卡界面美化") : t("已关闭原卡界面美化"));

	const saveField = (patch: Record<string, string>) =>
		run(async () => {
			await apiPut("/api/card", patch);
			apiGetCacheClear("/api/card");
			reload();
		}, t("已保存并重载会话"));

	const saveDisplayName = () =>
		run(async () => {
			await apiPut("/api/config", { displayName: displayDraft.trim() });
			setEditingDisplay(false);
			apiGetCacheClear("/api/card");
			config.reload();
			reload();
		}, t("已保存并重载会话"));

	const doExport = (format: "json" | "png") => {
		const url = `/api/card/export?format=${format}&lore=active`;
		const a = document.createElement("a");
		a.href = url;
		a.download = "";
		a.rel = "noopener";
		document.body.appendChild(a);
		a.click();
		a.remove();
		toast("info", format === "png" ? t("正在导出 PNG 角色卡…") : t("正在导出 JSON 角色卡…"));
	};

	const pickGreeting = (index: number) =>
		run(async () => {
			await apiPost("/api/greeting", { index, apply: true });
			apiGetCacheClear("/api/card");
			reload();
		}, t("开场白已更新"));

	const saveGreeting = (index: number, text: string) =>
		run(async () => {
			await apiPut("/api/card/greetings", { index, text });
			apiGetCacheClear("/api/card");
			reload();
		}, t("开场白已保存"));

	const addGreeting = () =>
		run(async () => {
			await apiPost("/api/card/greetings", { text: "" });
			apiGetCacheClear("/api/card");
			reload();
		}, t("已新建开场白"));

	const deleteGreeting = (index: number) =>
		run(async () => {
			await apiDelete(`/api/card/greetings?index=${index}`);
			apiGetCacheClear("/api/card");
			reload();
		}, t("已删除开场白"));

	const moveGreeting = (index: number, delta: -1 | 1) =>
		run(async () => {
			await apiPost("/api/card/greetings/move", { index, delta });
			apiGetCacheClear("/api/card");
			reload();
		});

	return (
		<div className="card-detail-scroll">
			<div className="card-detail-topbar">
				<button type="button" className="act back-btn" onClick={onBack}>
					<IconBack size={14} /> {t("返回卡库")}
				</button>
				{onOpenStudio && (
					<button
						type="button"
						className="rc-studio-btn"
						onClick={onOpenStudio}
						title={t("打开角色卡工坊")}
					>
						<IconEdit size={13} />
						<span>{t("角色卡工坊")}</span>
					</button>
				)}
			</div>
			<PanelStatus loading={loading} error={error} hasData={!!data} />
			{data && (
				<>
					<section className="sp-section">
						<div className="card-hero">
							{(libItem?.isPng || libItem?.hasCover) ? (
								<img className="card-hero-img" src={cardImgUrl(libItem.path)} alt={data.name} />
							) : (
								<div className="rc-hero-cover">
									<div className="rc-hero-seal">{(data.name || "？").slice(0, 1)}</div>
								</div>
							)}
							<div className="card-hero-info">
								<div className="model-current">{data.name}</div>
								{!editingDisplay ? (
									<div className="rc-display-row">
										<span className="rc-display-text">
											{data.displayName
												? t("显示名：{name}", { name: data.displayName })
												: `${t("显示名（可选）")}：${data.name}`}
										</span>
										<button
											type="button"
											className="rc-link-btn"
											onClick={() => {
												setDisplayDraft(config.data?.config.displayName ?? data.displayName ?? "");
												setEditingDisplay(true);
											}}
											title={t("仅界面显示；适用于卡名是剧本标题而非角色名的场景卡")}
										>
											{t("编辑")}
										</button>
									</div>
								) : (
									<div className="rc-display-edit">
										<input
											className="rc-inline-input"
											placeholder={t("留空使用卡名")}
											value={displayDraft}
											onChange={(e) => setDisplayDraft(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") void saveDisplayName();
												if (e.key === "Escape") setEditingDisplay(false);
											}}
										/>
										<button type="button" className="rc-btn rc-btn-primary" disabled={busy} onClick={() => void saveDisplayName()}>
											{t("保存")}
										</button>
										<button type="button" className="rc-btn" disabled={busy} onClick={() => setEditingDisplay(false)}>
											{t("取消")}
										</button>
									</div>
								)}
								<div className="field-hint">{data.path}</div>
							</div>
						</div>

						{onToggleLorePicker && (
							<button
								type="button"
								className={`rc-lore-entry-btn ${lorePickerOpen ? "active" : ""}`}
								style={{ marginBottom: 10 }}
								onClick={onToggleLorePicker}
								aria-expanded={lorePickerOpen}
							>
								<IconLorebook size={14} className="rc-lore-entry-icon" />
								<span className="rc-lore-entry-label">{t("世界书")}</span>
								<span className="rc-lore-entry-meta">
									{activeLoreCount > 0 ? t("已挂 {n} 本", { n: activeLoreCount }) : t("未挂载")}
								</span>
								{lockedLoreForCard && (
									<span className="rc-lore-locked-tag">{t("本卡已存")}</span>
								)}
								<span className="rc-lore-entry-action">
									{lorePickerOpen ? t("收起") : t("选择世界书")}
								</span>
							</button>
						)}

						<div className="panel-row card-actions-row" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
							<div className="card-export-group" style={{ display: "inline-flex", gap: 6 }}>
								<button type="button" className="drawer-btn" disabled={busy} onClick={() => doExport("json")}>
									{t("导出 JSON")}
								</button>
								<button type="button" className="drawer-btn" disabled={busy} onClick={() => doExport("png")}>
									{t("导出 PNG")}
								</button>
							</div>
							<button type="button" className="drawer-btn card-delete-btn" disabled={busy} onClick={onDelete} title={t("删除角色卡")}>
								{t("删除")}
							</button>
						</div>
						{front?.hasSkin && (
							<label className="cardfront-toggle field-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
								<input
									type="checkbox"
									checked={front.enabled}
									disabled={busy}
									onChange={(e) => void toggleFront(e.target.checked)}
								/>
								{t("原卡界面美化（卡作者的状态栏/界面样式）")}
							</label>
						)}
						<div className="field-hint">
							{t("导出含当前卡字段 + 活跃世界书（挂载书、本卡补充设定、原内嵌书合并去重）。PNG 保留立绘；纯 JSON 卡导出 PNG 时用占位图。")}
						</div>
						<EditableSection title={t("简介")} text={data.description} editable={fieldEditable} onSave={(v) => saveField({ description: v })} />
						<EditableSection title={t("性格")} text={data.personality} editable={fieldEditable} onSave={(v) => saveField({ personality: v })} />
						<EditableSection title={t("场景")} text={data.scenario} editable={fieldEditable} onSave={(v) => saveField({ scenario: v })} />
						<EditableSection title={t("作者注")} text={data.creatorNotes} editable={fieldEditable} onSave={(v) => saveField({ creatorNotes: v })} />
					</section>

					<section className="sp-section">
						<div className="greeting-sec-head">
							<h4>{t("开场白（{n}）", { n: data.greetings.length })}</h4>
							<button type="button" className="drawer-btn" disabled={busy} onClick={() => void addGreeting()}>
								{t("＋ 新建开场白")}
							</button>
						</div>
						<div className="field-hint">
							{t("点左侧圆点选用：若当前会话还没开聊会立刻换掉对话里的开场白；已开聊则记入下次新会话。↑↓ 调整顺序；可展开编辑。")}
						</div>
						{data.greetings.map((g) => (
							<GreetingCard
								key={`${g.index}-${g.text.slice(0, 24)}`}
								index={g.index}
								label={g.index === 0 ? t("默认开场白") : t("备选 {n}", { n: g.index })}
								text={g.text}
								selected={data.greetingIndex === g.index}
								busy={busy}
								total={data.greetings.length}
								onSelect={() => void pickGreeting(g.index)}
								onSave={(t) => void saveGreeting(g.index, t)}
								onDelete={() => void deleteGreeting(g.index)}
								onMove={(delta) => void moveGreeting(g.index, delta)}
								canDelete={data.greetings.length > 1}
							/>
						))}
					</section>
				</>
			)}
		</div>
	);
}

// ---------- 卡库视图 ----------

function CardItem({
	c,
	current,
	view,
	busy,
	onPick,
	onFav,
	onDelete,
}: {
	c: CardLibItem;
	current: boolean;
	view: CardView;
	busy: boolean;
	onPick: (c: CardLibItem) => void;
	onFav: (c: CardLibItem) => void;
	onDelete: (c: CardLibItem) => void;
}) {
	return (
		<div className={`card-item card-item-${view} ${current ? "current" : ""} ${c.fav ? "fav" : ""}`}>
			<button
				className="card-pick"
				disabled={busy}
				title={current ? t("当前使用中（点击进详情）") : t("切换到「{name}」并打开详情", { name: c.name })}
				onClick={() => onPick(c)}
			>
				{c.isPng || c.hasCover ? (
					<img className="card-thumb" src={cardImgUrl(c.path)} alt={c.name} loading="lazy" />
				) : (
					<span className="card-thumb card-thumb-json">JSON</span>
				)}
				<span className="card-name" title={c.name}>
					{c.name}
				</span>
			</button>
			<button
				className={`card-fav ${c.fav ? "on" : ""}`}
				title={c.fav ? t("取消收藏") : t("收藏并置顶")}
				aria-label={c.fav ? t("取消收藏") : t("收藏")}
				onClick={() => onFav(c)}
			>
				<IconStar size={14} filled={c.fav} />
			</button>
			{!current && (
				<button
					type="button"
					className="card-fav card-del"
					disabled={busy}
					title={t("删除这张卡…")}
					aria-label={t("删除角色卡「{name}」", { name: c.name })}
					onClick={() => onDelete(c)}
				>
					<IconClose size={13} />
				</button>
			)}
		</div>
	);
}

/** 配套世界书导入询问（ST 式） */
interface LorePromptItem {
	cardName: string;
	cardPath: string;
	entryCount: number;
	isCurrent?: boolean;
}

interface LorePrompt {
	items: LorePromptItem[];
}

export function CardLorePicker({
	toast,
	onClose,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	onClose: () => void;
}) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<LorebooksResponse>("/api/lorebooks"), {
		cacheKey: "/api/lorebooks",
		watchAgent: true,
	});
	const { busy, run } = useAction(toast);
	const [query, setQuery] = useState("");

	const active = useMemo(() => normalizeActiveLorebooks(data?.active ?? null), [data?.active]);
	const activeSet = useMemo(() => new Set(active), [active]);
	const lockedForCard = Boolean(data?.lockedForCard);

	const filteredBooks = useMemo(() => {
		const list = data?.books ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return list;
		return list.filter((b) => b.name.toLowerCase().includes(q) || b.path.toLowerCase().includes(q));
	}, [data?.books, query]);

	const toggleBook = (path: string) => {
		run(async () => {
			await apiPost("/api/lorebooks/select", { path });
			reload();
			bumpWatchPanels();
		});
	};

	const clearAll = () =>
		run(async () => {
			await apiPost("/api/lorebooks/select", { paths: [] });
			reload();
			bumpWatchPanels();
		}, t("已卸下全部世界书"));

	const toggleLockToCard = (checked: boolean) =>
		run(
			async () => {
				await apiPost("/api/lorebooks/select", { lockToCard: checked });
				reload();
				bumpWatchPanels();
			},
			checked ? t("已保存为本卡默认世界书") : t("已取消本卡默认世界书"),
		);

	return (
		<aside className="rc-lore-picker" aria-label={t("世界书选择")}>
			<div className="panel-head rc-lore-picker-head">
				<span className="panel-head-title">
					<IconLorebook size={15} />
					<span>{t("世界书选择")}</span>
				</span>
				<span className="panel-head-actions">
					<button
						type="button"
						className="icon-btn"
						onClick={onClose}
						title={t("关闭")}
						aria-label={t("关闭")}
					>
						<IconClose size={15} />
					</button>
				</span>
			</div>
			<div className="panel-body rc-lore-picker-body">
				<PanelStatus loading={loading} error={error} hasData={!!data} />
				{data && (
					<>
						<label className={`rc-lore-save-box ${lockedForCard ? "on" : ""}`}>
							<div className="rc-lore-save-row">
								<input
									type="checkbox"
									checked={lockedForCard}
									disabled={busy}
									onChange={(e) => void toggleLockToCard(e.target.checked)}
								/>
								<span className="rc-lore-save-title">{t("保存本卡世界书选择")}</span>
							</div>
							<div className="field-hint">
								{t("开启后记住当前勾选的世界书，下次打开这张卡时自动切换为这几本。")}
							</div>
						</label>

						<div className="rc-lore-toolbar">
							<SearchInput value={query} onChange={setQuery} placeholder={t("搜索世界书…")} />
							<div className="book-toolbar">
								<span className="lore-meta">{t("会话已挂 {n} 本", { n: active.length })}</span>
								{active.length > 0 && (
									<button type="button" className="act" disabled={busy} onClick={() => void clearAll()}>
										{t("全部卸下")}
									</button>
								)}
							</div>
						</div>

						{filteredBooks.length === 0 ? (
							<div className="sp-empty">
								{data.books.length === 0
									? t("还没有世界书——可以「＋ 新建」自己写，也可以导入 JSON")
									: t("此书无匹配条目。")}
							</div>
						) : (
							<div className="rc-lore-book-list">
								{filteredBooks.map((b) => {
									const mounted = activeSet.has(b.path);
									return (
										<button
											key={b.path}
											type="button"
											className={`rc-lore-book-item ${mounted ? "mounted" : ""}`}
											disabled={busy}
											onClick={() => toggleBook(b.path)}
										>
											<span className={`check ${mounted ? "on" : ""}`} aria-checked={mounted} role="checkbox" />
											<span className="rc-lore-book-name">{b.name}</span>
											<span className="lore-meta">{t("{n} 条条目", { n: b.entryCount })}</span>
											{mounted && <span className="lore-meta book-mounted-tag">{t("已挂")}</span>}
										</button>
									);
								})}
							</div>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

export function CardPanel({
	toast,
	onEnterChat,
	onGoHome,
	active = true,
	onFrontChange,
	onOpenStudio,
	lorePickerOpen,
	onToggleLorePicker,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	onEnterChat?: () => void;
	onGoHome?: () => void;
	active?: boolean;
	onFrontChange?: () => void;
	onOpenStudio?: () => void;
	lorePickerOpen?: boolean;
	onToggleLorePicker?: () => void;
}) {
	const lib = usePanelData(() => apiGet<CardsResponse>("/api/cards"), { cacheKey: "/api/cards" });
	const { busy, run } = useAction(toast);
	const [detail, setDetail] = useState(true);
	const [lorePrompt, setLorePrompt] = useState<LorePrompt | null>(null);
	const [importLore, setImportLore] = useState(true);

	const openLorePrompt = (items: LorePromptItem[]) => {
		setImportLore(true);
		setLorePrompt({ items });
	};
	const [deletePrompt, setDeletePrompt] = useState<CardLibItem | null>(null);
	const [delLore, setDelLore] = useState(false);
	const [delData, setDelData] = useState(false);
	const [currentPath, setCurrentPath] = useState<string | null>(null);
	const wasActive = useRef(active);

	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<CardSort>(() => (localStorage.getItem("liyuan.cards.sort") as CardSort) || "recent");
	const [view, setView] = useState<CardView>(() => (localStorage.getItem("liyuan.cards.view") as CardView) || "list");
	const fileRef = useRef<HTMLInputElement>(null);
	const [importing, setImporting] = useState(false);
	const [pathInput, setPathInput] = useState("");
	const [creating, setCreating] = useState(false);
	const [newCardName, setNewCardName] = useState("");
	const [newFirstMes, setNewFirstMes] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const canCreateCard = newCardName.trim().length > 0 && newFirstMes.trim().length > 0;

	useEffect(() => {
		if (lib.data?.current) setCurrentPath(lib.data.current);
	}, [lib.data?.current]);

	useEffect(() => {
		const opened = active && !wasActive.current;
		wasActive.current = active;
		if (!opened) return;
		const cur = currentPath ?? lib.data?.current;
		if (cur) setDetail(true);
	}, [active, currentPath, lib.data?.current]);

	const setSortP = (s: CardSort) => {
		setSort(s);
		localStorage.setItem("liyuan.cards.sort", s);
	};
	const setViewP = (v: CardView) => {
		setView(v);
		localStorage.setItem("liyuan.cards.view", v);
	};

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		let list = (lib.data?.cards ?? []).filter(
			(c) => !q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)),
		);
		list = [...list].sort((a, b) => {
			if (a.fav !== b.fav) return a.fav ? -1 : 1;
			if (sort === "name") return a.name.localeCompare(b.name);
			return b.mtimeMs - a.mtimeMs;
		});
		return list;
	}, [lib.data, query, sort]);

	const effectiveCurrent = currentPath ?? lib.data?.current ?? null;
	const currentLibItem = lib.data?.cards.find((c) => c.path === effectiveCurrent);

	const afterCardReady = (info: { name: string; path: string; embeddedLoreCount: number }) => {
		apiGetCacheClear("/api/card");
		setCurrentPath(info.path);
		bumpWatchPanels();
		if (info.embeddedLoreCount > 0 && isLorePending(info.path)) {
			openLorePrompt([
				{
					cardName: info.name,
					cardPath: info.path,
					entryCount: info.embeddedLoreCount,
					isCurrent: true,
				},
			]);
		} else {
			if (info.embeddedLoreCount === 0) clearLorePending(info.path);
			setDetail(true);
		}
	};

	const skipLoreImport = () => {
		if (lorePrompt) {
			for (const it of lorePrompt.items) {
				clearLorePending(it.cardPath);
			}
		}
		setLorePrompt(null);
		setDetail(true);
	};

	const confirmLoreImport = (mountCurrent: boolean) =>
		run(async () => {
			if (!lorePrompt || lorePrompt.items.length === 0) return;
			const items = lorePrompt.items;
			const r = await apiPost<{
				ok: true;
				results?: Array<{ path: string; entryCount: number; name: string; mounted: boolean }>;
			}>("/api/card/import-embedded-lore", {
				cards: items.map((it) => ({
					card: it.cardPath,
					mount: mountCurrent && (it.isCurrent || items.length === 1),
				})),
			});
			for (const it of items) {
				clearLorePending(it.cardPath);
			}
			setLorePrompt(null);
			setDetail(true);
			bumpWatchPanels();
			const mountedItem = r.results?.find((x) => x.mounted);
			if (mountedItem?.path) {
				try {
					sessionStorage.setItem("liyuan.lore.focus", mountedItem.path);
				} catch {
					/* ignore */
				}
			}
		}, mountCurrent ? t("配套世界书已导入并加入挂载") : t("配套世界书已导入（未挂载）"));

	const pick = (c: CardLibItem) => {
		if (c.path === effectiveCurrent) {
			setDetail(true);
			return;
		}
		void run(async () => {
			const r = await apiPost<{ name: string; path: string; embeddedLoreCount: number; promoted?: boolean }>("/api/card/switch", {
				card: c.path,
				switchSession: false,
			});
			if (r.promoted) lib.reload();
			afterCardReady({
				name: r.name,
				path: r.path ?? c.path,
				embeddedLoreCount: r.embeddedLoreCount ?? 0,
			});
		});
	};

	const switchByPath = (p: string) =>
		run(async () => {
			const r = await apiPost<{ name: string; path: string; embeddedLoreCount: number; promoted?: boolean }>("/api/card/switch", {
				card: p,
				switchSession: false,
			});
			if (r.promoted) lib.reload();
			afterCardReady({
				name: r.name,
				path: r.path ?? p,
				embeddedLoreCount: r.embeddedLoreCount ?? 0,
			});
		});

	const fav = (c: CardLibItem) =>
		run(async () => {
			await apiPost("/api/cards/fav", { path: c.path, fav: !c.fav });
			lib.reload();
		});

	const del = (c: CardLibItem) => {
		setDelLore(false);
		setDelData(false);
		setDeletePrompt(c);
	};

	const confirmDelete = () =>
		run(async () => {
			if (!deletePrompt) return;
			const c = deletePrompt;
			const wasCurrent = c.path === effectiveCurrent;
			const qs = `path=${encodeURIComponent(c.path)}${delLore ? "&lore=1" : ""}${delData ? "&data=1" : ""}`;
			const r = await apiDelete<{ ok: boolean; switchedTo: string | null }>(`/api/cards?${qs}`);
			setDeletePrompt(null);
			clearLorePending(c.path);
			if (wasCurrent) {
				setCurrentPath(r.switchedTo ?? null);
				setDetail(false);
				onGoHome?.();
			}
			lib.reload();
			bumpWatchPanels();
		}, delData ? t("已删除「{name}」", { name: deletePrompt?.name ?? "" }) : t("已删除「{name}」（数据保留，重新导入可续玩）", { name: deletePrompt?.name ?? "" }));

	const doCreateCard = () =>
		run(async () => {
			const name = newCardName.trim();
			const firstMes = newFirstMes.trim();
			if (!name) throw new Error(t("请先填卡名"));
			if (!firstMes) throw new Error(t("请写开场白——新会话的首条消息"));
			await apiPost<{ name: string; path: string }>("/api/cards", {
				name,
				firstMes,
				...(newDesc.trim() ? { description: newDesc.trim() } : {}),
			});
			setCreating(false);
			setNewCardName("");
			setNewFirstMes("");
			setNewDesc("");
			lib.reload();
			bumpWatchPanels();
		});

	const doImport = async (files: FileList | File[]) => {
		setImporting(true);
		try {
			let last: { name: string; path: string; embeddedLoreCount: number } | null = null;
			const withLore: LorePromptItem[] = [];
			for (const f of Array.from(files)) {
				try {
					const r = await importCard(f);
					toast("info", t("已导入「{name}」", { name: r.name }));
					if ((r.embeddedLoreCount ?? 0) > 0) {
						markLorePending(r.path);
						withLore.push({
							cardName: r.name,
							cardPath: r.path,
							entryCount: r.embeddedLoreCount!,
						});
					}
					last = {
						name: r.name,
						path: r.path,
						embeddedLoreCount: r.embeddedLoreCount ?? 0,
					};
				} catch (e) {
					toast("error", t("「{name}」导入失败：{err}", { name: f.name, err: e instanceof Error ? e.message : String(e) }));
				}
			}
			lib.reload();
			if (last) {
				void run(async () => {
					const r = await apiPost<{ name: string; path: string; embeddedLoreCount: number; promoted?: boolean }>("/api/card/switch", {
						card: last!.path,
						switchSession: false,
					});
					if (r.promoted) lib.reload();
					const path = r.path ?? last!.path;
					markLorePending(path);
					if (path !== last!.path) markLorePending(last!.path);
					setCurrentPath(path);
					apiGetCacheClear("/api/card");
					bumpWatchPanels();
					if (withLore.length > 0) {
						openLorePrompt(
							withLore.map((it) => ({
								...it,
								isCurrent: it.cardPath === path || it.cardPath === last!.path,
							})),
						);
					} else {
						setDetail(true);
					}
				});
			}
		} finally {
			setImporting(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const loreModal = lorePrompt && lorePrompt.items.length > 0 && (() => {
		const items = lorePrompt.items;
		const totalEntries = items.reduce((sum, it) => sum + it.entryCount, 0);
		const currentItem = items.find((it) => it.isCurrent) ?? items[items.length - 1];

		return (
			<div className="card-lore-modal" role="dialog" aria-modal="true" aria-labelledby="card-lore-title">
				<div className="card-lore-dialog">
					<button
						type="button"
						className="icon-btn card-lore-x"
						title={t("关闭")}
						aria-label={t("关闭")}
						onClick={skipLoreImport}
					>
						<IconClose size={18} />
					</button>
					<h3 id="card-lore-title">{t("配套世界书")}</h3>
					{items.length === 1 ? (
						<p>
							{t("角色卡「{name}」打包了配套世界书 {n} 条。", { name: items[0].cardName, n: items[0].entryCount })}
							<br />
							{t("世界书导入后可在世界书面板管理，也可随时挂载到对话。")}
						</p>
					) : (
						<p>
							{t("本次导入有 {cards} 张角色卡包含配套世界书（共 {entries} 条）：", { cards: items.length, entries: totalEntries })}
							<br />
							<span style={{ fontSize: "12.5px", color: "var(--text-soft)" }}>
								{items.map((it) => t("「{name}」（{n} 条）", { name: it.cardName, n: it.entryCount })).join(t("、"))}
							</span>
						</p>
					)}

					<label className="card-del-opt" style={{ margin: "14px 0 16px" }}>
						<input
							type="checkbox"
							checked={importLore}
							onChange={(e) => setImportLore(e.target.checked)}
						/>
						<span>{items.length > 1 ? t("导入配套世界书（{books} 本，共 {entries} 条）", { books: items.length, entries: totalEntries }) : t("导入配套世界书")}</span>
					</label>

					<div className="panel-row card-lore-actions">
						{importLore ? (
							<>
								<button
									type="button"
									className="drawer-btn save-btn"
									disabled={busy}
									onClick={() => void confirmLoreImport(true)}
								>
									{items.length > 1
										? t("全部导入，并挂载「{name}」", { name: currentItem.cardName })
										: t("导入并挂载")}
								</button>
								<button
									type="button"
									className="drawer-btn"
									disabled={busy}
									onClick={() => void confirmLoreImport(false)}
								>
									{t("导入但暂不挂载")}
								</button>
							</>
						) : (
							<button
								type="button"
								className="drawer-btn"
								disabled={busy}
								onClick={skipLoreImport}
							>
								{t("不导入世界书")}
							</button>
						)}
					</div>
				</div>
			</div>
		);
	})();

	const deleteModal = deletePrompt && (
		<div className="card-lore-modal" role="dialog" aria-modal="true" aria-labelledby="card-del-title">
			<div className="card-lore-dialog">
				<button type="button" className="icon-btn card-lore-x" title={t("取消")} aria-label={t("关闭")} onClick={() => setDeletePrompt(null)}>
					<IconClose size={18} />
				</button>
				<h3 id="card-del-title">{t("删除角色卡「{name}」？", { name: deletePrompt.name })}</h3>
				<p>
					{deletePrompt.path === effectiveCurrent ? t("卡片文件将从卡库移除；这是当前对话中的卡，删除后将回到主页。") : t("卡片文件将从卡库移除。")}
				</p>
				<label className="card-del-opt">
					<input type="checkbox" checked={delLore} onChange={(e) => setDelLore(e.target.checked)} />
					{t("同时删除配套世界书（以这张卡命名导入的书）")}
				</label>
				<label className="card-del-opt">
					<input type="checkbox" checked={delData} onChange={(e) => setDelData(e.target.checked)} />
					{t("同时删除相关数据（该卡全部会话记录与补充设定）")}
				</label>
				<p className="field-hint">{t("不勾「相关数据」时数据保留在本机：日后重新导入同一张卡，会话与设定无缝衔接。")}</p>
				<div className="panel-row card-lore-actions">
					<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void confirmDelete()}>
						{t("删除")}
					</button>
					<button type="button" className="drawer-btn" disabled={busy} onClick={() => setDeletePrompt(null)}>
						{t("取消")}
					</button>
				</div>
			</div>
		</div>
	);

	// 卡库与详情同挂载：返回仓库时不卸载封面 DOM，避免重新请求图片
	return (
		<div
			className="panel-body"
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => {
				e.preventDefault();
				if (e.dataTransfer.files.length > 0) void doImport(e.dataTransfer.files);
			}}
		>
			{loreModal}
			{deleteModal}
			<div className="card-lib-pane" hidden={detail} style={detail ? { display: "none" } : undefined}>
				<PanelStatus loading={lib.loading} error={lib.error} hasData={!!lib.data} />
				{lib.data && (
					<section className="sp-section">
						{currentLibItem && (
							<button
								type="button"
								className="current-card-banner"
								onClick={() => {
									onEnterChat?.();
									setDetail(true);
								}}
								title={t("打开当前卡详情并进入对话")}
							>
								{currentLibItem.isPng || currentLibItem.hasCover ? (
									<img className="card-thumb" src={cardImgUrl(currentLibItem.path)} alt={currentLibItem.name} />
								) : (
									<span className="card-thumb card-thumb-json">JSON</span>
								)}
								<span className="current-card-info">
									<span className="current-card-label">{t("当前使用")}</span>
									<span className="current-card-name">{currentLibItem.name}</span>
								</span>
								<span className="act">{t("详情 ›")}</span>
							</button>
						)}

						<SearchInput value={query} onChange={setQuery} placeholder={t("搜索卡名 / 标签…")} />
						<div className="panel-row list-toolbar">
							<select className="panel-search" value={sort === "fav" ? "recent" : sort} onChange={(e) => setSortP(e.target.value as CardSort)} aria-label={t("排序方式")}>
								<option value="recent">{t("最近修改")}</option>
								<option value="name">{t("按名字")}</option>
							</select>
							<button
								className="drawer-btn"
								title={view === "grid" ? t("切换到列表视图") : t("切换到网格视图")}
								aria-label={t("切换视图")}
								onClick={() => setViewP(view === "grid" ? "list" : "grid")}
							>
								{view === "grid" ? <IconList size={14} /> : <IconGrid size={14} />}
							</button>
							<button
								className="drawer-btn"
								title={t("自己新建一张角色卡（不必先有酒馆卡）")}
								onClick={() => setCreating((v) => !v)}
							>
								{t("＋ 新建卡")}
							</button>
							<button className="drawer-btn" disabled={importing} onClick={() => fileRef.current?.click()}>
								<IconUploads size={13} /> {importing ? t("导入中…") : t("导入卡")}
							</button>
							<input
								ref={fileRef}
								type="file"
								accept=".png,.json"
								multiple
								hidden
								onChange={(e) => {
									if (e.target.files?.length) void doImport(e.target.files);
								}}
							/>
						</div>
						{creating && (
							<div className="lore-edit" onClick={(ev) => ev.stopPropagation()}>
								<Field label={t("卡名")} hint={t("也是文件名；建完不会自动切换，去库里点开")}>
									<input
										className="panel-search"
										autoFocus
										value={newCardName}
										placeholder={t("例：青梧")}
										onChange={(ev) => setNewCardName(ev.target.value)}
										onKeyDown={(ev) => {
											if (ev.key === "Escape") setCreating(false);
										}}
									/>
								</Field>
								<Field label={t("开场白")} hint={t("必填——新会话的首条消息，没有它开不了场")}>
									<textarea
										className="panel-search"
										rows={3}
										value={newFirstMes}
										placeholder={t("她抬头看了你一眼，把茶碗往你那边推了推。")}
										onChange={(ev) => setNewFirstMes(ev.target.value)}
									/>
								</Field>
								<Field label={t("描述（选填）")} hint={t("性格/场景/对白示例等建完在详情里补")}>
									<textarea
										className="panel-search"
										rows={2}
										value={newDesc}
										placeholder={t("外貌、身份、背景…")}
										onChange={(ev) => setNewDesc(ev.target.value)}
									/>
								</Field>
								<div className="panel-row" style={{ marginTop: 6 }}>
									<button className="drawer-btn" disabled={busy || !canCreateCard} onClick={() => void doCreateCard()}>
										{t("新建")}
									</button>
									<button className="drawer-btn" onClick={() => setCreating(false)}>
										{t("取消")}
									</button>
								</div>
							</div>
						)}
						{shown.length === 0 && <div className="sp-empty">{t("没有匹配的卡。把 PNG/JSON 角色卡拖进面板即可导入。")}</div>}
						<div className={view === "grid" ? "card-grid" : "card-list"}>
							{shown.map((c) => (
								<CardItem
									key={c.path}
									c={c}
									current={c.path === effectiveCurrent}
									view={view}
									busy={busy}
									onPick={pick}
									onFav={fav}
									onDelete={del}
								/>
							))}
						</div>
						<div className="field-hint">{t("点卡即切换会话、进入对话，并在侧栏打开详情。返回卡库时封面不重载。")}</div>

						<details className="legacy-group">
							<summary>{t("按路径换卡（卡库扫不到的位置）")}</summary>
							<Field label={t("角色卡路径（.png / .json，相对 app/ 或绝对路径）")}>
								<input
									className="panel-search"
									placeholder="assets/cards/xxx.png"
									value={pathInput}
									onChange={(e) => setPathInput(e.target.value)}
								/>
							</Field>
							<button
								className="drawer-btn"
								disabled={busy || !pathInput.trim()}
								onClick={() => {
									void switchByPath(pathInput.trim());
									setPathInput("");
								}}
							>
								{t("切换角色卡")}
							</button>
						</details>
					</section>
				)}
			</div>
			{detail && (
				<div className="card-detail-pane">
					<CardDetail
						toast={toast}
						cardPath={effectiveCurrent}
						onBack={() => {
							if (lorePickerOpen) onToggleLorePicker?.();
							setDetail(false);
						}}
						libItem={currentLibItem}
						onDelete={() => {
							if (currentLibItem) del(currentLibItem);
						}}
						onFrontChange={onFrontChange}
						onOpenStudio={onOpenStudio}
						lorePickerOpen={lorePickerOpen}
						onToggleLorePicker={onToggleLorePicker}
					/>
				</div>
			)}
		</div>
	);
}
