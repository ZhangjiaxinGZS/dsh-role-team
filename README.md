# dsh-role-team

[中文](#中文) · [English](#english) · [GitHub Releases](https://github.com/ZhangjiaxinGZS/dsh-role-team/releases)

## 中文

像培养真人专家一样培养你的 AI 团队。在 DeepSeek Harness 里与角色一对一交流，把反复用到的判断标准和经验存成 Markdown，再让这些角色在团队里一起工作。

- **角色库**保存名称、职责、详细设定和长期经验。可预览并恢复最近十个设定版本。角色更新后，团队成员在下一轮采用新设定。
- **团队工作台**支持单栏和多栏对话，用 `@成员` 指派工作，通过共享任务板、定时任务和成员回报跟进进度。
- **会话与权限**由宿主管理。团队各有独立会话，模型与工具沿用宿主配置。首次培养会话默认完全权限，可以在输入栏切换。

### v0.3.0 团队协作

角色可保存默认模型和权限。角色改名后，工作台同步更新席位名称。团队设置中可以查看和复制工作目录。

团队面板将简报、任务板和定时任务放在三个标签页。简报变更通过消息后缀同步，保留系统提示词的缓存前缀，压缩或换代后会重新同步。多层团队按发送者与接收者的关系折叠例行通知。每个团队可选择优先委派、自由协作或自定义规则；优先委派时，队长会先向用户澄清缺失的目标与约束。

[设计说明](docs/DESIGN-v0.2.0.md) · [评测协议](docs/EVALUATION.md) · [复现指南](benchmarks/README.md) · [Flash 首轮报告](benchmarks/results/live-deepseek-flash/report.md) · [Codex 首轮报告](benchmarks/results/live-codex/report.md)

打开角色团队页面时会向 GitHub 查询最新发布版本，宿主缓存结果六小时。在 `role-team` 插件配置中设置 `checkUpdates: false` 可关闭此请求。

### 安装与上手

需要 DeepSeek Harness 0.2.2-rc.5（或兼容的 0.2.x）及 Node.js 24.9+。从 [v0.3.1 Release](https://github.com/ZhangjiaxinGZS/dsh-role-team/releases/tag/v0.3.1) 下载压缩包和校验文件，放在固定目录，在该目录执行下方命令。Desktop 与 Web 分别安装，选择你使用的端即可。

```sh
shasum -a 256 -c SHA256SUMS.txt
dsh plugin --profile web add "$PWD/dsh-role-team-0.3.1.tgz"
# macOS Desktop
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD/dsh-role-team-0.3.1.tgz"
```

1. 重启宿主，打开「角色团队 → 角色库与培养」，新建角色并填写职责。
2. 在培养对话中让角色记住一条经验。在「角色设定」中查看保存的内容。
3. 打开「团队工作台」，新建团队，选择队长、成员和工作目录。向队长发送任务，或用 `@` 指定成员。

本次发布通过 GitHub 分发。以后若同版本发布至 npm，Web 可使用 `dsh plugin --profile web add dsh-role-team@0.3.1` 按包名安装。也可从源码运行 `npm ci` 和 `npm pack` 自行构建。

## English

Train an AI team the way you would train a group of specialists. Coach each role in conversation, save its working standards and long-term lessons as Markdown, then bring the roles together on a shared assignment.

- **Role library.** Review and restore the last ten profile revisions. Team members pick up saved changes on their next turn.
- **Team workspace.** Follow conversations side by side or focus on one member. Assign work with @mentions and track it through the shared task board, schedules and member reports.
- **Sessions and permissions.** Each team has its own conversations. Models and tools come from the host. A role’s first coaching chat starts with Full access, adjustable in the composer.

### Team collaboration in v0.3.0

Save a default model and permission preset per role. Seat names follow role renames, and team settings let you view and copy the workspace directory.

The team panel has three tabs for the shared brief, task board and schedules. Brief updates travel in a message suffix so the system prompt prefix stays stable. The host resynchronizes the brief after compaction or seat replacement. Nested teams fold routine notifications according to the sender’s relationship to the recipient. Each team can use delegation-first, balanced or custom rules. The delegation-first policy asks the lead to clarify missing requirements before assigning work.

[Design](docs/DESIGN-v0.2.0.md) · [Evaluation protocol](docs/EVALUATION.md) · [Reproduction guide](benchmarks/README.md) · [Flash baseline](benchmarks/results/live-deepseek-flash/report.md) · [Codex baseline](benchmarks/results/live-codex/report.md)

### Install and start

Use DeepSeek Harness 0.2.2-rc.5 or a compatible 0.2.x host and Node.js 24.9+. Download the tarball and checksum from the [v0.3.1 release](https://github.com/ZhangjiaxinGZS/dsh-role-team/releases/tag/v0.3.1). Keep both in a stable directory. Run the checksum and profile-specific install commands above from that directory, then restart the host. For a source build, run `npm ci` and `npm pack`. Registry installation with `dsh plugin --profile web add dsh-role-team@0.3.1` requires a future npm publication.

1. Open **Role teams → Roles & training** and create a role with a short description.
2. Ask the role to remember a lesson. Open **Role settings** to review what it saved.
3. In **Team workspace**, create a team, select its lead and members, and choose a workspace directory separate from the role library. Give the lead a task or mention a particular member.

## License / 许可证

[MIT](LICENSE) · Copyright © 2026 ZhangjiaxinGZS

## Host runtime

Opening the workbench checks the public GitHub Release endpoint for updates. The host caches the result for six hours. Set `checkUpdates: false` on the `role-team` plugin entry to disable these requests.

The Host provides the plain-text role library, coaching sessions, native team orchestration, revision controls and seat replacement. The client workbench binds a separate live conversation to each seat. Run `npm run typecheck` and `npm test` for development checks.

The Host's `roleStoreDir` setting defaults to `~/.dsh-role-team/roles/`. Store one UTF-8 `role.md` per role and one Markdown file per memory in `memories/`. Each file's YAML `id` matches its role directory or memory filename. Use lowercase ASCII letters, digits, hyphens and underscores for IDs. Display names, titles and bodies support Unicode. The examples in [the design](./docs/DESIGN.md) show both formats.

Valid editor saves automatically create numbered snapshots. Every team loads the latest published settings and experience on its next turn. A turn already in progress keeps its starting revision. Every saved experience enters the next snapshot, including older files marked draft or archived. Delete an experience to remove it from future snapshots. An invalid source file yields its path and line along with the last valid revision. Deleting a role through the API moves it to `.retired/` so its old snapshots remain readable and its ID remains reserved.

### Host API

The `roleTeam` service exposes `listRoles`, `listMemories`, `readDocument`, `saveDocument`, `deleteDocument`, `readSnapshot`, `rescan`, `roleHistory`, and `restoreRole`. The wire contracts are exported from `dsh-role-team/shared`, and `dsh-role-team/remote` exports the mountable `TYPERT_REMOTE` descriptors. A document reference contains `roleId` and an optional `memoryId`. Pass `expectedHash: null` for creation or the SHA-256 returned by the last read for an update/deletion. A conflict returns both current disk text and proposed text. After a successful source write, inspect the returned `status.error` to check whether the entire role could publish.

Web and Desktop plugin writers share a directory lock and recheck disk content immediately before replacement. External editors do not participate in that lock. An editor and the plugin renaming over exactly the same file in the final check-to-rename interval remain subject to filesystem last-writer behavior.

### Training and teams

The typed `roleTeam` methods take a single `request` object for each team or training operation. The schemas are in [src/shared/runtime.ts](src/shared/runtime.ts).

- Call `openTraining` with a role ID to open or create its current chat. Concurrent opens share the same session. To explicitly start a fresh chat, call `createTraining` with a role ID and `mode` (`create`, `coach` or `debrief`). The Host allocates an empty directory for each training session under `<roleStoreDir>.training-sandboxes/<roleId>/`. Each role has its own sandbox parent. API callers can supply an existing `workspaceCwd` to override it. A debrief can optionally link a team through `sourceRunId`. Send ordinary chat to the returned Session. During coaching, `update_role` preserves the current display name by default. `remember_experience` and `revise_experience` save lessons directly.
- Call `createTeam` to open a fresh root. Use `addMember` with an optional `parentSeatId` to spawn a continuable child. Route user text via `promptSeat` with the seat’s current generation, a client-minted request ID, and `queue` or `steer`. `listTeams`, `getTeam`, `renameTeam`, and `archiveTeam` manage the run. Archiving retains its logs. From an archived team’s menu, **Delete permanently** removes the team, seat and generation indexes. Native session logs and the role library remain available.
- Each seat adopts the latest published role automatically at the next turn. Restoring a historical role setting creates a new revision and preserves current long-term experience.
- Call `resetSeat` with the seat’s current generation. The workbench sends an empty handoff for a new reset. The response supplies the new native session ID. A failed transfer leaves a durable reset intent. Retry the original generation and handoff to finish. Use `listGenerations` to find archived session IDs for read-only history.
- Managed sessions use the host default agent preset. The plugin exposes native team messaging and task tools during collaboration, and proposal tools during training. Coaching and team sessions can use the host’s configured MCP servers, browser, network, shell and workspace tools under the selected native permission mode. Native session lookup, inline session references and direct file-tool access to private role/session storage are blocked. Shell commands and external MCP servers run with the access granted by their own host or OS. Choose an agent mode in a blank coaching chat or when creating a team. DSH locks the mode after the first turn. Coaching tools request a Chinese summary of each saved change. Open **Trajectory** in a conversation to inspect tool arguments and results. The panel remembers its last page, role, team and role view on this client. Team composers follow each seat’s session, and children inherit the lead’s permission preset. Choose an existing project directory separate from the role library. The spawn depth limit is eight.
