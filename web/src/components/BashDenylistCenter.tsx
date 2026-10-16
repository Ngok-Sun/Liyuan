import { useEffect, useState } from "react";
import { apiGet, apiPut } from "../api.ts";
import { useAction } from "./kit.tsx";
import { IconClose } from "./icons.tsx";
import { t } from "../i18n/index.ts";

/** GET /api/bash-denylist（docs/PLAN-AGENT-BACK-TO-PI.md §二） */
interface BashDenylistView {
	path: string;
	content: string;
	rules: string[];
}

export interface BashDenylistCenterProps {
	onClose: () => void;
	toast: (level: "info" | "warning" | "error", text: string) => void;
}

/** 命令黑名单：设置 → agent 行为 →「后端操控」下面的入口，在中间栏展开编辑 */
export function BashDenylistCenter({ onClose, toast }: BashDenylistCenterProps) {
	const [path, setPath] = useState("");
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [dirty, setDirty] = useState(false);
	const { busy, run } = useAction(toast);

	useEffect(() => {
		let cancelled = false;
		void apiGet<BashDenylistView>("/api/bash-denylist")
			.then((data) => {
				if (cancelled) return;
				setPath(data.path);
				setText(data.content);
				setLoaded(true);
			})
			.catch((err) => toast("error", err instanceof Error ? err.message : String(err)));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const save = () =>
		run(async () => {
			await apiPut("/api/bash-denylist", { content: text });
			setDirty(false);
		}, t("命令黑名单已保存，下一拍生效"));

	// 规则数实时预览（与后端同一口径：非注释、非空行）
	const count = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;

	return (
		<div className="lore-center-overlay" role="dialog" aria-modal="true" aria-label={t("命令黑名单")}>
			<div className="lore-center-card">
				<div className="lore-center-head">
					<div className="lore-center-title-group">
						<div className="lore-center-title-texts">
							<h3 className="lore-center-title">{t("命令黑名单")}</h3>
						</div>
						<span className="lore-center-chars-tag">{t("{n} 条规则", { n: count })}</span>
					</div>
					<div className="lore-center-actions">
						<button type="button" className="drawer-btn save-btn" disabled={busy || !dirty || !loaded} onClick={save}>
							{dirty ? t("保存 *") : t("保存")}
						</button>
						<button
							type="button"
							className="icon-btn lore-center-close"
							onClick={onClose}
							title={t("关闭（Esc）")}
							aria-label={t("关闭")}
						>
							<IconClose size={18} />
						</button>
					</div>
				</div>

				<div className="lore-center-body">
					<div className="lore-center-editor">
						<div className="field-hint">
							{t("命中即拒绝执行，agent 拿不到任何执行结果。一行一条；# 与空行是注释；字面文本 + * 通配；按词边界匹配，rm -rf / 不误伤 rm -rf /var/log。删掉任何一条即失去那条保护。")}
						</div>
						<textarea
							className="panel-search lore-center-textarea"
							rows={22}
							spellCheck={false}
							value={text}
							disabled={busy || !loaded}
							onChange={(e) => {
								setText(e.target.value);
								setDirty(true);
							}}
						/>
						<div className="field-hint">{path}</div>
					</div>
				</div>
			</div>
		</div>
	);
}
