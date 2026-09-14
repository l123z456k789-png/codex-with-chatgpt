# Claude Code Integration

Claude Code as a C2C executor: ChatGPT plans and reviews; Claude Code executes.
This is a **thin adapter** over the generic task core — it adds Claude-specific
installation, hooks and browser transport, and reuses the shared lifecycle,
checkpoint, protocol-message and evidence code unchanged.

> Status: code complete and covered by tests; a real Claude→ChatGPT end-to-end
> run is **BLOCKED on this machine** (Claude Desktop, which provides the
> built-in `Claude_Browser`, is not installed and no ChatGPT login is
> available here). The local skill/guard/post-hook behavior is verified by
> `tests/claude-adapter.test.ts`.

## Architecture

```
Claude Code
  │  .claude/settings.local.json hooks (UserPromptSubmit / PreToolUse / PostToolUse)
  ▼
src/adapters/claude-code.ts        (Claude-specific only)
  │  session id → (executor=claude-code, agent-session=<Claude session id>)
  │  browser transport instructions, guard, prompt injection
  ▼
src/protocol/lifecycle.ts + messages.ts   (generic task core)
  │
  ▼
session/agent-session · execution records · ChatGPT MCP (read-only)
```

The adapter never defines its own protocol states, checkpoints, execution
records, message formats or connection validation.

## Installation

```bash
c2c claude install -w <workspace> --json
c2c claude status  -w <workspace> --json
c2c claude uninstall -w <workspace> --json
```

`install` writes **project-local** files only:

| File | Purpose |
| --- | --- |
| `.claude/rules/c2c-chatgpt.md` | Claude rule: ChatGPT plans/reviews, Claude executes; browser discipline |
| `.claude/skills/c2c/SKILL.md` | Auto-invoked skill describing the `c2c task` loop |
| `.claude/settings.local.json` | Merged hooks; existing keys and hooks are preserved |

`uninstall` removes only the managed files/hooks; other settings remain. A
global (`~/.claude`) install and a one-shot bootstrap wrapper are intentionally
not provided yet.

Before first use the workspace needs a verified ChatGPT connector/chat
(`c2c setup`, then `c2c session set` after verifying `workspace_info`). The
prompt hook gives a SETUP GATE when that is missing instead of starting a task.

## Lifecycle mapping

| Claude event | Core call |
| --- | --- |
| `UserPromptSubmit` (new coding prompt) | `startTask` → INIT checkpoint + INIT message |
| `UserPromptSubmit` (checkpoint active) | resume/execution gate from `readAgentSessionCheckpoint` |
| ChatGPT replied `STATE: PLAN` | `markPlan` (`c2c task plan …`) |
| implementation + tests done | `markExecuted` (`c2c task executed …`) → record + EXECUTED message |
| chat lost / replacement | `handoffTask` (`c2c task handoff …`) |
| ChatGPT replied `STATE: DONE` | `finishTask` (`c2c task done …`) |
| restarted agent | `readTaskStatus` (`c2c task status …`) |

The skill runs the same `c2c task` commands as every other executor; the hook
injects them with `--executor claude-code --agent-session <Claude session id>`
already filled in. Hook commands call the shared TypeScript API directly.

## Session isolation

Claude's hook `session_id` becomes the generic `agent-session`. Checkpoints are
stored per `(workspace, executor=claude-code, agent-session)` by the shared
store — there is **no** `claude-sessions/` directory and no second storage
format. Two concurrent Claude chats in one workspace share the connector but
never share checkpoints.

## Browser requirements

- Claude **Desktop**'s built-in browser (`Claude_Browser`) is required for the
  transport. Claude Code alone cannot send the control messages.
- The browser must be signed in to ChatGPT; login, CAPTCHA, 2FA and consent
  screens are handled by the user, never bypassed.
- Never launch or control a third-party browser, and never read, copy, import
  or export cookies or browser storage.
- Never click the composer by screen coordinates. Locate the prompt textarea,
  focus it, verify it is active, and re-read the text after every typing stage
  ("typed N chars" is not evidence). Use `shift+Enter` for line breaks.

### Manual fallback

If `Claude_Browser` is unavailable, show the user the exact `[C2C]` message to
paste into the saved chat. Never fabricate a PLAN, DONE or BLOCKED reply and
never record a state ChatGPT did not send.

## Security

- The MCP server stays **read-only**; the adapter adds no file, shell or
  network capability. Claude writes code with its own tools.
- The guard hook blocks `Bash|Edit|Write|NotebookEdit` while the task waits for
  the ChatGPT PLAN or review; C2C commands and read-only shell commands stay
  allowed.
- Evidence still flows through `c2c task executed` and the existing sanitizer
  (secret redaction, private-key rejection, UTF-16/NUL hardening). Diffs and
  logs are never pasted into the control messages.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Hook does not fire | `c2c claude status -w <workspace> --json`; reinstall; check `.claude/settings.local.json` has the three managed hooks |
| "MANDATORY C2C SETUP GATE" | Configure the workspace: `c2c setup`, save the verified chat with `c2c session set`, retry |
| Guard denies all edits | A checkpoint is waiting for ChatGPT's PLAN or review; send/record the expected message or `c2c task done` |
| EXECUTED message lost | `c2c task handoff -w <workspace> --executor claude-code --agent-session <id> --task <taskId> --json` and send that in the current chat |
| Browser tool unavailable | Manual fallback: ask the user to paste the message |
| Wrong/duplicate task | `c2c task status … --json`; never start a second task while a checkpoint is active |

## Not included (by design)

- Global `~/.claude` hook installation and `--global-fallback` dispatch.
- `claude bootstrap` (use the generic `c2c setup` / `c2c doctor`).
- Git-worktree canonicalization (use the installed workspace root).
- Any Claude-specific copy of the protocol lifecycle or storage.
