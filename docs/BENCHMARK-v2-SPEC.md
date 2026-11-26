# `dsh-role-team` Benchmark v2 学术级评测规格书（扩量、去偏与全流程可审计版）

> **定位**：基于首轮 114 试次（DeepSeek Flash + Codex `gpt-6.2-astra`）的真实排雷审计，结合 *CollabLLM* (ICML 2025)、*SWE-bench*、*MultiAgentBench* (ACL 2025)、*$\tau$-bench* (2024)、*MAST* (2025)、*AlpacaEval 2.0* (COLM 2024) 与组织行为学文献（Burke 2006 / Stasser & Titus 1985 / Salas 2005），将评测体系从「6 题先导实验」升级为「**15 题 × 3 重复、双语去偏、裁判自检、全流程可审计**」的学术级评测协议。

---

## 1. 指标瘦身与补漏审计（为什么保留这些、砍掉那些）

相比首轮草案，v2 对指标做了**「3 增 3 减」**，避免指标堆砌自嗨，确保每一项都有不可替代的评测目的：

### 主动补齐的 3 个业界关键维度（参考 CollabLLM / SWE-bench / 2025 MAS Survey）
1. **端到端墙钟耗时（Wall-Clock Time to Resolution, $p_{50}$ / $p_{95}$）**：只看准确率不看时间会掩盖“慢 10 倍换 5% 提升”的伪收益；与成本共同构成 **Cost/Latency vs. Accuracy 帕累托前沿**。
2. **用户努力度（User Effort / Turn-to-Completion, CollabLLM ICML 2025）**：统计用户需要发几轮消息、纠偏几次才完成任务，防止团队为刷澄清分而把用户问烦。
3. **跨成员重复劳动率（Cross-Agent Redundancy）**：从工具日志客观统计不同成员重复读取完全相同文件或重复执行相同只读查询的比例，直接量化任务拆解是否低效。

### 主动砍掉 / 合并的 3 项冗余指标
1. **合并 `Leader Information Density` 与 `Comm Precision`**：两者本质都在测队长自然语言回复里的有效信息占比，统一收敛进 **语义级 `Communication F1`**（`Precision` = 有效信息密度，`Recall` = 必含决策要素召回率）。
2. **移除硬编码英文词频的 `Closed-Loop Rate`**：其核心含义已被 `Handoff Fidelity`（跨跳约束保真）+ `Internal First-Pass Yield`（零追问一次做对）+ `MAST Stale Tasks` 完整且更客观地覆盖。
3. **降级 `Noise Ratio` 为 UI 辅助指标**：改名为 `Teammate Report Screen Share`，仅用于多智能体版本间对比（`single-agent` 显式标 `—`），不与核心交付指标混排。

---

## 2. 最终 12 项核心指标总表（互不重叠、逐项可计算）

| 支柱 | # | 指标名 | 测什么（核心目的） | 具体怎么测（客观算法 / 校准） | 适用臂 |
|---|---|---|---|---|---|
| **一、公平结果** | **1** | **Artifact-Only Pass@1** | 纯交付物有没有做对（剥离团队过程仪式，公平对比单 Agent） | 仅检查最终代码/单测/文件语义结果；通过试次数 ÷ 总试次数 | 全部臂 |
| | **2** | **Artifact-Only pass³** | 交付稳定性（专打“蒙对一次”） | 按每题算 $\binom{c}{3}/\binom{n}{3}$ 后跨题取均值 | 全部臂 |
| | **3** | **Milestone KPI** | 过程细粒度完成度（区分完成 80% 与彻底失败） | 单次达成检查点数 ÷ 总检查点数，跨试次取均值 | 全部臂 |
| | **4** | **Constraint Violation Rate (CVR)** | 安全底线（触碰硬性红线即一票否决） | 违背预设禁用约束的试次占比 | 全部臂 |
| **二、人机交互（外环）** | **5** | **Clarification & Pre-Delegation Order** | 需求模糊时是否**先**向用户问清核心要素再动手/派单 | 问齐缺失要素比例 + 事件时间戳断言（首轮澄清必须早于首次 `send_message`） | 全部臂（时序仅团队） |
| | **6** | **Semantic Communication F1** | 队长给用户的自然语言是否“又全又简”（有效信息 vs 废话） | 将回复拆分为原子信息单元：$P$ = 有效决策单元占比，$R$ = 覆盖必含决策要素比例；异源评委 + 20% 人工盲审 **Krippendorff's $\alpha \ge 0.80$** | 全部臂 |
| | **7** | **User Effort (Turns & Corrections)** | 人类操作负担（用户要来回聊几轮、纠偏几次） | 统计达到完成所需的总用户消息轮次与人工纠偏次数 | 全部臂 |
| **三、内部组织（内环）** | **8** | **Delegation Appropriateness** | 队长是否合理派发（抓单干越权 / 乱派） | 跨专业任务中准确派给对应专职成员的比例（不含单步简单快问） | 仅多智能体 |
| | **9** | **Internal First-Pass Yield & Handoff Fidelity** | 队长↔队员沟通是否清晰、跨跳传话是否失真 | 队员零追问一次做对率 + 跨角色传递后关键约束保留率 | 仅多智能体 |
| | **10** | **Adaptation & Continuity** | 中途转向适应力与长程压缩/换代抗遗忘 | 转向同步延迟 `Latency` + 转向后自洽度 `Coherence` + 压缩/换代后事实保留率 | 全部臂（换代仅团队） |
| **四、效率与成本** | **11** | **Wall-Clock Time ($p_{50}$/$p_{95}$) & Cross-Agent Redundancy** | 实用速度与分工重复劳动 | 端到端耗时分位数 + 不同成员重复读取相同只读目标的占比 | 全部臂（重复率仅团队） |
| | **12** | **Tokens per Solved & Prompt Cache Share** | 算力性价比与 KV Cache 经济性 | `总 Token / 纯产物通过数`；真实缓存占比 $\frac{\text{cacheRead}}{\text{uncachedInput} + \text{cacheRead} + \text{cacheWrite}}$ | 全部臂 |

