# dsh-role-team 插件设计与验证方案

> **项目定位**：面向 DeepSeek Harness (`0.2.2-rc.5+`) 的独立外部插件包，实现「对话培养 AI 角色 + 共享长期记忆 + 团队会话严格隔离 + 按需组队协作 + AionUi 风格多栏分屏工作台」。
>
> - **GitHub 公开仓库**：`https://github.com/ZhangjiaxinGZS/dsh-role-team`
> - **本地开发目录**：`/Users/zjx/Desktop/code/dsh-插件开发/dsh-role-team/`
> - **宿主边界**：纯外部 DSH bundle，按规范安装加载，**不修改 `deepseek-harness` 源码**
> - **默认纯文本角色库**：`~/.dsh-role-team/roles/`（可在插件设置中修改）
> - **手改发布策略**：外部编辑器保存 `role.md` / `memories/*.md` 后，**自动发布给后续新建团队**；并行进行中的团队仍由用户显式决定何时生效
> - **验收范围**：Web 端与 Electron Desktop 端双端跑通

---

## 一、核心特性清单（What We Build）

| 编号 | 特性名称 | 核心能力说明 |
|---|---|---|
| **F1** | **独立纯文本角色库与双向编辑** | 每个角色一个独立目录（`role.md` + `memories/*.md` + `snapshots/`），YAML frontmatter + Markdown 正文；既支持插件 UI 可视化编辑，也支持用户直接用外部编辑器打开修改，保存即自动发布给新建团队，并发冲突时保留双方文本。 |
| **F2** | **对话式角色培养与 1v1 纠偏模式** | 像带新同事一样通过多轮聊天定义角色（职责、判断标准、表达习惯、协作方式）；建好后随时可 1v1 单独训练或针对团队表现纠偏。模型通过受控工具提炼角色草稿与经验候选，必须经用户显式确认才沉淀，并支持明确声明“仅对本次任务有效”。 |
| **F3** | **四层信息作用域与严格跨团队隔离** | 严格区分「角色长期设定 / 已确认经验 / 团队与项目上下文 / 一次性临时要求」。每场团队协作创建全新空 `root` Session，每位成员按角色 `fresh spawn` 全新子代理 Session，同时收窄跨会话检索与越权文件访问，彻底杜绝甲乙队材料与编号串味。 |
| **F4** | **并行团队的规则生效时机控制** | 每个团队席位固化绑定的 `(roleRevision, memoryRevision)` 快照。新经验确认或文件手改保存后，自动对**新建团队**生效；对**正在并行运行的团队**展示“有新版本待应用”提示，由用户决定“下一轮生效”或“保持当前版本”，绝不打断正在执行的当前轮。 |
| **F5** | **按需组队、原生协作与直连任意成员对话** | 从角色库挑选成员并指定队长组队，直接复用 DSH 原生 `agentTeams` 共享任务板（`team_task_*`）与 `subagent` 树内消息（`send_message` / `wait_agent`）。团队运行中，用户可在多栏工作台直接给任意成员发消息（支持 `queue` 排队与 `steer` 实时切入）。 |
| **F6** | **运行中清空成员上下文并重注记忆（逻辑席位换代）** | 将 UI 席位与底层原生 `childSessionId` 解耦。当任务告一段落或上下文噪音过多时，一键归档并停止旧会话、`fresh spawn` 新代接管同一逻辑席位，首步只注入角色已发布长期记忆与用户指定/勾选的交接记忆，并自动迁移未完成任务，旧历史保留只读回看。 |
| **F7** | **多层级树状团队预留（Seat Tree）** | 数据模型从第一版采用带 `parentSeatId` 的逻辑席位树结构，创建子代理时显式支持 `maxDepth >= 2` 与子队长 spawn 能力；一期跑稳扁平团队（1 层）与树结构内核，后续无需重构即可扩展树状组织图与子团队管理。 |
| **F8** | **AionUi 风格多栏分屏工作台（双端通用）** | 通过 `sidebar.panellist` 注册独立主面板，Web 与 Desktop 共用同一套 Client Bundle：顶栏切换团队与成员胶囊，主区多列并排绑定独立 `SessionProvider`（互不串流），内置角色与记忆可视化管理页及单栏全屏。 |

---

## 二、具体技术实现方案（How We Build）

### 2.1 外部插件包结构与 DSH 宿主接入

遵循 `deepseek-harness` (`0.2.2-rc.5`) 外置 bundle 规范，项目结构如下：

