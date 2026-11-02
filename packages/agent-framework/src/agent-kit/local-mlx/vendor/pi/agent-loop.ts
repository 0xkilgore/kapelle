// Vendored (adapted) from https://github.com/earendil-works/pi @ b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6,
// packages/agent/src/agent-loop.ts (MIT, Copyright (c) 2025 Mario Zechner; see ./LICENSE and ./SOURCES.md).
// Kept: runAgentLoop's event protocol and streamAssistantResponse (verbatim except API-key resolution, removed: the local
// transport carries no credentials). Changed for Kapelle's restricted runtime: exactly ONE assistant turn. No steering,
// follow-up, prepareRequest/prepareNextTurn, transformContext or continuation (each can start another inference). Tool
// execution is not vendored: an assistant message carrying any tool call is REFUSED (thrown), never executed or repaired.
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	StreamFn,
} from "./types.js";
import { normalizeContext } from "./transcript.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export class UnsolicitedToolCall extends Error {
	constructor() {
		super("pi_unsolicited_tool_call");
		this.name = "UnsolicitedToolCall";
	}
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.tools && context.tools.length > 0) throw new Error("pi_tools_not_admitted");
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of prompts) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	// One turn (upstream runLoop, inner iteration only).
	const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
	newMessages.push(message);
	if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.content.some((c) => c.type === "toolCall")) {
		throw new UnsolicitedToolCall();
	}
	await emit({ type: "turn_end", message, toolResults: [] });
	await emit({ type: "agent_end", messages: newMessages });
	return newMessages;
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	const messages = context.messages;

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	const response = await streamFunction(config.model, llmContext, {
		reasoning: config.reasoning,
		signal,
	});
	// Record the requested level, whichever stream function answered.
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}
