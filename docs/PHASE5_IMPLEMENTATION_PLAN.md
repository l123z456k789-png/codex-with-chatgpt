# Phase 5 Implementation Plan — C2C-Owned Chrome Transport + Personal Daily Driver

Status: accepted. Follows `docs/C2C_TRANSPORT_DESIGN.md` (design of record).
Branch: `feat/any-agent-executor`. Do not use force/reset/clean.

Recovery note (2026-09-14): the foundation files `src/transport/errors.ts`,
`selectors.ts`, `reply.ts`, `delivery.ts` and `docs/C2C_TRANSPORT_DESIGN.md`
already existed as uncommitted work when this plan was written. They were
reviewed and are used as-is; Task 1 pins them with tests instead of
re-implementing them.

## Global constraints (apply to every task)

1. `executor` stays the caller id (e.g. `opencode`); no model names, provider
   ids, or DeepSeek references anywhere in transport, adapters, docs or tests.
2. The transport opens only `https://chatgpt.com/**` URLs. Any other origin is
   rejected with `INVALID_CONVERSATION_URL`.
3. The transport never touches the user's daily Chrome profile. One dedicated
   profile: `<state>/chrome-profile` (`getStateDir()` aware). No cookie,
   `Login Data`, storage or history reads/exports.
4. Login/CAPTCHA/2FA/consent stay human steps. Surface
   `CHATGPT_LOGIN_REQUIRED` with instructions; never fake success.
5. No fixed sleeps in flows: poll plus a stability window. Default reply
   timeout 600 s, configurable (`replyTimeoutSeconds` prefs / `--wait-seconds`).
6. Never send the same `(taskId, STATE, iteration)` message twice. The delivery
   ledger (`src/transport/delivery.ts`) is the source of truth; a crash between
   send and confirm resumes waiting instead of resending.
7. Reply identity: wrong `TASK_ID` or backwards `ITERATION` is a hard failure
   (`PROTOCOL_IDENTITY_MISMATCH`), no execution on it. Missing `[C2C]` /
   `TASK_ID` / `ITERATION` is accepted but records an abnormal signal.
8. Rotation thresholds (prefs): `maxTasksPerConversation=10`,
   `maxProtocolRoundtrips=30`, abnormal signals=3. A task always finishes in
   the conversation it started in; the next task starts a new one. Mid-task
   HANDOFF only when the conversation itself cannot continue; the reason is
   recorded.
9. Review limit (default 3, per-task override `--review-iterations N|until_done`):
   on reaching it, record the PLAN, set `waitingFor: USER`, keep the
   checkpoint and print the four choices (continue 1 / continue 3 / until done
   / stop) with exact `c2c task resume` commands. The no-progress fuse is
   separate: two consecutive review rounds with unchanged (changed files,
   tests, exit status) → `NO_PROGRESS_DETECTED`, checkpoint kept.
10. The existing low-level API (`task start/plan/executed/handoff/done/status`,
    `c2c record`, sessions, MCP) keeps working unchanged. Transport is opt-in:
    default `manual`.
11. `pnpm test` never launches Chrome and never hits chatgpt.com. The live E2E
    is separate and may legitimately stop at `CHATGPT_LOGIN_REQUIRED` (LEVEL B).
12. Transport resolution: CLI flag > `C2C_TRANSPORT` env > prefs > `manual`.
    Other defaults: `defaultMode=full` (only full implemented),
    `defaultReviewIterations=3`, `maxTasksPerConversation=10`,
    `maxProtocolRoundtrips=30`, `maxAbnormalSignals=3`,
    `replyTimeoutSeconds=600`.
13. Files follow design §4 layout exactly. No router, multi-agent, agent
    spawner, daemon or new dependency beyond `playwright-core`.
14. Every task: TDD, then `node_modules/.bin/tsc.cmd --noEmit` and
    `node_modules/.bin/vitest.cmd run` green, then a conventional commit.
    Windows note: `pnpm` is not on PATH; call the binaries in
    `node_modules/.bin/` directly.