```text
dsh-role-team/
├── package.json              # 声明 dsh.bundle.patch、exports["."](Host)、exports["./client"](Client)、dsh.client
├── cordis.patch.yml          # 使用 insert 注册 Host 服务与 Client UI 扩展行
├── tsconfig.json
├── tsdown.config.ts          # 分离构建 dist/host.js 与 dist/client.js（React 从宿主模块表外部化）
├── locales/                  # zh-CN / en-US 文案
├── docs/
│   └── DESIGN.md             # 本设计与验证方案
├── src/
│   ├── shared/               # 共享类型定义、Remote RPC 协议、错误码、常量
│   ├── host/
│   │   ├── index.ts          # Cordis Host 插件入口与 @Remote 暴露
│   │   ├── role-store/       # 纯文本角色库读写、YAML/MD 解析、原子写入、文件监听、快照与冲突检测
│   │   ├── storage/          # storageDomain 持久表（team_runs / team_seats / seat_generations / team_local_notes / training_sessions）
│   │   ├── training/         # 1v1 培养与纠偏模式运行时、受控提炼工具（草案/记忆确认/临时要求）
│   │   ├── team-runtime/     # 每场 fresh root 编排、fresh spawn 装配、agent/created 首步屏障、版本生效门控
│   │   ├── seat-reset/       # 逻辑席位换代（归档停止旧代 + fresh spawn 新代 + 任务 reassign + 交接注入）
│   │   └── isolation/        # 跨会话检索收窄、路径归属校验、受管成员工具限制策略
│   └── client/
│       ├── index.ts          # Client Cordis 入口，注册 sidebar.panellist、keyed main、settings.section、composer 入口
│       ├── workbench/        # AionUi 风格多栏分屏工作台（TeamHeader、MemberColumn + SessionProvider、SeatResetModal）
│       ├── roles/            # 角色库列表、role.md / memories/*.md 可视化编辑器、冲突对比器、1v1 训练视图
│       └── team-setup/       # 按需组队弹窗（选角色、定队长、树状层级预留）
└── test/                     # Vitest 单元测试 + 集成对照测试
```

### 2.2 纯文本角色库设计（用户可直接查看与修改）

默认路径：`~/.dsh-role-team/roles/`（通过插件设置 `roleStoreDir` 可修改），与插件安装目录和项目工作区完全分离：

```text
~/.dsh-role-team/roles/
└── evidence-reviewer/
    ├── role.md                  # 角色长期设定（权威源文件）
    ├── memories/
    │   ├── mem-20261122-01.md   # 单条已确认经验或草稿
    │   └── mem-20261122-02.md
    └── snapshots/
        └── rev-0003.json        # 自动发布时生成的只读文本快照（供旧团队冷恢复精确复现）
```

**`role.md` 文件格式示例：**

```markdown
---
id: evidence-reviewer
name: 证据审稿人
version: 3
model: deepseek-chat
skills: []
tools:
  deny:
    - session-reference
    - session-search
updatedAt: "2026-11-22T01:40:00+08:00"
---

## 职责
负责核查主笔提交的稿件与论据，识别数据偏差、逻辑跳跃与证据缺口。

## 判断标准
- 看到数字必须核对分子、分母和时间范围。
- 看到因果判断必须主动寻找其他可能的解释。

## 表达习惯与协作方式
- 按问题严重程度分级列出审稿意见。
- 指出证据不足时，必须同时给出主笔成本最低的补证办法。
```

**`memories/mem-20261122-01.md` 文件格式示例：**

```markdown
---
id: mem-20261122-01
title: 证据不足时附带最低成本补证办法
scope: role_long_term
status: published
source: training:sess_xxx
createdAt: "2026-11-22T01:42:00+08:00"
---

当发现论点缺少足够数据支撑时，不能只回复“证据不足”，必须附带 1 条成本最低、主笔可立即执行的补证方案（如补充对照口径、缩小结论范围或注明时间区间）。
```

