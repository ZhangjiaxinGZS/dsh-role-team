# dsh-role-team

An external DeepSeek Harness (`0.2.2-rc.5+`) plugin for conversational AI role cultivation, shared long-term memory, strict per-team session isolation, and AionUi-style multi-column team collaboration.

## Highlights

- **Plain-Text Role & Memory Store** (`~/.dsh-role-team/roles/`): Each role is an independent folder (`role.md` + `memories/*.md` + `snapshots/`) editable both in the plugin UI and directly in any text editor.
- **Conversational Cultivation & 1-on-1 Coaching**: Shape roles through natural dialogue, run practice exercises or post-task debriefs, and explicitly decide what becomes long-term memory vs. one-off task notes.
- **Strict Per-Team Isolation + Shared Long-Term Memory**: Every team run gets a fresh `root` session and fresh-spawned member sessions. Roles carry only published identity & confirmed memories across teams—never project context or secrets from another team.
- **Controlled Rollout for In-Flight Teams**: Saving role/memory edits auto-publishes for newly created teams, while active parallel teams let you choose when to adopt updates.
- **Mid-Run Context Reset (Logical Seat Generation)**: Clear noisy task context for any team member on the fly while preserving published role memory and optional handoff notes.
- **Multi-Column Workbench (Web & Desktop)**: AionUi-style side-by-side member panes with direct 1-on-1 messaging (`queue` / `steer`) to any member.

See [docs/DESIGN.md](./docs/DESIGN.md) for the full architecture and verification plan.
