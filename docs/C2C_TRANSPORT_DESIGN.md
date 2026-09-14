# C2C-Owned ChatGPT Chrome Transport — Design

Status: accepted for Phase 5 (`feat/any-agent-executor`).
Scope: give C2C its own outbound transport to ChatGPT so executors (OpenCode,
Claude Code, Codex, future agents) no longer need a browser.

## 1. Problem and audit findings

Until Phase 4 the control plane was outbound by delegation only:

- `src/protocol/lifecycle.ts` builds `[C2C]` messages and persists checkpoints;
  delivery was performed by the executor's own browser/computer-use tool, or by
  the user copy-pasting (`docs/AGENT_PROTOCOL.md`).
- `src/adapters/claude-code.ts` instructs Claude to use `Claude_Browser`;
  `skill/SKILL.md` instructs Codex to use its in-app browser.
- No `playwright` / `puppeteer` / CDP dependency existed anywhere
  (`package.json`, `pnpm-lock.yaml`, `src/`); C2C never opened a browser.
- There is no parser for ChatGPT replies; the executor records `task plan`
  from what it read.

Consequences: every executor needs its own browser automation, model choice
inside the executor can leak into the integration, and a Daily Driver requires
the agent to know transport details.

Audit evidence lives in `docs/ANY_AGENT_ARCHITECTURE_AUDIT.md` (two planes,
executor boundary) and upstream PR #431 (Claude adapter = executor boundary,
not a transport). Codex Skill browser rules worth reusing are only the
*discipline*, not the architecture: DOM checks instead of screenshots, never
resend after a timeout, verify typed text, one tab, verified workspace name
before continuing (`skill/SKILL.md:101-178`).

## 2. Decisions

| # | Decision | Reason |
| - | -------- | ------ |
| D1 | Executor != Transport. `executor=opencode` is constant; model names never enter the contract. | Model choice is an OpenCode internal detail. |
| D2 | Transport is C2C-owned and outbound: C2C opens ChatGPT and types the messages. | Agents stop needing browsers. |
| D3 | Fixed browser: Google Chrome, dedicated `--user-data-dir` under the C2C state dir. | Login persists; the user's daily profile is never touched. |
| D4 | First login is manual (user types credentials/CAPTCHA/2FA in the C2C Chrome window). | No cookie import, no credential automation, no CAPTCHA bypass. |
| D5 | On-demand lifecycle: Chrome may start for a command and stay alive for a bounded time; not a daemon. | Simple now; `on-demand → persistent` later must not rewrite the core. |
| D6 | Conversation reuse: one long-lived ChatGPT conversation per workspace (`SavedSession.url`), optional forced new chat, automated rotation by thresholds. | Matches existing session storage; avoids per-task chats. |
| D7 | FULL mode first (`INIT → PLAN → EXECUTED → review → PLAN|DONE|BLOCKED`); REVIEW/OFF are config placeholders only. | Do not delay transport for three modes. |
| D8 | Review iteration limits and rotation thresholds are configuration, never hard-coded policy. | User-owned policy. |
| D9 | Existing low-level API (`task start/plan/executed/handoff/done/status`) is unchanged. Transport is opt-in (`--transport chrome` / prefs / env). | 215 existing tests and the Codex workflow must keep working. |

## 3. Automation technology choice

Candidates evaluated before implementation:

| Criterion | `playwright-core` | `puppeteer-core` | raw CDP (`chrome-remote-interface`) |
| --- | --- | --- | --- |
| Windows 11 stability | Very good | Very good | Own responsibility |
| Persistent Chrome profile | Ours: launch Chrome with `--user-data-dir`, attach via `connectOverCDP` | Same, `puppeteer.connect` | Same, hand-rolled websocket |
| Reliable ChatGPT page operation | Locator auto-wait, `getByRole`-style semantics | Good, manual waits | Manual selectors + wait loops |
| DOM detection | `page.evaluate` + locators | Same | Runtime.evaluate |
| Streaming completion | Our poll loop; stable APIs | Our poll loop | Our poll loop |
| Recovery / reattach | `connectOverCDP` (close = disconnect, browser survives) | `connect` | Reconnect by hand |
| Transitive dependencies | **0** (`playwright-core` only) | 6+ (`ws`, `chromium-bidi`, `devtools-protocol`, …) | `ws` + `commander` (old) |
| Maintainability | Actively maintained, Chrome-first CDP | Actively maintained | Protocol churn on us |

