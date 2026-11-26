# `dsh-role-team` Academic Evaluation Protocol & Benchmark Framework

> **定位**：本文档定义 `dsh-role-team` 的学术级评测协议（对标 ACL / ICSE / CHI / CSCW Artifact Evaluation 规范）。协议采用**「公认方法论对齐 + 批判性盲区补齐」**双层结构：既复用社区公认的可靠性、失败分类与统计检验标准，也针对现有基准的盲区设计可复现的消融与诊断实验。

---

## 1. Motivation：现有多智能体基准的批判性盲区分析

现有主流 Agent 评测基准在单点能力上贡献显著，但在评估**「人在环、长程、可持续进化的多智能体协作系统」**时存在四类系统性盲区：

| 外部基准 | 核心贡献（本文复用） | 结构性盲区（本文补齐） |
|---|---|---|
| **MultiAgentBench / MARBLE** (Zhu et al., ACL 2025) | 多智能体拓扑对比、过程里程碑 **Milestone KPI** | **无人在环**：封闭自主运行，无法衡量人类指挥官的注意力瓶颈、汇报清晰度与认知过载。 |
| **TheAgentCompany** (Xu et al., CMU, 2024/2025) | 真实软件工程环境、基于最终世界状态的客观检查点 | **本质为单 Agent**：模拟同事为固定脚本 NPC，无法测出真实多 Agent 间的信息交接失真（Handoff Distortion）与并行冲突。 |
| **$\tau$-bench** (Yao et al., Sierra, 2024) | 严格稳定性指标 **$\text{pass}^k$**、规则化模拟用户 | **短程单 Agent 客服**：十几轮即结束，不触发长上下文压缩、无多角色分工与长期经验沉淀。 |
| **MAST** (Cemri et al., UC Berkeley, 2025) | 1,600+ 轨迹实证的 **14 类失败分类学**（$\kappa=0.88$） | **仅事后验尸**：只诊断失败原因，不度量交付上限质量、算力性价比（KV Cache）或跨任务成长。 |

上述盲区恰好覆盖了 `dsh-role-team` 的四项核心架构设计：**① 人在环认知减负**（统一 3-Tab 面板、拓扑无关单行降噪、团队简报）；**② 长程状态连续性与 KV-Cache 经济性**（静态前缀 + 增量后缀同步 + 压缩/换代续传）；**③ 跨任务角色长期经验复用**（Role Library & 1v1 培养）；**④ 模式与执行器无关韧性**（Standard / PTC / Minimal / 外部适配器通用）。

---

## 2. 双环评价体系与标准化指标定义

将人机多智能体团队抽象为**「外环（队长 ↔ 用户）× 内环（队长 ↔ 队员 / 成员间数据流）× 终局裁判（Outcome）」**三层结构，所有指标均有明确文献出处与可计算定义：

### 2.1 终局裁判：安全底线 × 客观达标 × 上限质量

1. **Tier 1 安全底线（Guardrail Gate，必要条件 / 一票否决）**：
   - **Constraint Violation Rate (CVR)**：触犯预设硬性红线（安全、依赖、路径、权限边界）的任务占比。CVR > 0 直接判定该次运行未达标。
2. **Tier 2 客观达标与稳定性（Functional Reliability）**：
   - **$\text{Pass@1}$**：单次独立运行通过全部客观状态断言的比例。
   - **$\text{pass}^k$**（Yao et al., 2024）：同一任务连续 $k$ 次独立运行**全部通过**的概率估计（本协议默认 $k=3$），消除单次偶然成功。
   - **Milestone KPI**（MultiAgentBench, ACL 2025）：任务拆解为 $M$ 个客观里程碑检查点后的平均达成率 $\frac{1}{M}\sum_{j=1}^M \mathbb{I}(\text{milestone}_j)$。
   - **Hidden Profile Information Pooling Rate**（Stasser & Titus, 1985）：分散在不同角色/文档中的 $U$ 条未共享关键约束，最终被团队正确汇聚并体现在交付方案中的比例 $\frac{|U_{\text{pooled}}|}{|U|}$。
