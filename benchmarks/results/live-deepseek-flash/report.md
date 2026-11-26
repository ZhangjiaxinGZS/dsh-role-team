# Team benchmark

Mode: live

| Model | Preset | Mode | Arm | Pass@1 | pass³ | Milestone KPI | CVR | KV Cache Hit Rate | Tokens per Solved | Comm F1 | Noise Ratio | McNemar p | Wilcoxon p | Cliff’s δ | MAST Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| deepseek-account:deepseek-flash | standard | live | single-agent | 0.2778 | 0.1667 | 0.5981 | 0 | 1 | 1182162 | 0.2165 | 0 | — | — | — | 0 |
| deepseek-account:deepseek-flash | standard | live | v0.1.0 | 0.5556 | 0.1667 | 0.7602 | 0 | 1 | 7552482.8 | 0.1157 | 0.5575 | 0.1797 | 0.2888 | 0.2809 | 0 |
| deepseek-account:deepseek-flash | standard | live | v0.2.0-full | 0.3889 | 0.1667 | 0.625 | 0 | 1 | 14174346 | 0 | 0.1272 | 0.6875 | 1 | 0.037 | 0 |

## Measured provider usage

| Model | Arm | Trials | Uncached input | Cache read | Cache write | Output | Cache reads / prompt tokens |
|---|---|---:|---:|---:|---:|---:|---:|
| deepseek-account:deepseek-flash | single-agent | 18 | 117674 | 5611392 | 0 | 181744 | 0.9795 |
| deepseek-account:deepseek-flash | v0.1.0 | 18 | 1380209 | 73088256 | 0 | 1056363 | 0.9815 |
| deepseek-account:deepseek-flash | v0.2.0-full | 18 | 1571075 | 96602112 | 0 | 1047235 | 0.984 |

Counters come from assistant/message usage across the measured sessions. Auxiliary requests recorded separately, such as compaction summaries, are outside this total. DSH records uncached input, cache reads and cache writes as disjoint counts. The final column divides cache reads by the sum of these three counts.

## Scenario results

| Scenario | Arm | Passed / measured | Mean milestone KPI | Missed checks |
|---|---|---:|---:|---|
| S1 | single-agent | 2 / 3 | 0.8889 | budget × 1, latency × 1 |
| S1 | v0.1.0 | 2 / 3 | 0.7222 | budget × 1, export × 1, latency × 1, region × 1, retention × 1 |
| S1 | v0.2.0-full | 2 / 3 | 0.7222 | budget × 1, export × 1, latency × 1, region × 1, retention × 1 |
| S2 | single-agent | 0 / 3 | 0.5333 | audience × 1, budget × 1, clarified × 1, deadline × 1, decision × 3 |
| S2 | v0.1.0 | 0 / 3 | 0.5333 | audience × 1, budget × 1, clarified × 1, deadline × 1, decision × 3 |
| S2 | v0.2.0-full | 0 / 3 | 0 | audience × 3, budget × 3, clarified × 3, deadline × 3, decision × 3 |
| S3 | single-agent | 3 / 3 | 1 | — |
| S3 | v0.1.0 | 1 / 3 | 0.5833 | adapted × 1, consistent × 2, reused × 2 |
| S3 | v0.2.0-full | 1 / 3 | 0.6667 | consistent × 2, reused × 2 |
| S4 | single-agent | 0 / 3 | 0.25 | replaced × 3, resumed × 3, retained × 3 |
| S4 | v0.1.0 | 3 / 3 | 1 | — |
| S4 | v0.2.0-full | 3 / 3 | 1 | — |
| S5 | single-agent | 0 / 3 | 0.25 | closed × 3, handoffs × 3, parallel × 3 |
| S5 | v0.1.0 | 2 / 3 | 0.8333 | delivered × 1, handoffs × 1 |
| S5 | v0.2.0-full | 0 / 3 | 0.5833 | closed × 1, delivered × 2, handoffs × 2 |
| S6 | single-agent | 0 / 3 | 0.6667 | trained × 3 |
| S6 | v0.1.0 | 2 / 3 | 0.8889 | stage2 × 1 |
| S6 | v0.2.0-full | 1 / 3 | 0.7778 | stage2 × 2 |

