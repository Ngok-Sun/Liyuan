import { useEffect, useState } from "react";
import { apiGet, apiGetCacheClear, type AgentConfigResponse, type ModelEntry } from "../api.ts";
import type { BotSessionAction, BotSessionInfo, BotSessionSnapshot } from "../../../src/stage/bot-session-types.ts";
import { entryKeyOf, supportedLevelsOf } from "./ConnectPanel.tsx";
import { t } from "../i18n/index.ts";
import "./BotSessionControls.css";

function formatBotTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sessionTitleOf(s: BotSessionInfo): string {
	return s.firstMessage?.trim() || t("新对话");
}

export function BotSessionControls({ snapshot, disabled, send }: {
	snapshot: BotSessionSnapshot | null;
	disabled: boolean;
	send: (request: BotSessionAction) => void;
}) {
	const [historyOpen, setHistoryOpen] = useState(false);
	const [models, setModels] = useState<Array<{ provider: string; entry: string; model: ModelEntry }>>([]);
	const [error, setError] = useState("");
	const current = snapshot?.sessions.find(s => s.id === snapshot.activeId);
	useEffect(() => {
		let alive = true;
		apiGetCacheClear("/api/agent-config");
		void apiGet<AgentConfigResponse>("/api/agent-config").then(r => {
			if (alive) setModels(Object.entries(r.config.providers ?? {}).flatMap(([provider, p]) => (p.models ?? []).map(model => ({ provider, entry: entryKeyOf(model), model }))));
		}).catch(e => { if (alive) setError(String(e)); });
		return () => { alive = false; };
	}, []);
	useEffect(() => { setHistoryOpen(false); }, [snapshot?.activeId]);
	const key = current?.model ? JSON.stringify([current.model.provider, current.model.entry]) : "";
	const chosen = models.find(m => JSON.stringify([m.provider, m.entry]) === key);
	const sessions = snapshot ? [...snapshot.sessions].sort((a, b) => (b.updated || b.created) - (a.updated || a.created)) : [];
	return <div className="bot-session-controls">
		<div className="bot-session-row">
			<button
				type="button"
				className={`bot-history-toggle ${historyOpen ? "active" : ""}`}
				disabled={disabled || !snapshot}
				onClick={() => setHistoryOpen(v => !v)}
				aria-expanded={historyOpen}
			>
				<span>{t("对话记录")}</span>
				{sessions.length > 0 && <span className="bot-history-count">{sessions.length}</span>}
			</button>
			<span className="bot-session-current" title={current ? `${sessionTitleOf(current)} · ${formatBotTime(current.created)}` : ""}>
				{current ? `${sessionTitleOf(current)} · ${formatBotTime(current.created)}` : t("新对话")}
			</span>
			<button
				type="button"
				disabled={disabled}
				onClick={() => { setHistoryOpen(false); send({ action: "new" }); }}
			>
				{t("新建")}
			</button>
		</div>
		{historyOpen && <div className="bot-history-list" role="listbox" aria-label={t("副编剧会话")}>
			{sessions.map(s => {
				const isCur = s.id === snapshot?.activeId;
				const title = sessionTitleOf(s);
				const time = formatBotTime(s.created);
				return <button
					key={s.id}
					type="button"
					role="option"
					aria-selected={isCur}
					className={`bot-history-item ${isCur ? "active" : ""}`}
					disabled={disabled}
					onClick={() => { setHistoryOpen(false); if (!isCur) send({ action: "open", id: s.id }); }}
					title={`${title} · ${time}`}
				>
					<span className="bot-history-item-title">{title}</span>
					<span className="bot-history-item-time">{time}</span>
				</button>;
			})}
		</div>}
		<div className="bot-session-row">
			<select aria-label={t("副编剧模型")} value={key} disabled={disabled || !snapshot} onChange={e => {
				if (!e.target.value) send({ action: "model", model: null });
				else { const [provider, entry] = JSON.parse(e.target.value); send({ action: "model", model: { provider, entry } }); }
			}}>
				<option value="">{t("跟随主演模型")}</option>
				{key && !chosen && <option value={key}>{current?.model?.provider}/{current?.model?.entry} · {t("不可用")}</option>}
				{models.map(m => <option key={JSON.stringify([m.provider, m.entry])} value={JSON.stringify([m.provider, m.entry])}>{m.entry} · {m.provider}</option>)}
			</select>
			{current?.model && <select aria-label={t("思考档位")} value={current.model.thinking ?? ""} disabled={disabled} onChange={e => send({ action: "model", model: { ...current.model!, thinking: e.target.value || undefined } })}>
				<option value="">{t("条目默认")}</option>
				{supportedLevelsOf(chosen?.model).map(level => <option key={level} value={level}>{level}</option>)}
			</select>}
		</div>
		<div className="bot-context-row">
			<span>{snapshot?.status === "compacting" ? t("正在压缩…") : snapshot?.context
				? t("上下文约 {used}/{limit}", { used: snapshot.context.tokens.toLocaleString(), limit: snapshot.context.contextWindow.toLocaleString() })
				: t("上下文将在发送后统计")}</span>
			<button type="button" disabled={disabled || !snapshot?.messages.length} onClick={() => send({ action: "compact" })}>{t("压缩")}</button>
		</div>
		{snapshot?.context && snapshot.context.viewBeats < snapshot.context.totalBeats && <small>{t("当前带入 {count}/{total} 拍，更早剧情可按需读取", { count: snapshot.context.viewBeats, total: snapshot.context.totalBeats })}</small>}
		{snapshot?.status === "interrupted" && <small role="status">{t("上次运行中断，已保存的对话和操作仍在，可继续发送消息。")}</small>}
		{snapshot?.status === "stopped" && <small role="status">{t("已停止，已执行的操作不会撤回。")}</small>}
		{(snapshot?.error || error) && <small role="alert">{snapshot?.error || error}</small>}
	</div>;
}