## Task 1 — transport foundation tests and first commit

Goal: pin the recovered foundation modules with behavior tests, fix anything
the tests reveal, then commit the foundation + design doc + dependency.

Files: `tests/transport-foundation.test.ts` (new), fixes only in
`src/transport/errors.ts`, `selectors.ts`, `reply.ts`, `delivery.ts`; commits
`package.json`, `pnpm-lock.yaml`, `docs/C2C_TRANSPORT_DESIGN.md`.

Required tests (behavior, not implementation details):

- `parseChatGptReply`: finds `STATE: PLAN|DONE|BLOCKED|ERROR|READY` among prose,
  case-insensitive `[C2C]` marker, unknown state → `null`, parses `TASK_ID` and
  numeric `ITERATION`.
- `validateReplyIdentity`: wrong task id → `PROTOCOL_IDENTITY_MISMATCH`; reply
  iteration below the expected minimum → `PROTOCOL_IDENTITY_MISMATCH`; missing
  marker/task id/iteration → `ok: true` plus the matching signals; unknown
  state → `CHATGPT_RESPONSE_UNPARSEABLE`.
- `parseReadinessWorkspace`: extracts `WORKSPACE: <name>`, null otherwise.
- delivery ledger (isolated `C2C_STATE_DIR`): `prepare → markSent → confirm →
  recordResponse` lifecycle; key is `taskId:STATE:iteration`; whitespace-only
  differences hash equal; re-preparing a responded record keeps `responded`
  status and timestamps; `list/read`; `clearDeliveries`; corrupt store file →
  empty store, no throw.
- selectors: `isChatGptUrl` accepts `https://chatgpt.com/...` and
  `https://www.chatgpt.com/...`, rejects http, other hosts, malformed URLs;
  `isChatGptConversationUrl` requires `/c/` or `/g/`.

RED evidence: the code exists, so tests may pass immediately; to prove they
can fail, temporarily mutate each module (e.g. flip a comparison) and record
one RED run per module, then restore. Record this mutation evidence in the
report.

Commit: `feat(transport): add C2C ChatGPT transport foundation (selectors, replies, delivery ledger)`.

## Task 2 — machine-wide preferences

Goal: one owner for `prefs.json` with transport/review settings; `ui-prefs`
becomes a compatibility facade; CLI `prefs get/set` extended.

Files: `src/config/prefs.ts` (new), `src/config/ui-prefs.ts` (refactor to
delegate), `src/cli/index.ts` (prefs commands), `tests/prefs.test.ts` (extend),
`tests/machine-prefs.test.ts` (new if needed).

Interface (`src/config/prefs.ts`):

```ts
export type TransportMode = "manual" | "chrome";
export type TaskMode = "full" | "review" | "off";
export interface MachinePrefs {
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  transport: TransportMode | null;               // null = not chosen yet
  defaultMode: TaskMode;                          // default "full"
  defaultReviewIterations: number | "until_done"; // default 3
  maxTasksPerConversation: number;                // default 10
  maxProtocolRoundtrips: number;                  // default 30
  maxAbnormalSignals: number;                     // default 3
  replyTimeoutSeconds: number;                    // default 600
}
export function readMachinePrefs(): MachinePrefs;
export function mergeMachinePrefs(patch: MachinePrefsPatch): MachinePrefs;
export function resolveTransportMode(flag?: string | null): TransportMode;
```

Rules: same file (`<state>/prefs.json`); `developerModeEnabled` only ever
persisted as `true`; validation errors name the field; positive integers,
`defaultReviewIterations` an integer ≥ 1 or `"until_done"`; `resolveTransportMode`
order flag > `C2C_TRANSPORT` > prefs > `manual`, unknown values throw.
`ui-prefs.ts` keeps its exported names and behavior (existing test file must
stay green untouched) and delegates storage to `prefs.ts` so setting transport
never drops developer mode / setup mode and vice versa.

