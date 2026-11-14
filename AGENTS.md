# AGENTS.md

Instructions for coding agents working on this repo.

## Commands

```bash
npm test           # unit tests (node --test test/*.test.ts), no network
npm run typecheck  # tsc --noEmit
npm run lint       # biome lint, checks only
npm run format     # biome format, checks only
biome check --write .   # apply formatting
```

Run all four before committing. Requires Node >= 22.19 (type stripping without a flag) and `npm install` first.

## Layout

- `index.ts` — the extension entry. Registers the provider and the `/cadence` command.
- `src/endpoint.ts` — the single endpoint: provider id and name, base URL, probe path, rate limit (`limit`/`windowMs`) and the model list. Exports `ENDPOINT`.
- `src/models.ts` — the model catalog (id, context, vision, reasoning map) plus the `ChatModel`/`ReasoningSpec` types.
- `src/provider.ts` — registers the Pi provider and the lane-rotation streaming.
- `src/pool.ts` / `src/bucket.ts` — per-`(lane, model)` rate-limit buckets and lane acquisition. `LIMIT`/`WINDOW_MS` read from `ENDPOINT`.
- `src/relay.ts` — relay parsing/formatting (`host:port`, `host:port:user:pass`, `http://user:pass@host:port`).
- `src/probe.ts` — relay probing (no rate-limit cost), egress IP lookup, and the `Dispatchers` (cached undici `ProxyAgent` per relay).
- `src/store.ts` — persists relays to `~/.pi/agent/cadence.json`, mode 0600.
- `src/cadence.ts` — the `/cadence` command group (status, list, add, remove, test).
- `test/` — unit tests, no network.

## Facts that matter

- One runtime dependency: `undici` (a `ProxyAgent` per relay). Everything else is a dev dependency for typecheck/lint.
- The rate limit is per egress IP and per model (2 req/min on the endpoint), so each relay plus the direct connection is one lane and the lanes add up.
- Rotation retries only before any content is emitted; once a lane produces output the attempt is final, since a mid-stream retry would duplicate text.
- The provider id is `cadence` (provider-neutral, not the service name). Models show up as `cadence/<model>`.

## Release

Push a tag `v*` matching the `package.json` version. CI (`release.yml`) runs typecheck, lint, format and test, then publishes to npm with trusted publishing and creates a GitHub release with generated notes.
