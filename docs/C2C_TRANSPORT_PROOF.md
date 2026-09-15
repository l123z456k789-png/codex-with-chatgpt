# C2C Transport — Live E2E Proof

Status: **LEVEL B+** — the C2C-owned Chrome transport is verified live end to
end: dedicated-profile launch, CDP attach, login gate, composer
clear/type/read-back, send + user-message confirmation, reply wait and reply
parsing all work against the real ChatGPT web app with a human-logged-in
account. The full LEVEL A loop (INIT → PLAN → EXECUTED → MCP review → DONE)
is pending a live MCP connector for the workspace; the last live run stopped
at `WORKSPACE_VERIFICATION_FAILED` because the scratch connector name does not
exist in the ChatGPT account.

- Date: 2026-09-15
- Branch: `feat/any-agent-executor`
- Code under test: `aee54de` (includes all live hardening below)
- Machine: Windows, Google Chrome, real state dir
  `%LOCALAPPDATA%\codex-with-chatgpt` (C2C profile logged in by the user)
- Scratch workspace: `%TEMP%\c2c-t9-scratch`, connector
  `Codex with ChatGPT · t9-live`

## 1. Live verification runs

1. `c2c browser status --json` → no instance.
2. `c2c task start --transport chrome` (scratch workspace) → Chrome launched
   from `<state>\chrome-profile`, CDP attached, login detected as required
   until the user logged in once (`c2c browser login` helper added below).
3. After login and the live hardening fixes, `c2c task start --transport
   chrome --new-chat` delivered the bootstrap message: composer cleared,
   message typed, read-back verified, send button clicked, the new user
   message confirmed in the conversation, and the ChatGPT reply was read.
4. The reply contained no `WORKSPACE:` line, so verification correctly failed
   with `WORKSPACE_VERIFICATION_FAILED` — the scratch connector does not exist
   in the ChatGPT account yet. No success was faked.
5. `c2c browser status --json` → healthy instance; `c2c browser close --json`
   → closed. (Login left the C2C profile signed in, as intended.)

## 2. Real bugs found and fixed by the live runs

Unit tests use `FakePageDriver`; only the live runs could expose these:

| Commit | Fix |
| --- | --- |
| `81c77cb` | `page.evaluate` payload carried tsx/esbuild `__name` helpers (ReferenceError in the page); `readDomSnapshot` is now helper-free with a serialization regression test. |
| `da041cc` | No page-readiness wait after navigation (`CHATGPT_UI_CHANGED` flake); bounded readiness poll added, plus `c2c browser login` (launches the profile **without** the debugging port because Google sign-in rejects automated Chrome). |
| `a36ec5e` | `textContent` dropped ProseMirror block line breaks (composer verification and reply parsing); text is read with `innerText` now, with a DOM-level regression test. |
| `e3cd75e` | A leftover composer draft was appended to instead of replaced; the flow clears the composer before typing. |
| `aee54de` | The send button renders ~1 s after typing; `clickSend` now waits with a bounded poll. |

## 3. Evidence (abridged, from `.tooling/t9-e2e-transcript.txt`)

```json
{"ok":true,"instance":{"pid":9956,"port":49676,
 "profileDir":"C:\\Users\\...\\codex-with-chatgpt\\chrome-profile"},
 "healthy":true}
{"ok":true,"closed":true,"pid":9956}
```

```json
{"ok":true,"taskId":"c2c_eb7849","protocolState":"INIT",
 "transport":{"ok":false,"code":"WORKSPACE_VERIFICATION_FAILED",
 "detail":"The bootstrap reply reported workspace null, but this workspace is \"c2c-t9-scratch\".",
 "manualFallback":"[C2C]\nSTATE: INIT\n..."}}
```

The transport failure path returned the pending `[C2C]` message for manual
fallback without any fake success, as designed.

## 4. Acceptance items

| Item | Status |
| --- | --- |
| `REAL_OPEN_CODE_CHATGPT_E2E` | Transport mechanics verified live; full loop pending the MCP connector |
| `REAL_MCP_REVIEW` | Pending — needs a live connector for the scratch workspace |
| `ZERO_COPY_PASTE` | Message delivery proven without copy-paste; loop pending the connector |
| `PERSONAL_DAILY_DRIVER_READINESS` | LEVEL B+ verified (launch, login gate, delivery, reply, close) |

## 5. LEVEL A procedure (setup + one run)

1. Start the workspace bridge and public connection:
   `c2c start -w <workspace> --tunnel` (or `c2c doctor -w <workspace>` for the
   guided repair). Create the ChatGPT connector it links to, with the exact
   connector name saved for the workspace.
2. Run `c2c task start --transport chrome --goal "<small real task>" --new-chat`
   and capture the JSON transcript: bootstrap → `WORKSPACE: <name>` →
   INIT → PLAN.
3. Execute the plan with the executor, then `c2c task executed --transport
   chrome …`; capture the review reply (`PLAN` / `DONE` / `BLOCKED`).
4. Replace this section with the LEVEL A record once the loop completes.
