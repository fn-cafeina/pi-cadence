/**
 * Provider data for the default (and so far only) provider: the OVHcloud AI
 * Endpoints anonymous tier. This is the only module that names the service.
 *
 * Generic code consumes `ACTIVE_PROVIDER`, never these values directly. Adding
 * another provider later means adding another data file here and switching
 * which one `ACTIVE_PROVIDER` points at.
 */

import { type ChatModel, MODELS } from "../models.ts";

export interface ProviderDef {
	/** Provider-neutral id, shown as `<id>/<model>` in Pi. */
	id: string;
	name: string;
	/** Label for the (fake, anonymous) API key Pi requires. */
	authName: string;
	baseUrl: string;
	/** A path that costs no rate limit; used to probe relays. */
	probePath: string;
	/** Requests allowed per window per egress IP, per model. */
	limit: number;
	/** Length of the rate-limit window. */
	windowMs: number;
	models: readonly ChatModel[];
}

export const ACTIVE_PROVIDER: ProviderDef = {
	id: "cadence",
	name: "Cadence",
	authName: "anonymous",
	baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
	probePath: "/models",
	limit: 2,
	windowMs: 60_000,
	models: MODELS,
};