Decision: **`playwright-core`** (`1.63.0`, zero transitive dependencies).

Why not the alternatives: `puppeteer-core` is a fine runner-up but adds six
runtime packages and buys nothing this project needs. Raw CDP minimizes the
dependency count further but would put selector waiting, input synthesis,
streaming detection and reconnect logic under our maintenance, contradicting
the "transport must be reliable" requirement. We do **not** use Playwright's
bundled browsers or `launch()`; Chrome is launched by C2C with an isolated
profile and Playwright only attaches to it.

## 4. Architecture

```
src/transport/
  chrome.ts             Chrome binary discovery + isolated process lifecycle
                        (user-data-dir, remote-debugging-port, lock/state file,
                        health check, bounded relaunch, close)
  selectors.ts          Central selector registry + candidate fallback resolution
  driver.ts             Thin PageDriver port + PlaywrightPageDriver adapter
  chatgpt-page.ts       ChatGPT flows over the port: login detection, composer
                        verification, send + confirm, new conversation, reply wait
  reply.ts              [C2C] reply parser + identity validation + abnormal signals
  delivery.ts           Delivery ledger (message identity, content hash, confirmed
                        send, response identity) for crash recovery / dedupe
  errors.ts             TransportError with stable codes (CHATGPT_LOGIN_REQUIRED,
                        CHATGPT_UI_CHANGED, CHATGPT_SEND_UNCONFIRMED, …)
  chatgpt-transport.ts  Facade used by the protocol layer

src/conversation/rotation.ts   Conversation counters + ROTATION_RECOMMENDED
src/protocol/review-policy.ts  Review iteration limits, no-progress fuse
src/protocol/roundtrip.ts      Composes lifecycle + transport + policy;
                               used by `c2c task start/executed/resume --transport chrome`
src/adapters/opencode.ts       OpenCode plugin/skill installer over the generic core
```

Boundaries:

- Transport does **not** know task lifecycle, execution records, workspace
  logic, PLAN semantics, git or tests. It opens conversations, sends text,
  waits, reads text, validates conversation identity.
- The protocol layer does **not** know selectors, Chrome flags or DOM shapes.
- Executors do **not** import transport modules; they call the CLI.

## 5. Chrome lifecycle

- Profile: `<state>/chrome-profile` (`C2C_STATE_DIR` aware). Never in the repo,
  never temp, never a default Chrome profile. Contains only the C2C login.
- Binary: `C2C_CHROME_PATH` override, then standard Windows/macOS/Linux
  locations. Google Chrome only (no Edge).
- Launch: detached `chrome.exe --user-data-dir=<profile> --remote-debugging-port=0
  --no-first-run --no-default-browser-check <start-url>`; the port is read from
  the profile's `DevToolsActivePort` file.
- Lock/state: `<state>/transport/chrome.json` `{ pid, port, profileDir, startedAt }`.
  A live, healthy instance (loopback `/json/version`) is reused; a stale one is
  killed and replaced. Bounded: one relaunch attempt.
- Attachment: `chromium.connectOverCDP(http://127.0.0.1:<port>)`; after the
  command, `browser.close()` only *disconnects* — Chrome stays for the next
  command ("keep for a reasonable time"). `c2c browser close` terminates it.

## 6. Conversation model

- Navigation target for normal operation is the saved `chatUrl`
  (`requireConnectedSession`), guarded to `https://chatgpt.com/**`.
- `--new-chat` (or a rotation recommendation at the start of a new task)
  creates a fresh conversation at `https://chatgpt.com/`, sends a bootstrap
  message (`buildBootstrapMessage`) that asks GPT to verify
  `workspace_info == <workspace name>` and reply with `[C2C]` plus a
  `WORKSPACE: <workspace name>` line (`parseReadinessWorkspace`), then saves
  the resulting `/c/<id>` URL as the workspace `chatUrl`.
- Rotation policy (`src/conversation/rotation.ts`), thresholds from prefs:
  `maxTasksPerConversation` (default 10), `maxProtocolRoundtrips` (default 30),
  abnormal signals (default 3). Reaching a threshold marks
  `ROTATION_RECOMMENDED`; the current task always finishes in the old
  conversation, and the next task starts a new one.
- Emergency mid-task rotation: only when the conversation itself cannot
  continue (identity mismatch / unreadable conversation). C2C builds a HANDOFF
  from the checkpoint (`taskId`, `iteration`, goal, progress, issues, next
  step), bootstraps the new conversation, sends HANDOFF, and resumes. The
  reason is recorded.

