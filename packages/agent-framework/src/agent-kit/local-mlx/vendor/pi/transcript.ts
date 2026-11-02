// Vendored (subset) from https://github.com/earendil-works/pi @ b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6,
// packages/ai/src/utils/transcript.ts (MIT, Copyright (c) 2025 Mario Zechner; see ./LICENSE and ./SOURCES.md).
// Kept verbatim: createInitialSystemMessage, normalizeContext. Change: import path only; other replay helpers not needed.
import type { Context, SystemMessage, Tool, TranscriptContext } from "./types.js";

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}