**双向同步、防冲突与自动发布机制：**
1. **原子写入**：UI 保存文件时先写同目录临时文件再原子 `rename`，防止半写损坏。
2. **摘要防冲突**：读取文件时计算内容 SHA-256 摘要；UI 保存携带 `expectedHash`，若期间外部编辑器改动了文件，拒绝静默覆盖并返回冲突（保留双方文本供对比或重载）。
3. **保存即自动发布（策略 B）**：文件监听器（`fs.watch` + 定时/手动 rescan 兜底）检测到外部编辑器保存且 YAML/Markdown 校验通过后，自动递增 `publishedRevision` 并写入只读快照 `snapshots/rev-xxxx.json`：
   - **后续新建团队**：自动使用最新 `publishedRevision`；
   - **并行运行中的旧团队**：席位保持原 `adoptedRevision`，UI 顶栏显示“有新版本可同步”，由用户决定“下一轮生效”或“保持当前版本”；
   - **解析失败保护**：若用户手改时 YAML 语法写错，UI 高亮具体文件名和行号报错，正在运行与新建的团队继续沿用最近一次有效快照，不会崩溃。

### 2.3 插件持久化索引（`storageDomain`）

因外置插件不应依赖未登记进宿主词表的自定义 Session 事件，运行态绑定与索引统一存于插件自有 `storageDomain` 表：

- **`team_runs`**：`runId`、`title`、`rootSessionId`、`leaderSeatId`、`workspaceCwd`、`status`、`createdAt`
- **`team_seats`**（逻辑席位树）：`seatId`、`runId`、`parentSeatId`（`null` 表示队长/根，为树状层级预留）、`roleId`、`displayName`、`currentGeneration`、`currentSessionId`、`nativeAgentName`、`adoptedRoleRev`、`adoptedMemoryRev`、`pendingRoleRev`、`pendingMemoryRev`、`status`（`active | resetting | archived`）
- **`seat_generations`**（历代会话审计）：`seatId`、`generation`、`sessionId`、`nativeAgentName`、`roleSnapshotHash`、`memoryIds`、`handoffNote`、`archivedAt`
- **`team_local_notes`**（一次性/项目内临时要求）：`noteId`、`runId`、`seatId`（可选，空表示全队有效）、`content`、`createdAt`
- **`training_sessions`**（1v1 培养与纠偏会话）：`trainingId`、`roleId`、`sessionId`、`mode`（`create | coach | debrief`）、`sourceRunId`（可选，来自某次团队复盘）

### 2.4 原生机制嵌入与四层隔离设计

1. **首步装配屏障（`agent/created`）**：
   - 建队时先创建全新空 `root` Session，持久化 `team_runs` 与队长 `team_seats`，再开启原生 `agentTeams.setEnabled(root, true)`；
   - 每个队员通过原生 `subagent` 的 `startActivation`（指定预留 `childId`、`continuable: true`、fresh spawn 不复制父历史、`maxDepth` 显式传配置值）启动；
   - 在 `agent/created` 串行钩子中，根据 `sessionId` 反查插件索引表，向该实例的 `agent.ctx` 注入：
     - 固定 `systemPrompt` section：该席位已采纳快照对应的 `role.md` 正文；
     - 有界 `context` 注入：该席位已采纳的 `status: published` 长期记忆正文 + 当前 `runId` 的 `team_local_notes` +（若为换代）用户交接记忆；
     - 工具限制：默认禁用跨会话引用/检索工具（`session-reference`、`session-search`），并在文件工具/自定义工具中校验路径，防止受管成员越权读取其他团队记录或直接扫盘读取未发布记忆草稿。
2. **1v1 培养与纠偏模式**：
   - 使用独立训练 Session（与任何团队 `root` 完全分离），向模型注册受控工具：
     - `propose_role_update`：生成角色设定修改草案，展示 diff，**必须用户确认**后写入 `role.md` 并发布；
     - `propose_role_memory`：提炼长期经验候选，生成 `status: draft` 条目，**必须用户确认**后转为 `published`；
     - `record_temporary_note`：当用户说明“仅对本次/甲项目有效”时，仅写入 `team_local_notes`，绝不触碰角色长期库。
   - 原始 1v1 训练对话历史**绝不**作为跨团队召回源。
3. **团队内直连任意成员对话**：
   - 多栏工作台每列渲染独立 `SessionProvider`（参考 `ui-subagent` 的 `SidebarChatTab` 模式），按该列绑定的 `sessionId` 分别 `retain` / `release` `SessionReference`；
   - 队长（root）列走普通 `session.prompt`，所有子成员列走 `remote.subagents.prompt({ childSessionId, delivery: 'queue' | 'steer', requestId, content })`，支持成员运行中随时发消息、停止与审批。