CLI: `prefs get` shows transport/mode/review settings (text + `--json`);
`prefs set` accepts `--transport <manual|chrome>`, `--default-mode <full|review|off>`,
`--review-iterations <n|until_done>`, `--max-tasks-per-conversation <n>`,
`--max-roundtrips <n>`, `--reply-timeout <seconds>` in addition to the
existing `--developer-mode` / `--setup-mode`, keeping the existing output
style.

Commit: `feat(prefs): add machine-wide transport and review preferences`.

## Task 3 — isolated Chrome lifecycle

Goal: `src/transport/chrome.ts` exactly per design §5.

Files: `src/transport/chrome.ts` (new), `tests/transport-chrome.test.ts` (new).

Interface:

```ts
export interface ChromeInstance { pid: number; port: number; profileDir: string; startedAt: string }
export interface ChromeDeps {
  spawnFn?: …; probe?: (port: number) => Promise<boolean>;
  findBinary?: () => string | null; platform?: NodeJS.Platform;
  waitPort?: (profileDir: string) => Promise<number | null>; now?: () => Date;
}
export function findChromeBinary(deps?: ChromeDeps): string | null;
export function chromeStateFile(): string;
export function readChromeState(): ChromeInstance | null;
export async function ensureChrome(deps?: ChromeDeps): Promise<{ instance: ChromeInstance; reused: boolean }>;
export async function closeChrome(deps?: ChromeDeps): Promise<{ closed: boolean; pid?: number }>;
```

Behavior: profile `<state>/chrome-profile`; binary `C2C_CHROME_PATH` first, then
standard locations (Google Chrome only); launch detached
`chrome.exe --user-data-dir=<profile> --remote-debugging-port=0 --no-first-run
--no-default-browser-check https://chatgpt.com/`; port read from
`<profile>/DevToolsActivePort` (first line); health check loopback
`http://127.0.0.1:<port>/json/version`; state file
`<state>/transport/chrome.json` `{ pid, port, profileDir, startedAt }`;
a healthy live instance is reused; a stale/dead one is killed
(if the pid is alive) and replaced; at most one relaunch attempt, then
`CHROME_LAUNCH_FAILED`. `closeChrome` kills the recorded pid, removes the
state file, returns `{ closed: false }` when nothing ran. Errors use
`TransportError` codes. Logs stay friendly and never print profile contents.

Tests use injected `spawnFn`/`probe`/`findBinary`/`waitPort` and an isolated
`C2C_STATE_DIR`; no test may spawn a real process. Cover: discovery order and
`C2C_CHROME_PATH`; fresh launch writes state; healthy instance reused without
spawn; stale pid replaced; bounded relaunch then failure; `closeChrome`
kills + clears; state file malformed → treated as absent.

Commit: `feat(transport): add isolated Chrome lifecycle for C2C`.

## Task 4 — page driver port and ChatGPT page flows

Goal: `src/transport/driver.ts` (port + Playwright adapter) and
`src/transport/chatgpt-page.ts` (flows over the port) per design §4/§9.

Files: `src/transport/driver.ts`, `src/transport/chatgpt-page.ts` (new),
`tests/transport-page.test.ts` (new), `tests/fake-page-driver.ts` (test util).

Interface (`driver.ts`):

```ts
export interface PageMessage { id: string; role: "user" | "assistant"; text: string }
export interface PageSnapshot {
  url: string; composerPresent: boolean; composerText: string;
  generating: boolean; loginRequired: boolean; messages: PageMessage[];
}
export interface PageDriver {
  open(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  focusComposer(): Promise<void>;
  typeText(text: string): Promise<void>;
  readComposerText(): Promise<string>;
  clickSend(): Promise<void>;
}
export async function createPlaywrightDriver(port: number): Promise<PageDriver>;
```

`createPlaywrightDriver` attaches with `chromium.connectOverCDP` (lazy import
of `playwright-core`), reuses the first page or opens one, and closing it must
not kill Chrome (verify against Playwright docs/logic; disconnect only).

Flows (`chatgpt-page.ts`):

