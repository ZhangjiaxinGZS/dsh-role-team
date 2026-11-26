# Reproducing the team benchmark

Use Node.js 24.9 or newer from the repository root. Install repository dependencies with `npm ci`. Benchmark sources and results live outside the plugin package.

## Benchmark v2 (offline)

The [sample report](results/v2-offline/report.md) shows the completed fixture matrix. From the repository root, each run needs a new output directory.

```sh
node benchmarks/runner.ts --v2 --dry-run --out benchmarks/results/my-v2-run
node benchmarks/analyze.ts --v2 benchmarks/results/my-v2-run
```

The preflight checks the five frozen holdout cases and exercises four verifier controls for every scenario. A full run produces 150 isolated trials: 42 single-agent, 45 v0.1.0, 45 v0.2.0-full, 12 brief-only (E1–E2 and G1–G2) and 6 prefix-brief (C3–C4). G5 requires four private expert signoffs and is excluded from the single-agent arm. The seed controls order within each adjacent scenario/repeat block. The system header starts with a fresh per-trial UUID, fixed across all its agents and turns. Every arm receives the same clarification instruction and persistent workspace notebook.

The CLI uses deterministic fixture agents. The host adapter for an independently provisioned temporary DSH worker is in `drivers/v2-host.ts`; the temperature-zero sponsor and independent semantic/pairwise judge adapters are in `drivers/v2-judges.ts`. The offline CLI does not boot a provider. C1/C2 invoke native compaction and seat replacement through the port; E6 starts a fresh session for the second depot. Only C3/C4 allow the driver to write controlled brief revisions. The offline port exercises these transitions, without implying a measured DSH/provider result.

Engineering submissions are copied by declared filename after each stage. After the last turn the trusted judge compiles the snapshots and runs an external read-only Vitest suite. Candidate code runs in a separate, timed Node permission-mode subprocess with an empty environment. Agents get the stubs and shared requirements; reference implementations and acceptance cases stay outside their workspace. Artifact-only success and process milestones are reported separately. For G1/G2 the order check compares the sponsor's first substantive clarification reply to the first leader dispatch by time and then event sequence. No delegation is marked inapplicable for ordering.

Options `--max-wall-ms`, `--max-steps`, and `--max-total-tokens` apply equally to all arms. Defaults are 900000 ms, 100 aggregate steps and 1500000 tokens. Capped trials stay in the denominator as `budget_exceeded`. Before provider I/O the host reserves concurrent calls against their declared combined context windows; if remaining headroom cannot cover another call it stops conservatively. A route without a declared bound is inadmissible. Use `--usd-per-million` to supply the conversion price per million weighted units. The default of 1 is illustrative. Synthetic counters are never provider billing records.

`protocol.json` records the exact allocation and `calibration.json` the verifier outcomes. `trials/{dev,holdout}` contains per-trial clocks, native-event-shaped audit digests and outcome checks. `report.md` and `summary.json` present separate dev, holdout and archetype strata, 95% cluster bootstrap intervals and matched-arm comparisons. The five held-out scenario/fixture digests in `v2/holdout.lock.json` are frozen. Never use held-out traces to tune prompts or policies; use the dev slice.

`reviews/{dev,holdout}` contains blinded decision packets, pairs for G3/G4 and the randomized 20% human review queue. Use an independent provider for semantic coding, and have humans code the selected packets blind. Reanalyze using `node benchmarks/analyze.ts --v2 OUT ratings.json`. Ratings contain `coding` keyed by blind ID (atomic rubric-ID lists, correct assignments, first-pass specialists and preserved facts), `ratings` keyed by sampled ID (equal-length binary `judge` and `human` arrays), and `pairs` (blind left/right IDs and winner). Interpret semantic scores only after Krippendorff’s α reaches 0.80. Missing independent judgments, insufficient agreement evidence or unidentified length regressions are reported explicitly. No human agreement or model preference is imputed by the offline executor.

## Legacy pilot (S1–S6) offline validation

```sh
node benchmarks/runner.ts --dry-run --preset ptc --repeats 3 --out benchmarks/results/offline-ptc
node benchmarks/analyze.ts benchmarks/results/offline-ptc
```

