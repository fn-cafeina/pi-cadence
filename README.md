# pi-cadence

Free-tier models spread across relays so the per-IP rate limit adds up.

The default provider allows **2 requests per minute per IP and per model**.
Your own connection is one lane; every relay adds another. Ten relays plus
your own connection is 11 lanes, 22 rpm per model. Fewer relays means fewer
lanes; it also works with none (2 rpm on your own connection).

## Install

```bash
pi install npm:pi-cadence                           # from npm (recommended)
pi install git:github.com/fn-cafeina/pi-cadence     # from git
pi install ./pi-cadence                             # local path
```

`pi list` shows what is installed, `pi remove npm:pi-cadence` removes it.

No API key, no `/login`. The provider shows up as `cadence` with nine models.

## Use

```
/cadence              state: lanes, free quota per model
/cadence list         saved relays, numbered
/cadence add [relay]  add a relay, or open the editor to paste many
/cadence remove [n]   delete one by number
/cadence test [n]     probe one relay by number, or all of them
```

`/cadence add relay` saves one relay; with no argument it opens a multiline
editor. Paste your whole proxy list, in either format, and it figures out each
line:

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

| model                                 | thinking                           | vision | context |
| ------------------------------------- | ---------------------------------- | ------ | ------- |
| `gpt-oss-20b`, `gpt-oss-120b`         | low, medium, high                  | no     | 131k    |
| `Qwen3.8-27B`                         | off, low, medium, xhigh            | yes    | 262k    |
| `Qwen3.6-27B`                         | off, low, medium, high, xhigh, max | yes    | 262k    |
| `Qwen3.5-9B`, `Qwen3.5-397B-A17B`     | off, low, medium, high             | yes    | 262k    |
| `Mistral-Small-3.2-24B-Instruct-2506` | no                                 | yes    | 131k    |
| `Qwen2.5-VL-72B-Instruct`             | no                                 | yes    | 32k     |
| `Meta-Llama-3_3-70B-Instruct`         | no                                 | no     | 131k    |

Thinking levels are mapped to what each model actually accepts. `high` on
Qwen3.8 became `xhigh` because the provider rejects `high` there; `off` does not
exist on gpt-oss, so those models offer no `off`.

## How requests are spread

Every request takes a slot from a bucket keyed by `(lane, model)` and streams
through it. pi-cadence does not intercept the stream: every event, including
errors, is forwarded to Pi untouched.

A lane that has spent a slot cannot serve that model until the window resets,
so the next request takes another lane. When every lane is full, the request
waits for the nearest window reset (up to 65s) instead of failing. Retries are
Pi's to make; each one simply takes the next slot, and the least-spent lanes
come first.

## The endpoint

pi-cadence talks to one fixed endpoint. Its id, base URL, rate limit and model
list live in `src/endpoint.ts`; if the service changes, that file is the only
one to edit.

## What this does not do

- 22 rpm is 22 HTTP requests, not 22 chat turns. One agent turn with ten tool
  calls spends eleven of them.
- Buckets are per model, so switching models starts a fresh 22 rpm but does not
  refund the previous model's usage.
- Compaction and subagents draw from the same buckets.
- Two Pi windows each count the same per-IP budget from zero; the 429s spend
  slots until the window resets.

## Development

```bash
npm test          # unit tests, no network
npm run typecheck # tsc --noEmit
npm run lint      # biome lint
npm run format    # biome format
```

## License

MIT. See [LICENSE](LICENSE).
