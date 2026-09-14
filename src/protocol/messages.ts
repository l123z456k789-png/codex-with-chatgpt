export const INIT_GOAL_MAX_CHARS = 1500;
export const RESULT_FIELD_MAX_CHARS = 300;

/** Collapse whitespace and cap a free-text field so control messages stay small. */
function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export interface InitMessageInput {
  taskId: string;
  goal: string;
  connectorName: string;
  workspaceName: string;
}

export function buildInitMessage(input: InitMessageInput): string {
  return [
    "[C2C]",
    "STATE: INIT",
    `TASK_ID: ${input.taskId}`,
    "ITERATION: 0",
    "",
    "GOAL:",
    compact(input.goal, INIT_GOAL_MAX_CHARS),
    "",
    "INSTRUCTION:",
    `Use only the connector named "${input.connectorName}". Confirm workspace_info returns "${input.workspaceName}", inspect the workspace through MCP, and produce a C2C PLAN message for this goal.`,
  ].join("\n");
}

export interface ExecutedMessageInput {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests?: string | null;
  exitStatus?: string;
  connectorName: string;
}

export function buildExecutedMessage(input: ExecutedMessageInput): string {
  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles.length > 0
      ? input.changedFiles.join(", ")
      : "0"
    : String(input.changedFiles);
  const tests = input.tests && input.tests.trim() ? input.tests : "not run";
  const exitStatus = input.exitStatus ?? "ok";
  const result = exitStatus === "ok" ? "Execution finished." : `Execution ${exitStatus}.`;

  return [
    "[C2C]",
    "STATE: EXECUTED",
    `TASK_ID: ${input.taskId}`,
    `ITERATION: ${input.iteration}`,
    "",
    "RESULT:",
    result,
    "",
    "CHANGED_FILES:",
    compact(changedFiles, RESULT_FIELD_MAX_CHARS),
    "",
    "TESTS:",
    compact(tests, RESULT_FIELD_MAX_CHARS),
    "",
    `Use only the connector named "${input.connectorName}". Independently inspect the current git diff and workspace through MCP. If execution_output lists a readable item for this iteration, list then read it; if status is restricted, review from git_diff.`,
  ].join("\n");
}

export interface HandoffMessageInput {
  taskId: string;
  iteration: number;
  protocolState: string;
  originalGoal?: string;
  completedSubtasks?: string;
  knownIssues?: string;
  nextExpectedStep?: string;
}

export function buildHandoffMessage(input: HandoffMessageInput): string {
  const originalGoal = input.originalGoal?.trim() || "Not recorded.";
  const progress = input.completedSubtasks?.trim() || "See the connected workspace and git diff.";
  const knownIssues = input.knownIssues?.trim() || "None recorded.";
  const nextExpectedStep = input.nextExpectedStep?.trim() || "Inspect the workspace and continue the C2C loop.";

  return [
    "[C2C]",
    "STATE: HANDOFF",
    `TASK_ID: ${input.taskId}`,
    `ITERATION: ${input.iteration}`,
    "",
    "ORIGINAL_GOAL:",
    originalGoal,
    "",
    "PROGRESS:",
    progress,
    "",
    "CURRENT_STATE:",
    input.protocolState,
    "",
    "KNOWN_ISSUES:",
    knownIssues,
    "",
    "NEXT_EXPECTED_STEP:",
    nextExpectedStep,
  ].join("\n");
}
