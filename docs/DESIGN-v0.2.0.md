# `dsh-role-team` v0.2.0 技术方案（定稿 v2）：模式无关、低噪协作与统一团队面板

> **执行约束（面向 Codex CLI 实现方）**：本文档为严格工程规格书。所有架构原则、文件路径、存储路径、Zod Schema、JSON Schema 约束、RPC 签名、生命周期钩子、UI 结构、样式变量、国际化键及验收用例均已锁定。**禁止**擅自新增未约定的工具、按钮、弹窗或配置项；**禁止**修改 `deepseek-harness` 宿主源码；**禁止**触碰用户真实角色库、团队或凭据。

---

## 0. 核心架构原则（贯穿全方案，面向契约而非特定模式）

`dsh-role-team` 是运行在 DeepSeek Harness 上的通用协作插件，**绝不能**绑定某一种运行模式、某一个工具执行器、某一家模型适配器或某一种团队拓扑。所有模块必须遵守以下 **5 条模式无关原则**：

1. **Prompt 与 Preset 无关（Preset-Agnostic）**：
   - 必须同时适配 `standard`、`ptc`、`minimal` 以及任意用户自定义 / 未来新增的 `agentPreset`。
   - 不再硬编码 `composedPreset === 'minimal'`；改为在 `system-prompt/assemble` 阶段检测 `role-team-role` section 是否被当前 preset 保留，若未被保留则由 `required: true` 的 runtime context 自动兜底。
   - `systemPrompt` 前缀保持 100% 静态，绝不拼入动态简报正文，保护长会话 Prefix KV Cache。
2. **工具执行器与模型适配器无关（Executor & Adapter-Agnostic）**：
   - 所有插件工具入参 **必须** 满足「扁平无联合 JSON Schema 契约」：顶层 `type: "object"`，属性仅使用基础类型（`string` / `number` / `boolean` / `array`），可选字段直接省略，**严禁**出现 `anyOf` / `oneOf` / `nullable` / Zod `~standard` 元数据，确保 Native Tool Calling、PTC 代码沙箱、DeepSeek、Claude、Gemini、`dsh-agy-link` 及任意 OpenAI-compatible 网关 100% 兼容。
   - 简报同步**不强依赖工具可用**：即使某个模式屏蔽或禁用了插件工具，用户手动更新简报依然通过 `agent/pre-step` 增量送达。
3. **生命周期与上下文连续性无关（Lifecycle-Agnostic）**：
   - 完整覆盖 5 种状态迁移：**正常多轮对话**、**会话压缩（`compaction/summary`）**、**中途切换模式（`agent-preset/selected`）**、**成员换代（`resetSeat`）**、**宿主重启冷恢复**。
   - 任何情况下既不重复注入浪费 Token / 破坏缓存，也不在压缩或换代后静默丢失简报。
4. **宿主可选服务能力降级（Capability-Driven）**：
   - `schedule`、`agentTeams`、`permissionPresets`、`agentPresets` 均为宿主可选服务。通过 `getTeam` 显式暴露宿主能力标志（`capabilities`），前端按能力优雅降级，绝不因某项宿主插件未启用而导致整个团队面板报错或白屏。
5. **团队拓扑与协作方向无关（Topology-Agnostic）**：
   - 不硬编码 `rt-root-` 代表所有管理者；兼容扁平团队、多级嵌套子队长团队与成员间平级协作。
   - 消息卡片的默认展开/折叠由**发件人与收件人的上下级关系**决定（上级派单默认展开，下属/平级汇报默认单行折叠），异常终态（`error` / `aborted` / `refusal`）必须醒目标识；自定义 `team-brief` 上下文消息由前端显式接管，绝不泄漏原生裸标签。

---

## 1. 模块一：团队简报（Team Brief）

### 1.1 磁盘存储、隔离与原子并发

- **物理路径**：`join(dirname(roles.root), 'teams', runId, 'brief.md')`
  - 默认 `roleStoreDir = ~/.dsh-role-team/roles` → `~/.dsh-role-team/teams/<runId>/brief.md`。
  - 测试环境临时 `roleStoreDir = /tmp/.../roles` → `/tmp/.../teams/<runId>/brief.md`（天然隔离）。
  - 绝不写入 `workspaceCwd`（不污染用户 Git 仓库），也绝不写入 `roles/`（不触发 `RoleStore` 扫描）。
