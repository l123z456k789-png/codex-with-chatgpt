import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { readAgentSessionCheckpoint } from "../session/agent-session.js";
import { readConnectedSession } from "../session/connected.js";
import {
  finishTask,
  handoffTask,
  markExecuted,
  markPlan,
  readTaskStatus,
  startTask,
  type TaskDoneResult,
  type TaskMessageResult,
  type TaskScope,
  type TaskStateResult,
  type TaskStatusResult,
} from "../protocol/lifecycle.js";
import type { TaskCheckpoint } from "../session/state.js";

export const CLAUDE_EXECUTOR_ID = "claude-code";
export const CLAUDE_RULE_PATH = ".claude/rules/c2c-chatgpt.md";
export const CLAUDE_SKILL_PATH = ".claude/skills/c2c/SKILL.md";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.local.json";

const PROMPT_HOOK_MARKER = "claude prompt-hook";
const GUARD_HOOK_MARKER = "claude guard-hook";
const POST_HOOK_MARKER = "claude post-hook";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------- install / uninstall

export interface ClaudeAdapterInstallResult {
  workspaceRoot: string;
  rulePath: string;
  skillPath: string;
  settingsPath: string;
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface ClaudeAdapterUninstallResult {
  removedFiles: string[];
  updatedSettings: boolean;
}

const BROWSER_DISCIPLINE =
  "Use Claude Desktop's built-in browser for ChatGPT (Claude_Browser) and never launch or control a " +
  "third-party browser, and never read, copy, import or export cookies or browser storage. " +
  "NEVER click or focus the composer by screen coordinates: locate the prompt textarea, focus it, and " +
  "verify it is the active element. Treat a browser \"typed N chars\" result as untrusted: after every " +
  "typing stage read the textarea text back and verify it. Use shift+Enter (never shift+Return) for line " +
  "breaks. After sending, verify the composer emptied and the TASK_ID is visible. Ask the user for " +
  "login, CAPTCHA or 2FA; never bypass them.";

function renderRule(): string {
  return `# C2C: ChatGPT plans and reviews, Claude Code executes

- C2C is mandatory for coding, debugging, architecture and code-review tasks. The UserPromptSubmit hook starts or resumes it; the user never has to ask for C2C.
- ChatGPT owns high-level planning and independent review through the workspace's saved C2C chat. Claude Code owns implementation, commands, tests and final verification.
- Record only what ChatGPT actually replied (PLAN / DONE / BLOCKED). Never invent or assume a reply.
- Use only Claude Desktop's built-in browser for ChatGPT. Never launch or control a third-party browser and never read, copy or export cookies or browser storage.
- NEVER click or focus the composer by screen coordinates. Locate the prompt textarea, focus it, verify it is the active element, and re-read the text after every typing stage.
- Use \`shift+Enter\` (never \`shift+Return\`) for line breaks. A browser "typed N chars" result is not evidence that text landed.
- Never paste diffs, file bodies or logs into the control chat; ChatGPT reads the workspace through the read-only MCP connector.
- Keep control messages small and drive the loop with the C2C CLI commands injected by the hooks.
`;
}

function renderSkill(command: string): string {
  return `---
name: c2c
description: Use the saved ChatGPT web conversation as the planning and independent-review brain while Claude Code implements and tests. Invoke automatically for coding, debugging, architecture and code-review tasks.
---

# C2C workflow for Claude Code

The C2C CLI for this workspace is: \`${command}\`.
The hooks inject exact commands that already include \`--executor ${CLAUDE_EXECUTOR_ID}\` and \`--agent-session\`; use those commands as-is and keep the same session id for the whole task.

1. The UserPromptSubmit hook starts or resumes the task and injects the current gate (PLAN / EXECUTION / RESUME / SETUP / RECOVERY). Obey that gate before planning or editing.
2. Send the INIT message it provides to the saved ChatGPT conversation through Claude Desktop's built-in browser (\`Claude_Browser\`). Wait for a structured \`STATE: PLAN\`.
3. Record the plan with the injected \`task plan\` command, then implement and test with your normal tools. Claude Code owns execution and tests.
4. After tests, run the injected \`task executed\` command. It appends the execution record (with \`executor=${CLAUDE_EXECUTOR_ID}\`) and returns the EXECUTED message; send that message in the same chat.
5. Wait for ChatGPT's reply. It inspects the real git diff and execution evidence through MCP. On \`STATE: PLAN\` continue with the next iteration; on \`STATE: DONE\` run the \`task done\` command; on \`STATE: BLOCKED\` surface the reason to the user.
6. If the chat was lost, run the \`task handoff\` command and send the returned HANDOFF message in the replacement chat.
7. If the built-in browser is unavailable, show the user the exact message to paste. Never fabricate a ChatGPT reply and never record a plan or verdict ChatGPT did not send.

Browser rules (from the injected gates): built-in browser only; no third-party browser; no cookie or storage access; no screen-coordinate clicking; verify typed text; \`shift+Enter\` line breaks; ask the user for login, CAPTCHA or 2FA.
`;
}

function shellCommandArg(value: string): string {
  return JSON.stringify(value);
}

function managedHook(command: string, marker: string, workspaceRoot: string): JsonObject {
  return {
    type: "command",
    command: `${command} claude ${marker} --workspace-root ${shellCommandArg(workspaceRoot)}`,
  };
}

function mergeManagedHook(
  settings: JsonObject,
  event: string,
  matcher: string | null,
  hook: JsonObject,
  marker: string
): void {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const kept = groups.filter((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return true;
    return !group.hooks.some((entry) => isObject(entry) && String(entry.command ?? "").includes(marker));
  });
  const group: JsonObject = { hooks: [hook] };
  if (matcher) group.matcher = matcher;
  kept.push(group);
  hooks[event] = kept;
}

function removeManagedHook(settings: JsonObject, event: string, marker: string): void {
  if (!isObject(settings.hooks)) return;
  const hooks = settings.hooks;
  if (!Array.isArray(hooks[event])) return;
  const kept = (hooks[event] as unknown[]).filter((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return true;
    return !group.hooks.some((entry) => isObject(entry) && String(entry.command ?? "").includes(marker));
  });
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function renderSettings(current: string | null, command: string, workspaceRoot: string): string {
  let settings: JsonObject = {};
  if (current?.trim()) {
    const parsed = JSON.parse(current) as unknown;
    if (!isObject(parsed)) throw new Error(`${CLAUDE_SETTINGS_PATH} must contain a JSON object`);
    settings = parsed;
  }
  mergeManagedHook(settings, "UserPromptSubmit", null, managedHook(command, "prompt-hook", workspaceRoot), PROMPT_HOOK_MARKER);
  mergeManagedHook(
    settings,
    "PreToolUse",
    "Bash|Edit|Write|NotebookEdit",
    managedHook(command, "guard-hook", workspaceRoot),
    GUARD_HOOK_MARKER
  );
  mergeManagedHook(settings, "PostToolUse", "Bash", managedHook(command, "post-hook", workspaceRoot), POST_HOOK_MARKER);
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function writeManagedFile(file: string, content: string, workspaceRoot: string, result: ClaudeAdapterInstallResult): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const relative = path.relative(workspaceRoot, file).split(path.sep).join("/");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content, "utf8");
    result.created.push(relative);
    return;
  }
  const current = fs.readFileSync(file, "utf8");
  if (current === content) {
    result.unchanged.push(relative);
    return;
  }
  fs.writeFileSync(file, content, "utf8");
  result.updated.push(relative);
}