The run directory must be new. The default matrix covers all five arms and six scenarios, with three independent trial directories per cell. The deterministic executor models a common static prefix, invalidates its suffix on prefix-brief revisions, and appends brief revisions separately in the full arm. It writes one native-event-shaped JSONL trace per actor and materializes the scenario deliverables. Every outcome passes through the same verifier and log parser used for live runs. The dry-run mode is **dry-run (synthetic harness validation)**. Its token counts, timing, messages and successes are generated fixtures. Repeated identical fixtures exercise aggregation; their intervals do not estimate model quality.

## Model-backed runs

```sh
node benchmarks/runner.ts --live --host-module /path/to/isolated-driver.mjs \
  --model deepseek:MODEL_ID --preset standard --repeats 3 \
  --arms single-agent,v0.1.0,v0.2.0-no-brief,v0.2.0-prefix-brief,v0.2.0-full \
  --scenarios S1,S2,S3,S4,S5,S6 --out benchmarks/results/live-standard
```

Use the provider and model ID registered by your driver. Run a separate matrix for each model, effort and preset. Supported presets are `standard` and `ptc`. Pass exactly one of `--dry-run` and `--live`. Results default to `benchmarks/results/<timestamp>`. `--host-module` is required for live trials. There is no built-in provider and no automatic fallback. Configure the same sampling settings, reasoning effort, resource budgets and role cards across arms.

### LiveHostDriver contract

The runner starts a fresh Node child process per trial. It supplies a fresh `DSH_HOME`, XDG data/config/cache directories, role store, workspace and trace directory. The environment forwards `PATH` and caller-supplied `BENCH_*` settings. Supply only dedicated test credentials. Use a trusted module that honors these paths. Process isolation is not an OS sandbox for arbitrary driver code.

### Local Desktop runtime driver

The bundled `drivers/dsh-local-driver.ts` runs the shipped DSH 0.2.2-rc.5 host programmatically in standard mode. Set `BENCH_HOST_ANCHOR` to the absolute package.json of a separately staged runtime with the base and Web bundles. Set `BENCH_V010_PACKAGE` to a built, detached worktree of tag `v0.1.0`. Build the current workspace for the full and prefix arms. For Codex, point `BENCH_CODEX_PACKAGE` at a standalone installation of `dsh-codex-subscription` with dependencies accessible from that package. Keep all staged packages outside production profiles.

For example, from the plugin checkout on a Mac with the matching Desktop application and sibling host checkout:

```sh
bench_kit=$(mktemp -d /tmp/dsh-bench-kit.XXXXXXXX)
bench_asar=$(find ../deepseek-harness/node_modules/.pnpm -path '*/node_modules/@electron/asar/package.json' -print -quit)
node -e 'require(require("node:path").resolve(process.argv[1],"..")).extractAll(process.argv[2],process.argv[3])' "$bench_asar" "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" "$bench_kit/desktop"
export BENCH_HOST_ANCHOR="$bench_kit/desktop/dsh/package.json"
export BENCH_V010_PACKAGE="$bench_kit/old"
git worktree add --detach "$BENCH_V010_PACKAGE" v0.1.0
ln -s "$PWD/node_modules" "$BENCH_V010_PACKAGE/node_modules"
npm --prefix "$BENCH_V010_PACKAGE" run build
npm pack --pack-destination "$bench_kit" dsh-codex-subscription@3.2.30
tar -xzf "$bench_kit/dsh-codex-subscription-3.2.30.tgz" -C "$bench_kit"
export BENCH_CODEX_PACKAGE="$bench_kit/package"
mkdir "$BENCH_CODEX_PACKAGE/node_modules"
for pkg in @deepseek-ai ws undici https-proxy-agent; do
  ln -s "$bench_kit/desktop/dsh/node_modules/$pkg" "$BENCH_CODEX_PACKAGE/node_modules/$pkg"
done
```

Use the same staged paths when resuming an interrupted invocation. After all runs, remove the detached worktree with `git worktree remove --force "$BENCH_V010_PACKAGE"` and delete the temporary kit.

This driver requires explicit authorization to read the local DSH login. Each fork copies only the local DSH credential document into its fresh DSH home with mode 0600. The Codex provider uses the DSH account vault. A near-expiry Codex login stops the trial before the subscription plugin can rotate its refresh token. Host stdout and stderr are suppressed. Only bounded error categories and aggregate evidence survive cleanup. Use the installed runtime and dedicated disposable credentials for independent replication.