- **路径安全校验**：`runId` 必须匹配 `/^[a-zA-Z0-9_-]{1,128}$/`，否则直接抛错拒绝。
- **文件格式**：人类可读 UTF-8 Markdown + 轻量 YAML frontmatter：
  ```markdown
  ---
  updatedAt: "2026-11-25T19:30:00.000Z"
  updatedBy: "user"
  ---
  （用户或队长维护的简报正文）
  ```
  - 对外结构化字段：`{ text, hash, updatedAt, updatedBy }`，其中 `hash` 为完整文件内容 SHA-256（复用 `src/host/role-store/markdown.ts` 的 `digest`）。
  - 文件不存在时读取返回 `null`（不自动生成空文件）。
  - **模板非强制**：简报正文不强校验特定标题结构（适配研发、运营、写作、调研等任意场景）；3 段式骨架仅作为 UI 新建时的引导占位符。
- **原子写入与并发控制**：
  - 新建 `src/host/team-runtime/briefs.ts`（`TeamBriefs` 类），复用 `src/host/role-store/files.ts` 的 `directory`、`readFileText`、`stageText`。
  - 写入操作通过 `TeamRuntime.ordered('brief/' + runId, ...)` 串行化。
  - CAS 冲突保护：传入 `expectedHash`（新建传 `null`，修改传上次读取的 `hash`）；若磁盘现状与 `expectedHash` 不一致，返回 `{ ok: false, code: 'conflict', current }`。
- **字数预算**：
  - Agent 工具 `update_team_brief`：**硬上限 1500 字符**（`text.trim().length <= 1500`）。超限时返回结构化错误信息（包含当前字数、上限 1500、建议改为文件路径指针），避免 Agent 盲目重试死循环。
  - UI 手动保存（`saveTeamBrief`）：**软提示 1500 字符**（计数器变色提示），**硬上限 4000 字符**；提交空白文本视为清空并删除 `brief.md`，返回 `{ ok: true, brief: null }`。
- **生命周期清理**：
  - `deleteTeam(runId)` 在删除 `team_runs` 之前调用 `await this.briefs.remove(runId)`，使用 `rm(teamDir, { recursive: true, force: true })` 彻底清理；
  - `archiveTeam(runId)` 保留 `brief.md` 供只读查阅，拒绝后续写入。
- **文件隔离加固（`src/host/isolation/index.ts`）**：
  - 将 `teamsRoot = join(dirname(roles), 'teams')` 加入 `protectedRoots`（与 `roles`、`DSH_HOME` 同级），禁止任何成员及临时子智能体通过 `read` / `write` / `edit` / `apply_patch` / `glob` / `grep` 直接访问 `teams/` 目录；
  - `workspacePath(path, roles)` 同样拒绝选择 `teamsRoot` 或其子/父目录作为工作区。

### 1.2 Shared Schema 与 Remote RPC

1. **新增 `src/shared/briefs.ts`**（并从 `src/shared/index.ts` 导出）：
   ```ts
   import { z } from 'zod'
   import { hash } from './index.js'

   const timestamp = z.iso.datetime({ offset: true })
   export const briefSource = z.enum(['user', 'leader'])
   export const teamBrief = z.strictObject({
     text: z.string(),
     hash,
     updatedAt: timestamp,
     updatedBy: briefSource,
   })
   export const briefSaveResult = z.union([
     z.strictObject({ ok: z.literal(true), brief: teamBrief.nullable() }),
     z.strictObject({ ok: z.literal(false), code: z.literal('conflict'), current: teamBrief.nullable() }),
   ])
   export type TeamBrief = z.infer<typeof teamBrief>
   export type BriefSaveResult = z.infer<typeof briefSaveResult>
   ```
2. **`src/shared/index.ts` 变更**：
   - `indexRecords.seat_generations` 增加可选字段：`seenBriefHash: hash.nullable().optional()`。
