# Any-Agent End-to-End Proof (Phase 3)

> Status: **COMPLETE (local protocol proof) / ChatGPT E2E BLOCKED**
>
> This document records only evidence that actually exists. The run used an
> isolated C2C state directory (`.tooling/phase3-proof-state`, gitignored) so
> no real user session was touched. The ChatGPT chat metadata is a clearly
> labeled local fixture; no ChatGPT reply is fabricated anywhere.

## 1. Goal

Prove that the generic `c2c task` protocol (`6701c73`) can be driven by a real
non-Codex executor end to end on a real code change:

```
c2c task start → INIT → (PLAN) → c2c task plan → implement + test
→ c2c task executed → review → c2c task done
```

with correct executor-tagged evidence, session isolation, recovery and error
handling.

## 2. Environment

| Item | Value |
| --- | --- |
| Date | 2026-09-14 (+08:00) |
| Host agent | **OpenCode** (generic coding agent CLI) |
| Model | **DeepSeek 4.1** |
| OS / shell | Windows 10.0.26200 / PowerShell 5.1 |
| Node / pnpm | v24.16.0 / pnpm 11.24.0 (repo `packageManager` pin, via corepack) |
| Repo | `D:\AgentProjects\codex-with-chatgpt` @ `6701c73` |
| C2C state for proof | isolated `C2C_STATE_DIR=.tooling\phase3-proof-state`; the machine has **no real C2C state dir** (`%LOCALAPPDATA%\codex-with-chatgpt` absent) |
| ChatGPT session | local fixture: chat `https://chatgpt.com/c/phase3-local-proof`, connector `Codex with ChatGPT · phase3-proof` (fictional; used only so `requireConnectedSession` can be exercised) |
| Evidence artifacts | `.tooling/phase3-proof/` (command JSON, captured logs) — gitignored |

## 3. Executor

| Field | Value |
| --- | --- |
| executor id | `opencode` |
| agent sessions used | `deepseek41-phase3-main`, `-verify`, `-iso-a`, `-iso-b`, `-crash`, `-invalid`, `-utf16` (plus `executor custom-test` for isolation) |
| workspace | this repository |
| transport | none available for ChatGPT (see §9); PLAN steps are local fixtures |

## 4. Protocol Commands

`c2c task start|plan|executed|handoff|done|status`, each with required
`--executor <id>`, `--agent-session <id>`, `-w <workspace>` and optional
`--json`. All exercised at the CLI level with the built `bin/c2c.js`.

## 5. Test Task (real code change)

Two real defects were exercised through the protocol. The task goal registered
in INIT was defect #1; defect #2 was discovered by the evidence pipeline
itself:

1. **Stale known issues** — after a failed iteration followed by a successful
   one, `HANDOFF`/`status` kept reporting `Execution status: failed`.
2. **UTF-16 evidence bypass** — `--output-file` decoded logs as UTF-8 only;
   UTF-16 logs (PowerShell/Notepad) reached the sanitizer as NUL-interleaved
   mojibake, so a UTF-16 private key was **not** rejected (`allowed: true`).

## 6. INIT Evidence

`c2c task start` (fixed CLI), session `deepseek41-phase3-main`:

```json
{ "ok": true, "taskId": "c2c_574edb", "iteration": 0,
  "protocolState": "INIT", "waitingFor": "GPT_PLAN",
  "chatUrl": "https://chatgpt.com/c/phase3-local-proof",
  "connectorName": "Codex with ChatGPT · phase3-proof",
  "message": "[C2C]\nSTATE: INIT\nTASK_ID: c2c_574edb\nITERATION: 0\n\nGOAL: ...\n\nINSTRUCTION:\nUse only the connector named ..." }
```

The INIT message contained the real goal, the connector name and the workspace
name. Transport to ChatGPT: **not performed** (see §9).

## 7. PLAN Evidence

`PLAN` is produced by ChatGPT. With ChatGPT unreachable, two PLAN inputs were
supplied as **local fixtures** to exercise the state machine and are labeled as
fixtures:

- `task plan --iteration 1 --next-step "Add failing regression test, then fix stale knownIssues…"` → `PLAN_RECEIVED`
- `task plan --iteration 2 --next-step "Apply the fix and re-run the suite"` → `PLAN_RECEIVED`

No fabricated "ChatGPT said…" content appears anywhere in this proof.

## 8. Execution Evidence

**Iteration 1 (real failed run)** — the new regression test really failed:

- command: `corepack pnpm vitest run tests/task-protocol.test.ts` → exit 1,
  `expected 'Execution status: failed' to be undefined`
- `c2c task executed --exit-status failed --command … --output-file … --exit-code 1`
  → record: `(c2c_574edb, iter=1, executor=opencode, exitStatus=failed,
  outputId=1, outputAvailable=true)`; EXECUTED message: `RESULT:\nExecution failed.`

**Iteration 2 (real fixed run)**:

- command: `corepack pnpm test` → exit 0, **201 passed**
- `c2c task executed --exit-status ok --changed-files "src/protocol/lifecycle.ts,tests/task-protocol.test.ts" --tests "201 passed"`
  → record `(iter=2, exit=ok, outputId=2)`; message `RESULT:\nExecution finished.`

**Evidence store inspection** (exactly what the MCP tools read):

```
executions/915f43260c66.jsonl:
 c2c_574edb iter=1 executor=opencode exit=failed outputId=1 available=True
 c2c_574edb iter=2 executor=opencode exit=ok     outputId=2 available=True
 c2c_63a732 iter=2 executor=opencode exit=ok
 c2c_42a714 iter=1 executor=opencode exit=ok
execution-outputs/.../index.json: items allowed/truncated/sizeBytes per id
```