- `messageIdFor(index, text)` → stable `msg-<index>-<hash8>` id.
- `readSnapshot` mapping DOM → `PageSnapshot` using `SELECTORS` candidates;
  missing composer while logged in → `CHATGPT_UI_CHANGED`.
- `sendMessage(driver, text)`: focus, type, read composer back and compare
  normalized text (mismatch → `CHATGPT_COMPOSER_VERIFY_FAILED`), click send,
  poll until the composer is empty and a user message with the same normalized
  text exists (else `CHATGPT_SEND_UNCONFIRMED`), return its message id.
- `waitForReply(driver, afterMessageId, { timeoutMs, pollMs, stabilityMs })`:
  poll snapshot; require `!generating`, an assistant message with index after
  `afterMessageId`, non-empty text stable for the stability window; timeout →
  `CHATGPT_RESPONSE_TIMEOUT`.
- `openConversation(driver, url)` validates `https://chatgpt.com/**`
  (`INVALID_CONVERSATION_URL`) and detects `loginRequired` after open →
  `CHATGPT_LOGIN_REQUIRED`.
- `startNewConversation(driver)` opens `https://chatgpt.com/`.

Tests use `FakePageDriver` (constructed from scripted snapshots / mutations);
no real browser. Cover: happy path replies; prose-only reply still returned
for the parser; login required; composer verify failure; send unconfirmed;
response timeout with fake timers or a tiny injected clock; UI changed.

Commit: `feat(transport): add page driver port and ChatGPT page flows`.

## Task 5 — transport facade with delivery recovery

Goal: `src/transport/chatgpt-transport.ts` plus `buildBootstrapMessage` in
`src/protocol/messages.ts`, per design §6–§8.

Files: `src/transport/chatgpt-transport.ts` (new),
`src/protocol/messages.ts` (add bootstrap builder),
`tests/transport-facade.test.ts` (new), `tests/protocol-messages.test.ts`
(extend).

`buildBootstrapMessage(input: { connectorName: string; workspaceName: string })`
asks GPT to use only that connector, confirm `workspace_info` returns the
workspace name, and reply with a message containing `[C2C]` and a
`WORKSPACE: <exact workspace name>` line (and `WORKSPACE_OK`).

Facade:

```ts
export interface TransportContext { workspaceId: string; workspaceName: string; connectorName: string }
export interface DeliverInput {
  taskId: string; state: string; iteration: number; message: string;
  chatUrl?: string | null; forceNewChat?: boolean; timeoutMs?: number;
}
export interface DeliverOutcome {
  chatUrl: string; sentMessageId: string; reusedConfirmation: boolean;
  replyMessageId: string; replyText: string; reply: ParsedReply; signals: AbnormalSignalKind[];
}
export class ChatGptTransport {
  constructor(driver: PageDriver, context: TransportContext, options?: { pollMs?; stabilityMs?; now? });
  ensureConversation(input: { chatUrl?: string | null; forceNewChat?: boolean }): Promise<string>;
  deliver(input: DeliverInput): Promise<DeliverOutcome>;
  close(): Promise<void>;
}
```

Behavior: conversation URL guard; login check before send
(`CHATGPT_LOGIN_REQUIRED`); when `forceNewChat` or no chat URL, open root, send
the bootstrap, wait for the reply, verify the `WORKSPACE:` name equals the
context workspace name (else `WORKSPACE_VERIFICATION_FAILED`), then require a
`/c/` conversation URL (else `CONVERSATION_NOT_FOUND`) and return it;
delivery: `prepareDelivery` by `(taskId, STATE, iteration)`, if a confirmed or
sent record exists and the last user message matches the content hash → reuse
(do not resend), else send + confirm with the recovered message id; wait for
the reply relative to that id; `recordDeliveryResponse`; parse and
`validateReplyIdentity` against `{ taskId, minIteration: iteration }`; hard
failures throw `TransportError` with `PROTOCOL_IDENTITY_MISMATCH`; missing
headers return `signals`. `close()` disconnects the driver only.

