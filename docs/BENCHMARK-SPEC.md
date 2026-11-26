# `dsh-role-team` `benchmarks/` 自动化评测基础设施技术规范

> **执行约束（面向 Codex CLI 实现方）**：本文档是 [EVALUATION.md](./EVALUATION.md) 的工程落地规格书。所有目录结构、统计函数签名与数学公式、DSH `.jsonl` 日志解析字段、6 个场景夹具（S1–S6）、5 组消融 Arm、CLI 参数与单测要求均已锁定。**禁止**修改 `deepseek-harness` 宿主源码，**禁止**触碰用户真实 `~/.dsh` / `~/.dsh-role-team` 目录，**禁止**把 `benchmarks/` 打进插件发布包（保持 `package.json` `files` 数组不变）。

---

## 1. 目录结构

在 `benchmarks/` 下建立以下模块：

```text
benchmarks/
├── types.ts                  # 全量评测数据类型（ScenarioSpec, TrialResult, ArmStats, ComparisonReport）
├── stats.ts                  # 零外部依赖学术统计引擎（pass^k, McNemar, Wilcoxon, Cliff's δ, Bootstrap CI, Krippendorff's α, Comm F1）
├── log-parser.ts             # DSH 真实 .jsonl 会话日志解析器（TokenUsage, KV Cache, Compaction, 协调步数, 首屏噪声, 规则 MAST）
├── scenarios/
│   ├── index.ts              # 统一导出 S1–S6 场景注册表
│   ├── s1-hidden-profile.ts  # S1：5 条分散隐藏约束汇总与权衡
│   ├── s2-grounding.ts       # S2：模糊需求澄清 + 固定规则 SimulatedUser
│   ├── s3-pivot.ts           # S3：40%/70% 双次中途转向（Latency / Reuse / Coherence）
│   ├── s4-compaction.ts      # S4：长程压缩 + resetSeat 换代抗遗忘与 KV Cache
│   ├── s5-dense-reports.ts   # S5：4 成员并行密集汇报（Handoff Fidelity / Closed-Loop / 首屏 SNR）
│   └── s6-cross-task.ts      # S6：端到端两阶段任务（T1 -> 经验沉淀 -> T2，计算 Δ_learn）
├── runner.ts                 # 隔离环境 A/B 跑测器（支持 --dry-run 确定性自检与 --live 真实模型运行）
├── analyze.ts                # 聚合原始轨迹与断言结果，生成 summary.json 与学术格式 report.md
└── README.md                 # 一键复现说明（参数说明、模型配置、结果目录结构）
```

配套新增单元测试：`test/benchmarks.test.ts`（纳入 `npm test` 常规测试集）。

---

## 2. 学术统计引擎规范（`benchmarks/stats.ts`）

严禁引入重型外部统计库，全部用纯 TypeScript 精确实现并配教科书级真值单测：

1. **`passAt1(outcomes: readonly boolean[]): number`**：通过数 / 总数（空数组返回 `0`）。
2. **`passPowK(outcomes: readonly boolean[], k: number): number`**（$\tau$-bench, Yao et al. 2024）：
   - 设总试验数 $n = \text{outcomes.length}$，成功数 $c$：
   - 若 $n < k$ 或 $c < k$ 返回 `0`；
   - 否则返回无偏组合估计 $\frac{\binom{c}{k}}{\binom{n}{k}}$（逐项连乘 $\prod_{i=0}^{k-1} \frac{c - i}{n - i}$ 防止阶乘溢出）。
3. **`bootstrapCI(values: readonly number[], options?: { iterations?: number; alpha?: number; seed?: number }): { mean: number; median: number; low: number; high: number }`**
   - 默认 `iterations = 10000`, `alpha = 0.05`, `seed = 42`（使用确定性 Mulberry32 PRNG，保证同输入 100% 可复现）。
4. **`mcnemarExact(pairs: readonly [boolean, boolean][]): { b: number; c: number; pValue: number }`**
   - $b$ = `(true, false)` 计数，$c$ = `(false, true)` 计数，$m = b + c$；
   - 若 $m === 0$ 返回 `pValue: 1`；否则计算双侧精确二项检验 $p = \min\left(1, 2 \sum_{i=0}^{\min(b,c)} \binom{m}{i} 0.5^m\right)$（对数伽马或递推防溢出）。
