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
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChatModel, thinkingLevelMap } from "./models.ts";
import type { Lane, LanePool } from "./pool.ts";
import { type Dispatchers, describe } from "./probe.ts";
import { ACTIVE_PROVIDER } from "./providers/ovh.ts";

export const PROVIDER_ID = ACTIVE_PROVIDER.id;
/** Pi refuses to send a request without a key; the anonymous tier ignores it. */
const FAKE_KEY = "unused";
const MAX_ATTEMPTS = 6;

export interface ProviderDeps {
	pool: LanePool;
	dispatchers: Dispatchers;
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

export function isRateLimited(message: string): boolean {
	return /429|rate.?limit|too many requests/i.test(message);
}

export function isRetryableTransport(message: string): boolean {
	return /fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|other side closed|network|proxy/i.test(
		message,
	);
}

/**
 * Streams one request, rotating lanes on a rate limit or transport failure that
 * happens before any content. Once a lane has produced output the attempt is
 * final: a mid-stream retry would duplicate text.
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

		const source = openAICompletionsApi().streamSimple(model, context, {
			...options,
			apiKey: FAKE_KEY,
			fetch: anonymousFetch(lane, deps.dispatchers),
		});

		let emitted = false;
		let retry = false;
		for await (const event of source) {
			if (event.type === "error") {
				const message = event.error.errorMessage ?? "";
				const rateLimited = isRateLimited(message);
				if (!emitted && (rateLimited || isRetryableTransport(message))) {
					if (rateLimited) deps.pool.release(lane.key, model.id);
					deps.pool.markFailed(lane.key);
					lastError = message || "error desconocido";
					retry = true;
					break;
				}
				out.push(event);
				out.end();
				return;
			}
			if (event.type === "start") {
				emitted = true;
				out.push(event);
				continue;
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
