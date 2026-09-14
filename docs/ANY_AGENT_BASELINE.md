# Any-Agent Baseline (Phase 6)

Recorded before any source modification on the `feat/any-agent-executor`
branch. This file is the ground truth for "did we regress something?" during the
Any-Agent work. Baseline failures are not regressions.

## Repository identity

| Item | Value |
| --- | --- |
| Local checkout | `D:\AgentProjects\codex-with-chatgpt` |
| Origin (fork) | `https://github.com/l123z456k789-png/codex-with-chatgpt.git` |
| Upstream | `https://github.com/XiaoDuoYa/codex-with-chatgpt.git` |
| Default branch | `main` |
| Baseline commit | `9663b88753e35c76796c5bce000293e0bd22cd9e` ("Accept leftover -w on machine-wide c2c commands.") |
| `origin/main` at baseline | `9663b88` (identical) |
| `upstream/main` at baseline | `9663b88` (identical) |
| Fork ahead / behind upstream | 0 / 0 |
| User commits on fork | none |
| Working tree before baseline | clean |
| Latest release tag | `v0.1.3` (`8fdd97c`); one commit after it (`9663b88`) |
| Recording time | 2026-09-14 15:47 (+08:00, China Standard Time) |

## Runtime environment

| Tool | Version | Notes |
| --- | --- | --- |
| OS | Windows (win32), PowerShell 5.1 | |
| git | 2.55.0.windows.3 | |
| node | v24.16.0 | project requires `>=20` (`package.json` engines) |
| npm | 11.13.0 | present but not used by this project |
| corepack | 0.35.0 | used to run the pinned package manager |
| pnpm | 11.24.0 | pinned via `packageManager`; lockfile `pnpm-lock.yaml` |
| gh | 2.97.0 | installed, but the stored token is invalid (not logged in) |
| python | 3.12.10 | not required by the project |

Network note: direct git access to `github.com:443` is blocked on this machine.
The system proxy `http://127.0.0.1:7897` works for HTTPS; git commands were run
with `HTTPS_PROXY`/`HTTP_PROXY` set per command. No global git config was
changed and no git proxy config was written.

## Dependency install

| Item | Result |
| --- | --- |
| Command | `corepack pnpm install` (with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`) |
| Lockfile | up to date; resolution skipped; `pnpm-lock.yaml` unchanged |
| Packages | 156 added, exit code 0 |
| Post-install `git status` | clean (no lockfile or manifest change) |

## Baseline verification (command / exit / result)

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm typecheck` (`tsc --noEmit`) | 0 | pass |
| `corepack pnpm test` (`vitest run`) | 0 | 17 test files, 172 tests passed, 0 failed, 0 skipped |
| `corepack pnpm build` (`tsc -p tsconfig.json`) | 0 | pass, `dist/` generated |
| `corepack pnpm lint` | n/a | no lint script exists in `package.json` |

Test files at baseline (all passing): `endpoint`, `sandbox-allow`, `prefs`,
`pairing`, `session`, `execution-output`, `workspace`, `search`, `tunnel`,
`port`, `runtime`, `oauth`, `windows-process`, `mcp-integration`,
`record-cli`, `git`, `cli-workspace-flag`.

## Known baseline issues

- None. The baseline is fully green.
- README states "150 tests"; the actual count is 172 (docs lag only, not a failure).
- Tests create temp state under the repo-local `.tooling/test-tmp` (gitignored)
  and do not require network access. Some tests spawn `git` (available).

## Reproduce

```powershell
cd D:\AgentProjects\codex-with-chatgpt
$env:HTTPS_PROXY='http://127.0.0.1:7897'   # only for git fetch/clone
corepack pnpm install
corepack pnpm typecheck; corepack pnpm test; corepack pnpm build
```

Expected: exit 0 for all three, 172/172 tests passing.
