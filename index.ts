/**
 * pi-cadence: free-tier models spread across relays so the per-IP limit adds up.
 *
 * One provider (`cadence`) and one command group (`/cadence`). Relays are
 * managed from inside Pi; nothing to format by hand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleCadence } from "./src/cadence.ts";
import { LanePool } from "./src/pool.ts";
import { Dispatchers } from "./src/probe.ts";
import { registerProvider } from "./src/provider.ts";
import { loadRelays } from "./src/store.ts";

export default function (pi: ExtensionAPI) {
	const dispatchers = new Dispatchers();
	const pool = new LanePool(loadRelays());
	const deps = { pool, dispatchers };

	registerProvider(pi, deps);

	pi.registerCommand("cadence", {
		description: "Relays: status, list, add, remove, test",
		getArgumentCompletions: (prefix: string) => {
			const items = ["list", "add", "remove", "test"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await handleCadence(args, ctx, deps);
		},
	});

	pi.on("session_shutdown", async () => {
		await dispatchers.closeAll();
	});
}