```sh
TMPDIR=/tmp node benchmarks/runner.ts --live --resume \
  --host-module benchmarks/drivers/dsh-local-driver.ts \
  --model deepseek-account:deepseek-flash --preset standard \
  --arms single-agent,v0.1.0,v0.2.0-full --scenarios S1,S2,S3,S4,S5,S6 \
  --repeats 3 --out benchmarks/results/live-deepseek-flash
```

Run the same command separately with `--arms v0.2.0-prefix-brief --scenarios S4` in a fresh output directory for the cache control. Repeat these two commands for `openai-codex:gpt-6.2-astra`. The local driver selects `high` for every agent on that route and rejects any request header recording a different effort. Use the separate `smoke-codex-high` directory for its preflight. A smoke trial uses S1, the full arm and one repeat in its own directory. Resumption requires an identical protocol and skips already measured trials, including failed task assertions. Provider errors interrupt the run and do not become task failures. A bench-only guard confines filesystem tools to top-level fixture files and permits the team coordination and training tools. Each recorded request header must match the selected route. The actual reasoning effort is included in trial results.

The default export implements [LiveHostDriver](./types.ts). The following integration sketch assumes your own `startIsolatedHost` implementation. The Cordis setup in [the runtime tests](../test/runtime.test.ts) shows how to mount storage, JSONL persistence, workspace, agent loop, agent teams, preset and role services.

```js
import { startIsolatedHost } from './your-host-assembly.mjs'

export default {
  arms: ['single-agent', 'v0.2.0-full'],
  capabilities: ['clarification', 'pivots', 'compaction', 'reset', 'parallel-reports', 'training'],
  async runTrial(trial) {
    const host = await startIsolatedHost(trial)
    try {
      // The driver selects the actual adapter, preset and arm before starting any turn.
      await host.executeScenario(trial.scenario)
      return await host.exportEvidence(trial.traceDir)
    } finally {
      await host.dispose()
    }
  }
}
```

- Set every persistence root explicitly to a trial path. Role cards are already seeded as `<roleStoreDir>/<role-id>/role.md`. Load the requested role plugin artifact and real provider before creating sessions. For a single agent, provide the source information from all stakeholder cards and workspace documents to the one agent. Do not send verifier code or expected answers.
- Mount the historical baseline for v0.1.0. The two experimental arms require a driver-owned assembly disabling brief injection or applying revisions to the system prefix. The full arm uses the current plugin unchanged. Advertise only implemented arms and capabilities. If a requested combination cannot be exercised, throw before running the task.
- Dispatch `initialPrompt`; route actual clarification requests to `simulatedUser`. Deliver the S3 pivots at global checkpoints 4 and 7 of 10. For S4 force actual compaction, replace the member using `resetSeat`, and collect evidence from its successor. For S5 dispatch the four specialists concurrently. For S6 verify T1 before training, persist the role's sort/deduplicate lesson through 1v1 training, then start a fresh T2 conversation that receives this experience. In the first two-model matrix the single agent still executes the workspace task for S4–S6. The report identifies the team-specific structural checks, which have no single-agent analogue.
- Wait for all involved sessions to settle and flush. Export **decoded JSONL** to new files under `traceDir` (decompress persistent zstd streams if applicable). Return `traces: [{path,leader,hasBrief}]`, `workers: string[]` and time-ordered `observations`. Include root and child/generation traces exactly once. Set `leader` only on leader traces; `hasBrief` indicates that a brief existed at trace start. Without that flag the parser infers brief existence from the first sync.
- Observations are trusted **host-side** evidence. Use stable fixture role IDs across seat replacement. For clarification, capture actual questions and the final answer. For pivots, log the delivered instruction and the checkpoint of each actor's first relevant work. For compaction/reset, log committed events and subsequent work with retained facts. For assignments and board changes use recipient/owner as `actor`, and for reports use sender. For S6 emit `stage1` and `stage2` with `text: 'accepted'` only if the stage artifact passes at that checkpoint; the verifier also inspects the final files. Record the actual persisted experience as an `experience` observation. A model's claim to have completed an intervention is insufficient.
- Dispose every host and descendant process in a `finally` block; never log credentials. The runner removes its temporary directory after success or failure. An incomplete invocation exits nonzero; completed trials remain in the requested output directory.

## Results and interpretation

```text
<out>/
  trials/<scenario>_<arm>_<repeat>/metrics.json
  summary.json
  report.md
```

