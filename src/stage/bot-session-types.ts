import type { BotBeat, BotThreadEntry, BotToolCallRecord, BotToolResult } from "./bot.ts";
import type { StageTool } from "./tools.ts";

export interface BotModelSelection { provider: string; entry: string; thinking?: string }
export interface BotSessionInfo {
	id: string;
	name: string;
	firstMessage?: string;
	created: number;
	updated: number;
	model?: BotModelSelection;
	deleted?: boolean;
}
export interface BotContextInfo {
	tokens: number;
	contextWindow: number;
	outputReserve: number;
	viewBeats: number;
	totalBeats: number;
	estimated: boolean;
}
export interface BotSessionSnapshot {
	activeId: string;
	sessions: BotSessionInfo[];
	messages: BotThreadEntry[];
	status: "idle" | "running" | "complete" | "stopped" | "error" | "interrupted" | "compacting";
	error?: string;
	context?: BotContextInfo;
	modelLabel?: string;
}
export type BotSessionAction =
	| { action: "list" | "new" | "open" | "rename" | "delete"; id?: string; name?: string }
	| { action: "model"; model?: BotModelSelection | null }
	| { action: "compact" | "stop" };

export interface BotSessionRun {
	file: string;
	cwd: string;
	systemPrompt: string;
	userText: string;
	view: { summary?: string; state: string; beats: BotBeat[]; window?: number };
	tools: StageTool[];
	execute: (name: string, args: Record<string, unknown>) => Promise<BotToolResult>;
	signal: AbortSignal;
	onDelta?: (kind: "text" | "thinking", delta: string) => void;
	onActivity?: (detail: string) => void;
	onToolCall?: (record: BotToolCallRecord) => void;
	compact?: boolean;
}