Tests: FakePageDriver + isolated state dir; cover bootstrap success and
workspace mismatch, fresh conversation URL saved, idempotent resume (same
content already sent → no second send), send/confirm crash resume, identity
mismatch, missing-header signals, invalid URL.

Commit: `feat(transport): add ChatGPT transport facade with delivery recovery`.

## Task 6 — conversation rotation and review policy

Goal: `src/conversation/rotation.ts` and `src/protocol/review-policy.ts` per
design §6/§10.

Files: `src/conversation/rotation.ts`, `src/protocol/review-policy.ts` (new),
`tests/conversation-rotation.test.ts`, `tests/review-policy.test.ts` (new).

Rotation interface:

```ts
export interface RotationThresholds { maxTasksPerConversation: number; maxProtocolRoundtrips: number; maxAbnormalSignals: number }
export interface RotationState { chatUrl: string | null; tasks: number; roundtrips: number; abnormalSignals: number; updatedAt: string }
export function readRotationState(workspaceId: string): RotationState;
export function recordTaskStarted(workspaceId: string, chatUrl: string): RotationState;   // resets counters when chatUrl changes
export function recordRoundtrip(workspaceId: string, chatUrl: string): RotationState;
export function recordAbnormalSignals(workspaceId: string, count: number): RotationState;
export function rotationRecommendation(state: RotationState, thresholds: RotationThresholds): { recommended: boolean; reason: string | null };
export function resetConversation(workspaceId: string, chatUrl: string): RotationState;
```

State file `<state>/transport/conversations/<workspaceId>.json`. A chat url
change resets counters for the new conversation. `recommended` when tasks ≥
max, roundtrips ≥ max, or abnormalSignals ≥ max; reason names the trigger.
Mid-task HANDOFF is not this module's job.

Review policy interface:

```ts
export type ReviewIterations = number | "until_done";
export function resolveReviewIterations(pref: ReviewIterations, flag?: string | null): ReviewIterations;
export function detectNoProgress(records: ExecutionRecord[]): boolean; // last two: same changedFiles, tests, exitStatus
export interface ReviewEvaluation { action: "continue" | "limit_reached" | "no_progress" | "terminal"; iteration: number; reason: string }
export function evaluateReviewReply(input: {
  replyState: "PLAN" | "DONE" | "BLOCKED" | "ERROR";
  reviewRound: number; limit: ReviewIterations;
  records: ExecutionRecord[];
}): ReviewEvaluation;
```

`terminal` for DONE/BLOCKED; `no_progress` when a PLAN arrives and
`detectNoProgress` (checked before the limit); `limit_reached` when
`reviewRound >= limit` (never for `until_done`); otherwise `continue`.
`tests` in execution records is `string | null`, so compare normalized.

Commit: `feat(protocol): add conversation rotation and review policy`.

## Task 7 — roundtrip composition and CLI wiring

Goal: `src/protocol/roundtrip.ts` composing lifecycle + transport + policy,
and the CLI surface that makes the loop zero-copy-paste.

Files: `src/protocol/roundtrip.ts` (new), `src/cli/index.ts`,
`tests/task-transport-cli.test.ts` (new), `tests/roundtrip.test.ts` (new).

Roundtrip:

```ts
export interface RoundtripDeps { transport?: ChatGptTransport | null; prefs?: MachinePrefs }
export async function startTaskWithTransport(scope, input, deps?): Promise<StartOutcome>;
export async function executedWithTransport(scope, input, deps?): Promise<ExecutedOutcome>;
export async function resumeWithTransport(scope, deps?): Promise<ResumeOutcome>;
```

- start: rotation recommendation → force new chat; `startTask` (unchanged
  lifecycle), then `deliver` INIT; PLAN reply → `markPlan` (iteration from the
  reply) and return the plan text; other states returned as-is; abnormal
  signals recorded to rotation; roundtrip counted.
- executed: `markExecuted` (unchanged) then deliver EXECUTED; reply drives
  `evaluateReviewReply`; PLAN → `markPlan` + return decision; limit reached →
  checkpoint `waitingFor: USER`, return the four choices text with exact
  `c2c task resume --transport chrome ...` commands; no progress → return
  `NO_PROGRESS_DETECTED` with checkpoint kept; DONE/BLOCKED returned.