**附：3 项辅助诊断指标（单独列表，不混入主表）**
- **Length-Controlled Win Rate (LC-WR)**：对复杂开放综合题做异源成对盲评 + 长度回归去偏；
- **Teammate Report Screen Share**：多智能体版本间队长窗口默认噪声对比（`single-agent` 标 `—`）；
- **MAST Failure Proxy Count**：越权拒绝 + 僵尸 `in_progress` 任务 + 连续 $\ge 3$ 次死循环调用。

---

## 3. 场景扩量设计（15 题 × 3 重复 = 每组 45 对配对样本）

告别玩具 JSON 填空，分为 **3 个梯队、共 15 道独立任务**（确保统计功效足以检验中等效应量 Cliff's $\delta \ge 0.35$）：

1. **梯队 A：真实代码工程与单测裁判（6 题，`E1–E6`）**
   - 全部自带真实小型 TypeScript/Node 项目 + 客观 `vitest` 单元测试集（**由编译器与测试套件 100% 客观裁判，零字面正则误差！**）：
   - `E1–E2`：隐藏剖面多模块改造（安全/性能/兼容约束分散在文档与不同专家角色卡中）；
   - `E3–E4`：中途 2 次接口/需求转向（测转向延迟、复用率与跨模块接口自洽）；
   - `E5`：多模块并行开发与集成联调（3–4 名专职成员并行改不同模块 + 集成测试）；
   - `E6`：两阶段跨任务代码迁移（$T_1 \rightarrow$ 复盘沉淀经验 $\rightarrow T_2$，测 $\Delta_{\text{learn}}$）。
2. **梯队 B：人机对齐与信息综合决策（5 题，`G1–G5`）**
   - `G1–G2`：模糊需求澄清（缺 3–4 项核心约束，由异源低温度模拟用户按固定事实卡应答）；
   - `G3–G4`：多源冲突信息调研综合（存在成本/性能/合规冲突，需给出帕累托权衡方案，测 `Communication F1` 与 `LC-WR`）；
   - `G5`：高密度 4 专家并行评审汇总（测 `Handoff Fidelity`、`Internal First-Pass Yield` 与首屏噪声）。
3. **梯队 C：长程状态连续性与缓存经济性（4 题，`C1–C4`）**
   - `C1–C2`：长上下文触发原生 `/compact` + 成员 `resetSeat` 换代续接（测压缩记忆保持、简报重同步）；
   - `C3–C4`：多轮渐进变更下的 **Suffix Brief vs. Prefix Brief** 配对消融（直接验证长程场景下的真实 KV Cache 经济性差异）。

---

## 4. 全流程防作弊与质量门禁（解决首轮审计发现的全部 6 类漏洞）