3. **Tier 3 综合上限质量（Excellence Beyond Compliance）**：
   - **Length-Controlled Pairwise Win Rate (LC-WR)**（Dubois et al., COLM 2024）：将对照组与实验组的匿名产出成对提交给异源评委模型（及抽样人工盲评），使用 GLM 回归剥离篇幅偏差（Length Bias），评估在冲突约束下的**权衡质量与综合严密性**。
   - **Cross-Task Learning Gain ($\Delta_{\text{learn}}$)**：同一角色团队完成 Task $T_1$ 并通过 1v1 复盘沉淀长期经验后，在同域变体任务 $T_2$ 上的 $\text{Pass@1}$ 增益、返工步数降幅与红线违背降幅。
4. **失败模式分布（Diagnostic Taxonomy）**：
   - **MAST 14-Mode Failure Count**（Cemri et al., 2025）：按 Specification/System Design、Inter-Agent Misalignment、Task Verification 三大类 14 子类统计轨迹失败事件。

### 2.2 内环：内部数据流与转向适应性（Galbraith OIPT / Salas / Burke）

拒绝仅用“协调步数”衡量协作，采用 4 个互补数据流指标 + 3 个转向适应指标：

1. **Handoff Fidelity（交接保真率）**：关键约束与事实在「用户 → 队长 → 队员 → 队长」跨跳传递后的保留率（量化传话筒失真）。
2. **Closed-Loop Communication Rate（闭环率，Salas et al., 2005）**：派单包含「目标 + 约束 + 验收标准」且回执包含「状态 + 结论/卡点 + 任务板同步」的闭环比例。
3. **Clarification / Re-Dispatch Rate（澄清与返工派单率）**：因上一跳指令不清导致二次追问或做偏重派的交互占比。
4. **Adaptation Quality（团队转向适应性，Burke et al., *JAP* 2006）**：
   - **Adaptation Latency**：用户变更方向后，全队所有活跃成员切入新轨道的平均滞后步数；
   - **Artifact Reuse vs. Sunk-Cost Waste**：转向后可复用中间产物的保留率与无效废弃工作量占比；
   - **Post-Pivot Coherence**：转向后新旧模块接口与口径的全局自洽度（防“缝合怪”）。

### 2.3 外环：人机沟通质量与认知负荷（Grice / Clark & Brennan / Team Topologies）

摒弃单一信噪比（防止“极短但空洞”的伪高信噪比），采用**充分性 × 行为可行动性 × 认知负荷**：

1. **Communication $F_1$（充分度 × 简洁度调和分）**：
   - $\text{Recall}_{\text{comm}}$：回复覆盖下一步决策所需的最小充分要素集（结论、依据、风险/阻塞、需拍板项）的比例；
   - $\text{Precision}_{\text{comm}}$：非冗余有效信息占比；$F_1 = \frac{2 \cdot P \cdot R}{P + R}$。
2. **Downstream Actionability / First-Pass Yield（一次对齐/做对率）**：接收方（模拟用户或队员）仅凭该消息即可零追问做出正确下一步动作的比例。
3. **Human-Facing Cognitive Load**：
   - **默认首屏噪声占比**：队长窗口默认展开给用户阅读的字符中，队友内部过程报文占比；
   - **人工纠偏次数**：长程任务中用户被迫重复提醒既有决定的次数；
   - **NASA-TLX**（Hart & Staveland, 1988）：小样本人类盲评主观认知负荷（0–100 量表，6 维度）。

### 2.4 算力公平性与缓存经济性（消除 Compute Confound）

直接解析 DSH 持久化 `.jsonl` 中的 `assistant/message.usage` 事件：
1. **Effective Token Cost per Solved Task**：$\frac{\sum \text{Total Tokens}}{\text{Solved Tasks}}$（排除靠多烧算力换指标的混淆）。
2. **Prompt Prefix KV Cache Hit Rate**：$\frac{\sum \text{cache\_read\_tokens}}{\sum \text{total\_input\_tokens}}$，用于消融验证静态前缀 + 增量后缀注入对长会话缓存的保护效果。

---

## 3. 实验设计：5 组消融对照、双模型矩阵与 6 梯度场景

### 3.1 5 组阶梯消融对照（Ablation Arms）