Only aggregate counts, verifier checks and non-secret trial identifiers are retained. Raw messages, workspaces and role files are transient. To reproduce the aggregate report from completed trial files, run `node benchmarks/analyze.ts <out>`. For the S4 cache ablation, supply the separate prefix results directory as a second argument to compare matched prefix/full trials in the same report. Compare only complete matched matrices from the same run configuration.

`pass³` is estimated separately per scenario and macro-averaged. Fewer than three repeats gives an unavailable estimate. Pairing uses model, preset, scenario and repeat; the first selected arm in canonical protocol order is the reference. McNemar tests binary success and constraint violations. Wilcoxon uses average tied ranks and continuity correction; Cliff’s δ compares the experimental sample against the baseline. Percentile bootstrap intervals for means use 10,000 draws with seed 42. Missing denominators are marked unavailable where applicable. Krippendorff’s α requires at least two pairable ratings and nonzero expected disagreement.

S2's decision units and S3–S6's milestone rubric are fixture-specific, English-language objective checks. S4 retention requires facts in post-reset work. S5 checks four report-to-deliverable handoffs and matching closed-loop board updates. S6 reports the paired difference in stage pass rates. Collapsed noise uses an 80-character estimate per report; it is not a browser measurement. Repetition counts the third and subsequent calls in an uninterrupted run of equivalent calls per session. The report identifies the three automated MAST proxies and does not infer the remaining categories or human workload scores.

## Benchmark v2.1 offline protocol

Run `node benchmarks/runner.ts --v2 --dry-run --out <new-directory>`. The default matrix covers 21 scenarios, 14 Dev and 7 frozen Holdout, across 204 scenario/arm/repeat combinations at k=3. Calibration runs four fixture classes for each scenario. Offline fixtures have a deterministic nonce and event clock; live trials use independent random nonces and monotonic wall time. Compare two fresh offline output directories recursively to verify reproducibility. The decision table uses paired primary arms, with restricted ablations shown in the scenario matrix. Synthetic rankings measure the fixture executor.

The default cost ceiling is 1,000,000 units using weights 1/0.1/1.25/4 for uncached input, cache reads, cache writes and output. S/M/L step limits are 40/100/160, with a separate 900-second wall limit. Four consecutive steps with identical failed tool arguments and result in one session and turn trigger the repeated-failure stop. All seats may use the shared scratchpad. The S2 read-only lookup separately scores compliance with its no-write instruction. Original v2 live results retain their historical protocol.

Blind coding uses a per-ticket schema and one retry for invalid responses. Rejected payloads are redacted and hashed in the trial ticket, including when the second ballot succeeds. Transport failures propagate. The v2.1 live driver writes to a version-specific directory. The offline entry point never initializes it.

### Decision score

Within each S/M/L tier, compare the three primary arms on the same scenario and repeat. Include a triple only when all three trials are available. G5 and the targeted ablations remain in the per-scenario matrix. Each matched triple has equal weight in the tier average.

| Dimension | Score per trial (0–100) |
|---|---|
| Delivery quality, Q | `100 × (0.8 × P + 0.2 × M)`. P is 1 for a verified pass and 0 otherwise. M is the fraction of milestone checks passed. |
| Collaboration experience, X | `100 / (1 + U + D)`. U counts recorded user corrections. D counts leader `send_message` events on S-tier tasks and is zero for M/L. |
| Economic efficiency, E | `50 × ((Cmin + 1)/(C + 1) + (Tmin + 1)/(T + 1))`. C is weighted cost in units, T is agent wall time in milliseconds. Each minimum is taken independently across the three arms of the same triple. |

The tier score is `0.50 × mean(Q) + 0.25 × mean(X) + 0.25 × mean(E)`. The report shows the matched denominator and tied best/worst arms. Offline fixtures use a deterministic event clock. `N/A` marks inapplicable measures, `SKIPPED (offline)` marks intentionally omitted online judgments, and `ERR/MISSING` marks expected live data that was missing or rejected.

Run the live v2.1 pilot with `node benchmarks/drivers/v2-dev-smoke.mjs --pilot`. It runs S1, G1 and L2 once on each primary arm, saves resumable tickets under `results/v2.1-live-pilot/`, and uses the same isolated host and provider-default Codex sampling as the Dev smoke test. Set `BENCH_V020_PACKAGE` to a built checkout of tag `v0.2.0` when the current plugin version has advanced.
