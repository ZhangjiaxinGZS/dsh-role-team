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

3. **Create roles and a team.** Open **Role teams → Roles & training**. Choose **New role**, enter a name and start talking. The role is immediately available. **New conversation** replaces this role’s previous coaching chat. The Host archives its native session. The role starts fresh with its saved instructions and long-term experience. Tell it what to change or ask it to remember a lesson. For manual entry, choose **Add experience**, type the lesson and click **Remember**. Open **Role profile** to edit instructions and review long-term experience. To assemble a team, return to **Team workspace → New team**. Select the lead, members, and an existing workspace directory separate from the role library. For generated replies and conversational coaching, configure your DeepSeek key in the Host’s model settings.

Read the [Chinese installation guide and Web/Desktop verification report](docs/VERIFICATION.md) for the tested workflows, screenshots and model coverage.

## Host runtime

The Host provides the plain-text role library, coaching sessions, native team orchestration, revision controls and seat replacement. The client workbench binds a separate live conversation to each seat. Run `npm run typecheck` and `npm test` for development checks.

The Host's `roleStoreDir` setting defaults to `~/.dsh-role-team/roles/`. Store one UTF-8 `role.md` per role and one Markdown file per memory in `memories/`. Each file's YAML `id` matches its role directory or memory filename. Use lowercase ASCII letters, digits, hyphens and underscores for IDs. Display names, titles and bodies support Unicode. The examples in [the design](./docs/DESIGN.md) show both formats.

Valid editor saves automatically create numbered snapshots. New consumers choose the latest valid revision; an existing consumer can still request its pinned revision after restart. Only published memory bodies enter snapshots. An invalid source file yields its path and line along with the last valid revision. Deleting a role through the API moves it to `.retired/` so its old snapshots remain readable and its ID remains reserved.

### Host API

The `roleTeam` service exposes `listRoles`, `listMemories`, `readDocument`, `saveDocument`, `deleteDocument`, `readSnapshot`, and `rescan`. The wire contracts are exported from `dsh-role-team/shared`, and `dsh-role-team/remote` exports the mountable `TYPERT_REMOTE` descriptors. A document reference contains `roleId` and an optional `memoryId`. Pass `expectedHash: null` for creation or the SHA-256 returned by the last read for an update/deletion. A conflict returns both current disk text and proposed text. After a successful source write, inspect the returned `status.error` to check whether the entire role could publish.

Web and Desktop plugin writers share a directory lock and recheck disk content immediately before replacement. External editors do not participate in that lock. An editor and the plugin renaming over exactly the same file in the final check-to-rename interval remain subject to filesystem last-writer behavior.

### Training and teams

The typed `roleTeam` methods take a single `request` object for each team or training operation. The schemas are in [src/shared/runtime.ts](src/shared/runtime.ts).

- Call `createTraining` with a role ID and `mode` (`create`, `coach` or `debrief`). The Host allocates an empty directory for each training session under `<roleStoreDir>.training-sandboxes/<roleId>/`. Each role has its own sandbox parent. API callers can supply an existing `workspaceCwd` to override it. A debrief can optionally link a team through `sourceRunId`. Send ordinary chat to the returned Session. Show proposals from `getTraining`, including the original text and diff. Call `confirmProposal` when the user accepts. Each memory and role proposal has its own confirmation.
- Call `createTeam` to open a fresh root. Use `addMember` with an optional `parentSeatId` to spawn a continuable child. Route user text via `promptSeat` with the displayed generation, a client-minted request ID, and `queue` or `steer`. `listTeams`, `getTeam`, `renameTeam`, and `archiveTeam` manage the run. Archiving retains its logs.
- For a pending seat revision, send the displayed revision to `versionDecision` with `next-turn` or `keep`. A scheduled revision appears in `approved` until the first admitted step of the new turn. `addNote` stores run-wide or seat-specific notes. `listNotes` reads one run.
- Call `resetSeat` with the displayed generation and selected handoff. The response supplies the new native session ID. A failed transfer leaves a durable reset intent. Retry the original generation and handoff to finish. Use `listGenerations` to find archived session IDs for read-only history.
- The managed preset exposes native team messaging and task tools during collaboration, and proposal tools during training. Team members can read and edit files inside the shared workspace. Shell execution and cross-session search remain restricted. Team composers follow each seat’s session, and children inherit the lead’s permission preset. Choose an existing project directory separate from the role library. The spawn depth limit is eight.

## Product roadmap

- **Plain-Text Role & Memory Store** (`~/.dsh-role-team/roles/`): Each role is an independent folder (`role.md` + `memories/*.md` + `snapshots/`) editable both in the plugin UI and directly in any text editor.
- **Conversational Cultivation & 1-on-1 Coaching**: Shape roles through natural dialogue, run practice exercises or post-task debriefs, and explicitly decide what becomes long-term memory vs. one-off task notes.
- **Strict Per-Team Isolation + Shared Long-Term Memory**: Every team run gets a fresh `root` session and fresh-spawned member sessions. Roles carry only published identity & confirmed memories across teams—never project context or secrets from another team.
- **Controlled Rollout for In-Flight Teams**: Saving role/memory edits auto-publishes for newly created teams, while active parallel teams let you choose when to adopt updates.
- **Mid-Run Context Reset (Logical Seat Generation)**: Clear noisy task context for any team member on the fly while preserving published role memory and optional handoff notes.
- **Multi-Column Workbench (Web & Desktop)**: AionUi-style side-by-side member panes with direct 1-on-1 messaging (`queue` / `steer`) to any member.

See [docs/DESIGN.md](./docs/DESIGN.md) for the full architecture and verification plan.
