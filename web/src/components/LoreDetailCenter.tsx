import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, type LoreEntryPatchBody, type LoreEntryView } from "../api.ts";
import { bumpWatchPanels, ConfirmButton, Field, Toggle, useAction } from "./kit.tsx";
import { IconClose } from "./icons.tsx";
import { t } from "../i18n/index.ts";

function parseKeyLine(s: string): string[] {
	return s
		.split(/[,，、\n]+/)
		.map((k) => k.trim())
		.filter(Boolean);
}

export interface LoreDetailCenterProps {
	entry: LoreEntryView;
	scopePath: string;
	bookName?: string;
	onClose: () => void;
	toast: (level: "info" | "warning" | "error", text: string) => void;
}

export function LoreDetailCenter({
	entry: initialEntry,
	scopePath,
	bookName,
	onClose,
	toast,
}: LoreDetailCenterProps) {
	const [entry, setEntry] = useState<LoreEntryView>(initialEntry);
	const [fullContent, setFullContent] = useState<string | null>(null);
	const [loadingContent, setLoadingContent] = useState(false);
	const [editing, setEditing] = useState(false);
	const { busy, run } = useAction(toast);

	// 编辑草稿状态
	const [draftComment, setDraftComment] = useState(entry.comment);
	const [draftOrder, setDraftOrder] = useState(String(entry.order));
	const [draftConstant, setDraftConstant] = useState(entry.constant);
	const [draftSelective, setDraftSelective] = useState(entry.selective);
	const [draftKeys, setDraftKeys] = useState(entry.keys.join("、"));
	const [draftSec, setDraftSec] = useState(entry.secondaryKeys.join("、"));
	const [draftContent, setDraftContent] = useState("");

	// 当外界选中新条目时同步
	useEffect(() => {
		setEntry(initialEntry);
		setDraftComment(initialEntry.comment);
		setDraftOrder(String(initialEntry.order));
		setDraftConstant(initialEntry.constant);
		setDraftSelective(initialEntry.selective);
		setDraftKeys(initialEntry.keys.join("、"));
		setDraftSec(initialEntry.secondaryKeys.join("、"));
		setEditing(false);
		setFullContent(null);
	}, [initialEntry.fingerprint]);

	// 惰性加载全文
	useEffect(() => {
		let cancelled = false;
		setLoadingContent(true);
		apiGet<{ content: string }>(`/api/lorebook/entry?fp=${encodeURIComponent(entry.fingerprint)}`)
			.then((r) => {
				if (!cancelled) setFullContent(r.content);
			})
			.catch(() => {
				if (!cancelled) setFullContent(entry.preview);
			})
			.finally(() => {
				if (!cancelled) setLoadingContent(false);
			});
		return () => {
			cancelled = true;
		};
	}, [entry.fingerprint]);

	// 监听 Esc 键关闭
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (editing) setEditing(false);
				else onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editing, onClose]);

	// 启停条目
	const handleToggle = (enabled: boolean) => {
		run(async () => {
			await apiPost("/api/lorebook/toggle", { fingerprint: entry.fingerprint, enabled });
			setEntry((prev) => ({ ...prev, enabled }));
			bumpWatchPanels();
		}, enabled ? t("已启用该条目") : t("已停用该条目"));
	};

	// 切换常驻/关键词灯
	const handleFlipLight = () => {
		if (!entry.enabled) return;
		const nextConstant = !entry.constant;
		run(async () => {
			await apiPut("/api/lorebook/entry", { fingerprint: entry.fingerprint, constant: nextConstant });
			setEntry((prev) => ({ ...prev, constant: nextConstant }));
			setDraftConstant(nextConstant);
			bumpWatchPanels();
		}, nextConstant ? t("已改为蓝灯（常驻）") : t("已改为绿灯（关键词触发）"));
	};

	// 开启编辑
	const startEdit = () => {
		setDraftContent(fullContent ?? entry.preview);
		setDraftComment(entry.comment);
		setDraftOrder(String(entry.order));
		setDraftConstant(entry.constant);
		setDraftSelective(entry.selective);
		setDraftKeys(entry.keys.join("、"));
		setDraftSec(entry.secondaryKeys.join("、"));
		setEditing(true);
	};

	// 保存编辑
	const saveEdit = () => {
		const orderNum = Number.parseInt(draftOrder, 10);
		const keys = parseKeyLine(draftKeys);
		const secondaryKeys = parseKeyLine(draftSec);
		const patchBody: LoreEntryPatchBody = {
			fingerprint: entry.fingerprint,
			comment: draftComment.trim(),
			order: Number.isFinite(orderNum) ? orderNum : entry.order,
			constant: draftConstant,
			selective: draftSelective && secondaryKeys.length > 0,
			keys,
			secondaryKeys,
			content: draftContent,
		};

		run(async () => {
			await apiPut("/api/lorebook/entry", patchBody);
			setFullContent(draftContent);
			setEntry((prev) => ({
				...prev,
				comment: draftComment.trim(),
				order: patchBody.order ?? prev.order,
				constant: draftConstant,
				selective: patchBody.selective ?? prev.selective,
				keys,
				secondaryKeys,
				chars: draftContent.length,
				preview: draftContent.slice(0, 200),
			}));
			setEditing(false);
			bumpWatchPanels();
		}, t("条目已保存"));
	};

	// 删除条目
	const handleDelete = () => {
		run(async () => {
			await apiDelete(`/api/lorebook/entry?fp=${encodeURIComponent(entry.fingerprint)}&path=${encodeURIComponent(scopePath)}`);
			bumpWatchPanels();
			onClose();
		}, t("条目已删除"));
	};

	const titleText = entry.comment || entry.keys[0] || t("（未命名条目）");

	return (
		<div className="lore-center-overlay" role="dialog" aria-modal="true" aria-label={titleText}>
			<div className="lore-center-card">
				{/* 顶栏 Header */}
				<div className="lore-center-head">
					<div className="lore-center-title-group">
						<button
							type="button"
							className={`lore-light lore-light-${!entry.enabled ? "off" : entry.constant ? "blue" : "green"}`}
							title={entry.constant ? t("蓝灯 · 常驻（点击切换）") : t("绿灯 · 关键词触发（点击切换）")}
							disabled={busy || !entry.enabled}
							onClick={handleFlipLight}
						/>
						<div className="lore-center-title-texts">
							{bookName && <span className="lore-center-book-tag">{bookName}</span>}
							<h3 className="lore-center-title">{titleText}</h3>
						</div>
						<span className="lore-center-chars-tag">{t("{n} 字", { n: entry.chars })}</span>
					</div>

					<div className="lore-center-actions">
						<Toggle
							checked={entry.enabled}
							disabled={busy}
							title={entry.enabled ? t("停用条目") : t("启用条目")}
							onChange={handleToggle}
						/>
						{!editing ? (
							<button type="button" className="drawer-btn" disabled={busy} onClick={startEdit}>
								{t("编辑")}
							</button>
						) : (
							<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={saveEdit}>
								{t("保存")}
							</button>
						)}
						{editing && (
							<button type="button" className="drawer-btn" disabled={busy} onClick={() => setEditing(false)}>
								{t("取消")}
							</button>
						)}
						<button
							type="button"
							className="icon-btn lore-center-close"
							onClick={onClose}
							title={t("关闭（Esc）")}
							aria-label={t("关闭详情")}
						>
							<IconClose size={18} />
						</button>
					</div>
				</div>

				{/* 属性胶囊 Bar */}
				<div className="lore-center-props">
					<span className="lore-center-prop-pill">
						{entry.constant ? t("类型：蓝灯常驻") : t("类型：绿灯关键词")}
					</span>
					<span className="lore-center-prop-pill">
						{t("优先级：#{order}", { order: entry.order })}
					</span>
					{entry.keys.length > 0 && (
						<div className="lore-center-keys">
							<span className="lore-center-key-label">{t("主关键词：")}</span>
							{entry.keys.map((k, i) => (
								<span key={i} className="lore-center-key-chip">{k}</span>
							))}
						</div>
					)}
					{entry.selective && entry.secondaryKeys.length > 0 && (
						<div className="lore-center-keys">
							<span className="chip chip-selective">AND</span>
							<span className="lore-center-key-label">{t("次要关键词：")}</span>
							{entry.secondaryKeys.map((k, i) => (
								<span key={i} className="lore-center-key-chip">{k}</span>
							))}
						</div>
					)}
				</div>

				{/* 主体正文区 */}
				<div className="lore-center-body">
					{!editing ? (
						<div className="lore-center-viewer">
							{loadingContent && fullContent === null ? (
								<div className="sp-empty">{t("读取正文中…")}</div>
							) : (
								<div className="lore-center-prose">{fullContent ?? entry.preview}</div>
							)}
							<div className="lore-center-footer-bar">
								<button type="button" className="drawer-btn" disabled={busy} onClick={startEdit}>
									{t("编辑此条目")}
								</button>
								<ConfirmButton disabled={busy} confirmText={t("确认彻底删除此条目？")} onConfirm={handleDelete}>
									{t("删除条目")}
								</ConfirmButton>
							</div>
						</div>
					) : (
						<div className="lore-center-editor">
							<div className="lore-center-edit-grid">
								<Field label={t("标题（comment）")}>
									<input
										className="panel-search"
										value={draftComment}
										placeholder={t("条目标题…")}
										onChange={(ev) => setDraftComment(ev.target.value)}
									/>
								</Field>
								<div className="panel-row lore-edit-row">
									<Field label={t("类型")}>
										<select
											className="panel-search"
											value={draftConstant ? "constant" : "keyed"}
											onChange={(ev) => setDraftConstant(ev.target.value === "constant")}
										>
											<option value="constant">{t("蓝灯 · 常驻")}</option>
											<option value="keyed">{t("绿灯 · 关键词")}</option>
										</select>
									</Field>
									<Field label={t("优先级 order")} hint={t("越小越靠前")}>
										<input
											className="panel-search lore-order-input"
											type="number"
											min={0}
											max={9999}
											value={draftOrder}
											onChange={(ev) => setDraftOrder(ev.target.value)}
										/>
									</Field>
								</div>
								{!draftConstant && (
									<>
										<Field label={t("主关键词")} hint={t("逗号 / 顿号分隔")}>
											<input
												className="panel-search"
												value={draftKeys}
												placeholder={t("如：南京、玄武湖")}
												onChange={(ev) => setDraftKeys(ev.target.value)}
											/>
										</Field>
										<Field label={t("次要关键词")} hint={t("可选；勾选 AND 后需同时命中")}>
											<input
												className="panel-search"
												value={draftSec}
												onChange={(ev) => setDraftSec(ev.target.value)}
											/>
										</Field>
										<label className="lore-check">
											<input
												type="checkbox"
												checked={draftSelective}
												onChange={(ev) => setDraftSelective(ev.target.checked)}
												disabled={parseKeyLine(draftSec).length === 0}
											/>
											{t("次要关键词也要同时命中（selective / AND）")}
										</label>
									</>
								)}
								{draftConstant && (
									<Field label={t("关键词（可选，供检索）")}>
										<input
											className="panel-search"
											value={draftKeys}
											onChange={(ev) => setDraftKeys(ev.target.value)}
										/>
									</Field>
								)}
								<Field label={t("正文内容")}>
									<textarea
										className="panel-search lore-center-textarea"
										value={draftContent}
										rows={16}
										onChange={(ev) => setDraftContent(ev.target.value)}
									/>
								</Field>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
