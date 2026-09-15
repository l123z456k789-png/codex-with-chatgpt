# C2C Transport — Live E2E Proof

Status: **LEVEL B** — the C2C-owned Chrome transport launched, attached over
CDP, navigated to ChatGPT and correctly surfaced `CHATGPT_LOGIN_REQUIRED`
before any message was sent. The full loop (LEVEL A) is pending a one-time
manual login in the C2C Chrome profile.

- Date: 2026-09-15
- Branch: `feat/any-agent-executor`
- Code under test: `81c77cb` (includes the `__name` serialization fix below)
- Machine: Windows, Google Chrome installed, `C2C_STATE_DIR` unset (real
  state dir: `%LOCALAPPDATA%\codex-with-chatgpt`)
- Scratch workspace: `%TEMP%\c2c-t9-scratch`, connector
  `Codex with ChatGPT · t9-live`, saved chat `https://chatgpt.com/c/t9-live`

## 1. What was exercised

1. `c2c browser status --json` → no instance.
2. `c2c task start --transport chrome --wait-seconds 30 --json` (scratch
   workspace, `executor=opencode`) → Chrome launched from
   `<state>\chrome-profile`, CDP attached, chat opened, then the **first
   run failed with a real bug** (see §2).
3. After the fix: `c2c task resume --transport chrome --wait-seconds 30 --json`
   → `CHATGPT_LOGIN_REQUIRED` with instructions and the pending `[C2C]` INIT
   message as the manual fallback. Nothing was sent; no fake success.
4. `c2c browser status --json` → healthy instance
   (`pid 9956`, port `49676`, profile
   `%LOCALAPPDATA%\codex-with-chatgpt\chrome-profile`).
5. `c2c browser close --json` → closed (`pid 9956`); no C2C Chrome process
   left behind.

## 2. Bug found and fixed by this run

First live attempt failed before login detection:

```
"transport":{"ok":false,"code":"TRANSPORT_UNAVAILABLE",
"detail":"Opening the ChatGPT conversation failed: page.evaluate:
ReferenceError: __name is not defined at readDomSnapshot ..."}
```

Root cause: `src/transport/driver.ts` passes `readDomSnapshot` to
`page.evaluate`; Playwright serializes the function source into the page, and
tsx/esbuild (`keepNames`) had injected `__name(...)` helper calls around the
inner named function bindings — a helper that does not exist in the page
context. Unit tests use `FakePageDriver`, so serialization was never
exercised before the live run.

Fixed in `81c77cb` (`fix(transport): keep page.evaluate payload free of
transpiler helpers`): the payload now contains only inline expressions and
anonymous callbacks, plus a regression test that executes the serialized
function source in a context without `__name` (RED verified before the fix,
`tests/transport-page.test.ts`).

## 3. LEVEL B transcript (abridged)

```json
{"ok":true,"taskId":"c2c_441d51","iteration":0,"protocolState":"INIT",
 "waitingFor":"GPT_PLAN","chatUrl":"https://chatgpt.com/c/t9-live",
 "transport":{"ok":false,"code":"CHATGPT_LOGIN_REQUIRED",
 "detail":"ChatGPT requires a manual login. Complete login, CAPTCHA or 2FA in the C2C Chrome window, then retry.",
 "manualFallback":"[C2C]\nSTATE: INIT\n..."}}
```

```json
{"ok":true,"instance":{"pid":9956,"port":49676,
 "profileDir":"C:\\Users\\bimubai\\AppData\\Local\\codex-with-chatgpt\\chrome-profile",
 "startedAt":"2026-09-15T08:00:45.286Z"},"healthy":true}
{"ok":true,"closed":true,"pid":9956}
```

## 4. Acceptance items

| Item | Status |
| --- | --- |
| `REAL_OPEN_CODE_CHATGPT_E2E` | Pending — blocked on the one-time login |
| `REAL_MCP_REVIEW` | Pending — needs the live MCP session at LEVEL A |
| `ZERO_COPY_PASTE` | Pending — the loop stops at login before the first send |
| `PERSONAL_DAILY_DRIVER_READINESS` | LEVEL B verified (launch, attach, login gate, close) |

## 5. LEVEL A procedure (once, after login)

1. Run any transport command (e.g. `c2c task resume --transport chrome …`);
   the C2C Chrome window opens at `https://chatgpt.com/`.
2. Log in manually (the profile is C2C-owned; cookies never leave it).
3. Re-run the same command; the pending `[C2C]` INIT message is delivered —
   the delivery ledger guarantees it is never sent twice.
4. Capture the JSON transcripts for INIT → PLAN → EXECUTED → review → DONE,
   including the MCP review evidence, and replace this section with the
   LEVEL A record.