1. **裁判自检集（Verifier Calibration，开跑前强制通过）**：
   - 每道题的 Verifier 必须通过 **4 类对抗单测**：① 标准正例；② 等价变体正例（中文回答、嵌套 JSON、同义词、乱序提问）必须 **0 误杀**；③ 敷衍/作弊反例（无关文本含数字 `7`、废话凑长度、先委派后澄清）必须 **0 漏放**；④ 边界截断反例。
2. **语言去偏（Language Neutrality）**：
   - 统一双语或纯中文协议，**严禁**对中文协作产物用纯英文关键词正则判分；JSON 产物统一在 Prompt 中给出明确 Schema 且 Verifier 支持合理嵌套/类型归一化（如 `80` 与 `"80 credits"` 均正确解析数值），消除格式冤杀。
3. **升级模拟用户（Fact-Card + 异源低温度模拟用户）**：
   - 放弃死板正则，改用「**结构化事实卡 + 固定 `temperature = 0` 异源模型**」扮演用户：仅回答 Agent 明确问到的槽位，绝不主动泄题，能自然理解中英文同义提问与任意提问顺序；所有模拟用户对话全部落盘接受事后审计。
4. **配对顺序随机化（Randomized Arm Order）**：
   - 每个 `(scenario, repeat)` 内用确定性种子随机打乱 `single-agent / v0.1.0 / v0.2.0-full` 的执行顺序，消除服务端共享缓存与时段波动的系统性偏差。
5. **脱敏过程审计包（Auditable Trace Digest）**：
   - 每个 trial 导出脱敏过程摘要（事件序号、时间戳、角色、工具名、路由 `request/header`、原生 `usage`、`compaction` 节点、脱敏消息文本，绝对不含凭据或本机路径），第三方可逐条回放验证过程真实性。
