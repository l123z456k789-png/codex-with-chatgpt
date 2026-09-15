# C2C Agent Protocol

Agent-neutral control plane for driving a C2C task with **any** local coding
agent. ChatGPT plans and reviews; the local agent executes. This document is
the contract a new executor implements. It is not tied to Codex, OpenCode,
Claude Code or any specific tool.

## Requirements

An executor needs only:

- shell command execution
- JSON parsing (`c2c task … --json`)
- the ability to edit files in the workspace
- a way to deliver a small text message to ChatGPT (its own browser or
  computer-use tool, or manual copy-paste)

No API key, no SDK, no process spawning: the agent calls C2C; **C2C never
starts the agent**. C2C adds no file, shell or network capability the agent
did not already have.

## Lifecycle

```
c2c task start  → INIT message        (state INIT, waiting for GPT_PLAN)
      │  forward the INIT message to ChatGPT
      ▼
ChatGPT replies with STATE: PLAN (TASK_ID, ITERATION, ACTIONS, TESTS,
SUCCESS_CRITERIA …)
      │
c2c task plan   → checkpoint PLAN_RECEIVED (records the PLAN)
      │  implement + run tests in the workspace
      ▼
c2c task executed → appends the execution record (+ optional sanitized
                    command output) and returns the EXECUTED message
                    (state EXECUTED_SENT, waiting for GPT_REVIEW)
      │  forward EXECUTED to ChatGPT
      ▼
ChatGPT inspects the workspace through the C2C MCP connector
      ├─ STATE: PLAN    → next iteration: task plan → implement → task executed
      ├─ STATE: BLOCKED → surface the reason to the user
      └─ STATE: DONE    → c2c task done (checkpoint cleared)
```

- `c2c task handoff` builds a HANDOFF message from the checkpoint when the chat
  was lost or must be replaced. It never deletes the checkpoint.
- `c2c task status` reports whether a checkpoint is active, so a restarted
  agent process can resume instead of starting a duplicate task.
- `PLAN`, `DONE` and `BLOCKED` are produced by ChatGPT. The local agent only
  records them; it must never invent them.

A preflight `c2c doctor -w <workspace> --json` keeps the local bridge healthy.
`c2c task start/executed/handoff` require a workspace that already has a saved
ChatGPT chat and a matching connector (`c2c session set`, `c2c setup`).

## Required IDs

| ID | Meaning | Source |
| --- | --- | --- |
| workspace | local project (`-w <path>`, defaults to the current directory) | user |
| executor | stable id of the agent implementation: `opencode`, `claude-code`, `custom-agent` … (`[a-z0-9][a-z0-9._-]{0,63}`) | integration |
| agent-session | stable id of one agent conversation/process (UUID-like); must stay the same across restarts of that session | integration |
| taskId | one protocol task (`c2c_` + random hex) | `c2c task start` |
| iteration | one plan → execute → review round | ChatGPT's PLAN message |

`--executor` and `--agent-session` are required on every `c2c task` command.

## Session isolation

Checkpoints are stored per **(workspace, executor, agent-session)** under the
C2C state directory, hashed so that any combination is collision-free:

```
<state>/agent-sessions/<workspaceId>/<sha256(executor + "\0" + agent-session)>.json
```

Consequences:

- two sessions of the same executor never share a checkpoint;
- the same session id under a different executor is a different session;
- the legacy workspace-level session (used by the Codex Skill) is never
  touched by this protocol.

`c2c task start` refuses to run while a checkpoint is already active for that
identity: resume it (`status` / `handoff`) or finish it (`done`) first.

## Evidence

`c2c task executed` appends a JSONL execution record for the workspace and
sets `executor` to the id you passed. Optionally pass `--command`,
`--output`/`--output-file` and `--exit-code` to nominate a command log; a local
sanitizer redacts tokens and home paths, rejects private keys, and caps size.
ChatGPT reads the result through the read-only MCP tools `execution_summary`,
`test_status` and `execution_output` and reviews the real `git_diff` — it does
not rely on the EXECUTED message text.

## Recovery

| Situation | Action |
| --- | --- |
| Restarted agent process | `c2c task status --json`; if `active` is true, resume from `checkpoint.protocolState` |
| ChatGPT chat lost / replaced | `c2c task handoff` → send the returned message into the new chat |
| Stuck after INIT | `handoff` (goal/next step) or `done` to abandon |
| Wrong task id / stale iteration | the CLI rejects it; use `status` to read the active task |
| ChatGPT returns PLAN for a new iteration | `c2c task plan --iteration <n>` then continue |
| DONE received | `c2c task done` |

## Security

- The C2C MCP server is read-only; the protocol adds no write tools.
- Workspace containment, sensitive-file policy and the output sanitizer are
  unchanged by this protocol.
- The agent writes code with its own tools; C2C only records protocol state,
  evidence and connector metadata.
- Never paste file bodies, diffs or logs into the control messages; ChatGPT
  pulls them through MCP.

## Example

See [examples/generic-agent-flow.md](examples/generic-agent-flow.md) for a
complete machine-readable flow. Minimal form:

```bash
C2C="c2c -w <workspace>"
EXEC="--executor custom-agent --agent-session <stable-session-id>"

START=$($C2C task start $EXEC --goal "<one-paragraph goal>" --json)
TASK_ID=$(echo "$START" | jq -r .taskId)
# forward $(echo "$START" | jq -r .message) to ChatGPT, read STATE: PLAN

$C2C task plan $EXEC --task "$TASK_ID" --iteration <n> --json
# ... implement and test in the workspace ...
$C2C task executed $EXEC --task "$TASK_ID" --iteration <n> \
  --changed-files "<files or count>" --tests "<summary>" --exit-status ok \
  --command "<test command>" --output-file <log> --exit-code <n> --json
# forward the returned message; on DONE:
$C2C task done $EXEC --task "$TASK_ID" --json
```

## Reference integration: Claude Code

`src/adapters/claude-code.ts` is the first shipped adapter and the pattern for
new ones: it installs Claude-specific hooks/rules, maps Claude's `session_id`
to the generic `agent-session`, and delegates every lifecycle action to this
protocol. It defines no second lifecycle, checkpoint store or message format.
See [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md).

## Outbound transport (optional)

By default this protocol only builds the `[C2C]` messages; delivery is the
executor's job (its own browser, computer-use tool, or manual copy-paste). The
optional C2C-owned Chrome transport can deliver them and read ChatGPT's reply
instead: add `--transport chrome` to `c2c task start/executed/resume`, or make
it the machine default with `c2c prefs set --transport chrome`. Transport is
opt-in, never changes this protocol, and always keeps the manual fallback
message when it fails. Setup, the daily loop for OpenCode/Claude Code/Codex,
review limits, rotation, recovery, security boundaries and the live E2E
procedure are documented in [C2C_TRANSPORT.md](C2C_TRANSPORT.md).
