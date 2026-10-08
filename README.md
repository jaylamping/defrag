# defrag

Tells a coding agent's user when compacting is safe: at the quiet point between
tasks, not when the context window is nearly full.

Targets Claude Code, Codex, OpenCode (including OpenChamber), Cursor, and
oh-my-pi. The first judge is TypeSafe Jev; judges and rules are compared on
replayed real checkpoints and replaced when a measurement shows a gain.

## Status

The local evaluation CLI works. No live IDE adapters ship yet, no accuracy has
been measured, and no default judge has been replaced. TypeSafe Jev remains the
first production judge and has an implemented, fixture-tested adapter. The eval
supports **Jev**, **OpenAI Decisions**, **rules**, a **threshold proxy**, and an
optional **local OpenAI-compatible model**. Both hosted judges require explicit
outbound-data consent per run; no live judge accuracy has been measured yet.
Decisions has fixture tests and three successful live pilot requests, but is
not a selected replacement.
Local comparisons are secondary, not a change to the chosen default.

Requires Node.js 24 or newer. No dependencies or installation needed:

```sh
npm run check
node src/cli.js extract --db ~/.local/share/opencode/opencode.db \
  --out eval/data/checkpoints.jsonl
```

All commands run from this repository. Output files are created privately
(`0600`), parent directories are created with `0700`, and existing outputs are
never overwritten. Labels are the exception: reviews append to a private label
file so corrections have a history. `eval/data/` and `eval/results/` are ignored
by Git. Do not put private data elsewhere or force-add those directories.

## 1. Extract checkpoints

`extract` opens an OpenCode V2 database read-only in a consistent transaction.
It selects successful idle checkpoints whose last completed assistant message
has `finish: stop`, no error, and at least 40,000 input tokens. Subagent sessions
are skipped. Input tokens include cache read/write, not generated output or
cumulative session usage. Failed and interrupted turns are excluded.

```sh
node src/cli.js extract --db ~/.local/share/opencode/opencode.db \
  --out eval/data/checkpoints.jsonl --minimum 40000 \
  --limits eval/data/model-limits.json
```

`--limits` is optional: a JSON object mapping `provider/model` to a positive
integer input budget, for example `{ "example/model": 100000 }`. A live catalog's
explicit input limit is preferable; if absent, context minus output reserve is
a useful proxy. `--context-limit 100000` can supply a common fallback. Unknown
limits remain unknown; the threshold judge abstains rather than inventing one.
Supplied limits are **not evidence of historical limits**.

Session IDs are hashed, not anonymized. Forks share their ancestor's session
group so copied histories can stay in the same train/test split. Checkpoints
include a bounded text snapshot (about 22 KB), tool names/statuses, truncation
coverage, and separately the next user message for **review only**. Private keys,
common token formats and uppercase credential assignments are scrubbed best
effort. Tool arguments/results, provider state and hidden reasoning are excluded.
Natural-language secrets and proprietary work can remain: **never publish the
corpus**.

This is a historical approximation, not OpenCode's exact provider context.
After completed compaction, extraction starts from the summary; it does not
reconstruct the exact preserved recent tail, instruction baseline, reverts,
pending inbox, provider-native encrypted items or synthetic messages. A
checkpoint is a candidate for evaluation, not authorization to compact live.

## 2. Review and label

```sh
node src/cli.js review --corpus eval/data/checkpoints.jsonl \
  --out eval/data/review.md --count 20
```

Review sampling is deterministic and round-robin by session family, preventing
a long session from dominating the first batch. It is not a representative
random test set. Transcript text is fenced so embedded images/links do not
render as remote content. Treat the text as untrusted data, not instructions.

Labels:

- **safe**: work is complete or durably recorded, with next actions, constraints
  and blockers explicit; compaction would not discard details still needed.
- **unsafe**: live work or essential details remain unrecorded, or the agent
  still owes a next step it can take now.