export function installClaudeAdapter(workspaceRoot: string, command = "c2c"): ClaudeAdapterInstallResult {
  const workspace = new Workspace(workspaceRoot);
  const rule = workspace.resolve(CLAUDE_RULE_PATH, { allowSensitive: true }).abs;
  const skill = workspace.resolve(CLAUDE_SKILL_PATH, { allowSensitive: true }).abs;
  const settings = workspace.resolve(CLAUDE_SETTINGS_PATH, { allowSensitive: true }).abs;
  const result: ClaudeAdapterInstallResult = {
    workspaceRoot: workspace.root,
    rulePath: rule,
    skillPath: skill,
    settingsPath: settings,
    created: [],
    updated: [],
    unchanged: [],
  };
  writeManagedFile(rule, renderRule(), workspace.root, result);
  writeManagedFile(skill, renderSkill(command), workspace.root, result);
  writeManagedFile(settings, renderSettings(fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : null, command, workspace.root), workspace.root, result);
  return result;
}

export function uninstallClaudeAdapter(workspaceRoot: string): ClaudeAdapterUninstallResult {
  const workspace = new Workspace(workspaceRoot);
  const removedFiles: string[] = [];
  for (const relative of [CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH]) {
    const file = workspace.resolve(relative, { allowSensitive: true }).abs;
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removedFiles.push(relative);
    }
  }

  const settingsPath = workspace.resolve(CLAUDE_SETTINGS_PATH, { allowSensitive: true }).abs;
  let updatedSettings = false;
  if (fs.existsSync(settingsPath)) {
    const current = fs.readFileSync(settingsPath, "utf8");
    let settings: JsonObject = {};
    if (current.trim()) {
      const parsed = JSON.parse(current) as unknown;
      if (!isObject(parsed)) throw new Error(`${CLAUDE_SETTINGS_PATH} must contain a JSON object`);
      settings = parsed;
    }
    const before = JSON.stringify(settings);
    removeManagedHook(settings, "UserPromptSubmit", PROMPT_HOOK_MARKER);
    removeManagedHook(settings, "PreToolUse", GUARD_HOOK_MARKER);
    removeManagedHook(settings, "PostToolUse", POST_HOOK_MARKER);
    if (JSON.stringify(settings) !== before) {
      if (Object.keys(settings).length === 0) fs.rmSync(settingsPath, { force: true });
      else fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      updatedSettings = true;
    }
  }
  return { removedFiles, updatedSettings };
}

