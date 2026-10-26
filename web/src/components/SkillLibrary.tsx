/**
 * 技能库面板（读写 /api/stage-skills —— 与引擎 scanSkillFiles 共用 `skills/<目录>/SKILL.md`）：
 * 保存后下一拍装载即生效；支持新建、导入/导出 .md、展开预览正文与对模型显隐开关。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, downloadText } from "../api.ts";
import { IconDownload, IconPencil, IconPlus, IconTrash, IconUploads } from "./icons.tsx";
import { ConfirmButton, Toggle } from "./kit.tsx";
import { t } from "../i18n/index.ts";

type Scope = "global" | "card";
type StageSkill = {
	dir: string;
	name: string;
	description: string;
	chars: number;
	body: string;
	disabled: boolean;
	scope: Scope;
	shadowed?: boolean;
};
type EditState = { dir: string | null; name: string; description: string; body: string; scope: Scope };

/** 从导入的 .md 解析可选 frontmatter 与正文 */
function parseImportedSkillMd(raw: string, fallbackName: string): { name: string; description: string; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!m) {
		return { name: fallbackName, description: "", body: raw.trim() };
	}
	const head = m[1];
	const pick = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(head)?.[1]?.trim() ?? "";
	return {
		name: pick("name") || fallbackName,
		description: pick("description"),
		body: m[2].trim(),
	};
}

