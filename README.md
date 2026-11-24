# dsh-role-team

An external DeepSeek Harness (`0.2.2-rc.5+`) plugin for conversational AI role cultivation, shared long-term memory, strict per-team session isolation, and AionUi-style multi-column team collaboration.

## Install and start in three steps

Tested with DeepSeek Harness 0.2.2-rc.5 on macOS. Web and Electron Desktop use the same package and maintain separate plugin profiles.

1. **Build the package.** From this repository with Node.js 24.9 or newer, run the following commands. Keep the resulting tarball at a stable absolute path.

   ```sh
   npm ci
   npm pack
   ```

2. **Install into the profile you use.** For Web, stop its Host, run the command below, then start it with `dsh web`. For Desktop, open the app once, fully quit it, use its bundled CLI for the second command, then reopen the app. The examples show the macOS application path. If Desktop registered its bundled `dsh` command in your terminal, you can use that command directly.

   ```sh
   dsh plugin --profile web add "/absolute/path/dsh-role-team-0.1.0.tgz"
   # macOS Desktop
   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "/absolute/path/dsh-role-team-0.1.0.tgz"
   ```

3. **Create roles and a team.** Open **Role teams → Roles & training**. Choose **New role**, enter a unique role name, and start chatting beside the role settings panel. Selecting a role opens its current coaching chat or starts its first one automatically. A role’s first coaching chat starts with Full access. Choose a permission preset in the composer to change it. Confirm **New conversation** in the chat toolbar to replace the previous chat and carry its selected preset into the new one. The Host archives its native session. The role starts fresh with its saved instructions and long-term experience. Tell it what to change or ask it to remember a lesson. For manual entry, choose **Add experience**, type the lesson and click **Remember**. Open **Role settings** to edit instructions and review experience. Choose **History** to preview and restore one of the ten most recent versions in the same panel. Each role remembers which panes you leave open. To assemble a team, return to **Team workspace → New team**. Select the lead, members, and an existing workspace directory separate from the role library. For generated replies and conversational coaching, configure your DeepSeek key in the Host’s model settings.

Read the [Chinese installation guide and Web/Desktop verification report](docs/VERIFICATION.md) for the tested workflows, screenshots and model coverage.

## Host runtime

The Host provides the plain-text role library, coaching sessions, native team orchestration, revision controls and seat replacement. The client workbench binds a separate live conversation to each seat. Run `npm run typecheck` and `npm test` for development checks.

The Host's `roleStoreDir` setting defaults to `~/.dsh-role-team/roles/`. Store one UTF-8 `role.md` per role and one Markdown file per memory in `memories/`. Each file's YAML `id` matches its role directory or memory filename. Use lowercase ASCII letters, digits, hyphens and underscores for IDs. Display names, titles and bodies support Unicode. The examples in [the design](./docs/DESIGN.md) show both formats.

Valid editor saves automatically create numbered snapshots. Every team loads the latest published settings and experience on its next turn. A turn already in progress keeps its starting revision. Every saved experience enters the next snapshot, including older files marked draft or archived. Delete an experience to remove it from future snapshots. An invalid source file yields its path and line along with the last valid revision. Deleting a role through the API moves it to `.retired/` so its old snapshots remain readable and its ID remains reserved.

### Host API

The `roleTeam` service exposes `listRoles`, `listMemories`, `readDocument`, `saveDocument`, `deleteDocument`, `readSnapshot`, `rescan`, `roleHistory`, and `restoreRole`. The wire contracts are exported from `dsh-role-team/shared`, and `dsh-role-team/remote` exports the mountable `TYPERT_REMOTE` descriptors. A document reference contains `roleId` and an optional `memoryId`. Pass `expectedHash: null` for creation or the SHA-256 returned by the last read for an update/deletion. A conflict returns both current disk text and proposed text. After a successful source write, inspect the returned `status.error` to check whether the entire role could publish.

Web and Desktop plugin writers share a directory lock and recheck disk content immediately before replacement. External editors do not participate in that lock. An editor and the plugin renaming over exactly the same file in the final check-to-rename interval remain subject to filesystem last-writer behavior.

### Training and teams

The typed `roleTeam` methods take a single `request` object for each team or training operation. The schemas are in [src/shared/runtime.ts](src/shared/runtime.ts).

- Call `openTraining` with a role ID to open or create its current chat. Concurrent opens share the same session. To explicitly start a fresh chat, call `createTraining` with a role ID and `mode` (`create`, `coach` or `debrief`). The Host allocates an empty directory for each training session under `<roleStoreDir>.training-sandboxes/<roleId>/`. Each role has its own sandbox parent. API callers can supply an existing `workspaceCwd` to override it. A debrief can optionally link a team through `sourceRunId`. Send ordinary chat to the returned Session. During coaching, `update_role` preserves the current display name by default. `remember_experience` and `revise_experience` save lessons directly.
- Call `createTeam` to open a fresh root. Use `addMember` with an optional `parentSeatId` to spawn a continuable child. Route user text via `promptSeat` with the seat’s current generation, a client-minted request ID, and `queue` or `steer`. `listTeams`, `getTeam`, `renameTeam`, and `archiveTeam` manage the run. Archiving retains its logs.
- Each seat adopts the latest published role automatically at the next turn. Restoring a historical role setting creates a new revision and preserves current long-term experience.
- Call `resetSeat` with the seat’s current generation and selected handoff. The response supplies the new native session ID. A failed transfer leaves a durable reset intent. Retry the original generation and handoff to finish. Use `listGenerations` to find archived session IDs for read-only history.
- Managed sessions use the host default agent preset. The plugin exposes native team messaging and task tools during collaboration, and proposal tools during training. Coaching and team sessions can use the host’s configured MCP servers, browser, network, shell and workspace tools under the selected native permission mode. Native session lookup, inline session references and direct file-tool access to private role/session storage are blocked. Shell commands and external MCP servers run with the access granted by their own host or OS. Choose an agent mode in a blank coaching chat or when creating a team. DSH locks the mode after the first turn. Coaching tools request a Chinese summary of each saved change. Open **Trajectory** in a conversation to inspect tool arguments and results. The panel remembers its last page, role, team and role view on this client. Team composers follow each seat’s session, and children inherit the lead’s permission preset. Choose an existing project directory separate from the role library. The spawn depth limit is eight.

## Product roadmap

- **Plain-Text Role & Memory Store** (`~/.dsh-role-team/roles/`): New roles receive a random ID. Active role names are unique after trimming whitespace and ignoring case. Each role is an independent folder (`role.md` + `memories/*.md` + `snapshots/`) editable both in the plugin UI and directly in any text editor.
- **Conversational Cultivation & 1-on-1 Coaching**: Shape roles through natural dialogue, run practice exercises or post-task debriefs, and explicitly decide what becomes long-term experience and keep one-off instructions in the current conversation.
- **Strict Per-Team Isolation + Shared Long-Term Memory**: Every team run gets a fresh `root` session and fresh-spawned member sessions. Roles carry their saved settings and long-term experience across teams—never project context or secrets from another team.
- **Automatic role updates**: New teams use the latest published settings and experience. Active teams adopt each update on their next turn.
- **Mid-Run Context Reset (Logical Seat Generation)**: Clear noisy task context for any team member on the fly while preserving published role memory and optional handoff notes.
- **Multi-Column Workbench (Web & Desktop)**: AionUi-style side-by-side member panes with direct 1-on-1 messaging (`queue` / `steer`) to any member.

See [docs/DESIGN.md](./docs/DESIGN.md) for the full architecture and verification plan.
