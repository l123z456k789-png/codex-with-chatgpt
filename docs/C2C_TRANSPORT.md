# C2C ChatGPT transport

The optional **C2C transport** gives C2C its own outbound path to ChatGPT: C2C
opens a dedicated Google Chrome instance, types the `[C2C]` control message
into the workspace's saved ChatGPT conversation, waits for the structured reply
and records it. The executor (OpenCode, Claude Code, Codex, any agent) only
calls the CLI — it no longer needs a browser, and nobody copy-pastes messages.

Transport is **opt-in and additive**. The low-level protocol
(`c2c task start/plan/executed/handoff/done/status`) is unchanged and still
defaults to `manual`, where the CLI only prints the pending `[C2C]` message for
a human or agent to deliver. Architecture and rationale:
[C2C_TRANSPORT_DESIGN.md](C2C_TRANSPORT_DESIGN.md).

## Enabling transport

Resolution order for every `c2c task …` command:

```
--transport <mode>   >   C2C_TRANSPORT env   >   prefs.json   >   manual
```

- Per command: `--transport chrome` (or `--transport manual`).
- Per shell: set the `C2C_TRANSPORT` environment variable to `chrome` (unknown
  values fail loudly).
- Per machine: `c2c prefs set --transport chrome`; inspect with `c2c prefs get`
  (`--json` for machine-readable output).

The C2C Chrome profile lives under the C2C state directory
(`C2C_STATE_DIR`; on Windows `%LOCALAPPDATA%\codex-with-chatgpt` by default); it
is never the user's daily Chrome profile. `C2C_CHROME_PATH` overrides Chrome
discovery.

## First login

Chrome starts on demand with the isolated C2C profile and opens the saved
conversation, but the transport window is launched with
`--remote-debugging-port=0` — and Google blocks sign-in in a browser started
with a debugging port ("this browser or app may not be secure"). The first
login therefore has to happen once in a plain window:

```bash
c2c browser login
```

This opens the same dedicated profile (`<state>/chrome-profile`) and the same
ChatGPT page as a normal, user-facing window: no debugging port, no
attachment, nothing recorded in `chrome.json`. Log in there (login, CAPTCHA,
2FA and consent are always human steps; C2C never imports cookies or bypasses
a challenge), then close the window. The session persists in the C2C profile.

Then use the transport in a connected workspace:

1. Run a transport command, e.g.
   `c2c task start --executor opencode --agent-session <id> --goal "<goal>" --transport chrome`.
2. If ChatGPT is still not logged in, the command fails with
   `CHATGPT_LOGIN_REQUIRED` and prints the manual fallback (the pending
   `[C2C]` message). Nothing was sent and the checkpoint is kept. Run
   `c2c browser login` again, log in and close the window, then deliver the
   message without creating a second task:

   ```bash
   c2c task resume --executor opencode --agent-session <id> --transport chrome
   ```

   `task start` must not be repeated: the INIT checkpoint already exists and
   would be rejected.

The login persists in the C2C profile. If the command reports
`CHROME_NOT_FOUND`, install Google Chrome or set `C2C_CHROME_PATH`.

## Daily loop

All executors use the same commands; only `--executor` and the agent-session id
differ:

