import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { writeSession } from "../src/session/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const CONNECTOR = "Codex with ChatGPT · cli-test";

function runTask(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "task", ...args, "--workspace", root],
    { cwd: projectRoot, encoding: "utf8", env: process.env }
  );
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

function connect(target: Workspace): void {
  writeSession(target.id, {
    url: "https://chatgpt.com/c/cli-test-chat",
    conversationMode: "long-chat",
    connectorName: CONNECTOR,
    savedAt: new Date().toISOString(),
  });
  writeLastEndpoint({
    workspaceId: target.id,
    port: 48765,
    publicUrl: null,
    mcpUrl: null,
    connectorName: CONNECTOR,
  });
}

function withTaskEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("task-cli-workspace");
  const stateDir = makeTmpDir("task-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;

  try {
    const workspace = new Workspace(root);
    connect(workspace);
    run(root, workspace);
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

describe("c2c task", () => {
  it("drives the documented lifecycle over --json", () => {
    withTaskEnvironment((root) => {
      const started = runTask(root, [
        "start",
        "--executor",
        "opencode",
        "--agent-session",
        "cli-1",
        "--goal",
        "Implement dark mode.",
        "--json",
      ]);
      expect(started.status).toBe(0);
      const startJson = lastJson(started.stdout);
      expect(startJson.ok).toBe(true);
      expect(startJson.taskId).toMatch(/^c2c_[0-9a-f]{6}$/);
      expect(startJson.protocolState).toBe("INIT");
      expect(startJson.message).toContain("[C2C]\nSTATE: INIT");
      expect(startJson.connectorName).toBe(CONNECTOR);

      const taskId = startJson.taskId as string;

      const planned = runTask(root, [
        "plan",
        "--executor",
        "opencode",
        "--agent-session",
        "cli-1",
        "--task",
        taskId,
        "--iteration",
        "1",
        "--json",
      ]);
      expect(planned.status).toBe(0);
      expect(lastJson(planned.stdout).protocolState).toBe("PLAN_RECEIVED");

      const executed = runTask(root, [
        "executed",
        "--executor",
        "opencode",
        "--agent-session",
        "cli-1",
        "--task",
        taskId,
        "--iteration",
        "1",
        "--changed-files",
        "2",
        "--tests",
        "176 passed",
        "--json",
      ]);
      expect(executed.status).toBe(0);
      const executedJson = lastJson(executed.stdout);
      expect(executedJson.protocolState).toBe("EXECUTED_SENT");
      expect(executedJson.message).toContain("[C2C]\nSTATE: EXECUTED");

      const done = runTask(root, [
        "done",
        "--executor",
        "opencode",
        "--agent-session",
        "cli-1",
        "--task",
        taskId,
        "--json",
      ]);
      expect(done.status).toBe(0);
      expect(lastJson(done.stdout).cleared).toBe(true);
    });
  });

  it("rejects an invalid executor id", () => {
    withTaskEnvironment((root) => {
      const result = runTask(root, [
        "start",
        "--executor",
        "OpenCode",
        "--agent-session",
        "cli-1",
        "--goal",
        "goal",
        "--json",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("executor id");
    });
  });

  it("returns a stable JSON error when no checkpoint exists", () => {
    withTaskEnvironment((root) => {
      const result = runTask(root, [
        "executed",
        "--executor",
        "opencode",
        "--agent-session",
        "nobody",
        "--task",
        "c2c_missing",
        "--iteration",
        "1",
        "--json",
      ]);

      expect(result.status).toBe(1);
      const json = lastJson(result.stdout);
      expect(json.ok).toBe(false);
      expect(String(json.error)).toMatch(/checkpoint/i);
    });
  });
});
