import { describe, expect, it } from "vitest";
import { buildBootstrapMessage, buildExecutedMessage, buildHandoffMessage, buildInitMessage } from "../src/protocol/messages.js";

const CONNECTOR = "Codex with ChatGPT · demo";

describe("buildInitMessage", () => {
  it("renders the documented INIT format", () => {
    const message = buildInitMessage({
      taskId: "c2c_ab12cd",
      goal: "Implement dark mode.",
      connectorName: CONNECTOR,
      workspaceName: "demo",
    });

    expect(message).toBe(
      [
        "[C2C]",
        "STATE: INIT",
        "TASK_ID: c2c_ab12cd",
        "ITERATION: 0",
        "",
        "GOAL:",
        "Implement dark mode.",
        "",
        "INSTRUCTION:",
        `Use only the connector named "${CONNECTOR}". Confirm workspace_info returns "demo", inspect the workspace through MCP, and produce a C2C PLAN message for this goal.`,
      ].join("\n")
    );
  });

  it("collapses whitespace and caps long goals", () => {
    const message = buildInitMessage({
      taskId: "c2c_ab12cd",
      goal: `Line one\n\nLine   two ${"x".repeat(2000)}`,
      connectorName: CONNECTOR,
      workspaceName: "demo",
    });

    const goalLine = message.split("\n")[6];
    expect(goalLine.startsWith("Line one Line two x")).toBe(true);
    expect(goalLine.endsWith("…")).toBe(true);
    expect(goalLine.length).toBe(1500);
  });
});

describe("buildBootstrapMessage", () => {
  it("renders the documented bootstrap format", () => {
    const message = buildBootstrapMessage({ connectorName: CONNECTOR, workspaceName: "demo" });

    expect(message).toBe(
      [
        "[C2C]",
        "STATE: BOOTSTRAP",
        "",
        "INSTRUCTION:",
        `Use only the connector named "${CONNECTOR}". Confirm workspace_info returns "demo" exactly. Then reply with the protocol marker from this message plus the exact line "WORKSPACE: demo" and "WORKSPACE_OK".`,
      ].join("\n")
    );
    expect(message.match(/\[C2C\]/g)).toHaveLength(1);
  });
});

describe("buildExecutedMessage", () => {
  it("renders the documented EXECUTED format", () => {
    const message = buildExecutedMessage({
      taskId: "c2c_ab12cd",
      iteration: 2,
      changedFiles: ["src/a.ts", "src/b.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      connectorName: CONNECTOR,
    });

    expect(message).toBe(
      [
        "[C2C]",
        "STATE: EXECUTED",
        "TASK_ID: c2c_ab12cd",
        "ITERATION: 2",
        "",
        "RESULT:",
        "Execution finished.",
        "",
        "CHANGED_FILES:",
        "src/a.ts, src/b.ts",
        "",
        "TESTS:",
        "27 passed",
        "",
        `Use only the connector named "${CONNECTOR}". Independently inspect the current git diff and workspace through MCP. If execution_output lists a readable item for this iteration, list then read it; if status is restricted, review from git_diff.`,
      ].join("\n")
    );
  });

  it("accepts a changed-files count and reports missing tests", () => {
    const message = buildExecutedMessage({
      taskId: "c2c_ab12cd",
      iteration: 1,
      changedFiles: 3,
      tests: null,
      exitStatus: "ok",
      connectorName: CONNECTOR,
    });

    expect(message).toContain("CHANGED_FILES:\n3\n");
    expect(message).toContain("TESTS:\nnot run\n");
  });

  it("marks non-ok executions in RESULT", () => {
    const failed = buildExecutedMessage({
      taskId: "t",
      iteration: 1,
      changedFiles: 0,
      tests: "1 failed",
      exitStatus: "failed",
      connectorName: CONNECTOR,
    });
    const blocked = buildExecutedMessage({
      taskId: "t",
      iteration: 1,
      changedFiles: 0,
      tests: "not run",
      exitStatus: "blocked",
      connectorName: CONNECTOR,
    });

    expect(failed).toContain("RESULT:\nExecution failed.");
    expect(blocked).toContain("RESULT:\nExecution blocked.");
  });
});

describe("buildHandoffMessage", () => {
  it("renders checkpoint fields in the documented HANDOFF format", () => {
    const message = buildHandoffMessage({
      taskId: "c2c_f81a",
      iteration: 4,
      protocolState: "EXECUTED_SENT",
      originalGoal: "Implement dark mode with a persisted user preference.",
      completedSubtasks: "Iter 1-2: theme context + toggle. Iter 3: persistence.",
      knownIssues: "Flash-on-load fix needs verification.",
      nextExpectedStep: "Independently review iteration 4 via git_diff.",
    });

    expect(message).toBe(
      [
        "[C2C]",
        "STATE: HANDOFF",
        "TASK_ID: c2c_f81a",
        "ITERATION: 4",
        "",
        "ORIGINAL_GOAL:",
        "Implement dark mode with a persisted user preference.",
        "",
        "PROGRESS:",
        "Iter 1-2: theme context + toggle. Iter 3: persistence.",
        "",
        "CURRENT_STATE:",
        "EXECUTED_SENT",
        "",
        "KNOWN_ISSUES:",
        "Flash-on-load fix needs verification.",
        "",
        "NEXT_EXPECTED_STEP:",
        "Independently review iteration 4 via git_diff.",
      ].join("\n")
    );
  });

  it("falls back when checkpoint fields are missing", () => {
    const message = buildHandoffMessage({
      taskId: "c2c_f81a",
      iteration: 4,
      protocolState: "EXECUTED_SENT",
    });

    expect(message).toContain("ORIGINAL_GOAL:\nNot recorded.");
    expect(message).toContain("PROGRESS:\nSee the connected workspace and git diff.");
    expect(message).toContain("KNOWN_ISSUES:\nNone recorded.");
    expect(message).toContain("NEXT_EXPECTED_STEP:\nInspect the workspace and continue the C2C loop.");
  });
});