5. **`wilcoxonSignedRank(pairs: readonly [number, number][]): { w: number; n: number; pValue: number }`**
   - 剔除差值为 `0` 的配对，按 $|d_i|$ 排序并处理并列秩（平均秩），计算 $W = \min(W^+, W^-)$；
   - 当有效对数 $n \le 20$ 且无并列秩时用精确分布枚举，否则用带连续性修正与 tie correction 的正态近似双侧 $p$ 值；$n === 0$ 返回 `pValue: 1`。
6. **`cliffsDelta(a: readonly number[], b: readonly number[]): { delta: number; magnitude: 'negligible' | 'small' | 'medium' | 'large' }`**
   - $\delta = \frac{\#(a_i > b_j) - \#(a_i < b_j)}{|a| \cdot |b|}$；
   - 效应量分级采用 Romano et al. (2006) 标准阈值：`< 0.147` negligible、`< 0.33` small、`< 0.474` medium、`>= 0.474` large。
7. **`krippendorffAlpha(units: readonly (number | null)[][], level: 'nominal' | 'ordinal'): number`**
   - 行为评委、列为样本（允许 `null` 缺失），支持名义与有序尺度，计算 $\alpha = 1 - \frac{D_o}{D_e}$。
8. **`communicationF1(precision: number, recall: number): number`**
   - $P + R === 0$ 返回 `0`，否则返回 $\frac{2 P R}{P + R}$。

---

## 3. DSH `.jsonl` 日志解析器规范（`benchmarks/log-parser.ts`）

直接解析 DSH 0.2.2 持久化会话事件流（每行一个 JSON 事件，兼容 `event` 字段或顶层 `{ type, seq, time, data }`）：

- **Token 与 KV Cache 指标**（来自 `assistant/message` 的 `data.usage`）：
  - 累加 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`（缺省 `totalTokens` 时按 `inputTokens + outputTokens` 估算）；
  - `kvCacheHitRate`: 设 `promptDenominator = Math.max(inputTokens, cacheReadTokens)`（兼容不同适配器把 `cacheReadTokens` 计入或独立于 `inputTokens` 的差异），当总分母 `> 0` 时返回 `cacheReadTokens / promptDenominator`，否则返回 `null`。
- **简报与压缩指标**：
  - `briefSyncCount`：`user/message` 中 `data.source.kind === 'team-brief'` 的条数；
  - `compactionCount`：`compaction/summary` 事件数；
  - `postCompactionResyncRate`：每次 `compaction/summary` 之后后续若仍有步骤，是否出现新的 `team-brief` 同步（仅在团队存在简报时计算）。
- **协调与工具步数**：
  - 统计 `tool/call` 与 `tool/ptc-dispatch-start`（同时兼容 Standard 与 PTC 模式！）；
  - 归类：`coordinationTools = new Set(['send_message', 'team_task_create', 'team_task_update', 'team_task_list', 'read_team_brief', 'update_team_brief'])`；
  - 输出 `coordinationSteps`、`taskWorkSteps`、`coordinationRatio = coordinationSteps / Math.max(1, coordinationSteps + taskWorkSteps)`。
- **人类首屏噪声量化（队长会话）**：
  - 统计队长回复给用户的 `assistant/message` 文本总字符 `leaderAnswerChars`；
  - 统计队友发往队长的 `user/message`（`source.kind` 为 `agent-message` / `team-message` / `subagent-settled`）的原始总字符 `rawTeammateReportChars` 与单行摘要折算字符 `compactTeammateReportChars`（按每条最多 80 字符单行摘要估算）；
  - 输出 `defaultExpandedNoiseRatio = rawTeammateReportChars / Math.max(1, leaderAnswerChars + rawTeammateReportChars)` 与 `compactCollapsedNoiseRatio = compactTeammateReportChars / Math.max(1, leaderAnswerChars + compactTeammateReportChars)`。
- **规则化 MAST 客观事件检测**：
  - `deniedToolCalls`：`tool/result` 中 `data.isError === true` 且含权限/隔离拒绝关键字的次数；
  - `staleInProgressTasks`：会话结束时 `team/task` 最终快照仍停留在 `in_progress` 的任务数；
  - `repeatedIdenticalToolCalls`：连续 3 次及以上完全相同 `name + arguments` 的工具调用次数（MAST Step Repetition）。

---

## 4. 6 个梯度场景夹具规范（`benchmarks/scenarios/`）

每个场景导出统一接口 `ScenarioSpec`：
- `id`: `'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'`
- `title`、`category`、`theoreticalBasis`（对应文献出处）
- `roles`: 最小角色卡定义数组（测试运行时写入临时 `roleStoreDir`，绝不碰用户真实角色）
- `seedWorkspace(dir: string): Promise<void>`：初始化干净临时工作区文件
- `initialPrompt`: 发给队长的初始指令
- `simulatedUser?`: 确定性应答函数（根据队长提问关键词返回固定答复，用于 S2 / S3 / S6）
- `pivots?`: 预设中途转向触发点与转向指令（用于 S3 / S6）
- `verify(ctx: VerifyContext): Promise<ScenarioVerification>`：纯客观断言函数，返回：
  - `passed: boolean`（Tier 2 客观全通过）
  - `constraintViolations: number`（Tier 1 红线违背计数）
  - `milestoneKpi: number`（0..1，已达成里程碑 / 总里程碑）
  - `hiddenFactsPooled?: number` & `hiddenFactsTotal?: number`（S1）
  - `clarificationCoverage?: number` & `commPrecision?: number` & `commRecall?: number`（S2）
  - `adaptationLatencySteps?: number` & `postPivotCoherence?: number`（S3）
  - `postCompactionRetention?: number`（S4）
  - `handoffFidelity?: number` & `closedLoopRate?: number`（S5）
  - `stage1Passed?: boolean` & `stage2Passed?: boolean`（S6，用于计算 $\Delta_{\text{learn}}$）
  - `details: Record<string, unknown>`

---

## 5. 跑测器与分析报告器（`runner.ts` / `analyze.ts`）

### 5.1 5 组消融 Arm 定义
`type AblationArm = 'single-agent' | 'v0.1.0' | 'v0.2.0-no-brief' | 'v0.2.0-prefix-brief' | 'v0.2.0-full'`

### 5.2 运行模式
- **`--dry-run`（CI / 离线确定性验证模式）**：
  - 不调用外部付费 LLM API；使用确定性模拟执行器按每个 Arm 的真实架构差异（例如 `v0.2.0-prefix-brief` 变更简报时重置缓存前缀、`v0.2.0-full` 保持静态前缀并走增量后缀、`v0.1.0` 无简报且全展开噪声）生成标准格式的 DSH `.jsonl` 轨迹 + 工作区产物，完整跑通 `seedWorkspace → verify → log-parser → stats → analyze`，写入临时目录并校验报告结构。
  - **报告中必须显式标注 `mode: "dry-run (synthetic harness validation)"`，绝不可伪装成真实模型实测数据！**
- **`--live`（真实模型 A/B 实测模式）**：
  - CLI 参数：`--live --arms single-agent,v0.1.0,v0.2.0-full --scenarios S1,S2,S3,S4,S5,S6 --model <provider:model> --preset standard|ptc --repeats 3 --out benchmarks/results/<run-id>`；
  - 每次试验在完全独立的临时 `DSH_HOME` + 临时 `roleStoreDir` + 临时 `workspace` 中启动隔离 DSH Host（复用 `dsh-role-team` 已有原生测试宿主装配方式，不污染用户真实数据），执行完整试验并保留脱敏后的 `metrics.json` 与聚合统计。

### 5.3 报告输出（`analyze.ts`）
给定结果目录，自动生成：
1. `summary.json`（完整机器可读结果、置信区间、显著性检验、MAST 统计）；
2. `report.md`（符合学术表格格式：Model / Preset / Mode / Arm / $\text{Pass@1}$ / $\text{pass}^k$ / Milestone KPI / CVR / KV Cache Hit Rate / Tokens per Solved / Comm $F_1$ / Noise Ratio / McNemar $p$ / Wilcoxon $p$ / Cliff's $\delta$ / MAST Failures + 自动附加 Threats to Validity 备注）。

---

## 6. 验收标准

1. `npm run typecheck && npm run build && npm test` 全量通过（含新增 `test/benchmarks.test.ts`，覆盖全部统计函数真值、`.jsonl` 日志解析、S1–S6 正/反例断言校验、`--dry-run` 端到端产出合法 `summary.json` 与 `report.md`）。
2. `package.json` 的 `files` 字段保持不变（`npm pack --dry-run` 确认 `benchmarks/` 不进入发布包）。
3. 零改动 `deepseek-harness` 源码，零触碰用户真实目录，清理所有临时运行产物。