3. **`src/shared/runtime.ts` 与 `src/host/index.ts` 变更**：
   - 新增 RPC `getTeamBrief`：`{ runId: id }` → `teamBrief.nullable()`
   - 新增 RPC `saveTeamBrief`：`{ runId: id, text: z.string().max(4000), expectedHash: hash.nullable() }` → `briefSaveResult`（需校验 `this.runtime.active(runId)`，`updatedBy: 'user'`）
   - 扩展 `getTeam` 返回值：增加可选字段 `capabilities: z.strictObject({ schedules: z.boolean() }).optional()`（宿主返回 `{ schedules: Boolean(this.runtime.native.ctx.get('schedule')) }`）。
   - 扩展 `teamMessageSender` 返回值：从 `{ name: title.nullable() }` 扩展为 `z.strictObject({ name: title.nullable(), fromParent: z.boolean().optional() }).nullable()`。
     - 计算规则：在当前团队 `seats` 树中，从接收者 `seat.parentSeatId` 向上追溯所有祖先 `seatId`，若发送者 `seatId` 在祖先集合中则 `fromParent: true`，否则 `fromParent: false`。

### 1.3 Agent 工具注册（扁平通用 Schema + 严格权限）

在 `src/host/team-runtime/briefs.ts` 实现 `install(agent: Agent, runId: string, isLeader: boolean, scope: Context)`：

- **`read_team_brief`**（队长 + 所有活跃成员均可用，只读）：
  - `parameters`（手写或经清理的扁平纯 JSON Schema，禁止 `anyOf`/`oneOf`/`nullable`）：
    ```ts
    { type: 'object', properties: {}, additionalProperties: false }
    ```
  - 返回 JSON 字符串：`{ exists: false, text: '', hash: null, updatedAt: null, updatedBy: null }` 或 `{ exists: true, text, hash, updatedAt, updatedBy }`。
- **`update_team_brief`**（**仅队长**注册与可执行）：
  - 非队长成员不注册该工具；同时在 `src/host/isolation/index.ts` 的 `blocked(name)` 中增加 `(team === 'member' && name === 'update_team_brief')`。
  - 队长侧 `execute` 二次校验：`if (exec.agent !== agent || this.team.active(runId).rootSessionId !== agent.id) throw new Error('Only the team leader can update the team brief')`。
  - `parameters`（**严格扁平 JSON Schema，无 `nullable` / `anyOf`**）：
    ```ts
    {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Concise Markdown team brief (max 1500 chars). Keep current goal, locked decisions/guardrails, and artifact file paths; never paste long reports.',
        },
        expectedHash: {
          type: 'string',
          description: 'Optional SHA-256 hash from the last read_team_brief call for conflict detection. Omit to update the latest revision.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    }
    ```
  - 运行时参数校验：
    - `text` trim 后长度必须在 `1..1500`；若 `> 1500`，抛清晰错误 `Team brief exceeds 1500 characters (got ${len}). Summarize decisions and use file paths instead of pasting long reports.`；
    - `expectedHash` 若传入则校验 64 位 hex 并执行 CAS；若省略则读取当前磁盘 hash 原子覆盖。
  - **防自回显**：队长调用 `update_team_brief` 成功后，立即将队长当前代际的 `seenBriefHash` 更新为新 `brief.hash`。

### 1.4 模式无关 Prompt 兜底 + KV-Cache 安全增量同步 + 压缩/切模式续传