S1 grades exact top-level JSON fields. S2 grades specified decision phrases as well as the saved facts. Missing a rubric check can reflect output format or phrasing.

McNemar uses paired success. Wilcoxon and Cliff’s δ in the table use milestone KPI versus the first selected protocol arm in canonical order. Positive δ favors the comparison arm on KPI. A dash denotes unavailable data. See summary.json for paired counts, 95% intervals, individual scenarios, learning gains and MAST counts.

## Threats to validity

- Internal: provider nondeterminism and prompt sensitivity affect comparisons. Pair the same scenario, model, preset and replicate.
- External: these six local text tasks do not establish performance on large teams or multimodal workloads.
- Construct: character counts and scripted communication checks are proxies for human workload. Human NASA-TLX and blinded ratings require separate data.
- Conclusion: three replicates have limited power. Exploratory p-values are unadjusted, with percentile intervals over observed trials. Correlated trials may narrow these intervals.

deepseek-account:deepseek-flash recorded reasoning effort: high.

The single-agent arm performs the same workspace task. It has no child seat to replace in S4, no inter-agent handoff or shared board in S5, and no persisted role training in S6. Interpret those structural checks separately from artifact correctness.

Cache rates use the prespecified denominator max(inputTokens, cacheReadTokens). For adapters reporting uncached input separately this metric can saturate at 1.0. Raw counter totals are in the trial records.

## Paired plugin version comparison

Across 18 matched scenario/repeat pairs for deepseek-account:deepseek-flash, v0.1.0 alone passed 5 and v0.2.0-full alone passed 2. Two-sided exact McNemar p = 0.4531.

## Runtime

DSH Desktop runtime 0.2.2-rc.5 with Node v26.6.0. Historical plugin v0.1.0 (f3e0b353fe894adbc36784c496c1fefc9ca31ec5). The host package and plugin file digests are recorded in environment.json.

The driver creates a fresh DSH profile, workspace, role store and session tree for every trial. The single agent receives all stakeholder cards. Teams use one card per seat and communicate through native DSH tools. The tool guard admits top-level fixture file reads, writes and edits plus the listed team and training operations. Shell and external MCP calls are outside this protocol. All arms receive the same scenario fixtures. Live session events provide usage, message and task evidence. The verifier checks workspace files and event order. Smoke trials are recorded separately from the matrix.

Trials run in fixed scenario, repeat and arm order. Fresh local state does not reset a provider’s shared prompt cache. Cache carryover and time-of-day effects can therefore influence comparisons. The S4 prefix control is a later block.

Interrupted infrastructure attempts: 1. Their usage and outcomes are excluded. See interruptions.jsonl for affected trial IDs.

## S4 cache ablation

| Model | Repeat | Suffix cache reads | Prefix cache reads | Suffix input | Prefix input | Suffix syncs | Prefix syncs |
|---|---:|---:|---:|---:|---:|---:|---:|
| deepseek-account:deepseek-flash | 1 | 1257216 | 1481600 | 61141 | 86752 | 8 | 0 |
| deepseek-account:deepseek-flash | 2 | 966272 | 789760 | 59650 | 68769 | 5 | 0 |
| deepseek-account:deepseek-flash | 3 | 1303168 | 1031168 | 58780 | 78121 | 6 | 0 |

Across 3 matched pairs the suffix arm used 179571 uncached input tokens and the prefix arm used 233642 (23.14% lower with the suffix).

Token counts aggregate all measured agents and steps. Differences in generated trajectories and request lengths can change the absolute number of cache reads.

Completed sample: 54 / 54 scheduled trials.
