# Phase 5 Handoff — C2C-Owned Chrome Transport + Personal Daily Driver

Frozen: 2026-09-14. Branch: `feat/any-agent-executor`. HEAD: `c0db1db`.
Working tree clean. Baseline verified at this commit: `310/310` tests in 26
files, `tsc --noEmit` clean.

Documents of record:

- `docs/C2C_TRANSPORT_DESIGN.md` — accepted Phase 5 design (architecture,
  Chrome lifecycle, conversation model, review policy, security, config).
- `docs/PHASE5_IMPLEMENTATION_PLAN.md` — task-by-task plan with exact
  interfaces for T1–T9. Task 5's section is the working brief for tomorrow.
- SDD ledger and task artifacts (briefs/reports/reviews, git-ignored):
  `.superpowers/sdd/PHASE5_IMPLEMENTATION_PLAN/` — may be lost to a clean;
  the commits and this file are the durable record.

## 1. Phase 5 goal

```
OpenCode
  → C2C generic core
  → C2C-owned dedicated Chrome profile
  → ChatGPT
  → GPT PLAN
  → OpenCode executes
  → GPT MCP review
  → DONE
```

Zero copy-paste in normal use, `executor=opencode`, transport opt-in
(`--transport chrome`; default `manual`), existing 215+ tests and workflows
unchanged.

## 2. Architecture decisions (locked)

- C2C-owned outbound Chrome transport; executors never need a browser.
- Dedicated C2C Chrome profile (`<state>/chrome-profile`); never the user's
  daily profile; first login is manual; no cookie/storage import or export.
- Google Chrome, launched on demand by C2C (`--remote-debugging-port=0`),
  Playwright attaches over CDP; on-demand lifecycle, not a daemon.
- `executor=opencode` is constant and independent of any model inside
  OpenCode; a model name never enters the contract or the adapters.
- Default mode FULL. Fixed long-lived ChatGPT conversation per workspace,
  reused across tasks. Rotation is a hybrid policy (defaults 10 tasks /
  30 protocol roundtrips / abnormal signals) and normally only happens
  between tasks; a mid-task HANDOFF is reserved for a conversation that
  cannot continue.
- Review rounds are configurable (`defaultReviewIterations=3`), per-task
  override (`--review-iterations N|until_done`); at the limit the user
  chooses continue 1 / continue 3 / until DONE / stop.
- No router, multi-agent, agent spawner, daemon or new dependency beyond
  `playwright-core` (already committed).

## 3. What T1–T4 delivered (all reviewed and committed)

| Task | Commit | Delivered |
| --- | --- | --- |
| T1 foundation | `ba4e1bd` (+ fix `5415767`) | Tests pinning `src/transport/errors.ts`, `selectors.ts`, `reply.ts`, `delivery.ts`; first transport deps + design commit; 32 tests. |
| T2 prefs | `eebedd5` | `src/config/prefs.ts` owns `<state>/prefs.json` (transport, defaultMode, review iterations, rotation thresholds, reply timeout); `ui-prefs.ts` is a compatibility facade; CLI `prefs get/set` extended; `resolveTransportMode` = flag > `C2C_TRANSPORT` env > prefs > manual. |
| T3 Chrome | `52019a8` | `src/transport/chrome.ts`: Chrome discovery, isolated profile launch, DevToolsActivePort + health check, state file, reuse/stale-kill, one bounded relaunch, close; injected seams; 23 tests, no real process. |
| T4 page layer | `c0db1db` | `src/transport/driver.ts` (`PageDriver` port + thin CDP Playwright adapter) and `src/transport/chatgpt-page.ts` (open/login detect, send with composer read-back + new-message confirm, anchor-relative reply wait with poll+stability, no fixed sleeps); `FakePageDriver` + 27 tests. |

## 4. Why T5 is the next safe resume point