export function SkillLibrary({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [skills, setSkills] = useState<StageSkill[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [edit, setEdit] = useState<EditState | null>(null);
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [defaultScope, setDefaultScope] = useState<Scope>("global");
	const fileRef = useRef<HTMLInputElement>(null);

	const reload = useCallback(async () => {
		try {
			const r = await apiGet<{ skills: StageSkill[]; defaultScope: Scope }>("/api/stage-skills");
			setSkills(r.skills);
			setDefaultScope(r.defaultScope);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const save = async () => {
		if (!edit) return;
		setBusy(true);
		try {
			await apiPost("/api/stage-skills", {
				dir: edit.dir ?? undefined,
				scope: edit.scope,
				name: edit.name,
				description: edit.description,
				body: edit.body,
			});
			toast("info", t("已保存，下一拍装载即生效"));
			setEdit(null);
			await reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const setExposed = async (s: StageSkill, exposed: boolean) => {
		setBusy(true);
		try {
			await apiPost("/api/stage-skills", {
				dir: s.dir,
				scope: s.scope,
				name: s.name,
				description: s.description,
				body: s.body,
				disabled: !exposed,
			});
			await reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (dir: string, scope: Scope) => {
		setBusy(true);
		try {
			await apiDelete(`/api/stage-skills?dir=${encodeURIComponent(dir)}&scope=${scope}`);
			toast("info", t("已删除「{name}」", { name: dir }));
			if (edit?.dir === dir && edit.scope === scope) setEdit(null);
			await reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const handleImportMd = async (file: File) => {
		try {
			const raw = await file.text();
			const baseName = file.name.replace(/\.md$/i, "").trim() || "skill";
			const parsed = parseImportedSkillMd(raw, baseName);
			setEdit({
				dir: null,
				name: parsed.name,
				description: parsed.description,
				body: parsed.body,
				scope: defaultScope,
			});
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const exportSkillMd = (s: StageSkill) => {
		const fm = [
			"---",
			`name: ${s.name}`,
			...(s.description ? [`description: ${s.description}`] : []),
			...(s.disabled ? ["disable-model-invocation: true"] : []),
			"---",
			"",
			s.body,
		].join("\n");
		downloadText(`${s.name || s.dir}.md`, fm);
	};

	const renderForm = () => {
		if (!edit) return null;
		return (
			<div className="skill-edit-form">
				<label className="field-label">{t("适用范围")}</label>
				<select
					className="panel-search"
					aria-label={t("技能适用范围")}
					value={edit.scope}
					disabled={busy || edit.dir !== null}
					onChange={(e) => setEdit({ ...edit, scope: e.target.value as Scope })}
				>
					{defaultScope === "card" && <option value="card">{t("当前角色卡")}</option>}
					<option value="global">{t("所有角色卡")}</option>
				</select>
				<label className="field-label" style={{ marginTop: 8 }}>
					{t("名称（模型用它点名 skill_read）")}
				</label>
				<input
					className="panel-search"
					value={edit.name}
					disabled={busy}
					placeholder={t("如：打斗、我的文风")}
					onChange={(e) => setEdit({ ...edit, name: e.target.value })}
				/>
				<label className="field-label" style={{ marginTop: 8 }}>
					{t("简要说明（检索触发面）")}
				</label>
				<input
					className="panel-search"
					value={edit.description}
					disabled={busy}
					placeholder={t("只写什么时候用（触发场面）；别写做法摘要——模型会照摘要走捷径不读正文")}
					onChange={(e) => setEdit({ ...edit, description: e.target.value })}
				/>
				<label className="field-label" style={{ marginTop: 8 }}>
					{t("正文")}
				</label>
				<textarea
					className="panel-search ta preset-block-ta"
					rows={12}
					spellCheck={false}
					value={edit.body}
					disabled={busy}
					placeholder={t("写给模型看的正文：何时用/怎么写/一两段示范。Markdown。")}
					onChange={(e) => setEdit({ ...edit, body: e.target.value })}
				/>
				<div className="panel-row list-toolbar skill-edit-acts">
					<button className="drawer-btn save-btn" disabled={busy || !edit.name.trim() || !edit.body.trim()} onClick={() => void save()}>
						{t("保存")}
					</button>
					<button className="drawer-btn" disabled={busy} onClick={() => setEdit(null)}>
						{t("取消")}
					</button>
				</div>
			</div>
		);
	};

	return (
		<section className="sp-section">
			<div className="panel-row list-toolbar" style={{ marginBottom: 8 }}>
				<button
					type="button"
					className="drawer-btn save-btn"
					disabled={busy || !!edit}
					onClick={() => setEdit({ dir: null, name: "", description: "", body: "", scope: defaultScope })}
				>
					<IconPlus size={13} /> {t("＋ 新建技能")}
				</button>
				<button
					type="button"
					className="drawer-btn"
					disabled={busy || !!edit}
					onClick={() => fileRef.current?.click()}
				>
					<IconUploads size={13} /> {t("导入 .md")}
				</button>
				<input
					ref={fileRef}
					type="file"
					accept=".md,text/markdown"
					hidden
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) void handleImportMd(f);
					}}
				/>
			</div>

			{error && <div className="panel-error">{error}</div>}
			{skills && skills.length === 0 && !edit && (
				<div className="sp-empty">{t("还没有 skill。点「新建」写第一个（写作方法/场面写法/文风示范都可以）。")}</div>
			)}

			{edit && edit.dir === null && renderForm()}

			<div className="skill-card-list">
				{skills?.map((s) => {
					const rowKey = `${s.scope}:${s.dir}`;
					const isEditing = Boolean(edit && edit.dir === s.dir && edit.scope === s.scope);
					const isExpanded = expandedKey === rowKey;
					if (isEditing) {
						return <div key={rowKey}>{renderForm()}</div>;
					}
					return (
						<div key={rowKey} className={`skill-card-item ${!s.disabled ? "on" : "muted"}`}>
							<div className="skill-card-head">
								<button
									type="button"
									className="skill-card-main"
									onClick={() => setExpandedKey(isExpanded ? null : rowKey)}
								>
									<div className="skill-card-title-row">
										<span className="skill-card-name">{s.name}</span>
										<span className={`skill-scope-badge ${s.scope === "card" ? "card" : "global"}`}>
											{s.scope === "card" ? t("当前卡") : t("全局")}
										</span>
										{s.shadowed && <span className="skill-scope-badge shadowed">{t("当前卡已覆盖")}</span>}
										<span className="skill-card-chars">{t("{n} 字", { n: s.chars.toLocaleString() })}</span>
									</div>
									{s.description && <div className="skill-card-desc">{s.description}</div>}
								</button>
								<label
									className="expose-toggle"
									title={t("开＝名字与说明上 skill_read 清单，剧情模型按需读；关＝对模型隐身（本页仍在，随时开回来）")}
								>
									<Toggle checked={!s.disabled} disabled={busy || !!edit} onChange={(v) => void setExposed(s, v)} />
								</label>
							</div>

							{isExpanded && (
								<div className="skill-card-body">
									<pre className="skill-card-preview">{s.body}</pre>
									<div className="skill-card-acts">
										<button
											type="button"
											className="act"
											disabled={busy || !!edit}
											onClick={() => setEdit({ dir: s.dir, name: s.name, description: s.description, body: s.body, scope: s.scope })}
										>
											<IconPencil size={12} /> {t("编辑")}
										</button>
										<button type="button" className="act" onClick={() => exportSkillMd(s)}>
											<IconDownload size={12} /> {t("导出 .md")}
										</button>
										<ConfirmButton
											className="act"
											disabled={busy || !!edit}
											confirmText={t("确认删除")}
											onConfirm={() => void remove(s.dir, s.scope)}
										>
											<IconTrash size={12} /> {t("删除")}
										</ConfirmButton>
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