| Executor | Entry point | `--executor` |
| --- | --- | --- |
| OpenCode | `c2c opencode install` (installs `.opencode/skill/c2c/SKILL.md`) | `opencode` |
| Claude Code | `c2c claude install` (installs rules and hooks) | `claude-code` |
| Codex | the existing C2C skill; it can adopt the transport by calling the same commands | `codex` |
| Any other agent | the contract in [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | any stable id |

Substitute your own `--executor` id and one stable `--agent-session` id per
session.

1. **Start** — sends INIT, waits for the reply, records `STATE: PLAN`
   automatically:

   ```bash
   c2c task start --executor opencode --agent-session <session-id> \
     --goal "<one paragraph>" --transport chrome
   ```

   `--new-chat` bootstraps a fresh conversation, `--no-wait` sends without
   waiting, `--wait-seconds <n>` overrides the reply timeout, and
   `--review-iterations <n|until_done>` sets this task's review limit. Add
   `--json` for machine-readable output.

2. **Implement** with the executor's normal tools and run the tests. ChatGPT
   reviews the real git diff and the execution evidence through the read-only
   MCP connector — never paste diffs, file bodies or logs into the control
   chat.

3. **Record** — appends the evidence and sends EXECUTED:

   ```bash
   c2c task executed --executor opencode --agent-session <session-id> \
     --task <task-id> --iteration <n> --changed-files <files|count> \
     --tests "<summary>" --transport chrome
   ```

   Optional evidence flags: `--exit-status <ok|failed|blocked>`,
   `--notes "<text>"`, and `--command <text>` with `--output`/`--output-file`/
   `--exit-code` to nominate a sanitized command log.

4. **Follow the reply** — `STATE: PLAN` starts the next iteration (step 2-3);
   `STATE: DONE` ends it with
   `c2c task done --executor opencode --agent-session <session-id> --task <task-id>`;
   `STATE: BLOCKED` is surfaced to the user, unchanged checkpoint.

5. **Resume** — if a command returns while the reply is still pending, resume
   without resending:

   ```bash
   c2c task resume --executor opencode --agent-session <session-id> --transport chrome
   ```

The same commands without `--transport` (or with `--transport manual`) print
the pending `[C2C]` message for manual delivery. A transport failure never fails
the core: the manual fallback and the checkpoint are always kept.

Each session must keep **one stable `--agent-session` id** for its whole task.
OpenCode exposes no session id to the skill, so the agent generates one once
(a short workspace-scoped string), records it, and reuses it in every command.

## Browser lifecycle

- Chrome is started on demand and **reused** between commands; attaching and
  detaching never kills it.
- `c2c browser status` shows the recorded C2C Chrome instance and probes the
  debugging port; `c2c browser close` terminates the C2C-owned instance only.
- The CDP port is ephemeral and loopback-only; it is never exposed through the
  tunnel.

## Preferences

`c2c prefs set` stores machine-wide defaults; `c2c prefs get --json` prints them.

| Preference | Flag | Default |
| --- | --- | --- |
| Transport | `--transport manual\|chrome` | `manual` |
| Task mode | `--default-mode full\|review\|off` | `full` (only full is implemented) |
| Review rounds | `--review-iterations <n\|until_done>` | `3` |
| Tasks per conversation | `--max-tasks-per-conversation <n>` | `10` |
| Protocol roundtrips | `--max-roundtrips <n>` | `30` |
| Abnormal signals | (not settable via CLI) | `3` |
| Reply timeout | `--reply-timeout <seconds>` | `600` |

## Review limits

A task may use at most `--review-iterations` review rounds (default from
prefs). When the limit is reached with another `STATE: PLAN`, the command
records the PLAN, pauses the task (`waitingFor: USER`) and prints exactly four
choices:

- continue 1 iteration,
- continue 3 iterations,
- continue `until_done`,
- stop (the task stays paused, checkpoint kept).

The user picks; an agent must surface the four `c2c task resume …` commands
instead of choosing for the user. The chosen limit is applied by running the
printed `c2c task resume --review-iterations …` command.

A separate no-progress fuse pauses the loop when two consecutive review rounds
report identical changed files, tests and exit status (`NO_PROGRESS_DETECTED`);
the checkpoint is kept and the command prints how to resume.

## Conversation rotation

One long-lived ChatGPT conversation per workspace is reused. Counters
(tasks per conversation, protocol roundtrips, abnormal signals) are compared to
the prefs thresholds above; on reaching one, C2C recommends rotation: the
current task always finishes in the old conversation and the next
`c2c task start` opens a fresh one (counters reset when the chat URL changes).
`--new-chat` forces a fresh conversation for one task. If a conversation
itself cannot continue (identity mismatch, unreadable), `c2c task handoff`
builds a HANDOFF message from the checkpoint to continue in a replacement chat.

## Recovery

| Situation | Action |
| --- | --- |
| Not logged in (`CHATGPT_LOGIN_REQUIRED`) | Run `c2c browser login`, log in and close the window, then `c2c task resume …` (never `task start` again) |
| Reply pending after `--no-wait` or a timeout | `c2c task resume …` (never resends a confirmed message) |
| Chrome missing or failed to start | Manual fallback is printed; install Chrome or set `C2C_CHROME_PATH` |
| Identity mismatch / unparseable reply | Hard failure; nothing is executed or recorded: `c2c doctor -w <workspace> --json`, then retry |
| Lost ChatGPT chat | `c2c task handoff …`, send the HANDOFF message in the replacement chat |
| Restarted agent process | `c2c task status --executor <id> --agent-session <id> --json`; resume from `checkpoint.protocolState` |
| Review limit or no-progress pause | Use the printed `c2c task resume --review-iterations …` command |

## Security boundaries

- Destinations are fixed: only validated `chatgpt.com` URLs are opened; no
  arbitrary-URL API.
- The C2C Chrome profile is isolated and C2C never reads, imports or exports
  cookies, storage, history or `Login Data`.
- Login, CAPTCHA, 2FA and consent are human steps; failure is reported, never
  faked.
- The debugging port is loopback-only and never tunneled.
- Command outputs nominated for review pass through the local sanitizer and
  the MCP server stays read-only.
- Control messages stay small; diffs, file bodies and logs are read by ChatGPT
  through MCP, not pasted.
- `executor=opencode` (or `claude-code`, `codex`, …) is the caller id; the
  transport never names or selects a model and adds no capability the executor
  did not have.

## OpenCode adapter

`c2c opencode install` writes one managed file, `.opencode/skill/c2c/SKILL.md`
(valid OpenCode skill: `name` matching the folder, third-person `description`
with triggers), and `c2c opencode uninstall` removes it. Install is idempotent
(a second run reports `unchanged`); unrelated `.opencode` files are never
touched. `c2c opencode status [--agent-session <id>] --json` reports
`installed`, `ready` and the active checkpoint.

**No plugin is shipped.** The OpenCode plugin documentation (checked
2026-09-14, <https://opencode.ai/docs/plugins>) documents local auto-discovery
(`.opencode/plugins/`), the plugin context (`project`, `directory`, `worktree`,
`client`, `$`), and the hooks `event`, `tool.execute.before/after`,
`shell.env` and `experimental.session.compacting` — but it defines no verified
way to inject the current session id plus commands into the conversation
context. Rather than guess a hook contract, C2C ships the skill only and the
agent keeps one stable session id itself.

## Live end-to-end verification

The live E2E is manual and never runs in `pnpm test`/`vitest` (tests never open
Chrome or reach chatgpt.com).

1. Prerequisites: a connected workspace (`c2c doctor -w <workspace> --json`
   green, `c2c session set` done) and Google Chrome available.
2. `c2c browser status` shows the recorded C2C Chrome instance (none is
   required yet).
3. Start a small real task in a scratch workspace:
   `c2c task start --executor opencode --agent-session <id> --goal "<small real task>" --transport chrome`.
4. If the outcome is `CHATGPT_LOGIN_REQUIRED` (LEVEL B): the user logs in once
   with `c2c browser login` (the transport window has a debugging port, which
   Google blocks for sign-in) and closes that window, the delivery is retried
   with
   `c2c task resume --executor opencode --agent-session <id> --transport chrome`
   (`task start` is not repeated; the INIT checkpoint exists), and the E2E
   continues.
5. Complete the loop (`c2c task executed … --transport chrome`, review, `c2c
   task done …`) and capture the JSON transcripts, then `c2c browser close`.

Record the verdict in `docs/C2C_TRANSPORT_PROOF.md`:

- **LEVEL A** — the full loop ran with zero copy-paste: start → PLAN →
  executed → independent review → DONE.
- **LEVEL B** — the run stopped at `CHATGPT_LOGIN_REQUIRED`; this is a valid,
  reported outcome, not a failure, because login is a human step.
- Flags: `REAL_OPEN_CODE_CHATGPT_E2E`, `REAL_MCP_REVIEW`, `ZERO_COPY_PASTE`,
  `PERSONAL_DAILY_DRIVER_READINESS`.