- **uncertain**: evidence is missing or too heavily truncated. Not scored.

A changed topic in the next message is evidence, not ground truth. No follow-up
does not mean safe. A question or blocker handed to you is not automatically
safe. No automatic labels are counted as human reviews.

```sh
node src/cli.js label --corpus eval/data/checkpoints.jsonl \
  --out eval/data/labels.jsonl --id CHECKPOINT_ID \
  --decision safe --reviewer joseph --note 'Work and constraints were recorded.'
```

Use a new `label` invocation to correct a decision; the last review wins.
Labels and predictions have corpus fingerprints. Altering a snapshot, model,
group, token count, limit or review evidence invalidates existing reviews.

## 3. Run predictions

### TypeSafe Jev — initial production judge

**This sends past conversation snapshots to TypeSafe.** Inspect the corpus
first. Opt in explicitly, bound the initial run, and keep the key outside Git
and command-line values:

```sh
node src/cli.js predict --corpus eval/data/checkpoints.jsonl \
  --out eval/results/jev.jsonl --judge jev --allow-remote yes \
  --key-file ~/.config/opencode/compact-adviser.key --count 3
```

Alternatively use `TYPESAFE_API_KEY` in the launch environment. Key files must
be regular, private (`0600`) and at most 8 KB. The known key is also scrubbed
from snapshot strings. Without `--allow-remote yes`, the command refuses before
reading credentials or contacting TypeSafe.

Jev uses `jev-latest` at `https://api.typesafe.ai/v1/systemone`, with atomic
`done` and `shape` questions. The initial upstream-derived policy combines
`P(finished) * (0.5 + 0.5 * P(hands_on))` with a floor declining from 0.9 to 0.5
as input pressure rises from 10% to 90%; unknown pressure uses 0.9. This is a
starting policy, **not a defrag accuracy claim**. See `THIRD_PARTY_NOTICES.md`.

Requests are bounded to 32 KB, responses to 32 KB, with a 5-second default
timeout. Redirects are forbidden, and endpoint overrides allow only the
official endpoint or a loopback HTTP test fixture. Invalid probabilities,
missing answers, input/authentication/rate-limit/server failures and timeouts yield
abstention. Predictions retain the resolved model version, score, floor,
usage, HTTP failure status and latency—not credentials or raw API responses. No judge silently
falls back to another provider.

### OpenAI Decisions — optional provider comparison