`execution_summary` reads the JSONL, `test_status` the latest record,
`execution_output` the index + bodies; all three see `executor: "opencode"`.

## 9. Review Evidence

```
INDEPENDENT_GPT_REVIEW=NOT_RUN
REAL_CHATGPT_E2E=BLOCKED
```

Blocker (recorded, not bypassed):

- the host agent exposes **no browser or computer-use tool**, so it cannot type
  into the ChatGPT web UI;
- the machine has **no configured C2C connector/chat** (no real state dir);
- `webfetch https://chatgpt.com` returns a transport error (public page only,
  never an authenticated conversation).

No part of this proof claims a ChatGPT exchange. Local review was limited to
inspecting the protocol's own evidence (records + diffs).

## 10. DONE Evidence

- main session: `task done` → `{"ok":true,"taskId":"c2c_574edb","cleared":true}`;
  follow-up `status` → `active:false, checkpoint:null`.
- verify session (`deepseek41-phase3-verify`): same clean clear.
- `task handoff` directly before `done` did **not** delete the checkpoint
  (`status` still `active:true` afterwards).

## 11. Session Isolation Evidence

CLI-level, same workspace:

| executor | agent-session | taskId | done one → other two |
| --- | --- | --- | --- |
| `opencode` | `deepseek41-phase3-iso-a` | `c2c_53231a` | `done` → inactive |
| `opencode` | `deepseek41-phase3-iso-b` | `c2c_278376` | still active |
| `custom-test` | `deepseek41-phase3-iso-a` | `c2c_2f20bb` | still active |

Same session id under a different executor is a different session; three
distinct task ids; finishing one checkpoint left the other two untouched; all
were cleaned up afterwards. The legacy workspace-level session file was never
read or written by these commands.

## 12. Failure / Recovery Tests

- **Crash/resume**: `start` → fresh CLI process `status` still shows
  `active:true, state=INIT` (state is on disk, not in memory) → `handoff` from
  `INIT` produced a full brief and preserved the checkpoint → `plan` →
  `executed` → `done`.
- **Failed → recovered iteration**: iteration 1 failed for real; iteration 2
  succeeded; the checkpoint correctly moved `PLAN_RECEIVED → EXECUTED_SENT`
  both times (and with the fix, stale issues are cleared on success).
- **Invalid states** (all exit 1, clear JSON or commander errors): executed
  before plan; plan before start; unknown task/session; stale task id; wrong
  iteration; empty executor; empty agent-session; empty goal; negative
  iteration; missing `--output-file` (clear ENOENT error, recorded as a
  limitation rather than changed behavior).

## 13. Bugs Found

1. **Stale `knownIssues`** (protocol): a successful iteration kept the previous
   failure in the checkpoint, so `status`/`HANDOFF` misreported it.
2. **UTF-16 evidence bypass** (security-relevant): `--output-file` decoded as
   UTF-8 only. Reproduction before the fix:
   `utf8 key → restricted(private_key)` but
   `UTF-16LE (BOM), UTF-16LE (no BOM), UTF-16BE (BOM) keys → allowed=true`.
3. Environment friction (not a product bug): PowerShell `Set-Content -Encoding
   utf8` adds a BOM that `JSON.parse` rejects (fixture had to be rewritten);
   PowerShell `Tee-Object` writes UTF-16 logs, which is what exposed bug 2.

## 14. Fixes

| Bug | Fix | Regression tests |
| --- | --- | --- |
| Stale known issues | `lifecycle.markExecuted` writes `""` for `knownIssues` on `ok`, which `mergeSession` normalizes away (clears) | `tests/task-protocol.test.ts` “clears stale known issues when a later iteration succeeds” (failed first: `expected 'Execution status: failed' to be undefined`) |
| UTF-16 bypass | CLI decodes BOM’d UTF-16LE/BE + BOM-less UTF-16 (NUL-parity heuristic) before sanitizing; sanitizer additionally refuses any NUL-containing text (`reason: non_text_output`) | `tests/record-cli.test.ts` UTF-16 key → `private_key` (3 encodings) and UTF-16 log → readable; `tests/execution-output.test.ts` NUL text → restricted |

Post-fix CLI re-check: all four key encodings `allowed=false,
reason=private_key`; a UTF-16 log is stored as readable text
(`204 tests passed …`).

## 15. Remaining Limitations

- `REAL_CHATGPT_E2E` not run (blocker in §9); independent GPT review not run.
- Checkpoint writes are single-file, non-atomic, last-write-wins; concurrent
  writers for the same (executor, session) are not coordinated.
- Task ids use 3 random bytes (`c2c_` + 6 hex).
- `--output-file` on a missing path surfaces a raw ENOENT message.
- The optional `EXECUTOR:` control-message header remains deferred (records
  already carry the executor).
- Fixture chat metadata was required for `start/executed/handoff`; a real run
  needs a configured connector.

## 16. Final Verdict

```
PUSHED=NO (at proof time)
LOCAL_PROTOCOL_PROOF=PASS
REAL_CHATGPT_E2E=BLOCKED
INDEPENDENT_GPT_REVIEW=NOT_RUN
```

The generic protocol worked as designed for a real non-Codex executor on a
real code change, including failure→recovery, isolation, crash/resume and
executor-tagged evidence — and the proof itself surfaced and fixed one security
bypass in the evidence pipeline.