## 7. Messages, replies and identity

- Outbound: existing `buildInitMessage` / `buildExecutedMessage` /
  `buildHandoffMessage` (unchanged) plus `buildBootstrapMessage`.
- Inbound: `parseChatGptReply` recognizes `STATE: PLAN|DONE|BLOCKED|ERROR`,
  `TASK_ID`, `ITERATION`, tolerating phrasing around them.
- Hard failures: reply `TASK_ID` != active task → `PROTOCOL_IDENTITY_MISMATCH`
  (no executor execution). Backwards `ITERATION` → same. Missing `TASK_ID` /
  `ITERATION` / `[C2C]` marker → accepted with an abnormal signal recorded.

## 8. Delivery and recovery

Delivery ledger entries keyed by `taskId + STATE + iteration`:
`{ contentHash, status: prepared|sent|confirmed|responded, sentAt, confirmedAt,
responseMessageId, responseState }`.

- Before sending, read the conversation: if the last user message content
  matches the prepared message, treat it as confirmed (idempotent resume).
- After send, confirm the new user message and record its message id; the
  reply is resolved relative to that id, never "whatever is last".
- Crash between send and confirm: next run finds the message and continues
  waiting; the same message is never sent twice.

## 9. Response completion

No fixed sleeps. Poll (cadence ~0.8s) the page snapshot:

1. wait for `!generating` (stop-button gone) **and**
2. an assistant message strictly after the sent user message **and**
3. its text non-empty and stable for a stability window (~1.5s).

Then parse. Generation longer than the configured timeout (default 600s,
`--wait-seconds`/prefs override) fails as `CHATGPT_RESPONSE_TIMEOUT` with the
checkpoint kept.

## 10. Review policy

- `defaultReviewIterations = 3` (prefs), per-task override
  (`--review-iterations N|until_done`), `until_done` supported.
- When the limit is reached with another PLAN: record the PLAN, set
  `waitingFor: USER`, keep the checkpoint, and print the four user choices
  (continue 1 / continue 3 / until done / stop) with exact `c2c task resume`
  commands. Never loop forever silently.
- Independent safety fuse (separate from the limit): unchanged
  (plan, changed files, tests, exit status) for two consecutive review rounds
  → `NO_PROGRESS_DETECTED`, checkpoint kept, loop paused.

## 11. Security

- No arbitrary-URL API: the only destinations are `chatgpt.com` (validated)
  and the configured conversation URL; the transport rejects other origins.
- The profile is isolated; C2C never reads, imports or exports cookies,
  `Login Data`, storage or history. Logs print only
  `profile initialized / login required / ready`, never profile contents.
- The CDP port binds loopback with an ephemeral port and is never exposed
  through the tunnel.
- Login, CAPTCHA, 2FA and consent remain human steps; failure surfaces
  `CHATGPT_LOGIN_REQUIRED` with instructions, never a fake success.
- Transport failure never fails the core: the pending `[C2C]` message and the
  manual fallback are always printed.

## 12. Configuration (prefs.json, machine-wide)

```json
{
  "transport": "manual | chrome            (default manual)",
  "defaultMode": "full | review | off      (default full; only full implemented)",
  "defaultReviewIterations": 3,
  "maxTasksPerConversation": 10,
  "maxProtocolRoundtrips": 30,
  "replyTimeoutSeconds": 600
}
```

CLI: `c2c prefs set --transport chrome --review-iterations 3 ...`. Resolution
order: CLI flag > `C2C_TRANSPORT` env > prefs > manual.

## 13. Testing strategy

- Unit/integration tests never hit chatgpt.com and never launch Chrome:
  - `FakePageDriver` scripts snapshots for page-flow tests;
  - injected `spawn`/`fetch` seams for the Chrome launcher;
  - isolated `C2C_STATE_DIR` for delivery/conversation state.
- Live E2E is separately marked (`LIVE_E2E`) and never runs in `pnpm test`.
- The first live run may legitimately end at `CHATGPT_LOGIN_REQUIRED`
  (LEVEL B); that is a valid, reported outcome, not a failure.

## 14. Non-goals (this phase)

Agent router, multi-agent, model router, agent spawner, plugin marketplace,
public installer, cloud service, OpenCode model-specific integration, Claude
Code / Codex browser as the main transport, Edge transport, daemon-first
transport. On-demand → persistent transport is a future upgrade that must not
require core rewrites.