1. **Preset 无关的 Prompt 兜底（重构 `src/host/isolation/index.ts` 的 `installRolePrompt`）**：
   - 在 `installRolePrompt(agent, text)` 中，不再硬编码 `composedPreset(agent.ctx) === 'minimal'`：
     - 保留 `systemPrompt.section({ name: 'role-team-role', order: 0, interpolate: false, text })`；
     - 维护每个 `agent` 的 `sectionPreserved` 标记（默认 `true`），在 `system-prompt/assemble` 监听器中记录最终 `result.sections.some(s => s.name === 'role-team-role')`；
     - 注册 `systemPrompt.context({ name: 'role-team-fallback-profile', order: 0, interpolate: false, required: true, text: () => (!sectionPreserved || agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) === 'minimal' ? text() : '') })`；
     - 这样无论是 `minimal` 还是任何未来/自定义覆盖 systemPrompt 的 preset，角色指令与简报规则均自动兜底送达，而在 `standard` / `ptc` 等保留 section 的模式下不重复注入。
   - 在 `TeamRuntime.attach` 的固定角色指令中仅追加 1 条**静态**简报规则（绝不拼接简报正文）：
     - 中文：`团队简报：本队共享一份简短主线简报。成员可用 read_team_brief 查看；仅队长（和用户）可用 update_team_brief 更新（限 1500 字，只写主线目标、已拍板决定与红线、当前阶段与产物路径，不粘贴长报告）。简报变更时系统会自动增量同步。用户最新直接指令始终高于简报。`
     - 英文：`Team brief: this team shares a concise brief. Any member may call read_team_brief; only the leader (and user) may call update_team_brief (max 1500 chars: current goal, locked decisions/guardrails, current stage and artifact paths—never paste long reports). Updates sync incrementally. The user's latest direct instruction always overrides the brief.`

