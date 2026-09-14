import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_EXECUTOR_ID,
  CLAUDE_RULE_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILL_PATH,
  claudeAdapterInstalled,
  claudeGuardHook,
  claudeHandoff,
  claudePostHook,
  claudePromptHook,
  finishClaudeTask,
  installClaudeAdapter,
  isClaudeC2CTask,
  isClaudeInternalNotification,
  markClaudeExecuted,
  markClaudePlan,
  readClaudeCheckpoint,
  readClaudeStatus,
  startClaudeTask,
  uninstallClaudeAdapter,
} from "../src/adapters/claude-code.js";
import { readAgentSessionCheckpoint } from "../src/session/agent-session.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { readSession, writeSession } from "../src/session/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { getStateDir } from "../src/config/paths.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

describe("Claude Code adapter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function project(): { root: string; workspace: Workspace } {
    const root = makeTmpDir("claude-adapter");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);
    const workspace = new Workspace(root);
    const connectorName = `Codex with ChatGPT · ${workspace.name}`;
    writeSession(workspace.id, {
      conversationMode: "long-chat",
      url: "https://chatgpt.com/c/verified-chat",
      connectorName,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://c2c-project.example.com",
      mcpUrl: "https://c2c-project.example.com/mcp",
      connectorName,
    });
    return { root, workspace };
  }

  it("installs project-local rules and hooks without touching other Claude files", () => {
    const { root } = project();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "keep me\n");

    const first = installClaudeAdapter(root);
    expect(first.created).toEqual([CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH, CLAUDE_SETTINGS_PATH]);
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(root, CLAUDE_SKILL_PATH), "utf8")).toContain("Claude_Browser");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain("claude prompt-hook");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain("claude guard-hook");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain("claude post-hook");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain("--workspace-root");
    expect(claudeAdapterInstalled(root)).toBe(true);
    expect(installClaudeAdapter(root).unchanged).toEqual([CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH, CLAUDE_SETTINGS_PATH]);
  });

  it("preserves existing Claude settings while installing deterministic hooks", () => {
    const { root } = project();
    const settingsPath = path.join(root, CLAUDE_SETTINGS_PATH);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(pnpm test *)"] }, enabledMcpjsonServers: ["portbay"] })
    );

    installClaudeAdapter(root, 'node "/opt/c2c/bin/c2c.js"');
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(pnpm test *)"]);
    expect(settings.enabledMcpjsonServers).toEqual(["portbay"]);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("claude prompt-hook");
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash|Edit|Write|NotebookEdit");
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Bash");

    installClaudeAdapter(root, 'node "/opt/c2c/bin/c2c.js"');
    const reread = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(reread.hooks.UserPromptSubmit).toHaveLength(1);
    expect(reread.hooks.PreToolUse).toHaveLength(1);
    expect(reread.hooks.PostToolUse).toHaveLength(1);
  });

  it("uninstalls only the managed hooks and files", () => {
    const { root } = project();
    const settingsPath = path.join(root, CLAUDE_SETTINGS_PATH);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Bash(pnpm test *)"] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/existing-context-hook" }] }],
        },
      })
    );

    installClaudeAdapter(root);
    const removed = uninstallClaudeAdapter(root);
    expect(removed.removedFiles).toEqual([CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH]);
    expect(claudeAdapterInstalled(root)).toBe(false);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(pnpm test *)"]);
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "/opt/existing-context-hook" }] },
    ]);
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(settings.hooks.PostToolUse).toBeUndefined();
  });

  it("starts a generic core task from the prompt hook and blocks implementation until PLAN", () => {
    const { root, workspace } = project();
    expect(isClaudeC2CTask("Please design the architecture and implement it")).toBe(true);
    expect(isClaudeC2CTask("yes")).toBe(false);

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Please design the architecture and implement it",
      command: 'node "/opt/c2c/bin/c2c.js"',
      agentSessionId: "chat-a",
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C PLAN GATE");
    expect(context).toContain("STATE: INIT");
    expect(context).toContain('--executor claude-code --agent-session "chat-a"');
    expect(context).toContain("Claude_Browser");
    expect(context).toContain("shift+Enter");
    expect(context).toContain("NEVER click or focus the composer by screen coordinates");

    const taskId = context.match(/c2c_[a-f0-9]+/)?.[0] ?? "";
    expect(taskId).not.toBe("");
    expect(readClaudeCheckpoint({ workspaceRoot: root, agentSessionId: "chat-a" })?.taskId).toBe(taskId);
    expect(readSession(workspace.id)?.checkpoint).toBeUndefined();

    const denied = claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {}, agentSessionId: "chat-a" });
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    const allowedC2C = claudeGuardHook({
      workspaceRoot: root,
      toolName: "Bash",
      toolInput: { command: `node "/opt/c2c/bin/c2c.js" task plan --task ${taskId} --iteration 1` },
      agentSessionId: "chat-a",
    });
    expect(allowedC2C).toEqual({});
    const allowedRead = claudeGuardHook({
      workspaceRoot: root,
      toolName: "Bash",
      toolInput: { command: "git status --short" },
      agentSessionId: "chat-a",
    });
    expect(allowedRead).toEqual({});

    markClaudePlan({ workspaceRoot: root, agentSessionId: "chat-a", taskId, iteration: 1 });
    expect(
      claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {}, agentSessionId: "chat-a" })
    ).toEqual({});
  });

  it("ignores Claude background notifications without creating a task", () => {
    const { root } = project();
    const notification = `<task-notification>
<task-id>bfvg039sk</task-id>
<status>completed</status>
<summary>Background command "Re-run tests after the fix" completed</summary>
</task-notification>`;
    expect(isClaudeInternalNotification(notification)).toBe(true);
    expect(isClaudeC2CTask(notification)).toBe(false);

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: notification,
      command: "c2c",
      agentSessionId: "notification-session",
    });
    expect(hook).toEqual({});
    expect(readClaudeCheckpoint({ workspaceRoot: root, agentSessionId: "notification-session" })).toBeNull();
  });

  it("maps the full lifecycle onto the generic core and records the executor", () => {
    const { root, workspace } = project();
    const init = startClaudeTask({ workspaceRoot: root, agentSessionId: "chat-a", goal: "Implement dark mode" });
    expect(init.message).toContain("STATE: INIT");
    expect(init.message).toContain("GOAL:\nImplement dark mode");

    markClaudePlan({ workspaceRoot: root, agentSessionId: "chat-a", taskId: init.taskId, iteration: 1 });

    const executed = markClaudeExecuted({
      workspaceRoot: root,
      agentSessionId: "chat-a",
      taskId: init.taskId,
      iteration: 1,
      changedFiles: "src/theme.ts,tests/theme.test.ts",
      tests: "12 passed",
      exitStatus: "ok",
    });
    expect(executed.message).toContain("STATE: EXECUTED");
    expect(executed.message).toContain("src/theme.ts, tests/theme.test.ts");
    expect(executed.message).not.toContain("diff --git");

    const records = readExecutionRecords(workspace.id);
    expect(records.at(-1)).toMatchObject({ taskId: init.taskId, iteration: 1, executor: "claude-code" });

    const guard = claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {}, agentSessionId: "chat-a" });
    expect(guard.hookSpecificOutput?.permissionDecisionReason).toContain("review response (PLAN, DONE, or BLOCKED)");

    const review = claudePostHook({ workspaceRoot: root, agentSessionId: "chat-a" });
    const reviewContext = review.hookSpecificOutput?.additionalContext ?? "";
    expect(reviewContext).toContain("MANDATORY C2C REVIEW GATE");
    expect(reviewContext).toContain("Claude_Browser");

    const handoff = claudeHandoff({ workspaceRoot: root, agentSessionId: "chat-a", taskId: init.taskId });
    expect(handoff.message).toContain("STATE: HANDOFF");
    expect(handoff.message).toContain("ORIGINAL_GOAL:\nImplement dark mode");

    finishClaudeTask({ workspaceRoot: root, agentSessionId: "chat-a", taskId: init.taskId });
    expect(readClaudeCheckpoint({ workspaceRoot: root, agentSessionId: "chat-a" })).toBeNull();
    expect(readClaudeStatus({ workspaceRoot: root, agentSessionId: "chat-a" }).active).toBe(false);
  });

  it("isolates concurrent Claude sessions while sharing one connector", () => {
    const { root } = project();
    const first = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement the first feature",
      command: "c2c",
      agentSessionId: "chat-a",
    });
    const second = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement the second feature",
      command: "c2c",
      agentSessionId: "chat-b",
    });
    const firstContext = first.hookSpecificOutput?.additionalContext ?? "";
    const secondContext = second.hookSpecificOutput?.additionalContext ?? "";
    const firstTask = firstContext.match(/c2c_[a-f0-9]+/)?.[0] ?? "";
    const secondTask = secondContext.match(/c2c_[a-f0-9]+/)?.[0] ?? "";

    expect(firstTask).not.toBe("");
    expect(secondTask).not.toBe("");
    expect(firstTask).not.toBe(secondTask);

    markClaudePlan({ workspaceRoot: root, agentSessionId: "chat-a", taskId: firstTask, iteration: 1 });
    expect(
      claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {}, agentSessionId: "chat-a" })
    ).toEqual({});
    expect(
      claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {}, agentSessionId: "chat-b" })
        .hookSpecificOutput?.permissionDecision
    ).toBe("deny");
  });

  it("does not claim a legacy workspace checkpoint for a new Claude session", () => {
    const { root, workspace } = project();
    writeSession(workspace.id, {
      ...readSession(workspace.id)!,
      checkpoint: {
        taskId: "c2c_legacy",
        iteration: 2,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: new Date().toISOString(),
      },
    });

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement a separate new feature",
      command: "c2c",
      agentSessionId: "brand-new-session",
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C PLAN GATE");
    expect(context).not.toContain("c2c_legacy");
    expect(readClaudeCheckpoint({ workspaceRoot: root, agentSessionId: "brand-new-session" })?.taskId).not.toBe("c2c_legacy");
    expect(readSession(workspace.id)?.checkpoint?.taskId).toBe("c2c_legacy");
  });

  it("uses the generic agent-session store only (no Claude-specific storage)", () => {
    const { root, workspace } = project();
    const init = startClaudeTask({ workspaceRoot: root, agentSessionId: "chat-a", goal: "goal" });

    expect(readAgentSessionCheckpoint(workspace.id, CLAUDE_EXECUTOR_ID, "chat-a")?.taskId).toBe(init.taskId);
    expect(fs.existsSync(path.join(getStateDir(), "claude-sessions"))).toBe(false);
    expect(fs.existsSync(path.join(getStateDir(), "agent-sessions", workspace.id))).toBe(true);
  });

  it("gives an unconnected project a setup gate instead of starting a task", () => {
    const root = makeTmpDir("claude-unconnected");
    dirs.push(root);
    makeGitRepo(root);
    dirs.push(isolateStateDir());

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement a production feature",
      command: "c2c",
      agentSessionId: "new-project",
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C SETUP GATE");
    expect(context).toContain("c2c setup");
    expect(readClaudeCheckpoint({ workspaceRoot: root, agentSessionId: "new-project" })).toBeNull();
  });

  it("wires install, hook stdin and uninstall through the CLI", () => {
    const { root } = project();
    const run = (args: string[], input?: string) =>
      spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
        env: process.env,
        input,
      });

    const install = run(["claude", "install", "--workspace", root, "--json"]);
    expect(install.status).toBe(0);
    expect(JSON.parse(install.stdout.trim()).ok).toBe(true);
    expect(claudeAdapterInstalled(root)).toBe(true);

    const hook = run(
      ["claude", "prompt-hook", "--workspace-root", root],
      JSON.stringify({ session_id: "cli-session", prompt: "Implement a CLI feature", cwd: root })
    );
    expect(hook.status).toBe(0);
    const payload = JSON.parse(hook.stdout.trim());
    expect(payload.hookSpecificOutput.additionalContext).toContain("MANDATORY C2C PLAN GATE");

    const status = run(["claude", "status", "--workspace", root, "--agent-session", "cli-session", "--json"]);
    expect(JSON.parse(status.stdout.trim()).installed).toBe(true);

    const uninstall = run(["claude", "uninstall", "--workspace", root, "--json"]);
    expect(uninstall.status).toBe(0);
    expect(claudeAdapterInstalled(root)).toBe(false);
  });
});