- resume: for a checkpoint waiting `GPT_PLAN`/`GPT_REVIEW`, re-enter delivery
  waiting with the ledger (never resend); returns the same shape as
  executed/start.
- transport failures (except identity mismatch which throws): return
  `{ transport: { ok: false, code, detail, manualFallback: message } }` so the
  caller can fall back to `manual` without losing the pending `[C2C]` message.

CLI:

- `task start` / `task executed`: add `--transport <manual|chrome>`,
  `--wait-seconds <n>`, `--review-iterations <n|until_done>`, `--new-chat`;
  `--transport chrome` implies `--wait` (add `--no-wait` to skip waiting).
- `task resume` (new): `-w`, `--executor`, `--agent-session`,
  `--transport <manual|chrome>`, `--wait-seconds`, `--json`.
- `browser` command group: `status` (state file + health) and `close`.
- Manual mode keeps printing the message exactly as today (215 tests keep
  passing); transport mode prints chat URL, reply state, plan/verdict text,
  and on failure the manual fallback message.
- Rotation/abnormal/roundtrip counters update through the roundtrip calls.

Tests: module-level roundtrip tests with a fake transport object (no Chrome)
covering start/executed/resume, limit reached choices, no-progress, manual
fallback; CLI tests keeping `--transport manual` output identical plus
`browser close` with no state and a `CHROME_NOT_FOUND` fallback path.

Commit: `feat(protocol): add transport roundtrip and CLI wiring`.

## Task 8 — OpenCode adapter and transport docs

Goal: `src/adapters/opencode.ts` + CLI `opencode install/uninstall/status`
(same shape as the Claude adapter) and a usage doc. OpenCode stays
`executor=opencode`; never set or mention a model.

Files: `src/adapters/opencode.ts` (new), `src/cli/index.ts`,
`tests/opencode-adapter.test.ts` (new), `docs/C2C_TRANSPORT.md` (new),
`docs/AGENT_PROTOCOL.md` (pointer).

Deliverables: installs `.opencode/skill/c2c/SKILL.md` (valid opencode skill
frontmatter: lowercase name matching folder, third-person description with
triggers) describing the zero-copy-paste loop with exact `c2c task
start/executed/resume --transport chrome` commands; installs a project-local
plugin `.opencode/plugin/c2c.js` only if its hooks can be verified against
`https://opencode.ai/docs/plugins` (it must inject the current session id and
the exact commands; no model, no provider). If the hook contract cannot be
verified, ship the skill only and note it in the report. Idempotent install,
`uninstall` removes only managed files, `status` detects them. Tests mirror
`tests/claude-adapter.test.ts` and must assert the word `model` and any
provider/model id never appear in generated files.

Docs: `docs/C2C_TRANSPORT.md` — enabling transport, first login, daily loop
(OpenCode/Claude/Codex as executors), browser close, prefs, review limits,
rotation, recovery, security boundaries, live E2E procedure with the
`CHATGPT_LOGIN_REQUIRED` LEVEL B outcome.

Commit: `feat(opencode): add the OpenCode adapter and transport docs`.

## Task 9 — live E2E and acceptance evidence (controller, with the user)

Procedure: `c2c browser status` → `c2c task start --transport chrome --wait
--goal "<small real task>"` in a scratch workspace with a connected MCP
session; if `CHATGPT_LOGIN_REQUIRED`, the user logs in once in the C2C Chrome
window and the command is re-run. Capture the JSON transcripts and the final
verdict in `docs/C2C_TRANSPORT_PROOF.md` (LEVEL A = full loop, LEVEL B =
stopped at login). Report
`REAL_OPEN_CODE_CHATGPT_E2E`, `REAL_MCP_REVIEW`, `ZERO_COPY_PASTE`,
`PERSONAL_DAILY_DRIVER_READINESS`.

## Final steps

Whole-branch review, then superpowers:finishing-a-development-branch.