export function claudeAdapterInstalled(workspaceRoot: string): boolean {
  try {
    const workspace = new Workspace(workspaceRoot);
    const rule = workspace.resolve(CLAUDE_RULE_PATH, { allowSensitive: true }).abs;
    const skill = workspace.resolve(CLAUDE_SKILL_PATH, { allowSensitive: true }).abs;
    const settings = workspace.resolve(CLAUDE_SETTINGS_PATH, { allowSensitive: true }).abs;
    if (!fs.existsSync(rule) || !fs.existsSync(skill) || !fs.existsSync(settings)) return false;
    const content = fs.readFileSync(settings, "utf8");
    return (
      content.includes(PROMPT_HOOK_MARKER) &&
      content.includes(GUARD_HOOK_MARKER) &&
      content.includes(POST_HOOK_MARKER)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Claude event parsing

const CODING_TASK_PATTERN =
  /\b(add|analy[sz]e|architect(?:ure)?|assess|audit|build|change|code|configure|create|debug|design|develop|diagnos(?:e|is)|fix|generate|implement|improve|integrate|investigate|migrat(?:e|ion)|optimi[sz]e|patch|plan|refactor|remove|rename|review|rewrite|setup|style|test|troubleshoot|update|upgrade)\b|\b(bug|feature|repository|repo|codebase|pull request|\bpr\b)\b/i;

const SHORT_CONTINUATION_PATTERN =
  /^(?:yes|no|ok(?:ay)?|continue|go|retry|resume|done|approved?|confirmed?|please do|do it|proceed|thanks?)[.! ]*$/i;

const INTERNAL_NOTIFICATION_PATTERN =
  /^\s*(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification\b|<system-reminder>\s*\[SYSTEM NOTIFICATION - NOT USER INPUT\])/i;

export function isClaudeInternalNotification(prompt: string): boolean {
  return INTERNAL_NOTIFICATION_PATTERN.test(prompt);
}

export function isClaudeC2CTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized || isClaudeInternalNotification(normalized) || SHORT_CONTINUATION_PATTERN.test(normalized)) {
    return false;
  }
  return CODING_TASK_PATTERN.test(normalized);
}

// ---------------------------------------------------------------- generic core mapping

export interface ClaudeScopeInput {
  workspaceRoot: string;
  agentSessionId: string;
}

function taskScope(input: ClaudeScopeInput): TaskScope {
  return {
    workspace: new Workspace(input.workspaceRoot),
    executor: CLAUDE_EXECUTOR_ID,
    agentSession: input.agentSessionId,
  };
}

function parseChangedFiles(value: string | string[] | number): string[] | number {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.split(",").map((file) => file.trim()).filter(Boolean);
}

export function startClaudeTask(input: ClaudeScopeInput & { goal: string; taskId?: string }): TaskMessageResult {
  return startTask(taskScope(input), { goal: input.goal, taskId: input.taskId });
}

export function markClaudePlan(
  input: ClaudeScopeInput & { taskId: string; iteration: number; nextStep?: string }
): TaskStateResult {
  return markPlan(taskScope(input), {
    taskId: input.taskId,
    iteration: input.iteration,
    nextStep: input.nextStep,
  });
}

export function markClaudeExecuted(
  input: ClaudeScopeInput & {
    taskId: string;
    iteration: number;
    changedFiles: string | string[] | number;
    tests?: string | null;
    exitStatus?: string;
    notes?: string;
  }
): TaskMessageResult {
  return markExecuted(taskScope(input), {
    taskId: input.taskId,
    iteration: input.iteration,
    changedFiles: parseChangedFiles(input.changedFiles),
    tests: input.tests ?? null,
    exitStatus: input.exitStatus,
    notes: input.notes,
  });
}

export function claudeHandoff(input: ClaudeScopeInput & { taskId: string }): TaskMessageResult {
  return handoffTask(taskScope(input), { taskId: input.taskId });
}

export function finishClaudeTask(input: ClaudeScopeInput & { taskId: string }): TaskDoneResult {
  return finishTask(taskScope(input), { taskId: input.taskId });
}

export function readClaudeTaskStatus(input: ClaudeScopeInput): TaskStatusResult {
  return readTaskStatus(taskScope(input));
}

export function readClaudeCheckpoint(input: ClaudeScopeInput): TaskCheckpoint | null {
  const workspace = new Workspace(input.workspaceRoot);
  return readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, input.agentSessionId);
}

export interface ClaudeStatus {
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

export function readClaudeStatus(input: { workspaceRoot: string; agentSessionId?: string }): ClaudeStatus {
  const workspace = new Workspace(input.workspaceRoot);
  const connected = readConnectedSession(workspace.id);
  const checkpoint = input.agentSessionId
    ? readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, input.agentSessionId)
    : null;
  const installed = claudeAdapterInstalled(workspace.root);
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

// ---------------------------------------------------------------- hooks

export interface ClaudeHookSpecificOutput {
  hookEventName: "UserPromptSubmit" | "PreToolUse" | "PostToolUse";
  additionalContext?: string;
  permissionDecision?: "deny";
  permissionDecisionReason?: string;
}

export interface ClaudeHookOutput {
  hookSpecificOutput?: ClaudeHookSpecificOutput;
}

function hookOutput(event: ClaudeHookSpecificOutput["hookEventName"], additionalContext: string): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

function taskCommand(
  command: string,
  workspaceRoot: string,
  agentSessionId: string,
  verb: string,
  extra = ""
): string {
  return `${command} task ${verb} -w ${shellCommandArg(workspaceRoot)} --executor ${CLAUDE_EXECUTOR_ID} --agent-session ${shellCommandArg(agentSessionId)}${extra}`;
}

function browserInstruction(chatUrl: string, connectorName: string, message?: string): string {
  const payload = message
    ? ` Send this exact C2C message and wait for the structured reply:\n${message}`
    : "";
  return (
    `${BROWSER_DISCIPLINE} Open ${chatUrl} in that browser and use only the connector named ` +
    `${JSON.stringify(connectorName)}.${payload}`
  );
}

function planGateContext(
  workspace: Workspace,
  agentSessionId: string,
  started: TaskMessageResult,
  command: string
): string {
  return [
    `MANDATORY C2C PLAN GATE. Canonical workspace: ${JSON.stringify(workspace.root)}.`,
    `Task ${started.taskId} is registered (INIT checkpoint saved, waiting for GPT_PLAN). Do not plan or modify files until ChatGPT returns STATE: PLAN and you record it with:`,
    `${taskCommand(command, workspace.root, agentSessionId, "plan")} --task ${started.taskId} --iteration <n> --next-step "<what you will do>" --json`,
    browserInstruction(started.chatUrl, started.connectorName, started.message),
  ].join("\n");
}

function executionGateContext(
  workspace: Workspace,
  agentSessionId: string,
  checkpoint: TaskCheckpoint,
  command: string
): string {
  return [
    `C2C EXECUTION GATE. Task ${checkpoint.taskId} (iteration ${checkpoint.iteration}) has ChatGPT's PLAN; implementation is allowed.`,
    `After tests, record the evidence and build the review message with:`,
    `${taskCommand(command, workspace.root, agentSessionId, "executed")} --task ${checkpoint.taskId} --iteration ${checkpoint.iteration} --changed-files "<files or count>" --tests "<summary>" --exit-status <ok|failed|blocked> --json`,
    "Send the returned EXECUTED message to ChatGPT through the built-in browser, then wait for PLAN, DONE or BLOCKED.",
  ].join("\n");
}

function resumeGateContext(
  workspace: Workspace,
  agentSessionId: string,
  checkpoint: TaskCheckpoint,
  command: string
): string {
  const connected = readConnectedSession(workspace.id);
  const target = connected
    ? browserInstruction(connected.chatUrl, connected.connectorName)
    : "The saved ChatGPT chat is missing; repair the workspace connection first (c2c doctor).";
  return [
    `MANDATORY C2C RESUME GATE. Task ${checkpoint.taskId} is ${checkpoint.protocolState} (waiting for ${checkpoint.waitingFor}); do not start another task and do not implement before ChatGPT's response.`,
    `Check the state with: ${taskCommand(command, workspace.root, agentSessionId, "status")} --json`,
    target,
  ].join("\n");
}

function setupGateContext(workspace: Workspace, command: string): string {
  return [
    `MANDATORY C2C SETUP GATE. Canonical workspace ${JSON.stringify(workspace.root)} has no verified ChatGPT chat/connector yet, so no C2C task was started.`,
    `Prepare it with: ${command} setup -w ${shellCommandArg(workspace.root)} --json, then save the verified chat with ${command} session set, then retry this prompt.`,
    "Ask the user only for ChatGPT login, CAPTCHA, 2FA or explicit consent.",
  ].join("\n");
}

function recoveryGateContext(workspace: Workspace, detail: string, command: string): string {
  return [
    `MANDATORY C2C RECOVERY GATE. C2C could not start for canonical workspace ${JSON.stringify(workspace.root)} (${detail}).`,
    `Run ${command} doctor -w ${shellCommandArg(workspace.root)} --json, then retry. Do not create another connector.`,
  ].join("\n");
}

export interface ClaudePromptHookInput {
  workspaceRoot: string;
  prompt: string;
  command: string;
  agentSessionId?: string;
}

export function claudePromptHook(input: ClaudePromptHookInput): ClaudeHookOutput {
  if (isClaudeInternalNotification(input.prompt)) return {};
  const agentSessionId = input.agentSessionId?.trim();
  if (!agentSessionId) return {};

  let workspace: Workspace;
  try {
    workspace = new Workspace(input.workspaceRoot);
  } catch {
    return {};
  }

  const checkpoint = readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, agentSessionId);
  if (checkpoint) {
    if (checkpoint.protocolState === "PLAN_RECEIVED" || checkpoint.protocolState === "EXECUTING") {
      return hookOutput("UserPromptSubmit", executionGateContext(workspace, agentSessionId, checkpoint, input.command));
    }
    if (checkpoint.protocolState === "DONE" || checkpoint.protocolState === "BLOCKED") return {};
    return hookOutput(
      "UserPromptSubmit",
      resumeGateContext(workspace, agentSessionId, checkpoint, input.command)
    );
  }

