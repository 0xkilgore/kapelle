// Vendored (trimmed) from https://github.com/earendil-works/pi @ b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6 (MIT, Copyright (c) 2025
// Mario Zechner; see ./LICENSE and ./SOURCES.md):
//   packages/ai/src/types.ts     -> message, content, usage, stop-reason, event and (chat) model types, verbatim where kept;
//   packages/agent/src/types.ts  -> AgentMessage, AgentContext, AgentEvent, StreamFn and the AgentLoopConfig subset used here.
// Changes: provider/catalog/auth/telemetry/image/classifier types removed; `typebox` (TSchema/Static) replaced by `unknown`
// (tools are never admitted in Kapelle); Model reduced to the fields the loop reads; AgentLoopConfig reduced to model +
// convertToLlm + reasoning (no steering, follow-ups, request/turn preparation, context transforms, API keys or tool hooks:
// each of those can start another inference, which this runtime forbids).

import type { AssistantMessageEventStream } from "./event-stream.js";

export type Api = string;
export type ProviderId = string;
export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
	argumentsError?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/** Tool declarations exist in the transcript protocol; Kapelle admits none (`tools: []`). */
export interface Tool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface ToolReference {
	name: string;
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	thinkingLevel?: ModelThinkingLevel | "off";
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
	durationMs?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	usage?: Usage;
	isError: boolean;
	durationMs?: number;
	timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;
export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** Chat model: only the fields the loop and Kapelle's stream function read. */
export interface Model {
	id: string;
	name: string;
	api: Api;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// ---- packages/agent/src/types.ts (subset) ----

export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentContext {
	messages: AgentMessage[];
	/** Always empty in Kapelle. */
	tools?: never[];
}

export interface StreamOptions {
	signal?: AbortSignal;
	reasoning?: ModelThinkingLevel;
}

/**
 * Stream function used by the agent loop (upstream contract): must not throw or reject for request/model/runtime
 * failures; failures are encoded as a final AssistantMessage with stopReason "error" or "aborted".
 */
export type StreamFn = (
	model: Model,
	context: TranscriptContext,
	options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface AgentLoopConfig {
	model: Model;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	reasoning?: ModelThinkingLevel;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage };
