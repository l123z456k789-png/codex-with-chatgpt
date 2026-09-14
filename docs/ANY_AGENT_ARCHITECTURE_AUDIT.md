# Any-Agent Architecture Audit

> Goal: **GPT thinks. Any agent works.**
> This audit covers where Codex is actually coupled into C2C, what is already
> agent-neutral, what upstream is about to deliver, and the smallest honest
> first slice for an Any-Agent executor layer. It intentionally does not
> implement anything.
>
> Baseline: `9663b88` (`feat/any-agent-executor`), see
> [ANY_AGENT_BASELINE.md](ANY_AGENT_BASELINE.md).

## 1. Executive Summary

C2C's value split is already correct: ChatGPT plans and reviews through a
read-only MCP bridge; a local harness executes. The surprise from this audit is
that the **core is already Agent-neutral by construction**:

- `bridge/`, `mcp/`, `workspace/`, `auth/`, `pairing/`, `tunnel/`, `process/`,
  `execution/`, `session/`, `config/` contain **zero** `executor`/`agent`
  abstractions and only a handful of `Codex` strings (naming/wording, not logic).
- There is no field, type, or branch anywhere that assumes *which* tool edits
  the workspace. The MCP server cannot even tell who ran a command.
- The execution record (`c2c record`) and the session/checkpoint store are
  generic: `taskId`, `iteration`, `changedFiles`, `tests`, `exitStatus`, output
  sanitization, and the `[C2C]` state machine do not reference Codex.

What is actually Codex-bound is concentrated in three places:

1. **The control plane transport**: the Skill types `[C2C]` messages into
   ChatGPT through **Codex's in-app browser API** (`setupBrowserRuntime()`,
   `agent.browsers.get("iab")`, `tab.markHandoff()`), and installs itself at
   `~/.codex/skills/codex-with-chatgpt/SKILL.md`.
2. **`c2c sandbox-allow`**: writes the C2C state dir into Codex's
   `~/.codex/config.toml` `[sandbox_workspace_write].writable_roots`. This is
   invoked by `setup`, `doctor --fix`, and the Skill's daily routine.
3. **Naming/semantics**: `PRODUCT_NAME = "Codex with ChatGPT"` flows into the
   CLI banner, connector names, OAuth consent page, MCP server name, and tool
   descriptions ("reported by the Codex harness", "after Codex reports
   EXECUTED"). The protocol docs say "Codex owns execution".

Estimated readiness for V0.1 ("GPT thinks. Any ONE agent works."): **40%**.
The hard infrastructure (OAuth, pairing, tunnel, read-only MCP, git evidence,
records, checkpoints, tests) is ~90% neutral; the executor boundary (0%), the
generic control path (0%), and user-facing naming (~20%) are what remain.

Upstream has just opened two directly relevant PRs: **#412** (`executor` field
on execution records, clean, +41/−9) and **#431** (Claude Code adapter with
per-session checkpoints, clean, base = our exact HEAD). Both should be reused
rather than reinvented.

## 2. Repository Baseline

See [ANY_AGENT_BASELINE.md](ANY_AGENT_BASELINE.md). Summary: commit `9663b88`,
branch `feat/any-agent-executor`, fork == upstream (0 ahead / 0 behind),
`pnpm install` clean, `typecheck`/`build` exit 0, **172/172 tests pass**, no
lint script, no known baseline failures.

## 3. Current Architecture

### 3.1 Two planes

- **Data plane (MCP, read-only)**: ChatGPT calls 9 tools over the public
  tunnel. Every request is bearer-authenticated, stateless (fresh
  `McpServer` + transport per POST, `src/mcp/http.ts:22`), and read-only by
  construction (`annotations: { readOnlyHint: true }`; no write tools exist).
- **Control plane (Computer Use)**: tiny `[C2C]` messages typed into the
  ChatGPT web UI by the executor's Skill. States:
  `INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR`
  plus `HANDOFF` (`docs/protocol.md:11`).

### 3.2 Modules and actual call graph

```
cli/index.ts
 ├── bridge/server.ts ── mcp/server.ts ── workspace/{manager,git,search,ignore}
 │                   ── auth/{oauth,store,middleware} ── pairing/manager
 │                   ── tunnel/{provider,cloudflared,cloudflared-named,…}
 │                   ── bridge/runtime.ts ── process/daemon.ts
 ├── session/state.ts        (chat URL, Project URL, checkpoint)
 ├── execution/records.ts    (JSONL per workspace)
 ├── execution/output.ts ── execution/sanitize.ts ── logger
 ├── config/{paths,endpoint,sandbox-allow,ui-prefs}
 └── version.ts
```

- The **executor never talks to the bridge directly**. Its only interactions
  are: the `c2c` CLI (record/session/doctor/setup/…) and the ChatGPT browser
  tab. That is the natural place for an executor boundary.
- `bridge/runtime.ts` / `process/daemon.ts` manage the daemon lifecycle from
  the CLI; nothing there knows about Codex.
- The MCP tool layer reads workspace + execution records; it has no
  executor-specific code paths.

### 3.3 Evidence path (already any-agent ready)

`c2c record` (`src/cli/index.ts:1057`) → `appendExecutionRecord`
(`src/execution/records.ts:30`) → `execution_summary` / `test_status` /
`execution_output` MCP tools (`src/mcp/server.ts:368-472`) → ChatGPT reviews
real `git_diff` + record metadata. Output bodies pass a deterministic
sanitizer (`src/execution/sanitize.ts:63`) with private-key rejection, token
redaction, home-path redaction, and size/line caps.

## 4. Codex Coupling Map

Classification: **A = hard** (cannot support other agents without change),
**B = protocol/terminology** (semantics/type/label binding), **C = UX/Skill**
(docs, install path, agent-specific instructions), **D = compatible legacy**
(keep as Codex adapter / backward compatibility).

### A — Hard coupling

| # | Location | What it does | Impact |
| --- | --- | --- | --- |
| A1 | `skill/SKILL.md` (whole file, 730 lines) + install path `~/.codex/skills/codex-with-chatgpt/SKILL.md` | The entire control-plane UX. Browser transport uses Codex-only APIs: `setupBrowserRuntime()`, `agent.browsers.get("iab")`, `markHandoff`/`markDeliverable`, visibility capability (§In-app browser). Update flow copies the Skill into `~/.codex/skills/`. | On OpenCode/Claude Code there is no `iab`, no `markHandoff`, no `~/.codex/skills`. The protocol survives; the transport does not. |
| A2 | `src/config/sandbox-allow.ts:16-24,54-76` | Writes `[sandbox_workspace_write].writable_roots` into `~/.codex/config.toml` (via `CODEX_HOME` or `~/.codex`). Called from `setup` (`src/cli/index.ts:297`), `doctor --fix` (`:437-444`), daily Skill step (`skill/SKILL.md:203`), and `c2c sandbox-allow` (`:785-805`). | Codex-only concept. For other executors this must be a no-op / opt-in adapter step, never a core command that silently edits another tool's config. |
| A3 | `skill/SKILL.md` browser-only approval flows + `src/cli/index.ts:809-869` (`update-check`) & Skill update workflow | Version update assumes a git checkout installed as a Codex Skill and refreshes `~/.codex/skills/...` | Needs an executor-agnostic install/update story (or per-executor adapters). |

### B — Protocol / terminology coupling

| # | Location | Evidence | Nature |
| --- | --- | --- | --- |
| B1 | `src/version.ts:3` | `PRODUCT_NAME = "Codex with ChatGPT"` | Flows into CLI banner (`cli/index.ts:216`), MCP server name (`mcp/server.ts:190`), OAuth resource name (`auth/oauth.ts:64`) |
| B2 | `src/config/endpoint.ts:9,67-76` | `DEFAULT_CONNECTOR_NAME = "Codex with ChatGPT"`, legacy fallback for existing workspaces | Connector identity shown to users |
| B3 | `src/auth/oauth.ts:78,131` | Scope label "Read Codex execution summaries"; pairing page "The pairing code was generated by Codex on this computer." | Consent UI wording |
| B4 | `src/mcp/server.ts:373,404,424` | Tool descriptions: "reported by the Codex harness", "after Codex reports EXECUTED", "output that Codex chose to record" | Tells ChatGPT the executor is Codex — actively misleading once other agents run |
| B5 | `docs/protocol.md`, `skill/SKILL.md`, `src/cli/index.ts:1059` | "Codex owns execution", "Record a Codex execution summary", INIT `INSTRUCTION` names Codex | Semantic protocol wording; no machine-readable dependency |
| B6 | Comments only: `src/execution/records.ts:7`, `src/execution/sanitize.ts:62`, `src/session/state.ts:79` | "written by the Codex harness", "Codex may nominate output" | Non-functional |

There is **no type-level coupling**: no `Codex*` type, no `if (executor === "codex")`,
no executor switch. All of B is strings.

### C — UX / Skill coupling

| # | Location | Notes |
| --- | --- | --- |
| C1 | `skill/SKILL.md` frontmatter (`name: codex-with-chatgpt`, trigger phrases "使用 Codex with ChatGPT …") | Trigger surface is Codex-worded |
| C2 | `README.md` one-paste install (lines 40-86, 101-103) | Install prompt is written for Codex; says copy Skill to `~/.codex/skills/` |
| C3 | `src/cli/index.ts` user messages: `:344` ("如果你在使用 Codex Skill"), `:788,799,804` (sandbox-allow), `:1059` | CLI text |
| C4 | `src/config/ui-prefs.ts:9-23` | Setup-mode prompt is generic text (OK), but flows are invoked from the Codex Skill |

### D — Compatible legacy (keep)

| # | Location | Keep because |
| --- | --- | --- |
| D1 | State dir name `codex-with-chatgpt` (`src/config/paths.ts:15-20`) | Renaming orphans tokens/sessions/endpoints and breaks existing installs. Treat as an internal codename. |
| D2 | `CODEX_HOME` env + `~/.codex/config.toml` handling in `sandbox-allow.ts` | This becomes the **Codex adapter's** allowlist installer; don't delete, isolate. |
| D3 | `endpoint.ts:67-76` legacy connector-name fallback | Existing workspaces must not be renamed. |
| D4 | Execution records without `executor` field | Absent = unknown; old JSONL lines must keep parsing (PR #412 approach). |
| D5 | `[C2C]` protocol states and local checkpoint states (`session/state.ts:9-28`) | Agent-neutral already; additive changes only. |
| D6 | `.c2c.json` (`name`, `maxIterations`) and `.c2cignore` | Neutral project config. |

### A note on what is NOT coupled

- `mcp/server.ts`: all 9 tools are workspace/git/execution reads; scope checks
  are `workspace.read`, `workspace.search`, `git.read`, `execution.read`.
- `auth/`, `pairing/`, `tunnel/`, `process/`, `bridge/`: zero Codex logic.
- `session/state.ts`: chat/Project/checkpoint bookkeeping is executor-agnostic
  (only the comment on `:79` says "THIS Codex thread").
- Tests: no test asserts Codex behavior; `tests/helpers.ts` is generic.

## 5. Reusable Core (module-by-module)

| Module | Current role | Codex coupling | Reusable as-is? | Required change | Risk |
| --- | --- | --- | --- | --- | --- |
| `bridge/` | Loopback HTTP server, port fallback, admin API | none in code | **Yes** | none | low |
| `mcp/` | 9 read-only tools, stateless HTTP | B4 wording only | **Yes** | neutralize descriptions (PR #412 does this) | low |
| `auth/` + `pairing/` | OAuth 2.1 + PKCE + DCR + pairing | B3 wording | **Yes** | neutral scope label / page copy | low |
| `tunnel/` | Quick/Named Cloudflare tunnels | none | **Yes** | none | low |
| `workspace/` | Path containment, sensitive policy, search, git status/diff | none | **Yes** | none | low |
| `execution/records` | JSONL evidence per workspace | B6 comments; no executor field | **Yes** | add optional `executor` (+ wiring) — PR #412 | low, backward compatible |
| `execution/output` + `sanitize` | sanitized command output for review | B6 comment | **Yes** | none (executor-neutral by design) | low |
| `session/state` | chat/Project URL + checkpoint store | B6 comment only | **Yes** | optional executor/session scoping for concurrent agents — PR #431 pattern | medium (state merge semantics) |
| `cli/` | `c2c` commands | A2 (`sandbox-allow`), C3 wording, `record` hidden but generic | **Mostly** | isolate `sandbox-allow` behind executor adapters; add generic executor commands; neutralize copy | medium (public CLI contract) |
| Protocol (`docs/protocol.md`) | states + message shapes | B5 wording | **Yes** | additive `EXECUTOR` header; wording | low (ChatGPT is the other party; additive only) |
| `process/` | daemon lifecycle | none | **Yes** | none | low |
| `config/paths` | state dir resolution | D1 name | **Yes** | none (keep name) | low if untouched |
| Tests | 172 tests | wording only | **Yes** | add adapter/regression tests | low |

**Bottom line:** the bottom half of the stack is already agent-neutral. The
work is an executor layer *above* it, not a rewrite *inside* it.

## 6. Upstream Assessment

Fork is exactly at `upstream/main` (`9663b88`); any future sync is
fast-forward. Upstream has 13 open PRs. Relevance to our goal:

### UPSTREAM_REUSE

| PR | State | Why reuse |
| --- | --- | --- |
| **#412** `feat(records): record which executor ran an iteration` (terryhappyhome, +41/−9, 5 files, mergeable clean) | open | Exactly V0.1 requirement 3. `executionRecordSchema` gains optional `executor` (max 80); `c2c record --executor`; `test_status` returns it; tool descriptions de-Codex. Backward compatible (absent = unknown). No protocol change. |
| **#431** `feat: add Claude Code bridge with isolated session checkpoints` (TribalHouse, +1520/−45, 8 files, mergeable clean, base = our HEAD) | open | A working precedent for the executor boundary: `src/adapters/claude-code.ts` (704 lines) + CLI namespace (`c2c claude start/plan/executed/handoff/done/bootstrap`), hook installation into `.claude/settings.local.json`, per-agent-session checkpoints to isolate concurrent chats, worktree→canonical-workspace resolution. It reuses `session/state`, `execution/records`, `workspace` unchanged — proving the core is sufficient. |

### WATCH

| PR | Why watch |
| --- | --- |
| #415 visible bidirectional task control (dirty, 14 files) | Adds persisted task lifecycle + `task_progress`/`cancel_task` MCP tools; overlaps future executor lifecycle (status/cancel). Not needed for V0.1; may reshape protocol later. |
| #413 constrained plan submission inbox (dirty, 25 files) | `submit_plan` MCP write path with `plan.write` scope; a different control-plane transport (no browser). Architecturally interesting for generic CLI (mailbox instead of typing). Too large/risky for V0.1. |
| #421 shared multi-workspace MCP gateway (dirty, 17 files) | One connector across workspaces; changes auth/lease model. Conflicts with one-workspace-one-token isolation. Watch before depending on it. |
| #416 / #430 tunnel DNS fixes; #423 Skill polling; #408 probe stdin fix | Small independent fixes likely to merge; rebase on top later. |

### IGNORE (for this initiative)

- #409 machine-wide gateway + Secure Tunnel (125 files, +36846/−6816, dirty):
  replaces OAuth with "Authentication: None" + OpenAI Secure MCP Tunnel. Huge,
  conflicts with the current security model and our minimal-abstraction
  philosophy.
- #435/#436 media workflows / shared browser preference: out of scope.
- #434 docs troubleshooting wording: docs only.

### CONFLICT

- If #421/#409 land first, the auth/gateway substrate changes and our executor
  layer must re-base. Do **not** build V0.1 on top of them; keep V0.1 limited
  to `records`/`session`/`cli` additions and the Skill split.
- #431 overlaps our "add Claude Code" step. Decide: cherry-pick/adapt it after
  merge, or design the generic adapter first and let #431 become an instance.
  Avoid maintaining two parallel Claude adapters.

## 7. Executor Architecture

Keep the existing two planes; do **not** invent a new agent runtime. The
minimal honest target:

```
             ChatGPT / GPT
                  │  planner / reviewer
                  │
        ┌─────────┴─────────┐
        │  C2C Core (today) │   protocol + records + workspace evidence
        │  bridge / mcp /   │   (already executor-agnostic)
        │  workspace / git  │
        └─────────┬─────────┘
                  │  c2c CLI (record / session / doctor / …)
        ┌─────────┴─────────────────────────────┐
        │  Executor adapters (new, thin)        │
        │  codex │ generic-cli │ opencode │ …   │
        └───────────────────────────────────────┘
```

Rules:

1. **Dependency direction is one-way**: adapters import core
   (`execution/records`, `session/state`, `config/paths`); core never imports
   adapters.
2. **Control messages are built once** in a small shared module (today the
   message text lives in the Skill prose and in PR #431's adapter). Move
   `INIT/PLAN/EXECUTED/HANDOFF` rendering into `src/protocol/messages.ts` so
   every executor emits identical, <1 KB messages.
3. **Executor identity is data, not branching**: `executor?: string` on records
   (#412), optional additive `EXECUTOR:` header in control messages.
4. **Per-agent-session checkpoints** (PR #431 pattern) are the right way to
   keep concurrent chats of the same agent independent without new protocol
   states.
5. **Agent-specific installs stay in adapters**: `sandbox-allow` belongs to the
   Codex adapter; a generic adapter installs nothing (or writes only files the
   user opted into).

## 8. Generic CLI Design (thin slice)

Two real gaps for a non-Codex CLI executor:

1. It cannot necessarily type into a ChatGPT browser tab (control plane).
2. It has no hooks/skill telling it how to drive `c2c session`/`c2c record`.

Minimal design consistent with the existing CLI (`c2c record` is already the
generic evidence command):

- `c2c record --executor <id> …` — #412 (evidence carries executor).
- `c2c exec start|plan|executed|handoff|done` (naming TBD) — adapter-neutral
  commands that:
  - read/write the existing session checkpoint store,
  - print the exact `[C2C]` control message to stdout (or `--json`),
  - append the execution record and the output item when given `--command`/
    `--output-file`, reusing `execution/output` sanitization.
  The human/agent delivers the printed message through whatever transport it
  has (browser, copy-paste, or later an MCP inbox PR #413/#415).
- Configuration stays code/config-light: an executor is just an id; there is no
  `executor: {command: …}` spawner in V0.1 because the executor is already the
  process the user is talking to. Introducing a spawner would add a
  process-management and prompt-injection surface with no V0.1 benefit (YAGNI).

Command/args/working-dir/stdout/stderr/exit-code handling only matters if we
later add a "spawn a CLI agent" mode; the existing `c2c record --command
--output-file --exit-code` already covers evidence capture for a command the
executor ran itself.

## 9. Protocol Migration

States stay as-is (`docs/protocol.md:11`). The state machine already has a
planner (`ChatGPT`) and an executor role, not a Codex role.

| Question | Answer |
| --- | --- |
| Which states change? | None. |
| New fields? | `executor` on execution records (optional, #412). Optional `EXECUTOR:` header in `INIT`/`EXECUTED` control messages (additive; ChatGPT ignores unknown headers today). |
| Execution record needs executor? | Yes — requirement 3; optional, absent = unknown (never assume Codex). |
| Checkpoint needs executor? | Not for V0.1. Checkpoints are per workspace + per agent session (PR #431 stores per-session checkpoints under `claude-sessions/`). A generic per-session namespace can follow the same pattern. |
| Session needs executor? | No new required field. |
| Legacy records? | Parse unchanged; absent `executor` = unknown. |
| Terminology ("Codex owns execution", "Codex with ChatGPT")? | Rewrite to role names ("the executor", C2C). Keep old strings only where they are identifiers users already installed (connector names, state dir). |

## 10. Backward Compatibility

- **State dir stays `codex-with-chatgpt`** (renaming would orphan tokens,
  endpoints, sessions, tunnels).
- **Connector names stay**; only *new* workspaces may get a neutral default
  (decision deferred; `DEFAULT_CONNECTOR_NAME` change is a one-line debate, but
  existing workspaces must keep their saved names via the existing fallback).
- **Execution records**: optional field, old lines keep parsing.
- **Protocol**: additive only. A ChatGPT conversation following the old boot
  prompt must keep working unchanged.
- **Codex flow must not regress**: the Skill's Codex path stays the reference
  implementation; baseline 172 tests remain the tripwire.

## 11. Security Impact

V0.1 is a **no-new-capability** change:

- MCP stays read-only; no new tools, no write scopes.
- `executor` is metadata on records; it passes through the same JSONL writer
  and zod schema.
- Control messages remain tiny; no diffs/logs travel in them.
- Output bodies keep flowing through `execution/sanitize.ts` (private keys
  rejected, secrets redacted, size caps).
- The one existing out-of-workspace write (`sandbox-allow` → Codex
  `config.toml`) becomes explicitly a **Codex-adapter** action, opt-in, not a
  core `setup`/`doctor` step for other executors. Never write another agent's
  config without an explicit adapter install command.
- New risk to track: agents other than Codex may have weaker sandbox
  discipline; C2C's read-only server boundary is unchanged, and evidence
  recording remains voluntary + sanitized, so the server-side guarantee holds.

## 12. Testing Strategy

- Keep the 172-test baseline green; run `typecheck` + `test` + `build` on every
  slice.
- Adopt #412's record tests (`--executor` present/absent) as the first slice's
  tests.
- Add tests for the shared protocol message builder: exact `[C2C]` headers,
  <1 KB, no file bodies, checkpoint transitions (`INIT → PLAN_RECEIVED →
  EXECUTING → EXECUTED_LOCAL/SENT → DONE/BLOCKED`).
- Add adapter contract tests mirroring `tests/claude-adapter.test.ts` (#431
  adds 371 lines): install idempotency, per-session checkpoint isolation,
  canonical workspace resolution, guard/hook outputs.
- Add a backward-compat test: parse a legacy JSONL record without `executor`.
- End-to-end proof (acceptance): one non-Codex executor completes
  INIT → PLAN → EXECUTED → independent review → DONE with records carrying
  `executor=<id>`.

## 13. Phased Implementation

| Slice | Content | Exit criteria |
| --- | --- | --- |
| 0 (this commit) | Baseline + audit docs only | docs committed, no source change |
| 1 | Neutral evidence: adopt #412 (or equivalent) — `executor` on records, `c2c record --executor`, neutral tool descriptions | baseline tests + new record tests green; Codex flow unchanged |
| 2 | Extract `src/protocol/messages.ts` (INIT/PLAN/EXECUTED/HANDOFF rendering) from Skill prose/adapter code; optional `EXECUTOR:` header | message-builder tests; Skill wording updated but behavior identical |
| 3 | Generic CLI executor commands (`start/plan/executed/handoff/done`) over existing session/records modules; `docs/ANY_AGENT.md` guide | CLI tests; works with copy/paste transport |
| 4 | Proof: run one full loop with OpenCode as executor (`executor=opencode`); evaluate #431 for Claude Code as the second adapter | end-to-end acceptance above |
| 5 | Skill split: shared protocol skill + per-executor adapter docs/install; isolate `sandbox-allow` as Codex-adapter step | Codex skill path still works; second executor has a documented path |

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream churn (#431/#412 merge, #409/#421 redesign auth) | Build only on stable seams (records/session/CLI); do not depend on open PR internals; re-base regularly from `upstream/main` |
| Duplicating #431's Claude adapter | Prefer upstreaming/adopting it; keep our V0.1 generic layer thin enough to sit under it |
| Codex flow regression | Baseline tests are the gate; every slice runs the full suite; Skill changes reviewed separately |
| Scope creep (router, multi-agent, GUI) | V0.1 explicitly excludes them; executor id is metadata only |
| Ambiguous executor identity in old records | Never infer Codex for absent values; document "absent = unknown" |
| Generic CLI transport hand-waves | Slice 3 proves copy/paste first; inbox transport deferred to follow-ups (#413/#415) |
| `sandbox-allow` writing another agent's config | Adapter-scoped, opt-in, never core |

## 15. Recommended First Slice

**Slice 1 — "Evidence knows its executor" (no protocol change, no core
rewrite):**

1. Add optional `executor` to `executionRecordSchema`
   (`src/execution/records.ts`), `c2c record --executor <id>`
   (`src/cli/index.ts`), `test_status` output schema + handler, and remove
   "Codex" from the three tool descriptions (`src/mcp/server.ts`) — i.e. adopt
   the substance of PR #412 (credit/coordinate with its author; it is clean and
   directly mergeable).
2. Add `tests/record-cli.test.ts` cases: executor recorded; absent = undefined;
   legacy JSONL parses.
3. Run `typecheck` + `test` + `build`; confirm 172+ tests green.
4. Update `docs/protocol.md` (EXECUTED section) to mention the optional
   executor field; do not change any state.

This gives ChatGPT the ability to *know* which agent ran an iteration —
the precondition for everything else — while touching no security boundary and
no Codex behavior.

## Appendix A — Phase 2A protocol-message audit (2026-09-14)

Decision: **PHASE_2A=NOT_JUSTIFIED** — do not extract `src/protocol/messages.ts`
until the first in-tree consumer exists. This appendix preserves the audit
evidence so the next phase does not repeat it.

### Where `[C2C]` messages actually live (HEAD `311015d`)

| Location | What it contains | Type |
| --- | --- | --- |
| `docs/protocol.md` | templates for INIT, PLAN, EXECUTED, DONE, BLOCKED, HANDOFF; boot prompt; Project instructions | prose |
| `skill/SKILL.md` | inline INIT + EXECUTED templates and a copy of Project instructions; boot prompt/HANDOFF referenced from docs | prose |
| `src/`, `tests/`, `scripts/`, `bin/` | **zero** message construction: no `[C2C]`, `STATE:`, `TASK_ID` or `ITERATION` string building; only checkpoint state types (`src/session/state.ts`) and CLI persistence (`c2c session set`) | code |
| upstream #431 (open PR, not in tree) | TS builders for INIT, EXECUTED (twice; one duplicated inline), HANDOFF in `src/adapters/claude-code.ts` | code |

Real duplication today is prose-to-prose (docs ↔ Skill); TypeScript has no
construction logic to consolidate. Extracting a TS module now would produce
dead code that the Skill (prose, consumed by the agent) cannot import and
whose format cannot be enforced anywhere.

### Evidence that future adapters will need a shared core (from #431)

- Duplicated message builders: INIT (goal + planning standard + instruction),
  EXECUTED (record metadata + review standard + connector name), HANDOFF
  (checkpoint fields). PLAN/DONE/BLOCKED are ChatGPT-generated and only
  recorded locally — no local builder needed.
- Generic needs #431 hand-rolled: connected-session validation (chatUrl +
  connectorName matching the endpoint), execution-record append (already
  core), checkpoint read/write, optional per-agent-session checkpoint
  isolation (`claude-sessions/<workspaceId>/<hash>.json`).
- Claude-specific (must stay in adapters): hook installation
  (UserPromptSubmit/PreToolUse/PostToolUse into `.claude/settings.local.json`),
  `.claude` rule/skill files, in-app browser automation and selectors
  (`#prompt-textarea`), internal-notification filtering, coding-task regex,
  guard-deny semantics.

### Trigger condition for extraction

Create `src/protocol/messages.ts` (pure, stateless, structured data → text;
optional `EXECUTOR:` header deferred until a consumer needs it) in the same
slice that introduces the first in-tree emitter (Generic CLI executor or the
first adapter). At that point characterization tests can pin real output
against the formats in `docs/protocol.md`.