4. **并行团队的规则生效门控（Pending → Effective）**：
   - 当某角色有新 `publishedRevision` 时，仅更新对应活跃席位的 `pendingRoleRev / pendingMemoryRev`，不改当前正在执行的轮；
   - 用户点击「下一轮生效」后，插件在 `agent/pre-step`（新轮次送往模型前）一次性切换 `adoptedRev = pendingRev` 并重装上下文，确保同一轮与重试读取完全一致的快照。

### 2.5 运行中“清空成员上下文并重注记忆”原子状态机

针对 DSH `0.2.2-rc.5` 原生无“同会话原地清空历史”接口的现实，通过**逻辑席位换代（Seat Generation）**实现：

1. **前置检查与锁定**：将 `team_seats.status` 置为 `resetting`（校验 `generation` 防并发重复点击），暂停该席位的新消息投递；若目标为带活跃下属的子队长，弹窗提示需连同其子树一并换代。
2. **停止并归档旧代**：调用 `workspaceRegistry.archiveSession(oldSessionId, { stopActivity: true })` 并等待旧代完全静止（旧对话日志完整保留，可在 UI 历史下拉中只读回看）。
3. **预留并启动新代**：递增 `generation`（如 `reviewer-1` → `reviewer-2`），预留新 `childSessionId` 并持久化新 `seat_generations` 记录；以 `fresh spawn` 启动新代，在 `agent/created` 屏障中**只装载**：① 角色最新已发布长期设定与长期记忆；② 用户本次勾选/手写的交接记忆（彻底排除旧任务噪音）。
4. **迁移未完成任务**：若旧代在原生任务板上仍有 `pending / in_progress` 任务，由 `root` 使用 `expectedRevision` 逐项 `reassign` 给新 `childSessionId`（已完成任务保留原 `oldSessionId` 审计记录）。
5. **UI 无缝重绑**：提交新代为 `active`，前端该列释放旧 `SessionReference`、绑定新 `SessionReference`，并向新代投递一条简短交接确认消息使其进入待命态。

### 2.6 AionUi 风格多栏分屏 UI（Web & Desktop 双端）

- **侧边栏主入口**：通过 `sidebar.panellist` 注册「角色团队」图标，对应 keyed `main` 工作台主页面（Web 与 Desktop 渲染同一页面）。
- **工作台布局**：
  - **顶栏**：团队切换下拉 + 成员胶囊标签（标出队长皇冠、当前代次、待更新版本红点）+「+ 新建团队 / 添加成员」+ 视图切换（多栏并排 / 单栏聚焦）。
  - **多栏主区**：每列顶部显示成员名、模型、代次、`清空上下文并重注` 按钮、`查看历史代次`、`全屏`；中间为独立流式对话区；底部为独立输入框（支持 `queue / steer` 切换、停止、权限审批）。
  - **右侧轻量抽屉（可选折叠）**：原生共享任务板（`team_task_*` 实时投影）+ 当前团队临时要求（`team_local_notes`）。
- **角色库子视图**：
  - 角色卡片列表 → 点击进入详情页：左右分栏（左侧 `role.md` 可视化/源码编辑 + `memories/*.md` 列表与发布/撤回开关 + “打开本地目录”；右侧直接内嵌该角色的 1v1 培养/纠偏聊天窗）。

---

## 三、分阶段实施路线

| 阶段 | 交付内容 | 核心产出 |
|---|---|---|
| **Phase 1** | 插件骨架 + 纯文本角色/记忆内核 | 外部 bundle 工程（Host/Client 构建通过）、`role-store` 读写/监听/原子写入/摘要冲突检测/策略 B 自动发布与快照、`storageDomain` 建表、完整单元测试 |
| **Phase 2** | 1v1 培养模式 + 原生 Team 隔离运行 + 逻辑席位换代 | 培养与提炼受控工具、每场 `fresh root` + `fresh spawn` 编排、`agent/created` 装配与跨会话隔离、并行版本门控、逻辑席位换代全流程、跨队隔离自动化集成测试 |
| **Phase 3** | AionUi 风格多栏分屏 UI + 角色库管理界面 | 独立主面板、多列独立 `SessionProvider` 绑定与 `subagents.prompt` 直连、清空上下文重注弹窗、角色与记忆可视化编辑器及冲突对比 UI |
| **Phase 4** | Web 端 + Electron Desktop 双端真机联调与验收 | 同一插件产物分别安装到 Web profile 与 Desktop profile，使用 DeepSeek 模型走完 T1–T8 全部端到端验收用例 |

---

## 四、验证与验收方案（How We Verify）

### 4.1 自动化测试层（Codex CLI 每阶段必须跑通）

