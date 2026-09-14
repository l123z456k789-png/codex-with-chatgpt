# Generic agent flow (machine-readable example)

This example shows how an executor drives the C2C task protocol with nothing
but shell execution and JSON parsing. Replace the placeholders; never commit
real tokens, chat URLs or credentials.

```bash
# --- setup -----------------------------------------------------------------
WORKSPACE="<path to the project>"
EXECUTOR="custom-agent"            # [a-z0-9][a-z0-9._-]{0,63}
AGENT_SESSION="<stable session id>"  # e.g. a UUID; keep it across restarts
C2C="c2c -w $WORKSPACE"
SCOPE="--executor $EXECUTOR --agent-session $AGENT_SESSION"

# --- preflight (local bridge / connector health) ---------------------------
c2c doctor -w "$WORKSPACE" --json

# --- 1. INIT ---------------------------------------------------------------
START=$($C2C task start $SCOPE \
  --goal "Add a regression test for the X boundary condition" --json)

TASK_ID=$(echo "$START" | jq -r .taskId)
ITERATION=$(echo "$START" | jq -r .iteration)     # 0
MESSAGE=$(echo "$START" | jq -r .message)
CONNECTOR=$(echo "$START" | jq -r .connectorName)
CHAT_URL=$(echo "$START" | jq -r .chatUrl)

# Deliver $MESSAGE to ChatGPT in $CHAT_URL using the executor's own transport
# (in-app browser, computer use, or manual forwarding). Wait for:
#   [C2C] STATE: PLAN  TASK_ID: <TASK_ID>  ITERATION: <n>
PLAN_ITERATION=<n from ChatGPT's PLAN>

# --- 2. PLAN ---------------------------------------------------------------
$C2C task plan $SCOPE --task "$TASK_ID" --iteration "$PLAN_ITERATION" \
  --next-step "Implement the accepted PLAN" --json

# --- 3. EXECUTE ------------------------------------------------------------
# Edit files and run tests with the executor's own tools.
TEST_LOG="<local log file>"
# ... run the tests, write their output to $TEST_LOG ...
TEST_SUMMARY="201 passed"
EXIT_CODE=0

RESULT=$($C2C task executed $SCOPE --task "$TASK_ID" \
  --iteration "$PLAN_ITERATION" \
  --changed-files "src/a.ts,tests/a.test.ts" \
  --tests "$TEST_SUMMARY" --exit-status ok \
  --command "pnpm test" --output-file "$TEST_LOG" --exit-code "$EXIT_CODE" \
  --json)
EXECUTED_MESSAGE=$(echo "$RESULT" | jq -r .message)

# Deliver $EXECUTED_MESSAGE to the same ChatGPT chat. ChatGPT inspects the
# workspace through MCP (git_diff, execution_summary, test_status,
# execution_output) and answers one of:
#   STATE: PLAN    -> loop from step 2 with the new iteration
#   STATE: BLOCKED -> surface the reason to the user
#   STATE: DONE    -> step 4

# --- 4. DONE ---------------------------------------------------------------
$C2C task done $SCOPE --task "$TASK_ID" --json

# --- recovery --------------------------------------------------------------
# Agent restarted:
$C2C task status $SCOPE --json          # { active, checkpoint.protocolState, waitingFor }

# Chat lost / replaced (checkpoint is preserved):
$C2C task handoff $SCOPE --task "$TASK_ID" --json
# Deliver the returned .message into the replacement chat, then continue.
```

Notes:

- `STATE`, `TASK_ID`, `ITERATION` are the only fields ChatGPT keys on; keep
  control messages under 1 KB and never paste diffs or logs into them.
- The CLI rejects stale task ids, wrong iterations and out-of-order states;
  read `task status --json` instead of guessing.
- `executor` is persisted in every execution record, so ChatGPT knows which
  agent produced the evidence.
