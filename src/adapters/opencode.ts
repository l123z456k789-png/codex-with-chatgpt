import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { readAgentSessionCheckpoint } from "../session/agent-session.js";
import { readConnectedSession } from "../session/connected.js";
import type { TaskCheckpoint } from "../session/state.js";

export const OPENCODE_EXECUTOR_ID = "opencode";
export const OPENCODE_SKILL_PATH = ".opencode/skill/c2c/SKILL.md";

const SKILL_MARKER = "Managed by `c2c opencode install`";

// ---------------------------------------------------------------- install / uninstall

export interface OpenCodeAdapterInstallResult {
  workspaceRoot: string;
  skillPath: string;
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface OpenCodeAdapterUninstallResult {
  removedFiles: string[];
}

/**
 * The skill is the whole adapter: OpenCode has no verified plugin hook that
 * injects the agent session id plus commands into the conversation, so C2C
 * ships instructions only and the agent keeps one stable session id itself.
 */
export function renderOpenCodeSkill(command: string): string {
  return `---
name: c2c
description: Use when OpenCode must implement a coding, debugging, architecture or code-review task while the workspace's saved ChatGPT conversation does the planning and the independent review. Runs the zero-copy-paste C2C loop with c2c task start/executed/resume --transport chrome.
---

# C2C workflow for OpenCode

C2C pairs OpenCode with the workspace's saved ChatGPT conversation: ChatGPT plans and reviews, OpenCode implements and tests. With the Chrome transport, C2C types each \`[C2C]\` message into ChatGPT and reads the structured reply itself, so nobody copies messages by hand.

${SKILL_MARKER}; run \`c2c opencode uninstall\` to remove it.

The C2C CLI for this workspace is: \`${command}\`.

## One stable session id

OpenCode exposes no session id to this skill, so choose one stable \`--agent-session\` id when the task starts (a short workspace-scoped string such as \`opencode-<workspace>-1\`), record it, and reuse that exact value in every command until the task is done. Never generate a new id per command and never ask the user to copy ids between commands.

## The zero-copy-paste loop

1. Start the task. C2C sends the INIT message through the C2C-owned Chrome, waits for the reply, and records a \`STATE: PLAN\` reply automatically:

   \`c2c task start --executor opencode --agent-session <session-id> --goal "<goal>" --transport chrome\`

   Optional flags: \`--new-chat\` (fresh conversation), \`--no-wait\` (send without waiting), \`--wait-seconds <n>\` (reply timeout), \`--review-iterations <n|until_done>\`, \`--json\` (machine-readable output).

2. Implement the PLAN with normal OpenCode tools and run the tests. ChatGPT reviews the real git diff and the execution evidence through the read-only MCP connector; never paste diffs, file bodies or logs into the control chat.

3. Record the execution. This appends the evidence and sends the EXECUTED message:

   \`c2c task executed --executor opencode --agent-session <session-id> --task <task-id> --iteration <n> --changed-files <files|count> --tests "<summary>" --transport chrome\`

   Optional: \`--exit-status <ok|failed|blocked>\`, \`--notes "<text>"\`, \`--command <text>\` with \`--output\`/\`--output-file\`/\`--exit-code\` to nominate a command log, \`--no-wait\`, \`--wait-seconds\`, \`--json\`.

4. Follow ChatGPT's reply: on \`STATE: PLAN\` run the next iteration (steps 2-3); on \`STATE: DONE\` run \`c2c task done --executor opencode --agent-session <session-id> --task <task-id>\`; on \`STATE: BLOCKED\` stop and surface the reason to the user.

5. If a command returns while the reply is still pending, continue without resending:

   \`c2c task resume --executor opencode --agent-session <session-id> --transport chrome [--review-iterations <n|until_done>]\`

## Review limits

Each task has a review-round limit (default 3, or \`--review-iterations\`). When the limit is reached the command prints four \`c2c task resume\` choices: continue 1 iteration, continue 3 iterations, continue \`until_done\`, or stop. Show all four choices to the user and wait for their decision; never pick one for them and never raise the limit on your own.

## Manual fallback

Chrome transport is opt-in; the default is \`--transport manual\`. In manual mode the same commands print the pending \`[C2C]\` message: show it to the user to paste into ChatGPT, then read the reply and record it with the same \`c2c task\` commands. A browser failure never breaks the loop; C2C prints the manual fallback and keeps the checkpoint.

## Browser and preferences

- \`c2c browser status\` shows the C2C-owned Chrome instance; \`c2c browser close\` terminates it when the user is done. Chrome is reused between commands.
- \`c2c prefs get\` shows the machine-wide settings; \`c2c prefs set --transport chrome\` makes Chrome the default on this machine. Resolution order: CLI flag, then \`C2C_TRANSPORT\`, then prefs, then \`manual\`.
- Login, CAPTCHA and 2FA are human steps in the C2C Chrome window: ask the user. Never import cookies, never read browser storage and never bypass a challenge.
- If a command reports \`CHATGPT_LOGIN_REQUIRED\`, ask the user to log in once in the C2C Chrome window and then retry with the \`c2c task resume\` command above; never repeat \`c2c task start\`, because the active checkpoint would be rejected.
- If the workspace connection is broken or a hard transport failure (identity mismatch, unparseable reply) is reported, run \`c2c doctor\`; never record a plan or verdict ChatGPT did not send.
`;
}

export function installOpenCodeAdapter(workspaceRoot: string, command = "c2c"): OpenCodeAdapterInstallResult {
  const workspace = new Workspace(workspaceRoot);
  const skill = workspace.resolve(OPENCODE_SKILL_PATH, { allowSensitive: true }).abs;
  const result: OpenCodeAdapterInstallResult = {
    workspaceRoot: workspace.root,
    skillPath: skill,
    created: [],
    updated: [],
    unchanged: [],
  };
  const content = renderOpenCodeSkill(command);
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  if (!fs.existsSync(skill)) {
    fs.writeFileSync(skill, content, "utf8");
    result.created.push(OPENCODE_SKILL_PATH);
  } else if (fs.readFileSync(skill, "utf8") === content) {
    result.unchanged.push(OPENCODE_SKILL_PATH);
  } else {
    fs.writeFileSync(skill, content, "utf8");
    result.updated.push(OPENCODE_SKILL_PATH);
  }
  return result;
}

export function uninstallOpenCodeAdapter(workspaceRoot: string): OpenCodeAdapterUninstallResult {
  const workspace = new Workspace(workspaceRoot);
  const skill = workspace.resolve(OPENCODE_SKILL_PATH, { allowSensitive: true }).abs;
  const removedFiles: string[] = [];
  if (fs.existsSync(skill)) {
    fs.rmSync(skill, { force: true });
    removedFiles.push(OPENCODE_SKILL_PATH);
  }
  return { removedFiles };
}

export function opencodeAdapterInstalled(workspaceRoot: string): boolean {
  try {
    const workspace = new Workspace(workspaceRoot);
    const skill = workspace.resolve(OPENCODE_SKILL_PATH, { allowSensitive: true }).abs;
    return fs.existsSync(skill) && fs.readFileSync(skill, "utf8").includes(SKILL_MARKER);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- status

export interface OpenCodeStatus {
  ok: true;
  workspaceName: string;
  installed: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  connectionMatches: boolean;
  ready: boolean;
  active: boolean;
  checkpoint: TaskCheckpoint | null;
}

export function readOpenCodeStatus(input: { workspaceRoot: string; agentSessionId?: string }): OpenCodeStatus {
  const workspace = new Workspace(input.workspaceRoot);
  const connected = readConnectedSession(workspace.id);
  const checkpoint = input.agentSessionId
    ? readAgentSessionCheckpoint(workspace.id, OPENCODE_EXECUTOR_ID, input.agentSessionId)
    : null;
  const installed = opencodeAdapterInstalled(workspace.root);
  return {
    ok: true,
    workspaceName: workspace.name,
    installed,
    chatUrl: connected?.chatUrl ?? null,
    connectorName: connected?.connectorName ?? null,
    connectionMatches: Boolean(connected),
    ready: installed && Boolean(connected),
    active: Boolean(checkpoint),
    checkpoint,
  };
}
