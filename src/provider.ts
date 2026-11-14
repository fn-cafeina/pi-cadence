/**
 * Provider registration. Service-specific data comes from `ACTIVE_PROVIDER`
 * in `src/providers/`; only the transport changes.
 *
 * Requests are spread over one lane per relay plus the direct connection. Each
 * lane has its own rate-limit bucket, so a 429 from one lane is retried on
 * another instead of reaching the user. Streaming is delegated to Pi's own
 * `openai-completions` implementation; only the transport changes.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChatModel, thinkingLevelMap } from "./models.ts";
import type { Lane, LanePool } from "./pool.ts";
import { type Dispatchers, describe } from "./probe.ts";
import { ACTIVE_PROVIDER } from "./providers/ovh.ts";

const PROVIDER_ID = ACTIVE_PROVIDER.id;
/** Pi refuses to send a request without a key; the anonymous tier ignores it. */
const FAKE_KEY = "unused";
const MAX_ATTEMPTS = 6;

export interface ProviderDeps {
	pool: LanePool;
	dispatchers: Dispatchers;
	streamSimple: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

/** Strip anything that would authenticate us: the anonymous tier 403s on it. */
function anonymousFetch(lane: Lane, dispatchers: Dispatchers): typeof fetch {
	const dispatcher = lane.relay ? dispatchers.get(lane.relay) : undefined;
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.delete("authorization");
		return fetch(
			input,
			dispatcher ? ({ ...init, headers, dispatcher } as RequestInit) : { ...init, headers },
		);
	};
}

function catalogModel(entry: ChatModel): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: ACTIVE_PROVIDER.baseUrl,
		reasoning: entry.reasoning !== undefined,
		thinkingLevelMap: thinkingLevelMap(entry),
		input: entry.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	};
}

function emptyMessage(
	model: Model<Api>,
	message: string,
	stopReason: "error" | "aborted",
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/**
 * Streams one request, rotating lanes when an attempt fails without producing
 * any content. The `start` event (HTTP headers, no content) is held back so a
 * stream that dies before its first chunk never reaches the harness. Once
 * real content has been emitted the attempt is final: a mid-stream retry
 * would duplicate text.
 */
export async function streamWithRotation(
	deps: ProviderDeps,
	out: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): Promise<void> {
	const signal = options?.signal;
	let lastError = "no relay responded";

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) {
			out.push({
				type: "error",
				reason: "aborted",
				error: emptyMessage(model, "aborted", "aborted"),
			});
			out.end();
			return;
		}

		const lane = await deps.pool.acquire(model.id, signal ?? new AbortController().signal);
		if (!lane) {
			const lanes = deps.pool.list().length;
			out.push({
				type: "error",
				reason: "error",
				error: emptyMessage(
					model,
					`all ${lanes} lanes at limit; next slot >65s. /cadence add for more lanes.`,
					"error",
				),
			});
			out.end();
			return;
		}

		const source = deps.streamSimple(model, context, {
			...options,
			apiKey: FAKE_KEY,
			fetch: anonymousFetch(lane, deps.dispatchers),
		});

		let emitted = false;
		let retry = false;
		let heldStart: AssistantMessageEvent | undefined;
		for await (const event of source) {
			if (event.type === "start") {
				// Headers, no content: hold until a real chunk arrives so a dead
				// stream can rotate without the harness ever seeing it.
				heldStart = event;
				continue;
			}
			if (event.type === "error") {
				if (!emitted && !signal?.aborted) {
					// Nothing was visible on this lane, so another lane cannot
					// duplicate content: same rotation as the pre-headers failures.
					deps.pool.release(lane.key, model.id);
					deps.pool.markFailed(lane.key);
					lastError = event.error.errorMessage || "error desconocido";
					retry = true;
					break;
				}
				// A stream that dies after content is evidence the lane is sick;
				// an aborted one just stops. Either way the attempt is final.
				if (!signal?.aborted) deps.pool.markFailed(lane.key);
				if (heldStart) {
					out.push(heldStart);
					heldStart = undefined;
				}
				out.push(event);
				out.end();
				return;
			}
			if (heldStart) {
				out.push(heldStart);
				heldStart = undefined;
			}
			emitted = true;
			out.push(event);
		}

		if (retry) continue;
		deps.pool.markOk(lane.key);
		out.end();
		return;
	}

	const lanes = deps.pool.list().length;
	out.push({
		type: "error",
		reason: "error",
		error: emptyMessage(
			model,
			`all ${lanes} lanes failed. Last error: ${lastError}. Check relays with /cadence test.`,
			"error",
		),
	});
	out.end();
}

function rotate(
	deps: ProviderDeps,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void streamWithRotation(deps, out, model, context, options).catch((error) => {
		out.push({
			type: "error",
			reason: "error",
			error: emptyMessage(model, describe(error), "error"),
		});
		out.end();
	});
	return out;
}

export function registerProvider(pi: ExtensionAPI, deps: ProviderDeps): void {
	const provider = createProvider({
		id: PROVIDER_ID,
		name: ACTIVE_PROVIDER.name,
		baseUrl: ACTIVE_PROVIDER.baseUrl,
		auth: {
			apiKey: {
				name: ACTIVE_PROVIDER.authName,
				resolve: async () => ({ auth: { apiKey: FAKE_KEY }, source: "anonymous" }),
			},
		},
		models: ACTIVE_PROVIDER.models.map(catalogModel),
		api: {
			"openai-completions": {
				// `stream` is required by the ProviderStreams contract. Rotation only
				// needs the provider-neutral options, so both entry points share it.
				stream: (model, context, options) => rotate(deps, model, context, options),
				streamSimple: (model, context, options) => rotate(deps, model, context, options),
			},
		},
	});
	pi.registerProvider(provider);
}
