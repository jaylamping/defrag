# Tiny judges for defrag

Research date: 2026-10-07. Sources are model cards, configuration files, repositories and papers, read through their public pages and APIs. No weights were downloaded, no inference was run, and no private `eval/` data was read for this research. Published performance numbers are authors' own claims, not local measurements.

**Bottom line:** no published number says any small model can judge defrag's "is compaction safe now" decision. Every accuracy figure below comes from other tasks. The next step is a bounded local eval, not a switch.

## What defrag does today

- The Jev judge sends the snapshot (`state`) with two atomic choice questions, `done` (finished / not_finished / unclear) and `shape` (hands_on / coordinating / unclear), to `jev-latest`. Source: `src/jev.js`, README "TypeSafe Jev".
- Score is `P(finished) * (0.5 + 0.5 * P(hands_on))`, compared with a floor that falls from 0.9 to 0.5 as input pressure rises from 10% to 90% (`src/jev.js`). The policy comes from [compact-adviser](https://github.com/kunchenguid/compact-adviser) (`THIRD_PARTY_NOTICES.md`).
- Request and response bodies are capped at 32 KB. Any invalid probability, missing answer, failure or timeout becomes abstention (`src/jev.js`). The snapshot is about 22 KB (README "Extract checkpoints"). That is roughly 5-7K tokens by a common 3-4 characters per token rule. This is my estimate, not measured with any tokenizer.
- The local judge asks a chat model for one JSON object `{safe: boolean}` and abstains on malformed output (README "Optional local comparisons").

## What "open-jev" is

There is no single open-jev. "Jev" is TypeSafe's hosted product, and a number of independent projects on Hugging Face use the name. Several describe themselves as unaffiliated; for example, the [OpenJev card](https://huggingface.co/openjev/openjev) says "an independent project, not affiliated with TypeSafe". I found no confirmed GitHub repository for the `sshalimov04/open-jev` project named in one card.

| Name | Base and size | License | Notes |
|---|---|---|---|
| [openjev/openjev](https://huggingface.co/openjev/openjev) | Qwen3.8-27B derivative, 27.4B parameters ([NOTICE](https://huggingface.co/openjev/openjev/blob/main/NOTICE), [API metadata](https://huggingface.co/api/models/openjev/openjev)) | Weights CC BY-NC 4.0; helper code Apache 2.0 ([card](https://huggingface.co/openjev/openjev)) | Not tiny. The user's intended open-jev project and actual local Qwen size are not established by this research. |
| [autotrust/JEV-9B](https://huggingface.co/autotrust/JEV-9B) | Qwen3.5-9B LoRA, distilled from TypeSafe Jev 1.13 | Apache 2.0 | Still 9B. |
| [IamBusy/OpenJev-0.6B](https://huggingface.co/IamBusy/OpenJev-0.6B) | Qwen3-0.6B LoRA plus a scalar head | Apache 2.0 | Tiny and Apple-measured, but research-grade. |
| [cainai/OpenJev-Qwen3.5-0.8b](https://huggingface.co/cainai/OpenJev-Qwen3.5-0.8b) | Qwen3.5-0.8B full fine-tune, 0.75B | Apache 2.0 | Chinese only. |
| [com-kotobalabs/open-jev-deberta-v3-large](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large) | DeBERTa-v3-large, 434M | Apache 2.0 card; code repo license shown as NOASSERTION ([GitHub](https://github.com/kotoba-lang/typed-decisions)) | 512-token context. |
| [sshalimov04/open-jev-base](https://huggingface.co/sshalimov04/open-jev-base) | mmBERT-small cross-encoder | MIT | Needs gold calibration rows per task. |

The 27B card gives its serving footprints. Other quantisations: bf16 about 54 GB, FP8 about 29 GB, MLX 8-bit about 27 GB, MLX 4-bit about 15 GB, GGUF Q4_K_M 16.5 GB ([card](https://huggingface.co/openjev/openjev)). Even the smallest Apple build is far from "tiny". Its speed numbers are one H100 (about 227 ms first read at 1.1K tokens, 1,758 ms at 15.1K) ([card](https://huggingface.co/openjev/openjev)). Those are not Apple Silicon numbers.

## Candidates

"Published" means the card's claim. "Unmeasured" means no source covers it for defrag.

| Candidate | Size | Context | Output | Published evidence (other tasks) | Failure-closed? | Apple Silicon |
|---|---|---|---|---|---|---|
| **IamBusy/OpenJev-0.6B** | Qwen3-0.6B base (about 0.75B total) + 1.15M LoRA + 1K head ([card](https://huggingface.co/IamBusy/OpenJev-0.6B), [Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B)) | **Shipped state-prefix cap 768 tokens, branch cap 192**, not the base's 32K ([config](https://huggingface.co/IamBusy/OpenJev-0.6B/blob/main/openjev_config.json)) | Scalar head, no answer generation, calibrated per primitive | 45/60 on its own 60-question set; regressions, one training seed ([card](https://huggingface.co/IamBusy/OpenJev-0.6B)) | Loader rejects over-limit input rather than truncating ([source](https://github.com/IamBusy/OpenJev/blob/v0.3.2/src/openjev/branch_model.py)); output still needs defrag validation | M3 Pro MPS BF16, warm synthetic 104 ms for one short question and about 0.70 s for a long state with 8 questions ([card](https://huggingface.co/IamBusy/OpenJev-0.6B)). Not a full defrag snapshot benchmark. |
| **cainai/OpenJev-Qwen3.5-0.8b** | 0.75B | 8,192 | Decision head | 72.5% agreement with synthetic labels vs 94.3% for the hosted Jev on the same set ([card](https://huggingface.co/cainai/OpenJev-Qwen3.5-0.8b)) | Requires wrapper validation and abstention | CPU and NVIDIA only per card; not measured on Apple |
| **kotoba open-jev-deberta-v3-large** | 434M ([API](https://huggingface.co/api/models/com-kotobalabs/open-jev-deberta-v3-large)) | 512 total, state cut to 256 tokens ([card](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large)) | One pass, softmax per question, no generation | In-domain 0.854, out-of-distribution 0.690, over-confident OOD ([card](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large)) | Structured output is not automatic safety; truncation must be detected | M1 Max CPU fp32 1.8 s for 4 questions ([card](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large)). ONNX build exists. |
| **ModernBERT-base / zero-shot v2.0** | 149M ([base card](https://huggingface.co/answerdotai/ModernBERT-base)) | 8,192 ([zero-shot config](https://huggingface.co/MoritzLaurer/ModernBERT-base-zeroshot-v2.0/blob/main/config.json)) | Classification/NLI head | No compaction evidence. [Zero-shot card](https://huggingface.co/MoritzLaurer/ModernBERT-base-zeroshot-v2.0) reports A100 batch-128 throughput, not single-request Mac latency; author notes further training is needed to exploit the 8K window. | No free-text parse, but invalid/uncertain/truncated results must still abstain | Unmeasured on this Mac and task. Long-context quality remains unknown. |
| **mmBERT-small** (to fine-tune) | 140M total, 42M non-embedding ([base card](https://huggingface.co/jhu-clsp/mmBERT-small)) | Base supports 8,192; **sshalimov04/open-jev-base is trained/rendered at 512** ([checkpoint card](https://huggingface.co/sshalimov04/open-jev-base)) | Cross-encoder: K passes for K choice options | No compaction evidence. That checkpoint reports 30-70% of a teacher's margin over chance on three unseen tasks **after task-specific gold calibration** ([card](https://huggingface.co/sshalimov04/open-jev-base)). | Requires explicit input bounds and output validation | Unmeasured; linked code repository returned 404 during verification |
| **Qwen3.5-0.8B or Qwen3-0.6B, promptable** | 0.87B ([API](https://huggingface.co/api/models/Qwen/Qwen3.5-0.8B)) / 0.75B | 262,144 / 32,768 | Generates text unless you read logits | No published decision benchmark for this use | Grammar constraints reduce invalid text, not wrong decisions; all errors must abstain | Unmeasured; optional controls, not the preferred default |
| **LFM2.5-350M** | 350M | Native card says 32,768; MLX card says 128K/config 128,000—use **32K conservatively** pending validation | Instruction-tuned generation, or experimental fixed-label logit readout | No compaction evidence. Vendor advertises under 1 GB memory and CPU decode throughput, **not our end-to-end judge latency** ([card](https://huggingface.co/LiquidAI/LFM2.5-350M)) | Needs constrained output/validation or a separately validated decision head | Official MLX, GGUF and ONNX builds; [MLX 8-bit card](https://huggingface.co/LiquidAI/LFM2.5-350M-MLX-8bit) lists 381 MB weights, not total resident RAM |
| **Gemma 3 270M IT** | 270M | 32K ([Google model card](https://ai.google.dev/gemma/docs/core/model_card_3)) | Instruction-tuned generation | General-task benchmarks only; no compaction accuracy | Needs constrained output/validation, or task-specific training | Google documents [MLX integration](https://ai.google.dev/gemma/docs/integrations/mlx); exact tiny checkpoint performance is unmeasured. Gemma terms and gated access apply. |

Deprioritized on size: autotrust/JEV-9B and the 27B OpenJev. Non-Apache licensing alone is **not** a technical rejection. [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-350M/blob/main/LICENSE) conditions commercial rights on a $10M annual-revenue threshold; redistribution obligations also apply. [Gemma terms](https://ai.google.dev/gemma/terms) need separate review before bundling. A public MIT application does not make third-party weights MIT.

## Constraints that decide it

**Context.** About 5-7K tokens (estimate) is beyond the shipped 768-token OpenJev prefix and 512-token cross-encoder recipes. Head-only truncation can lose the final work state; tail-only truncation can lose earlier constraints. Both require evaluation, not silent adaptation. ModernBERT's 8K and LFM/Gemma's 32K offer room on paper, but tokenize each real snapshot with the exact checkpoint tokenizer and include question overhead before claiming it fits. Raising a configuration limit does not prove the model was trained to use longer inputs well.

**Published versus measured.** Parameter count tells nothing about accuracy or Apple latency. Two examples from the cards: the 0.8B Chinese model gets 72.5% against the hosted Jev's 94.3% on one synthetic set, and the 0.6B model's "104 ms" is for one short question, not a 6K-token state. Time to first token on a 6K-token state is unmeasured for every candidate.

**Cold versus warm.** No cited result establishes cold-start behavior on this machine. Loading weights, importing dependencies and first Metal compilation can dominate short decisions. A resident optional runtime avoids launching Python per checkpoint but consumes idle memory. Measure both paths and sustained resident memory.

**Licensing.** Open-jev 27B weights are non-commercial (CC BY-NC 4.0). Check the Apache or MIT items, and their base models and data licences, before shipping. The 0.6B card says dataset texts keep their own licences, including CC BY-SA 3.0 and 4.0 ([card](https://huggingface.co/IamBusy/OpenJev-0.6B)). Nothing here is legal advice.

## One stage or two

- **Two questions (current).** `done` and `shape` are separately auditable. Compute cost depends on the architecture, not just question count: the IamBusy model shares a state prefix then scores candidate branches; the mmBERT cross-encoder uses K passes for K options. Shared caching does not make both questions one universal forward pass ([IamBusy source](https://github.com/IamBusy/OpenJev/blob/v0.3.2/src/openjev/branch_model.py), [cross-encoder card](https://huggingface.co/sshalimov04/open-jev-base)).
- **One direct `safe` classifier.** May reduce work but requires measuring the tradeoff: done/shape probabilities cannot be assumed equivalent to a direct safe label. Treat the coordination weight as a policy hypothesis, not established truth for defrag.
- **Cheap gate then Jev.** A conservative first stage may skip judging clearly ineligible/no-action checkpoints; do not let an unvalidated cheap classifier authorize compaction. Measure missed safe opportunities and unsafe false positives independently. Falling back to hosted Jev for uncertain local output must be explicitly configured because it changes privacy and cost.

For safety, every combination should abstain when any stage abstains.

## Promptable versus trained

- **Promptable.** Instructions are in the request. Changing them needs no training, but accuracy on this domain is unknown, and instruction drift on out-of-distribution questions is documented: the DeBERTa model drops from 0.854 to 0.690 on new instructions ([card](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large)).
- **Trained.** Fine-tune a 100-400M encoder or a LoRA on defrag's own labels. It needs a labelled set that does not exist yet (README: no labels yet, no accuracy measured), and the README warns about correlated checkpoints within a session, so splits must be by session family.
- A distilled student still depends on the quality of its teacher. The 9B student card measures agreement with the Jev teacher, not correctness ([card](https://huggingface.co/autotrust/JEV-9B)).

## Probabilities and failing closed

Probabilities read from logits are not reliable confidence. Temperature scaling on held-out data is the standard cheap repair ([Guo et al. 2017](https://arxiv.org/abs/1706.04599)). The cards confirm the problem: the sshalimov04 cross-encoder reports ECE 0.307 raw on 77 classes and 0.055 after fitting, and warns one fit gave a calibrated probability of 0 on a gold option ([card](https://huggingface.co/sshalimov04/open-jev-base)). The kotoba card reports over-confidence of about 0.03 out of distribution ([card](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large)). Defrag should therefore:

- calibrate on a split by session family that was not used for tuning;
- keep abstain for invalid/missing/non-finite output and explicitly decide how to handle ties (current `src/jev.js` accepts tied maxima; it does not reject ties);
- never ask a generative model to state a confidence number;
- if a generative model is used, constrain output to a grammar ([llama.cpp grammars](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)) and still treat parse failure as abstention.

## Shortlist

1. **LFM2.5-350M** as the first tiny generative baseline: small, a conservative 32K window, official local formats including MLX/ONNX, and no need to adapt a 768-token recipe. It is not already a validated decision model; test constrained classification and latency. License is custom, not Apache/MIT.
2. **ModernBERT-base-zeroshot-v2.0 (149M)** as the non-generative baseline: test NLI-style done/shape hypotheses without task training, then consider a task-specific head only once enough human labels exist. Long-input quality and Mac runtime support must be verified.
3. **IamBusy/OpenJev-0.6B** as the specialized typed-decision experiment: Apache 2.0 and MPS evidence, but a **768-token shipped prefix cap**, custom loader, single seed and measured regressions. Run only with an explicitly evaluated compact snapshot or independently tested longer-prefix configuration; it is not drop-in for our existing full snapshot.
4. **Gemma 3 270M IT** as a small control, conditional on access/terms. Keep promptable Qwen sub-1B variants optional; the large configured Qwen is not the benchmark target.

Longer-term: a fine-tuned 140-149M encoder may be appropriate, but a stock encoder is not a trained compaction judge. The existing short-window mmBERT-derived checkpoint cannot inherit its base model's long-context claim.

Keep TypeSafe Jev as the reference judge. The open 27B is not a candidate for the "small" goal.

## Bounded next eval

Goal: find out whether any shortlist item is worth a larger test. Not a model selection.

1. **Prerequisites.** Obtain explicit approval for optional runtime/weight downloads; pin code and model revisions outside tracked source files. The owner need not perform downloads manually if the agent is authorized. Run offline after setup and keep `eval/` private. The inspected machine is Apple M5 Max with 128 GiB unified memory (`sysctl`); system Python is 3.14, while the IamBusy loader recommends Python 3.12, so use an isolated compatible environment rather than modifying system Python.
2. **Data.** Use the already reviewed `safe` and `unsafe` labels only (skip `uncertain`). Split by session family into calibration and test; never tune and test on one family. Choose the test size before running. A simple cap: 40 checkpoints each of safe and unsafe, or all if fewer. Report the count.
3. **Candidates.** `rules-v1`, `threshold-v1`, LFM2.5-350M and ModernBERT zero-shot first; add tiny OpenJev/Gemma only when their input recipe/access is resolved. Compare Jev predictions only on matching checkpoints; further hosted runs need their own explicit approval. Three reviewed cases are a smoke test, not a calibration or model-selection dataset.
4. **Measurements.** Per checkpoint: score, abstain flag, latency split into cold (first call after launch) and warm (median and p95), and peak RAM. Run on the actual Apple machine. Run each sequentially, no parallelism.
5. **Metrics.** Use `score` as-is: precision, recall, coverage, abstentions and false positives. The false positive (recommending compaction on an unsafe checkpoint) matters most. Add a calibration plot of predicted score against observed safe rate on the calibration split; use temperature scaling fitted there only.
6. **Input coverage test.** For the short-window recipes, compare head-only/tail-only/structured compact snapshots as separate arms and record omissions. Also test no-truncation rejection and question-overhead accounting. Do not label a model superior if it was given an easier input than its comparator without reporting that difference.
7. **Stop rules.** A candidate advances only if its false-positive rate is no worse than Jev's on the same test set and its warm p95 latency is acceptable to the owner. With this few labels, confidence intervals will be wide; report them and do not claim a ranking from overlapping intervals.
8. **Not included.** No ranking by parameter count, no latency claims copied from cards, no generated confidence, no outbound calls.

## Caveats

- Names are ambiguous and sources change. Pin exact repositories/revisions; do not treat every project called open-jev as the same implementation. The linked sshalimov04 code repository returned HTTP 404, so source inspection there remains unavailable.
- Model cards are self-reported, none of the small cards test coding-agent compaction, and I did not run anything, so every Apple Silicon claim comes from a card.
- Context-token figures for the 22 KB snapshot are my estimate, not a tokenizer count.

## Local pilot results

Following the owner's approval, optional runtimes and weights were installed
locally and a bounded pilot was run on the **Apple M5 Max, 128 GiB unified
memory**, using Python 3.12.14. This section records actual measurements; the
research-only statements above describe the earlier source review.

### Workload and reproducibility

- Three session-balanced checkpoints, the same fingerprints as the three
  existing successful TypeSafe Jev predictions. These are the complete extracted
  `state` snapshots, **not complete original conversation histories**. No human
  decisions have been entered; no accuracy can be reported on them.
- One resident process per run; one first pass, five warm passes (15 successful
  warm requests for LFM/ModernBERT). Models ran sequentially. Inference time
  includes tokenization, scoring and device synchronization. Round-trip medians
  were within 0.3 ms of the reported inference medians.
- Model revisions are in `bench/models.json`; downloaded paths and private
  reports remain under ignored `eval/`. Runtimes: torch 2.14.1,
  Transformers 5.19.0, MLX 0.32.3, mlx-lm 0.32.0; OpenJev uses its separately
  installed 0.3.2 loader at commit `5a827c549035cc4231ee77c5dd2bfcf7e42543ac`,
  Transformers 4.57.6 and PEFT 0.18.1. Install recipes are in `bench/`.
- No extra hosted requests, automatic compactions, production-default changes,
  or changes to installed host plugins. Hub inference is offline with telemetry
  disabled and `trust_remote_code=False` where supported. This is not an
  OS-enforced network sandbox. Downloading weights does contact Hugging Face,
  without checkpoint data.

### Full checkpoint snapshots

| Candidate/runtime | Model input tokens | Startup to ready | First request | Warm median / observed p95 | Completed / unique checkpoints |
|---|---:|---:|---:|---:|---:|
| LFM2.5-350M MLX 8-bit | 2,020–2,398 | 1.631 s | 507 ms | 42.0 / 47.4 ms | 3 / 3 |
| ModernBERT MPS BF16 | 1,920–2,300 | 1.624 s | 955 ms | 35.5 / 44.5 ms | 3 / 3 |
| ModernBERT CPU FP32, 4 threads | 1,920–2,300 | 1.581 s | 709 ms | 669.0 / 865.9 ms | 3 / 3 |
| Tiny OpenJev MPS BF16 | 1,727–2,060 state-prefix tokens | 2.137 s | rejected | no successful requests | 0 / 3 |
| Gemma 3 270M IT | — | — | — | — | gated access unavailable |

Tiny OpenJev's 768-token prefix cap rejected all 18 attempted requests (three
checkpoints across six passes). Those approximately 2 ms rejections are **not
inference latency**. No context cap was raised and no snapshot was shortened.
The Qwen3-0.6B base was downloaded only to load this adapter, not benchmarked as
a standalone promptable judge. The 27B OpenJev was not downloaded or run.

| Full-snapshot run | Peak process RSS | Accelerator metric (overlaps RSS) |
|---|---:|---:|
| LFM MLX | 818 MiB | 2,255 MiB peak MLX allocation |
| ModernBERT MPS | 509 MiB | 1,033 MiB maximum sampled MPS driver allocation |
| ModernBERT CPU | 1,226 MiB | — |
| Tiny OpenJev (rejected input) | 636 MiB | 1,160 MiB maximum sampled MPS driver allocation |

These are different memory counters, **not additive total RAM**. MPS driver
allocation is sampled after each response and may miss transient peaks. The
MLX peak includes temporary prefill allocation; 381 MB weights do not imply
381 MB runtime RAM. No idle-memory or energy benchmark was run.

### Decision behavior

- LFM and ModernBERT recommended **no compaction on all three** real snapshots;
  the existing Jev results recommended compaction on all three matching
  fingerprints. That is disagreement, **not evidence that either side is right**.
- On six short synthetic checks (two safe, four unsafe), **all three models
  returned unsafe on every case**: 0/2 safe cases recognized, 4/4 unsafe cases
  rejected. An always-unsafe classifier produces exactly the same result;
  "4/6 correct" would therefore be a misleading endorsement.
- Short-synthetic warm medians: LFM 6.7 ms, ModernBERT MPS 7.8 ms,
  tiny OpenJev 56.3 ms (30 warm requests each). OpenJev did successfully score
  these short inputs, so its full-snapshot failures are input coverage failures,
  not evidence of a generally broken loader.
- LFM reads single-token A/B logits, with a provisional 0.1 total label-mass
  gate. It projects only the final hidden state using the pinned model's tied
  embedding; on two short verification inputs, the A/B scores differed from
  the standard full projection by less than 0.0003 (quantized kernel rounding).
- ModernBERT scores one direct-safe NLI hypothesis. Tiny OpenJev uses exactly
  `src/jev.js`'s done/shape questions and composed policy. These are **different
  recipes**, not an architecture-only comparison. All use the initial
  pressure-dependent 0.9–0.5 threshold, which is not calibrated for either
  direct-safe classifier. No threshold or prompt was tuned against these cases.

### Verification and conclusion

Actual synthetic over-limit probes were rejected without truncation by all
three loaders: LFM 80,105 tokens, ModernBERT 40,044 tokens and OpenJev 40,062
prefix tokens. CLI fixture tests additionally cover malformed probabilities,
private diagnostics, worker exits/timeouts and explicit truncation rejection.

**Keep Jev as the intended default.** LFM/ModernBERT are fast enough to justify
further investigation, but their current recipes miss obvious safe cases.
Tiny OpenJev is not a drop-in for full snapshots. Gemma needs the owner to
approve access/terms before it can be tested. Next useful work is human labels
and separately evaluated recipe/calibration changes, not choosing the model
with the smallest latency number. Three checkpoints and six authored synthetic
cases do not support an accuracy ranking or general latency p95 claim; first
requests also include warm-up/compilation, and the OS disk cache was not flushed.