所有对照严格共享同一初始工作区快照、同一模型与推理档位、同一 `agentPreset`（`standard` 或 `ptc`）、同一模拟用户答复表与同一客观验收脚本：

| 对照组 | 配置说明 | 验证假设 |
|---|---|---|
| **Arm 0: `Single-Agent`** | 同模型、同工具、不拆团队 | 验证多角色团队相对单 Agent 的净增益（回应 MAST 核心质疑） |
| **Arm 1: `v0.1.0`** | 角色团队基线（无简报、无降噪） | 历史版本基线 |
| **Arm 2: `v0.2.0-no-brief`** | 仅启用拓扑降噪与统一面板，关闭简报 | 剥离 UI 降噪对人类认知负荷的独立贡献 |
| **Arm 3: `v0.2.0-prefix-brief`** | 简报直接拼入 `systemPrompt` 前缀 | 定量对比静态前缀 vs 动态前缀对 **KV Cache 命中率与成本** 的影响 |
| **Arm 4: `v0.2.0-full`** | 完整版（增量后缀简报 + 压缩续传 + 拓扑降噪 + 统一面板） | 验证完整架构的综合收益 |

### 3.2 模型矩阵与重复次数

- **Matrix A（快模型压力组）**：全队 `DeepSeek Flash` —— 检验插件结构对轻量快模型抗漂移、抗遗忘的托底能力。
- **Matrix B（强模型 / 混编组）**：`Codex` 主力模型（全队 Codex，及可选 `Codex 队长 + DeepSeek Flash 队员` 混编）—— 检验在高推理能力模型上是否仍有降噪、省 Token、保缓存与减少返工的净收益。
- **重复次数**：每场景每 Arm 至少独立运行 **$k = 3$ 次**（计算 $\text{pass}^3$、均值、中位数与 Bootstrap 95% CI）。

### 3.3 评测任务套件（公开基准子集 + 6 梯度诊断场景）

- **外部对齐子集**：适配自 MultiAgentBench（Coding / Research Collaboration）与 TheAgentCompany 风格的多角色本地检查点任务。
- **专项诊断套件（S1–S6）**：
  - **S1（Hidden Profile 信息汇总）**：5 条互制约隐藏约束分散在不同角色与文档中，测信息汇总率与权衡质量。
  - **S2（模糊需求对齐）**：故意缺失 3 个核心要素，由固定规则「模拟用户」应答，测核心要素澄清率与 Communication $F_1$。
  - **S3（双次中途转向）**：40% 与 70% 进度点两次调整约束，测 Adaptation Latency、复用/沉没比与 Post-Pivot Coherence。
  - **S4（长程压缩 + 成员换代）**：强制触发 `compaction/summary` 与 `resetSeat`，测记忆保持率与 KV Cache 命中率。
  - **S5（高密度多成员汇报）**：4 成员并行交付长报告，测首屏噪声占比、Handoff Fidelity 与 Token 效费比。
  - **S6（端到端复杂工程 + 跨任务学习）**：连续执行 $T_1 \rightarrow$ 1v1 复盘沉淀经验 $\rightarrow T_2$，全维度联合评估并计算 $\Delta_{\text{learn}}$。

---

## 4. 统计检验与评委一致性规范

1. **配对显著性检验**：
   - 二元指标（$\text{Pass@1}$、CVR）：**McNemar's Test**（报告双侧 $p$ 值）；
   - 连续/有序指标（Milestone KPI、Pooling Rate、KV Cache Hit Rate、Token、Latency）：**Wilcoxon Signed-Rank Test** + **Cliff's $\delta$ 效应量** + **10,000 次重采样 Bootstrap 95% 置信区间**。
2. **LLM-as-a-Judge 校准**：
   - 评委模型必须与被测模型**异源**（禁止同家族自评），且成对盲评时交换 A/B 顺序消除位置偏差（Position Bias）；
   - 随机抽取 20% 轨迹由人工双盲复核，公开报告 **Krippendorff's $\alpha$**（可靠性门槛 $\alpha \ge 0.80$）。

---

## 5. Threats to Validity（效度威胁声明）