2. **增量后缀同步（`agent/pre-step`）**：
   - 声明扩展 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`：
     ```ts
     declare module '@deepseek-ai/dsh-llm' {
       interface MessageSourceMap {
         'team-brief': {
           kind: 'team-brief'
           form: 'notice'
           summary: string
           briefHash: string
           updatedAt: string
           updatedBy: 'user' | 'leader'
         }
       }
     }
     ```
   - 在 `agent/pre-step` 中，当 `decision.kind === 'enter'`：
     - 读取 `brief = await this.briefs.read(seat.runId)` 与当前代际 `gen`；
     - 仅当 `brief && brief.text.trim().length > 0 && brief.hash !== gen?.seenBriefHash` 时，使用 `createUserMessage` + `boundContextSummary`（均来自 `@deepseek-ai/dsh-llm`）构造后缀消息并追加到 `decision.messages` 末尾：
       ```ts
       const notice = createUserMessage({
         source: {
           kind: 'team-brief',
           form: 'notice',
           summary: boundContextSummary(
             run.locale === 'en' ? 'Team brief updated' : '团队简报已更新',
           ),
           briefHash: brief.hash,
           updatedAt: brief.updatedAt,
           updatedBy: brief.updatedBy,
         },
         content: [{
           type: 'text',
           text: [
             `<team-brief-update updated_at="${brief.updatedAt}" updated_by="${brief.updatedBy}">`,
             run.locale === 'en'
               ? 'Note: The user’s latest direct instruction always overrides this brief.'
               : '说明：用户最新直接指令的优先级始终高于本简报。',
             brief.text,
             '</team-brief-update>',
           ].join('\n'),
         }],
       })
       ```

3. **生命周期状态同步（`observeSessions()` 监听 `session/event`）**：
   - **重要**：DSH `SessionEventMap['user/message']` 的 `event.data` **直接就是 `UserMessage`**（不是 `{ message }`）！
   - 当 `event.type === 'user/message' && event.data.source.kind === 'team-brief'`：
     - 定位该 `session.id` 对应的 `seat_generations` 记录，原子更新 `seenBriefHash = event.data.source.briefHash`。
   - **防压缩失忆**：当 `event.type === 'compaction/summary'`：
     - 定位该 `session.id` 对应的 `seat_generations` 记录，将 `seenBriefHash` 重置为 `null`——这样压缩完成后下一步自动补发 1 次最新简报，且后续轮次恢复 0 注入。
   - **换代续传**：`resetSeat` 创建新代际时 `seenBriefHash` 初始为 `null`，新会话第一步自动同步最新简报。
   - **模式切换续传**：当 `event.type === 'agent-preset/selected'` 且为受管会话时，保持隔离与工具注册在下一轮有效（`system-prompt/assemble` 动态检测兜底，无需重建团队）。

---

## 2. 模块二：统一右侧「团队面板」3-Tab 抽屉

### 2.1 顶栏右侧精简（4 个控件 → 3 个控件）

修改 `src/client/workbench/Workbench.tsx` 的 `<header className="rt-controls">`：
- **移除**：独立「任务板」按钮、独立「定时任务」按钮以及独立挂载的 `<SchedulePanel />` Modal。
- **保留 3 个右侧控件**：
  1. `+ 添加成员`（`button.rt-add-member`）
  2. `团队面板`（`button.rt-icon.rt-drawer-toggle`，`aria-expanded={drawerOpen}`，图标使用 `IconPanelRightOutlineRegular` 若未导出则用 `IconFlatListOutlineRegular`；当活跃任务数 `in_progress + pending > 0` 时显示紧凑角标 `<span className="rt-badge">{activeTaskCount}</span>`）
  3. `⚙ 工作台设置`（`button.rt-icon`）

### 2.2 统一抽屉壳 `src/client/workbench/TeamDrawer.tsx`

- **布局**：挂载在 `.rt-floor` 右侧（`.rt-team-drawer`），`flex: 0 0 min(380px, 46%)`，`border-inline-start: 1px solid var(--dsw-alias-border-l4)`，`background: var(--dsw-alias-bg-base)`，`display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden;`。
- **Header**：
  - 左侧 `role="tablist"` 3 个 Tab（复用 `.rt-segment` 视觉风格）：
    1. `brief`：`简报` / `Brief`
    2. `tasks`：`任务` / `Tasks`（`activeTaskCount > 0` 时显示紧凑计数）
    3. `schedules`：`定时` / `Schedules`（仅当 `schedulesAvailable` 且活跃定时数 `> 0` 时显示计数）
  - 右侧：关闭按钮 `IconCloseOutlineRegular`；支持 `Escape` 关闭并将焦点归还顶栏按钮。
- **Tab 记忆**：持久化到 `localStorage['dsh-role-team:drawer-tab']`（默认 `'brief'`，白名单校验 `brief | tasks | schedules`）。
- **未保存保护**：在「简报」Tab 处于编辑态且有未保存改动时，切换 Tab 或关闭抽屉 / 按 `Escape` 触发保护（提供 `继续编辑` / `放弃修改` / `保存并继续`）。

### 2.3 Tab 1：`src/client/workbench/BriefPanel.tsx`

- **加载**：`useLoad('brief:' + run.runId, () => call('getTeamBrief', { runId: run.runId }), 2500)`；编辑态不覆盖用户正在输入的草稿。
- **阅读态（默认）**：
  - 空态：简洁说明 + `active` 时显示 `编写简报` 按钮（点击进入编辑态并预填可选的 3 段 Markdown 模板占位骨架）；已归档团队显示只读空态。
  - 有内容态：元信息条（`更新于 {本地时间} · {队长更新 / 手动编辑}`）+ `编辑` 按钮（仅 `active`）+ `MarkdownText`（`omitHtml`）正文区（单一纵向滚动区，无嵌套滚动条）。
- **编辑态（抽屉内联）**：
  - `<textarea>` 占满剩余空间（`flex: 1; min-height: 220px; resize: none;`），`maxLength={4000}`。
  - 底栏：左侧实时字数 `{len} / 1500`（`> 1500` 时标警告色并显示精简提示）；右侧 `取消` / `保存`。
  - 冲突处理：收到 `code: 'conflict'` 时，顶部显示冲突提示条并提供 `采用最新版本` / `覆盖保存`。

### 2.4 Tab 2 & Tab 3 嵌入与能力降级

- **`TaskBoard.tsx`**：导出 `useTeamTasks`，增加 `embedded?: boolean`（嵌入 `TeamDrawer` 时去掉外层抽屉壳和重复标题栏），原有搜索、筛选、`已完成` 折叠 + 5 条分页、点击展开详情、点击负责人跳成员列 **100% 保留**。
- **`SchedulePanel.tsx`**：改为嵌入抽屉渲染（移除外层 `<Modal>`）；新增 `available?: boolean` prop——当宿主未启用 `schedule` 服务（`available === false`）时，直接展示清晰降级提示（不发起 `teamSchedules` 轮询，不报错）；启用时 **100% 保留**全部 5 种调度规则、暂停/恢复、立即执行、删除确认与历史分页。

---

## 3. 模块三：低噪消息呈现（拓扑无关 + 显式接管 `team-brief`）

修改 `src/client/workbench/TeamTrigger.tsx`：

1. **显式接管 `source.kind === 'team-brief'`（消除原生裸标签噪声）**：
   - 在 `registerTeamTrigger` 中，对 `turn-trigger` / `context` / `turn-process` 识别 `source.kind === 'team-brief'`：
     - 剥离 `<team-brief-update ...>` 与 `</team-brief-update>` 外壳；
     - 渲染为极轻量的单行静默条（`.rt-team-trigger[data-brief-notice]`），默认折叠：`已同步团队简报 · {队长更新/手动编辑}  {HH:mm} ▸`；
     - 点击可展开查看当时同步的简报 Markdown 快照，再次点击收起。
2. **按协作方向决定队友卡片默认折叠/展开（拓扑无关）**：
   - 使用 `teamMessageSender` 返回的 `fromParent` 字段：
     - **`fromParent === true`**（来自上级/队长的派单）：**默认展开**（`useState(true)`），保留 260px 限高 + 柔和渐变遮罩 + `展开全部 / 收起`（无内滚条）；
     - **`fromParent !== true`**（来自下属的汇报/结算，或平级成员消息）：**默认折叠为单行摘要条**（`useState(false)`），格式：`来自 {角色名}[ · {状态}]  {去 Markdown 单行摘要}  {HH:mm} ▸`；点击 1 次**直接展开完整 Markdown**（无需二次点击「展开全部」，无内滚条），再次点击收起。
   - **异常状态醒目标识**：当 `message.status` 为 `'error' | 'aborted' | 'refusal'` 时，在单行摘要条上添加 `data-alert="true"`，状态文字使用 `--dsw-alias-state-warn-primary` / `--dsw-alias-state-error-primary` 语义色高亮，防止用户漏看异常。
3. **队长直接回复用户的内容**：不经过 `TeamTrigger`，**严禁**强制压缩或截断。

---

## 4. 国际化键清单（`locales/zh-CN.json` & `locales/en-US.json`）

| Key | `zh-CN` | `en-US` |
|---|---|---|
| `teamPanel` | `团队面板` | `Team panel` |
| `briefTab` | `简报` | `Brief` |
| `tasksTab` | `任务` | `Tasks` |
| `schedulesTab` | `定时` | `Schedules` |
| `teamBrief` | `团队简报` | `Team brief` |
| `emptyBrief` | `尚未编写团队简报` | `No team brief yet` |
| `emptyBriefHint` | `记录当前主线目标、已拍板决定与关键产物路径。仅你和队长可编辑，变更时自动同步给全队。` | `Capture the current goal, locked decisions, and artifact paths. Only you and the lead can edit; changes sync automatically.` |
| `createBrief` | `编写简报` | `Write brief` |
| `briefUpdatedByLeader` | `队长更新` | `Updated by lead` |
| `briefUpdatedByUser` | `手动编辑` | `Edited manually` |
| `briefLengthHint` | `建议控制在 1500 字以内，只保留结论与文件路径指针。` | `Recommended under 1500 chars—keep decisions and file paths only.` |
| `briefConflict` | `简报刚在其他位置更新，请确认如何处理。` | `The brief changed elsewhere. Choose how to proceed.` |
| `briefUseLatest` | `采用最新版本` | `Load latest` |
| `briefOverwrite` | `覆盖保存` | `Overwrite` |
| `briefUnsaved` | `简报有未保存修改，切换或关闭前要保存吗？` | `Save your unsaved brief changes before leaving?` |
| `briefDiscard` | `放弃修改` | `Discard` |
| `briefSaveAndLeave` | `保存并继续` | `Save & continue` |
| `briefSynced` | `已同步团队简报` | `Team brief synced` |
| `schedulesUnavailable` | `当前宿主未启用定时任务服务。` | `Scheduled tasks are unavailable in this host.` |

---

## 5. UI 设计规范清单（实现与复审统一标准）

所有界面改动必须严格满足以下 8 条规范：

1. **顶栏克制**：顶栏右侧固定 3 个控件（`+ 添加成员`、`团队面板`、`⚙ 设置`），窄屏下（`@container rt-board (max-width: 620px)`）无折行、无溢出、无遮挡。
2. **原生语义 Token 100% 对齐**：仅使用 DSH `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*` 变量，禁止硬编码黑白/十六进制颜色，浅色与深色模式对比度均清晰。
3. **零嵌套双滚动条**：抽屉内各 Tab 只有一个主滚动区；展开后的队友回报卡与简报正文绝不出现内层滚动条。
4. **单行摘要条对齐**：折叠态高度紧凑（约 34–38px），发送者名不换行、摘要单行省略号截断、时间右对齐不挤压、箭头图标方向明确；异常状态有清晰语义色。
5. **零裸标签泄漏**：对话流中绝不出现 `<team-brief-update>` 原文标签。
6. **键盘与焦点无障碍**：抽屉支持 `Escape` 关闭并恢复焦点到顶栏按钮；Tab 使用标准 `role="tablist"` / `role="tab"` / `aria-selected`。
7. **未保存与冲突安全**：编辑简报有脏状态时切换 Tab 或关闭抽屉必触发拦截；冲突时不静默覆盖用户输入。
8. **服务降级整洁**：未启用 `schedule` 服务时无报错横幅、无控制台错误。

---

## 6. 两段式验收门禁（缺一不可）

### 门禁一：Codex CLI 工程实现与全量测试
运行 `npm run typecheck && npm run build && npm test`，覆盖：
1. **Brief 存储与安全隔离**：读写、清空、CAS 冲突、非法 `runId` 拒绝、`deleteTeam` 清理、`archiveTeam` 只读、`isolate()` 阻止所有文件工具访问 `teams/`；
2. **多模式与工具契约**：
   - `read_team_brief` / `update_team_brief` 的 `parameters` 严格无 `anyOf` / `oneOf` / `nullable` / `~standard`（原生 + PTC + 外部适配器全兼容）；
   - 成员调用 `update_team_brief` 被拒；超 1500 字返回结构化提示；
   - `standard` / `ptc` / `minimal` / 自定义重写 prompt 的 preset 下，角色与简报说明均有效送达；
3. **KV-Cache 与全生命周期连续性**：
   - 修改 `brief.md` 前后 `systemPrompt` 逐字节不变；
   - 未变更时不重复注入；变更后仅增量注入 1 次；队长自写不自回显；
   - 触发 `compaction/summary` 后 `seenBriefHash` 自动重置并在下一步补发 1 次；
   - `resetSeat` 新代际第一步收到最新简报；
   - 宿主无 `schedule` 服务时 `getTeam().capabilities.schedules === false` 且面板不报错；
4. **前端组件测试**：
   - `TeamTrigger`：`fromParent: false` 默认单行折叠、点击 1 下完整展开（无内滚条）；`fromParent: true` 默认展开；`error` 状态带 `data-alert`；`source.kind === 'team-brief'` 渲染为单行同步提示条且无裸标签；
   - `TeamDrawer`：顶栏 3 控件、3 Tab 切换与 `localStorage` 记忆、未保存拦截、冲突处理、`schedulesAvailable: false` 降级。

### 门禁二：Antigravity（Lead）独立 UI 与设计规范复审
- Codex CLI 完成实现、单测与构建汇报后，**先不直接安装到正式端**；
- 由 **Antigravity** 亲自在隔离临时环境启动 DSH Web，使用 Chrome DevTools MCP 分别截取 **浅色 + 深色** 主题页面，逐条核对第 5 节 8 条 UI 设计规范（顶栏、3-Tab 抽屉、简报阅读/编辑、单行摘要折叠/展开、无裸标签、无控制台报错）；
- 若发现任何视觉或交互不达标，直接打回 Codex CLI 修复并复测；全部达标后再打包安装到正式 Desktop / Web 端并向用户汇报。