1. **纯文本角色库单测**：`role.md` 与 `memories/*.md` 解析/序列化、原子写入、外部手改监听触发自动发布与快照生成、并发编辑 `expectedHash` 冲突保留双方文本、YAML 语法错误降级保护。
2. **作用域与隔离集成测试**：构造同一角色同时加入 Team A 与 Team B，验证两队各自注入的 `systemPrompt + context` 中：① 共享内容仅含已发布 `role.md` 与 `published` 记忆；② Team A 的 `team_local_notes` 与对话内容绝不出现在 Team B 的组装结果中；③ 受管成员的跨会话检索工具已被屏蔽。
3. **版本生效门控单测**：修改角色并自动发布新版本后，验证：① 新建 Team C 自动采用新版；② 运行中 Team A 仍维持旧版直至显式调用“下一轮生效”，且不干扰进行中的当前轮；③ 进程冷恢复按快照还原。
4. **逻辑席位换代状态机测试**：验证换代过程正确归档并停止旧代、`fresh spawn` 新代只带角色记忆与交接记忆、未完成任务正确 `reassign`、已完成任务保留原作者、重复点击按 `generation` 幂等拒绝。

### 4.2 端到端真机验收用例（DeepSeek 模型 · Web & Desktop 双端各跑一遍）

| 用例 | 验收场景 | 操作步骤 | 通过标准 |
|---|---|---|---|
| **T1** | 自然语言建角 + 纯文本核验 | 在 1v1 培养聊天中通过 2–3 轮对话塑造「主笔兼队长」与「证据审稿人」，确认保存。 | `~/.dsh-role-team/roles/` 下生成规范的 `role.md`；用外部编辑器直接改一句审稿标准并保存，UI 自动刷新并生成新快照，无报错。 |
| **T2** | 1v1 纠偏与长期/临时区分 | 单独找「证据审稿人」做一道训练题，纠正其补充“最低成本补证办法”并确认记为长期习惯；再告诉它一条“仅本次测试有效”的要求。 | `memories/` 生成 `status: published` 长期记忆文件；临时要求不写入 `memories/`。 |
| **T3** | 甲队协作 + 专用编号 + 直连成员 | 新建「甲队」（主笔兼队长 + 证据审稿人），布置简报任务并告知甲队专用编号 `ALPHA-9527`；运行中在多栏工作台直接给审稿人发一条指导消息。 | 主笔通过原生机制派活给审稿人、审稿人复核回传、主笔修订交付；用户直连审稿人成功且流式输出不串列；原生任务板实时同步。 |
| **T4** | 乙队验证复用与严格隔离 | 不关闭甲队，新建「乙队」拉入同一个「证据审稿人」，提问新任务并追问“你知道甲队编号吗？”。 | 乙队审稿人**主动运用** T2 沉淀的“最低成本补证办法”，且**明确不知道** `ALPHA-9527`；切回甲队，甲队审稿人仍记得 `ALPHA-9527` 与上次审稿进度。 |
| **T5** | 并行团队规则生效时机 | 甲、乙两队均处于活跃状态，外部编辑器修改审稿人 `role.md` 增加一条新规则并保存。 | 新建「丙队」自动生效新规则；甲、乙两队弹出“有新版本待应用”提示，对甲队点“下一轮生效”、乙队选“保持当前版本”，验证下一轮仅甲队应用新规则。 |
| **T6** | 运行中清空上下文并重注记忆 | 在甲队多轮讨论产生大量噪音后，对审稿人点击「清空上下文并重注」，填写一条新的交接摘要。 | 审稿人同列无缝换代，新会话保留角色长期设定与长期记忆 + 新交接摘要，不再记得旧轮次噪音；旧历史仍可只读回看；原未完成任务归属正常迁移。 |
| **T7** | 重启冷恢复 | 重启 DSH Host 与界面，重新打开甲队与乙队。 | 两队成员列、历史对话、已采用版本快照、任务板状态全部完整恢复，无串队、无丢绑定。 |
| **T8** | Web 与 Desktop 双端独立验收 | 使用同一打包产物，分别在 Web 端（`dev:web` / Web profile）和真正启动的 Electron Desktop 端（Desktop profile）完成安装与核心闭环（T1–T7）。 | 双端均通过「安装 → 建角手改 → 培养 → 甲乙队并行分栏与隔离 → 席位换代 → 重启恢复」，无白屏、无跨列串流、无 Remote 报错。 |