6. **统计严谨性**：
   - 主表全部展示 12 项核心指标 + 95% Bootstrap CI + 配对 McNemar $p$ / Wilcoxon $p$ / Cliff's $\delta$，并报告多重检验校正提示（Holm-Bonferroni）与 `Krippendorff's α`。

---

## 5. 实验执行协议硬性门禁（修复首轮流程审计的 7 项结构性缺陷）

以下 7 条为 `Benchmark v2` Driver、Runner 与 LogParser 的**强制执行协议**，缺一不可：

1. **起点信息对等（消除 Single-Agent 全图挂偏置）**：
   - 所有用于「单 Agent vs 多智能体公平对比」的场景，业务约束必须**全部客观存放在共享工作区文件**中，**严禁**像 v1 那样把其他角色的 `privateContext` 直接塞进 `single-agent` 的初始 Prompt。
   - 若某题专门测「跨角色知识孤岛与跨跳保真」（`Handoff Fidelity`），须显式标记 `multiAgentOnly: true`，不与开了全图挂的 `single-agent` 做直接胜率对比。
2. **跨试次服务端 Prompt Cache 隔离（`trialNonce`）**：
   - 每个 trial 生成唯一 UUID `trialNonce`，注入该 trial 静态系统头（**试次内全程恒定，试次间绝不重复**），彻底切断云端账号级跨试次/跨臂热缓存串味，同时 100% 保留试次内多轮 KV-Cache 复用。
3. **区分「可控机制消融」与「自主能力评测」（撤掉脚本代打）**：
   - `C3–C4`（Suffix vs Prefix 缓存消融）保留 Driver 统一写入相同 brief 变更，确保自变量纯净；
   - `C1–C2`（长程抗遗忘）与 `E6`（跨任务学习）**禁止外部脚本代调用 `saveTeamBrief` 或强行开 `coach` 喂记忆**，只发真实用户指令，评测团队自主维护简报与沉淀经验的真实能力。
4. **外置只读验收测试与最小权限（防 Reward Hacking）**：
   - `E1–E6` 的评分用 `vitest` 测试集存放于**工作区外的只读裁判目录**，仅在 trial 结束后由 Harness 注入运行评分，Agent 无法看到或篡改验收测试；
   - 非代码/只读评审题按角色收紧工具写权限，确保 `CVR` 与 `MAST deniedToolCalls` 真实有效。
5. **去噪墙钟计时与结构化模拟用户状态机**：
   - 模拟用户（Fact-Card + `temp=0` 异源模型）输出结构化判定 `NEED_ANSWER | TASK_DONE`，废除脆弱的问号正则截断；
   - `Wall-Clock Time` 拆分为 4 段独立记录：`agentWallMs`（总耗时扣除 `setupMs`、`simUserMs` 与 `retryBackoffMs`）、`setupMs`、`simUserMs`、`retryBackoffMs`，主表仅报纯净的 `agentWallMs`；同一 `(scenario, repeat)` 的各臂在紧邻时间窗内随机顺序跑完（配对区组设计）。
6. **修正底层 Token / Cache 计算公式**：
   - `log-parser.ts` 彻底废弃 `Math.max(inputTokens, cacheReadTokens)`，统一改为真实缓存占比 `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`，并新增 `Cross-Agent Redundancy`（不同成员重复调用相同只读目标统计）。
7. **定向组件消融（消除多特性打包归因混淆）**：
   - 主矩阵保持 3 臂（`single-agent` / `v0.1.0` / `v0.2.0-full`）；
   - 额外提供 2 组定向消融臂：`v0.2.0-prefix-brief`（仅跑 `C3–C4`，隔离后缀简报缓存收益）与 `v0.2.0-brief-only`（仅跑 `G1–G2` + `E1–E2`，隔离 Team Brief 与队长协作策略各自的独立贡献）。
8. **强单智能体对等基线（消除不对称 Prompt Engineering 偏置）**：
   - 参考 *AI Agents That Matter* (Kapoor et al., TMLR 2024) 与 2025 单/多智能体公平对比规范：`single-agent` 基线不得是“裸奔提示词”，必须享有与团队队长**完全对等的外部持久草稿本能力与“需求模糊先澄清再动手”通用提示**，确保多智能体的胜出纯粹来自**角色上下文隔离与并行协作架构**，而非不公平的 Prompt 偏袒。
9. **缓存加权有效成本（Effective Cost）与硬性试次安全上限**：
   - 原始 `totalTokens` 直接相加会抹杀 98% KV-Cache 命中的真实省钱价值（实际计费中 `cacheRead` 仅为未缓存输入的 ~0.1×，而 `output` 为 ~4×）。`stats.ts` 与主表必须在 `Tokens per Solved` 旁同步报告 **缓存加权有效成本（Weighted Cost Units & 估算 USD）**；
   - 所有臂统一施加硬性资源上限（`maxWallMs`、`maxSteps`、`maxTotalTokens`），触顶显式记为 `budget_exceeded` 失败，防止单次死循环拉爆均值与配额。
10. **任务结构分层报告（Task-Type Stratification）**：
    - 每道场景必须标注结构类型标签：`parallel-read-synthesis`（并行信息综合）、`multi-module-isolation`（多模块隔离工程）、`sequential-pivot`（串行中途转向）、`long-horizon-continuity`（长程压缩/换代连续性）；报告除汇总总分外，必须按结构类型分层输出，防止“并行题大赢 + 串行题微亏”互相抵消掩盖真实边界。
11. **开发集 / 冻结留出集划分（Dev vs. Holdout Split，防过拟合）**：
    - 15 道场景显式标注 `split: 'dev'`（10 题）与 `split: 'holdout'`（5 题，覆盖全部 3 梯队）；后续调优插件提示词或策略时，**严禁**查看 `holdout` 题的 trace 来定向打补丁，报告分开列出 `dev` 与 `holdout` 成绩以检验泛化能力。

## 6. v2.1 一页决策总榜

在 S、M、L 各档按同题同轮配对。仅当单体、v0.1.0、v0.2.0-full 三个主臂均有试次时，该组才进入榜单，各组等权。单列的 G5 与定向消融臂可在逐题矩阵查看。分母同时列出配对数与计划数，首尾同分并列。

| 维度 | 单试次得分（0–100） |
|---|---|
| 交付质量 Q | `100 × (0.8 × P + 0.2 × M)`。P 为产物最终通过标志（0 或 1），M 为已通过里程碑检查占比。 |
| 协作体验 X | `100 / (1 + U + D)`。U 为记录的用户纠正次数，D 为 S 档队长发起的 `send_message` 次数，M/L 档取 0。 |
| 经济效率 E | `50 × ((Cmin + 1)/(C + 1) + (Tmin + 1)/(T + 1))`。C 为缓存加权成本单位，T 为剔除准备、模拟用户及退避时间后的智能体耗时（毫秒）。Cmin、Tmin 分别取同题同轮三个主臂的最低值。 |

各档综合分为 `0.50 × mean(Q) + 0.25 × mean(X) + 0.25 × mean(E)`。离线示例使用确定性事件时钟。报告以 `N/A` 标记不适用，以 `SKIPPED (offline)` 标记离线按协议跳过的线上裁判，以 `ERR/MISSING` 标记真机应采集但缺失或全部拒收的数据。