  if (!isClaudeC2CTask(input.prompt)) return {};
  try {
    const started = startTask(
      { workspace, executor: CLAUDE_EXECUTOR_ID, agentSession: agentSessionId },
      { goal: input.prompt }
    );
    return hookOutput("UserPromptSubmit", planGateContext(workspace, agentSessionId, started, input.command));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return hookOutput(
      "UserPromptSubmit",
      /no verified ChatGPT/i.test(detail)
        ? setupGateContext(workspace, input.command)
        : recoveryGateContext(workspace, detail, input.command)
    );
  }
}

const C2C_COMMAND_PATTERN =
  /(?:^|\s)(?:c2c|node\s+[^\n]*c2c\.js["']?)\s+(?:task|claude|doctor|session|setup|tunnel|pair|prefs|sandbox-allow)\b/;

const READ_ONLY_COMMAND_PATTERN =
  /^(?:pwd|ls\b|find\b|rg\b|grep\b|sed\s+-n\b|head\b|tail\b|wc\b|which\b|command\s+-v\b|git\s+(?:status|diff|log|show|branch)\b)/i;

function isReadOnlyShellCommand(command: string): boolean {
  const pieces = command.split(/\n|&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  return pieces.length > 0 && pieces.every((part) => READ_ONLY_COMMAND_PATTERN.test(part));
}

export interface ClaudeGuardHookInput {
  workspaceRoot: string;
  toolName: string;
  toolInput: JsonObject;
  agentSessionId?: string;
}

export function claudeGuardHook(input: ClaudeGuardHookInput): ClaudeHookOutput {
  const agentSessionId = input.agentSessionId?.trim();
  if (!agentSessionId) return {};

  let workspace: Workspace;
  try {
    workspace = new Workspace(input.workspaceRoot);
  } catch {
    return {};
  }

  const checkpoint = readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, agentSessionId);
  if (!checkpoint) return {};
  if (["PLAN_RECEIVED", "EXECUTING", "DONE", "BLOCKED"].includes(checkpoint.protocolState)) return {};

  if (input.toolName === "Bash") {
    const command = String(input.toolInput.command ?? "");
    if (C2C_COMMAND_PATTERN.test(command) || isReadOnlyShellCommand(command)) return {};
  }

  const waitingForReview = checkpoint.protocolState === "EXECUTED_SENT";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: waitingForReview
        ? `C2C gate: task ${checkpoint.taskId} is ${checkpoint.protocolState}; waiting for ChatGPT's review response (PLAN, DONE, or BLOCKED). Use the built-in browser to obtain and record it before further implementation.`
        : `C2C gate: task ${checkpoint.taskId} is ${checkpoint.protocolState}; waiting for ChatGPT's PLAN. Send the INIT message and record the PLAN before implementation.`,
    },
  };
}

