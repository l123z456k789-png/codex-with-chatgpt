import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readSession, writeSession } from "../src/session/state.js";
import { readAgentSessionCheckpoint } from "../src/session/agent-session.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { finishTask, handoffTask, markExecuted, markPlan, readTaskStatus, startTask } from "../src/protocol/lifecycle.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const CONNECTOR = "Codex with ChatGPT · test";
const CHAT_URL = "https://chatgpt.com/c/test-chat";

let stateDir: string;
let root: string;
let workspace: Workspace;
let previousStateDir: string | undefined;

function connect(target: Workspace): void {
  writeSession(target.id, {
    url: CHAT_URL,
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

function scope(executor = "opencode", agentSession = "session-1") {
  return { workspace, executor, agentSession };
}

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("task-protocol-ws");
  workspace = new Workspace(root);
  connect(workspace);
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(root);
  cleanup(stateDir);
});

describe("generic task lifecycle", () => {
  it("runs start -> plan -> executed -> handoff -> done", () => {
    const started = startTask(scope(), { goal: "Implement dark mode." });

    expect(started.ok).toBe(true);
    expect(started.taskId).toMatch(/^c2c_[0-9a-f]{6}$/);
    expect(started.iteration).toBe(0);
    expect(started.protocolState).toBe("INIT");
    expect(started.waitingFor).toBe("GPT_PLAN");
    expect(started.chatUrl).toBe(CHAT_URL);
    expect(started.connectorName).toBe(CONNECTOR);
    expect(started.message).toContain("[C2C]\nSTATE: INIT");
    expect(started.message).toContain("GOAL:\nImplement dark mode.");
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")?.protocolState).toBe("INIT");

    const planned = markPlan(scope(), { taskId: started.taskId, iteration: 1 });
    expect(planned.protocolState).toBe("PLAN_RECEIVED");
    expect(planned.waitingFor).toBe("none");
    expect(planned.checkpoint.nextExpectedStep).toBe("Execute the accepted PLAN.");

    const executed = markExecuted(scope(), {
      taskId: started.taskId,
      iteration: 1,
      changedFiles: ["src/a.ts"],
      tests: "42 passed",
      exitStatus: "ok",
      output: { command: "pnpm test", raw: "42 passed", exitCode: 0 },
    });
    expect(executed.protocolState).toBe("EXECUTED_SENT");
    expect(executed.waitingFor).toBe("GPT_REVIEW");
    expect(executed.message).toContain("[C2C]\nSTATE: EXECUTED");
    expect(executed.message).toContain("CHANGED_FILES:\nsrc/a.ts");

    const records = readExecutionRecords(workspace.id);
    expect(records.at(-1)).toMatchObject({
      taskId: started.taskId,
      iteration: 1,
      executor: "opencode",
      exitStatus: "ok",
    });
    expect(typeof records.at(-1)?.outputId).toBe("number");
    expect(listExecutionOutputs(workspace.id).at(-1)).toMatchObject({ command: "pnpm test", exitCode: 0 });

    const handoff = handoffTask(scope(), { taskId: started.taskId });
    expect(handoff.message).toContain("[C2C]\nSTATE: HANDOFF");
    expect(handoff.message).toContain("ORIGINAL_GOAL:\nImplement dark mode.");
    expect(handoff.message).toContain("CURRENT_STATE:\nEXECUTED_SENT");

    const status = readTaskStatus(scope());
    expect(status.active).toBe(true);
    expect(status.checkpoint?.taskId).toBe(started.taskId);

    const done = finishTask(scope(), { taskId: started.taskId });
    expect(done.cleared).toBe(true);
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")).toBeNull();
    expect(readTaskStatus(scope()).active).toBe(false);
  });

  it("isolates checkpoints between agent sessions and executors", () => {
    const one = startTask(scope("opencode", "session-1"), { goal: "goal one" });
    const two = startTask(scope("opencode", "session-2"), { goal: "goal two" });
    const three = startTask(scope("claude-code", "session-1"), { goal: "goal three" });

    expect(new Set([one.taskId, two.taskId, three.taskId]).size).toBe(3);
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")?.originalGoal).toBe("goal one");
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-2")?.originalGoal).toBe("goal two");
    expect(readAgentSessionCheckpoint(workspace.id, "claude-code", "session-1")?.originalGoal).toBe("goal three");
  });

  it("refuses to start a second task while a checkpoint is active", () => {
    startTask(scope(), { goal: "first" });
    expect(() => startTask(scope(), { goal: "second" })).toThrow(/active checkpoint/);
  });

  it("rejects executions that do not match the active checkpoint", () => {
    const started = startTask(scope(), { goal: "goal" });

    expect(() => markExecuted(scope(), { taskId: started.taskId, iteration: 1, changedFiles: 0 })).toThrow(
      /Cannot record execution/
    );

    markPlan(scope(), { taskId: started.taskId, iteration: 1 });

    expect(() =>
      markExecuted(scope(), { taskId: "c2c_other", iteration: 1, changedFiles: 0 })
    ).toThrow(/does not match/);
    expect(() =>
      markExecuted(scope(), { taskId: started.taskId, iteration: 2, changedFiles: 0 })
    ).toThrow(/iteration/);

    markExecuted(scope(), { taskId: started.taskId, iteration: 1, changedFiles: 0 });
    expect(() =>
      markExecuted(scope(), { taskId: started.taskId, iteration: 1, changedFiles: 0 })
    ).toThrow(/Cannot record execution/);
  });

  it("requires a connected ChatGPT session before emitting messages", () => {
    const bare = new Workspace(makeTmpDir("task-protocol-bare"));

    expect(() => startTask({ workspace: bare, executor: "opencode", agentSession: "s1" }, { goal: "goal" })).toThrow(
      /no verified ChatGPT/
    );
  });

  it("validates executor, agent session and goal inputs", () => {
    expect(() => startTask(scope("OpenCode", "s1"), { goal: "goal" })).toThrow(/executor id/);
    expect(() => startTask(scope("opencode", "  "), { goal: "goal" })).toThrow(/agent session id/);
    expect(() => startTask(scope(), { goal: "   " })).toThrow(/goal/);
  });

  it("records non-ok executions with the failure in the checkpoint", () => {
    const started = startTask(scope(), { goal: "goal" });
    markPlan(scope(), { taskId: started.taskId, iteration: 1 });
    markExecuted(scope(), {
      taskId: started.taskId,
      iteration: 1,
      changedFiles: 1,
      tests: "2 failed",
      exitStatus: "failed",
    });

    const checkpoint = readAgentSessionCheckpoint(workspace.id, "opencode", "session-1");
    expect(checkpoint?.knownIssues).toContain("failed");
    expect(readExecutionRecords(workspace.id).at(-1)?.executor).toBe("opencode");
  });

  it("leaves the legacy workspace-level session checkpoint untouched", () => {
    const saved = readSession(workspace.id)!;
    writeSession(workspace.id, {
      ...saved,
      checkpoint: {
        taskId: "c2c_legacy",
        iteration: 2,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: new Date().toISOString(),
      },
    });

    const started = startTask(scope(), { goal: "generic goal" });
    finishTask(scope(), { taskId: started.taskId });

    expect(readSession(workspace.id)?.checkpoint?.taskId).toBe("c2c_legacy");
    expect(readSession(workspace.id)?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });
});