T5 was dispatched and cancelled before it wrote anything: no partial files, no
resume ambiguity. Its dependencies are all committed (T1 foundation, T3
Chrome, T4 page flows). The exact contract is documented in
`docs/PHASE5_IMPLEMENTATION_PLAN.md` § Task 5 and
`.superpowers/.../briefs/task-5-brief.md`. Resume by dispatching T5 cleanly;
do not re-audit T1–T4.

Known review decisions T5 must honor (from T4's review):

1. Do not trust ledger status alone for idempotent resume — inspect the
   conversation's last user message content hash.
2. Confirm the sent user message is new (snapshot pre-send ids), not an older
   identical message.
3. Wrap non-`TransportError` driver failures as
   `TransportError("TRANSPORT_UNAVAILABLE", …)`.
4. Trim `parseReadinessWorkspace` output; blank `WORKSPACE:` is missing.
5. A bootstrap must end on a `/c/` conversation URL or
   `CONVERSATION_NOT_FOUND`.

## 5. Remaining tasks

- **T5 transport facade** — `src/transport/chatgpt-transport.ts` (login,
  conversation reuse/bootstrap, delivery ledger with crash recovery, reply
  identity) + `buildBootstrapMessage` in `src/protocol/messages.ts`.
  → `NEXT_TASK=T5 transport facade`
- **T6 rotation + review policy** — `src/conversation/rotation.ts`,
  `src/protocol/review-policy.ts` (thresholds, `ROTATION_RECOMMENDED`,
  no-progress fuse).
- **T7 roundtrip + CLI wiring** — `src/protocol/roundtrip.ts`, `task
  start/executed/resume --transport chrome`, `browser status/close`, manual
  fallback keeps printing the pending `[C2C]` message.
- **T8 OpenCode adapter + docs** — `src/adapters/opencode.ts` (skill/plugin
  installer; never binds a model), `docs/C2C_TRANSPORT.md`.
- **T9 live E2E** — real Chrome + ChatGPT loop, evidence in
  `docs/C2C_TRANSPORT_PROOF.md`; may legitimately stop at
  `CHATGPT_LOGIN_REQUIRED` until the user logs in once (LEVEL B).

## 6. Key files

Committed: `src/config/prefs.ts`, `src/config/ui-prefs.ts`,
`src/transport/{chrome,driver,chatgpt-page,selectors,reply,delivery,errors}.ts`.
Pending (create in T5+): `src/transport/chatgpt-transport.ts`,
`src/conversation/rotation.ts`, `src/protocol/{review-policy,roundtrip}.ts`,
`src/adapters/opencode.ts`. Tests under `tests/` (26 files, 310 tests).

Environment notes: `pnpm` is not on PATH; run
`node_modules\.bin\vitest.cmd run` and `node_modules\.bin\tsc.cmd --noEmit`.
Committing per task is authorized by the owner (no force/reset/clean).

## 7. Deferred review findings (final review triages; not blockers)

- T1: whitespace-only `WORKSPACE:` parse edge; ledger re-prepare downgrades
  `sent`→`prepared` (handled by T5 decision 1); one temp dir leak in a
  foundation test; `/c/` URL guard accepts no id.
- T2: dead `mergeUiPrefs` import; duplicated validation constants; stale
  `prefs` command descriptions.
- T3: stale-pid kill not awaited; `closeChrome` ignores deps seam; invalid
  `C2C_CHROME_PATH` silently falls back; unwrapped probe/waitPort seams;
  health accepts any 2xx; no concurrent-`ensureChrome` guard.
- T4: poll loops don't re-check login; two DOM heuristics live in the adapter
  instead of the selector registry; raw Playwright errors escape the adapter.

## 8. Tomorrow's first step

1. Read this file, then `docs/PHASE5_IMPLEMENTATION_PLAN.md` § Task 5.
2. Confirm the freeze: `git log --oneline -5`, `git status`,
   `node_modules\.bin\vitest.cmd run` (expect 310/310).
3. Dispatch T5 per the plan; keep TDD and the per-task review loop.
4. Then T6 → T7 → T8 → T9, updating this file or the ledger as tasks land.

`NEXT_TASK=T5 transport facade`