export interface ClaudePostHookInput {
  workspaceRoot: string;
  agentSessionId?: string;
}

export function claudePostHook(input: ClaudePostHookInput): ClaudeHookOutput {
  const agentSessionId = input.agentSessionId?.trim();
  if (!agentSessionId) return {};

  let workspace: Workspace;
  try {
    workspace = new Workspace(input.workspaceRoot);
  } catch {
    return {};
  }

  const checkpoint = readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, agentSessionId);
  if (!checkpoint) return {};

  if (checkpoint.protocolState === "PLAN_RECEIVED" || checkpoint.protocolState === "EXECUTING") {
    return hookOutput(
      "PostToolUse",
      `C2C EXECUTION GATE. Task ${checkpoint.taskId} (iteration ${checkpoint.iteration}): after tests pass, record and build the review message with ${taskCommand("c2c", workspace.root, agentSessionId, "executed")} --task ${checkpoint.taskId} --iteration ${checkpoint.iteration} --changed-files "<files or count>" --tests "<summary>" --exit-status <ok|failed|blocked> --json, then send it to ChatGPT.`
    );
  }

  if (checkpoint.protocolState === "EXECUTED_SENT") {
    const connected = readConnectedSession(workspace.id);
    const target = connected
      ? browserInstruction(connected.chatUrl, connected.connectorName)
      : "The saved ChatGPT chat is missing; run the `task handoff` command and send the returned message in the replacement chat.";
    return hookOutput(
      "PostToolUse",
      `MANDATORY C2C REVIEW GATE. Task ${checkpoint.taskId} (iteration ${checkpoint.iteration}) is recorded locally; send the EXECUTED message returned by the \`task executed\` command (or run \`${taskCommand("c2c", workspace.root, agentSessionId, "handoff")} --task ${checkpoint.taskId} --json\` and send that) and wait for ChatGPT's PLAN, DONE or BLOCKED. ${target}`
    );
  }

  return {};
}