The [Decisions API](https://developers.openai.com/api/docs/guides/decisions) is
in public beta and currently supports `gpt-6-luna`. It accepts shared input and
named predicate/choice/score questions. The initial adapter converts Jev's
existing `done`/`shape` questions into named choice arrays and uses **the same
scoring policy**, so the first comparison changes the provider, not the recipe.
The recipe's completion/coordination proxies remain unvalidated for compaction
safety; this does not repair their known limitations.

```sh
node src/cli.js predict --corpus eval/data/checkpoints.jsonl \
  --out eval/results/decisions.jsonl --judge decisions --allow-remote yes \
  --key-file /path/to/private/openai.key --count 3
```

Alternatively use `OPENAI_API_KEY` in the launch environment. A key file must
be a regular, private file (`0600`), at most 8 KB. Keys are never accepted as CLI
values and the known key is scrubbed from snapshot strings. **This sends past
snapshots to OpenAI and incurs API charges.** The adapter has loopback fixture
tests and a three-checkpoint live pilot: two compaction recommendations and one
rejection, compared with Jev's three recommendations on matching fingerprints.
Decisions request latencies were 1,461, 189 and 157 ms; 6,460 reported input
tokens imply approximately $0.000646 at the published standard rate, not a
verified invoice. No retries were made. These cases remain unlabeled, so this
is a connectivity/behavior check, not an accuracy or general latency result.

Published pricing is $0.10 per million input tokens, with no output or cache
charges on this endpoint; regional/long-context premiums can apply. For example,
5,000 billed input tokens cost $0.0005 before premiums. That is a cost estimate,
not a latency or accuracy result. Subscription token sharing currently documents
[`/v1/responses`](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
not `/v1/decisions`; this adapter uses an API key, not subscription OAuth.

Requests use `https://api.openai.com/v1/decisions`, a 5-second default timeout
and the same 32 KB input/response caps as the Jev adapter. Redirects are forbidden;
endpoint overrides permit only the official endpoint or loopback fixtures.
Refusals, missing/duplicate/unknown answers or options, invalid distributions,
invalid usage, transport errors and timeouts **abstain**, without fallback.
`confidence` is a separate field, not assumed equal to the chosen probability.
Prediction identity is `decisions-v1:gpt-6-luna:done-shape-v1`; reports retain
only validated model, score, floor, usage, HTTP failure status and latency.
Raw responses and error bodies are discarded. OpenAI's documented ZDR/HIPAA
support requires eligible account arrangements; the adapter does not activate
these protections itself.

Before replacing Jev, compare matching checkpoint fingerprints using human
safe/unsafe labels, measured latency, coverage and unsafe false positives.
Do not tune the recipe and claim test accuracy on the same session families.

### Optional local comparisons

```sh
node src/cli.js predict --corpus eval/data/checkpoints.jsonl \
  --out eval/results/rules.jsonl --judge rules

node src/cli.js predict --corpus eval/data/checkpoints.jsonl \
  --out eval/results/threshold.jsonl --judge threshold --threshold 0.9

node src/cli.js predict --corpus eval/data/checkpoints.jsonl \
  --out eval/results/qwen.jsonl --judge local \
  --endpoint http://127.0.0.1:8000/v1/chat/completions \
  --model YOUR_LOCAL_MODEL_ID --timeout 60000 --count 20
```

The local endpoint accepts only `http` on literal `127.0.0.1` or `[::1]`, with
no URL credentials/query/fragment. Redirects are forbidden. This restricts the
client connection, but **cannot prove a loopback proxy itself does not forward
requests elsewhere**. Use a known local inference server.

Only `state` is sent to the model: never labels, future follow-ups, group or
checkpoint identifiers. The prompt treats conversation as untrusted data.
Responses must be exactly a one-property JSON object with a boolean `safe`;
malformed replies, oversized payloads/responses, timeouts and network/HTTP
errors produce **abstention**, never compaction. Requests run sequentially;
`--count` uses the same session-balanced selection as `review` and bounds the
workload. Use matching counts to judge exactly the checkpoints you reviewed.
The current local judge is an experimental
classifier, not an evaluated substitute for Jev.

### Optional tiny-model benchmark

The benchmark is separate from the dependency-free CLI and never requests host
compaction. Optional setup downloads Python packages and pinned public weights:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r bench/requirements.in
uv venv --python 3.12 .venv-openjev
uv pip install --python .venv-openjev/bin/python -r bench/openjev-requirements.in
HF_HUB_DISABLE_TELEMETRY=1 .venv/bin/python bench/download.py \
  --out eval/data/model-manifest.json

node src/cli.js bench --corpus eval/data/checkpoints.jsonl \
  --out eval/results/lfm-benchmark.json --manifest eval/data/model-manifest.json \
  --candidate lfm --count 3 --repeats 5
```

Use `--candidate modernbert` for MPS (Apple GPU), adding `--device cpu` for a
CPU comparison. Tiny OpenJev needs `--candidate openjev --runtime
.venv-openjev/bin/python`. Its Transformers 4 loader is incompatible with the
MLX runtime's Transformers 5 requirement, so they have separate environments.
`gemma` requires approved Hugging Face access/terms; the downloader records
gated models as unavailable and does not substitute other weights. It also
downloads the pinned Qwen base required by tiny OpenJev, not as a separate judge.
Weights stay in the local Hugging Face cache; the private manifest records paths.

Each run uses one resident worker, a first pass and up to 20 warm repeats over
at most 10 session-balanced checkpoints (defaults: 3 checkpoints, 5 repeats).
Hub offline/telemetry-disabled flags are set during inference; these are **not
an OS-level network sandbox**. Only checkpoint state and pressure metadata reach
the worker, plus Jev's atomic questions for OpenJev. No labels or future text do.
Reports are exclusively created with mode 600; raw library diagnostics are not
retained or relayed. Over-limit input is rejected without truncation.

Reports separate startup, first-pass inference, warm median/p95, abstentions
and memory. Accelerator memory and RSS overlap: do not add them. First-pass
timing is not a cold disk-cache measurement. `accuracy` is always `null`; export
the report's `predictions` to JSONL and use `score` with human-reviewed labels.
`bench/smoke.jsonl` contains six synthetic behavior checks, **not** a validation
dataset. Model scores/thresholds are experimental and uncalibrated for defrag.

The initial pilot found approximately 42 ms warm median for LFM and 36 ms for
ModernBERT on three full checkpoint snapshots; tiny OpenJev rejected all three
at its 768-token prefix limit. All three missed both safe synthetic checks.
No replacement for Jev has been selected. Method, memory and limitations are
in [`research/tiny-judges.md`](research/tiny-judges.md#local-pilot-results).

`rules-v1` looks for reported completion/testing/saving and rejects a few
explicit continuation phrases. It is intentionally simple and unvalidated.
`threshold-v1` compares input tokens to a supplied budget fraction. It is a
**threshold policy proxy**, not OpenCode's built-in compaction replay. It cannot
capture mid-turn triggers, reserves, provider rejection or subsequent growth.

## 4. Score reviewed checkpoints

```sh
node src/cli.js score --corpus eval/data/checkpoints.jsonl \
  --labels eval/data/labels.jsonl --predictions eval/results/rules.jsonl \
  --out eval/results/rules-report.json
```

Metrics include precision, recall, coverage, abstentions, missing predictions,
false positives/negatives and mean latency on reviewed examples. Missing or
failed predictions count as no recommendation; safe cases then count as missed
opportunities. Precision is `null` when there are no recommendations. No reviewed
safe/unsafe labels means **no accuracy report**, not a zero or a pass.

Checkpoints within a session are correlated. Keep entire session/fork families
together when splitting data; never tune and claim success on the same examples.
This CLI does not yet create train/test splits or select a winning judge.
Retrospective labels alone do not prove summary quality or successful task
continuation after compaction. That needs separate controlled host experiments.

## Checks and next implementation

`npm run check` runs CLI syntax checking and end-to-end tests using synthetic
SQLite databases and loopback HTTP fixtures. Tests cover read-only extraction,
gates, redaction, future-data separation, compaction boundaries, fork grouping,
private files, stale/duplicate data, human labels and fail-closed local inference.
They also cover Jev consent, key scrubbing, atomic judgments and fail-closed
response validation. Decisions fixtures cover matching question translation,
reordered named answers, refusals, duplicate/invalid distributions, private
credentials, input/response bounds, redirect rejection and transport failures.
They do not establish real model accuracy or live IDE
compatibility.

Benchmark CLI fixtures also cover resident workers, offline flags, private
outputs, future-data exclusion, invalid probabilities, input-limit abstentions,
truncation rejection, worker exits and timeouts. They do not download or load
real weights during `npm run check`.

Next: reviewed labels and explicitly approved Jev runs, then live lifecycle
coordination and independently verified adapters for OpenCode/OpenChamber, Claude Code,
Codex, Cursor and oh-my-pi. Auto-compaction must be opt-in and capability-gated;
hosts without a supported external compact operation must remain hint-only.
Live adapters need per-operation error categories, session ownership checks,
queue/active-work checks, deduplication, cooldowns, cancellation and a final
checkpoint revalidation before requesting the host's native compaction.