按 ICSE / ACL 规范在最终实验报告中显式披露四类效度边界：
1. **Internal Validity（内部效度）**：不同模型对相同提示词模板敏感度不同；多轮工具调用受外部环境与模型非确定性影响（通过固定快照、异源评委、$k=3$ 重复和算力归一化缓解）。
2. **External Validity（外部效度）**：当前验证覆盖 DeepSeek Flash 与 Codex 系列模型及软件工程/调研协作场景，结论向超大规模团队（>10 成员）或非文本多模态任务的迁移需额外实验验证。
3. **Construct Validity（构造效度）**：模拟用户脚本与自动指标（如首屏字符占比、Communication $F_1$）是真实人类认知负荷的代理度量，需辅以小样本人工 NASA-TLX 盲评交叉验证。
4. **Conclusion Validity（结论效度）**：受限于长程多智能体实验的算力成本，单场景重复次数 $k=3$ 的统计功效有限，所有对比均以非参数检验 + 效应量 + 置信区间联合呈现，避免过度解读边缘差异。

---

## 6. 仓库内可复现结构规划（`benchmarks/`）

后续落地自动化评测脚本时统一置于本仓库 `benchmarks/` 目录：
- `benchmarks/scenarios/`：公开基准适配清单 + S1–S6 初始工作区快照、模拟用户规则表与客观断言脚本；
- `benchmarks/runner.ts`：隔离 `DSH_HOME` 与临时 `roleStoreDir` 的全自动 A/B 跑测器；
- `benchmarks/analyze.ts`：直接解析 DSH `.jsonl` 日志，自动输出 $\text{pass}^k$、Milestone KPI、KV Cache Hit Rate、Token Cost、Handoff/Closed-Loop 统计与 McNemar/Wilcoxon/Cliff's $\delta$ 显著性报告；
- `benchmarks/results/`：脱敏后的原始聚合数据表（JSON/CSV）与版本前后对比结果，随 Release 公开。

---

## References

- Burke, C. S., Stagl, K. C., Salas, E., Pierce, L., & Kendall, D. (2006). Understanding team adaptation: A conceptual analysis and model. *Journal of Applied Psychology*, 91(6), 1189–1207.
- Cannon-Bowers, J. A., Salas, E., & Converse, S. (1993). Shared mental models in expert team decision making. *Individual and Group Decision Making*.
- Cemri, M., et al. (2025). Why Do Multi-Agent LLM Systems Fail? *UC Berkeley (MAST)*.
- Clark, H. H., & Brennan, S. E. (1991). Grounding in communication. *Perspectives on Socially Shared Cognition*, 127–149.
- Dubois, Y., Galambosi, B., Liang, P., & Hashimoto, T. B. (2024). Length-Controlled AlpacaEval: A Simple Way to Debias Automatic Evaluators. *COLM 2024*.
- Forsgren, N., et al. (2021). The SPACE of Developer Productivity. *ACM Queue*, 19(1), 20–48.
- Galbraith, J. R. (1974). Organization Design: An Information Processing View. *Interfaces*, 4(3), 28–36.
- Grice, H. P. (1975). Logic and conversation. *Syntax and Semantics*, 3, 41–58.
- Hart, S. G., & Staveland, L. E. (1988). Development of NASA-TLX. *Advances in Psychology*, 52, 139–183.
- Malone, T. W., & Crowston, K. (1994). The interdisciplinary study of coordination. *ACM Computing Surveys*, 26(1), 87–119.
- Pentland, A. (2012). The New Science of Building Great Teams. *Harvard Business Review*.
- Salas, E., Sims, D. E., & Burke, C. S. (2005). Is there a "Big Five" in teamwork? *Small Group Research*, 36(5), 555–599.
- Skelton, M., & Pais, M. (2019). *Team Topologies*. IT Revolution Press.
- Stasser, G., & Titus, W. (1985). Pooling of unshared information in group decision making. *Journal of Personality and Social Psychology*, 48(6), 1467–1478.
- Xu, F. F., et al. (2024). TheAgentCompany: Benchmarking LLM Agents on Consequential Real World Tasks. *CMU*.
- Yao, S., et al. (2024). $\tau$-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains. *Sierra*.
- Zhu, K., et al. (2025). MultiAgentBench: Evaluating the Collaboration and Competition of LLM Agents. *ACL 2025*.
