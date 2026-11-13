# pi-cadence

Free-tier models spread across relays so the per-IP rate limit adds up.

The default provider allows **2 requests per minute per IP and per model**.
Your own connection is one lane; every relay adds another. Ten relays plus
your own connection is 11 lanes, 22 rpm per model. Fewer relays means fewer
lanes; it also works with none (2 rpm on your own connection).

## Install

```bash
pi install ./pi-cadence        # or: pi install npm:pi-cadence
```

No API key, no `/login`. The provider shows up as `cadence` with six models.

## Use

```
/cadence              state: lanes, free quota per model
/cadence list         saved relays, numbered
/cadence add          paste relays, one per line
/cadence remove       delete one
/cadence test [n]     probe one relay by number, or all of them
```

`/cadence add` opens a multiline editor. Paste your whole proxy list, in either
format, and it figures out each line:

```
45.38.107.97:6014:user:pass
http://user:pass@45.38.107.97:6014
proxy.example.com:8080
```

Each relay is probed against the provider before it is saved. Dead ones are
reported and dropped, so a broken relay never silently joins the pool. Probing
costs no rate limit.

`/cadence test` also shows each relay's egress IP and warns when two relays
share one, because those two share a bucket and the real limit is lower than the
lane count suggests.

Relays are stored in `~/.pi/agent/cadence.json` with mode `0600`.

Then pick a model:

```
/model          → cadence/Qwen3.8-27B
```

## Models

| model                                 | thinking                | vision | context |
| ------------------------------------- | ----------------------- | ------ | ------- |
| `gpt-oss-20b`, `gpt-oss-120b`         | low, medium, high       | no     | 131k    |
| `Qwen3.8-27B`                         | off, low, medium, xhigh | yes    | 262k    |
| `Qwen3.5-9B`, `Qwen3.5-397B-A17B`     | off, low, medium, high  | yes    | 262k    |
| `Mistral-Small-3.2-24B-Instruct-2506` | no                      | yes    | 131k    |

Three models the API still lists (`llama-3-3-70b`, `qwen-2-5-vl-72b`,
`qwen-3-6-27b`) are marked unavailable in the provider's catalog and redirect
with a 10s delay, so they are not offered.

Thinking levels are mapped to what each model actually accepts. `high` on
Qwen3.8 became `xhigh` because the provider rejects `high` there; `off` does not
exist on gpt-oss, so those models offer no `off`.

## How requests are spread

Every request takes a slot from a bucket keyed by `(lane, model)`. When a lane
answers 429 or fails to connect before producing any content, the request moves
to another lane and the user sees nothing. Once a lane has produced output the
attempt is final, since a retry mid-stream would duplicate text.

When every lane is full, the request waits for the nearest window reset (up to
65s) instead of returning a 429. That keeps Pi's own retry budget intact.

## Providers

The provider is the swappable part. The default is the OVHcloud AI Endpoints
anonymous tier; its id, base URL, rate limit and model list live in
`src/providers/ovh.ts`. Adding another provider means adding a data file there.

## What this does not do

- 22 rpm is 22 HTTP requests, not 22 chat turns. One agent turn with ten tool
  calls spends eleven of them.
- Buckets are per model, so switching models starts a fresh 22 rpm but does not
  refund the previous model's usage.
- Compaction and subagents draw from the same buckets.

## Development

```bash
npm test          # unit tests, no network
npm run typecheck # tsc --noEmit
npm run lint      # biome lint
npm run format    # biome format
```

## License

MIT. See [LICENSE](LICENSE).
