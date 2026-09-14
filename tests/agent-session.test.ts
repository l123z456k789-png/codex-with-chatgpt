import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { readSession, writeSession } from "../src/session/state.js";
import {
  agentSessionFile,
  clearAgentSessionCheckpoint,
  normalizeAgentSessionId,
  normalizeExecutorId,
  readAgentSessionCheckpoint,
  saveAgentSessionCheckpoint,
} from "../src/session/agent-session.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;
let root: string;
let workspace: Workspace;
let previousStateDir: string | undefined;

function keepCheckpoint(executor: string, agentSession: string, taskId: string, goal: string): void {
  saveAgentSessionCheckpoint(workspace.id, executor, agentSession, {
    taskId,
    iteration: 0,
    lastState: "INIT",
    checkpoint: {
      protocolState: "INIT",
      waitingFor: "GPT_PLAN",
      originalGoal: goal,
    },
  });
}

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("agent-session-ws");
  workspace = new Workspace(root);
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(root);
  cleanup(stateDir);
});

describe("agent session identity", () => {
  it("normalizes valid executor ids and rejects invalid ones", () => {
    expect(normalizeExecutorId(" opencode ")).toBe("opencode");
    expect(normalizeExecutorId("claude-code")).toBe("claude-code");
    expect(normalizeExecutorId("custom.agent_1")).toBe("custom.agent_1");

    for (const invalid of ["", "   ", "OpenCode", "open code", "-lead", "a".repeat(65)]) {
      expect(() => normalizeExecutorId(invalid)).toThrow(/executor id/);
    }
  });

  it("normalizes agent session ids and rejects empty or oversized ones", () => {
    expect(normalizeAgentSessionId(" session-1 ")).toBe("session-1");

    expect(() => normalizeAgentSessionId("")).toThrow(/agent session id/);
    expect(() => normalizeAgentSessionId("   ")).toThrow(/agent session id/);
    expect(() => normalizeAgentSessionId("s".repeat(257))).toThrow(/agent session id/);
  });
});

describe("agent session checkpoint storage", () => {
  it("keeps same-executor and same-session identities isolated", () => {
    keepCheckpoint("opencode", "session-1", "c2c_one", "goal one");
    keepCheckpoint("opencode", "session-2", "c2c_two", "goal two");
    keepCheckpoint("claude-code", "session-1", "c2c_three", "goal three");

    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")?.originalGoal).toBe("goal one");
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-2")?.originalGoal).toBe("goal two");
    expect(readAgentSessionCheckpoint(workspace.id, "claude-code", "session-1")?.originalGoal).toBe("goal three");

    expect(agentSessionFile(workspace.id, "opencode", "session-1")).not.toBe(
      agentSessionFile(workspace.id, "opencode", "session-2")
    );
    expect(agentSessionFile(workspace.id, "opencode", "session-1")).not.toBe(
      agentSessionFile(workspace.id, "claude-code", "session-1")
    );
  });

  it("returns null for missing or tampered checkpoint files", () => {
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "missing")).toBeNull();

    const file = agentSessionFile(workspace.id, "opencode", "session-1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        executor: "someone-else",
        agentSession: "session-1",
        checkpoint: {
          taskId: "c2c_tampered",
          iteration: 0,
          protocolState: "INIT",
          waitingFor: "GPT_PLAN",
          updatedAt: new Date().toISOString(),
        },
        savedAt: new Date().toISOString(),
      })
    );

    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")).toBeNull();
  });

  it("clears only the matching agent-session checkpoint", () => {
    keepCheckpoint("opencode", "session-1", "c2c_one", "goal one");
    keepCheckpoint("opencode", "session-2", "c2c_two", "goal two");

    expect(clearAgentSessionCheckpoint(workspace.id, "opencode", "session-1")).toBe(true);
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-1")).toBeNull();
    expect(readAgentSessionCheckpoint(workspace.id, "opencode", "session-2")?.taskId).toBe("c2c_two");
    expect(clearAgentSessionCheckpoint(workspace.id, "opencode", "session-1")).toBe(false);
  });

  it("leaves the legacy workspace-level session untouched", () => {
    const savedAt = new Date().toISOString();
    writeSession(workspace.id, {
      url: "https://chatgpt.com/c/legacy",
      conversationMode: "long-chat",
      savedAt,
      checkpoint: {
        taskId: "c2c_legacy",
        iteration: 2,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: savedAt,
      },
    });

    keepCheckpoint("opencode", "session-1", "c2c_new", "new goal");
    expect(readSession(workspace.id)?.checkpoint?.taskId).toBe("c2c_legacy");

    clearAgentSessionCheckpoint(workspace.id, "opencode", "session-1");
    expect(readSession(workspace.id)?.checkpoint?.taskId).toBe("c2c_legacy");
    expect(readSession(workspace.id)?.url).toBe("https://chatgpt.com/c/legacy");
  });
});
