/**
 * The single endpoint pi-cadence talks to. Identity, rate limit and model
 * catalog live here; if the service changes, edit this file.
 */

import { MODELS } from "./models.ts";

export const ENDPOINT = {
	id: "cadence",
	name: "Cadence",
	authName: "anonymous",
	baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
	probePath: "/models",
	limit: 2,
	windowMs: 60_000,
	models: MODELS,
};
