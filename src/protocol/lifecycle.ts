import { randomBytes } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import {
  clearAgentSessionCheckpoint,
  normalizeAgentSessionId,
  normalizeExecutorId,
  readAgentSessionCheckpoint,
  saveAgentSessionCheckpoint,
} from "../session/agent-session.js";
import { requireConnectedSession, type ConnectedSession } from "../session/connected.js";
import type { ProtocolState, TaskCheckpoint, WaitingFor } from "../session/state.js";
import { buildExecutedMessage, buildHandoffMessage, buildInitMessage } from "./messages.js";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXECUTION_STATUSES: readonly string[] = ["ok", "failed", "blocked"];

export interface TaskScope {
  workspace: Workspace;
  executor: string;
  agentSession: string;
}

interface NormalizedScope {
  workspace: Workspace;
  executor: string;
  agentSession: string;
}

export interface TaskStateResult {
  ok: true;
  workspaceRoot: string;
  workspaceName: string;
  executor: string;
  agentSession: string;
  taskId: string;
  iteration: number;
  protocolState: ProtocolState;
  waitingFor: WaitingFor;
  checkpoint: TaskCheckpoint;
}

export interface TaskMessageResult extends TaskStateResult {
  chatUrl: string;
  connectorName: string;
  message: string;
}

export interface TaskStatusResult {
  ok: true;
  workspaceRoot: string;
  workspaceName: string;
  executor: string;
  agentSession: string;
  active: boolean;
  checkpoint: TaskCheckpoint | null;
}

export interface TaskDoneResult {
  ok: true;
  workspaceRoot: string;
  workspaceName: string;
  executor: string;
  agentSession: string;
  taskId: string;
  cleared: true;
}

export interface StartTaskInput {
  goal: string;
  taskId?: string;
}

export interface MarkPlanInput {
  taskId: string;
  iteration: number;
  nextStep?: string;
}

export interface ExecutedOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
}

export interface MarkExecutedInput {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests?: string | null;
  exitStatus?: string;
  notes?: string;
  output?: ExecutedOutputInput;
}

export interface HandoffTaskInput {
  taskId: string;
}

export interface FinishTaskInput {
  taskId: string;
}

function normalizeScope(scope: TaskScope): NormalizedScope {
  return {
    workspace: scope.workspace,
    executor: normalizeExecutorId(scope.executor),
    agentSession: normalizeAgentSessionId(scope.agentSession),
  };
}

function newTaskId(): string {
  return `c2c_${randomBytes(3).toString("hex")}`;
}

function normalizeTaskId(value: string): string {
  const normalized = value.trim();
  if (!TASK_ID_PATTERN.test(normalized)) {
    throw new Error("task id must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}");
  }
  return normalized;
}

function parseIteration(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("iteration must be a non-negative integer");
  return value;
}

function requireCheckpoint(scope: NormalizedScope): TaskCheckpoint {
  const checkpoint = readAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession);
  if (!checkpoint) {
    throw new Error(
      `No active checkpoint for executor "${scope.executor}" session "${scope.agentSession}" in this workspace. Run \`c2c task start\` first.`
    );
  }
  return checkpoint;
}

function assertTaskId(checkpoint: TaskCheckpoint, taskId: string): void {
  if (checkpoint.taskId !== taskId) {
    throw new Error(`Task ${taskId} does not match the active checkpoint (${checkpoint.taskId}).`);
  }
}

function assertState(checkpoint: TaskCheckpoint, allowed: readonly ProtocolState[], action: string): void {
  if (!allowed.includes(checkpoint.protocolState)) {
    throw new Error(
      `Cannot ${action} for task ${checkpoint.taskId}: state is ${checkpoint.protocolState} (waiting for ${checkpoint.waitingFor}).`
    );
  }
}

function stateResult(scope: NormalizedScope, checkpoint: TaskCheckpoint): TaskStateResult {
  return {
    ok: true,
    workspaceRoot: scope.workspace.root,
    workspaceName: scope.workspace.name,
    executor: scope.executor,
    agentSession: scope.agentSession,
    taskId: checkpoint.taskId,
    iteration: checkpoint.iteration,
    protocolState: checkpoint.protocolState,
    waitingFor: checkpoint.waitingFor,
    checkpoint,
  };
}

function messageResult(
  scope: NormalizedScope,
  connected: ConnectedSession,
  checkpoint: TaskCheckpoint,
  message: string
): TaskMessageResult {
  return {
    ...stateResult(scope, checkpoint),
    chatUrl: connected.chatUrl,
    connectorName: connected.connectorName,
    message,
  };
}

export function startTask(scopeInput: TaskScope, input: StartTaskInput): TaskMessageResult {
  const scope = normalizeScope(scopeInput);
  const connected = requireConnectedSession(scope.workspace.id);
  const active = readAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession);
  if (active) {
    throw new Error(
      `An active checkpoint already exists for this agent session (task ${active.taskId}, state ${active.protocolState}). Resume it or run \`c2c task done\` first.`
    );
  }
  const goal = input.goal.trim();
  if (!goal) throw new Error("goal must not be empty");
  const taskId = input.taskId ? normalizeTaskId(input.taskId) : newTaskId();

  const checkpoint = saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
    taskId,
    iteration: 0,
    lastState: "INIT",
    checkpoint: {
      protocolState: "INIT",
      waitingFor: "GPT_PLAN",
      originalGoal: goal,
      nextExpectedStep: "Wait for ChatGPT PLAN, then execute it.",
    },
  });

  const message = buildInitMessage({
    taskId,
    goal,
    connectorName: connected.connectorName,
    workspaceName: scope.workspace.name,
  });
  return messageResult(scope, connected, checkpoint, message);
}

export function markPlan(scopeInput: TaskScope, input: MarkPlanInput): TaskStateResult {
  const scope = normalizeScope(scopeInput);
  const checkpoint = requireCheckpoint(scope);
  const taskId = normalizeTaskId(input.taskId);
  assertTaskId(checkpoint, taskId);
  assertState(checkpoint, ["INIT", "EXECUTED_SENT"], "record a PLAN");
  const iteration = parseIteration(input.iteration);

  const updated = saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
    taskId,
    iteration,
    lastState: "PLAN",
    checkpoint: {
      protocolState: "PLAN_RECEIVED",
      waitingFor: "none",
      nextExpectedStep: input.nextStep?.trim() || "Execute the accepted PLAN.",
    },
  });
  return stateResult(scope, updated);
}

export function markExecuted(scopeInput: TaskScope, input: MarkExecutedInput): TaskMessageResult {
  const scope = normalizeScope(scopeInput);
  const checkpoint = requireCheckpoint(scope);
  const taskId = normalizeTaskId(input.taskId);
  assertTaskId(checkpoint, taskId);
  assertState(checkpoint, ["PLAN_RECEIVED", "EXECUTING"], "record execution");
  const iteration = parseIteration(input.iteration);
  if (iteration !== checkpoint.iteration) {
    throw new Error(
      `iteration ${iteration} does not match the active checkpoint iteration ${checkpoint.iteration}.`
    );
  }

  const exitStatus = input.exitStatus ?? "ok";
  if (!EXECUTION_STATUSES.includes(exitStatus)) {
    throw new Error("exit-status must be one of ok, failed, blocked");
  }
  if (!Array.isArray(input.changedFiles) && (!Number.isInteger(input.changedFiles) || input.changedFiles < 0)) {
    throw new Error("changed-files must be a list of paths or a non-negative count");
  }

  const connected = requireConnectedSession(scope.workspace.id);

  let outputId: number | undefined;
  let outputAvailable: boolean | undefined;
  if (input.output) {
    const saved = saveExecutionOutput(scope.workspace.id, {
      command: input.output.command,
      raw: input.output.raw,
      exitCode: input.output.exitCode ?? null,
      taskId,
      iteration,
    });
    outputId = saved.id;
    outputAvailable = saved.allowed;
  }

  appendExecutionRecord(scope.workspace.id, {
    taskId,
    iteration,
    changedFiles: input.changedFiles,
    tests: input.tests ?? null,
    exitStatus,
    timestamp: new Date().toISOString(),
    executor: scope.executor,
    notes: input.notes?.slice(0, 400),
    outputId,
    outputAvailable,
  });

  const updated = saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
    taskId,
    iteration,
    lastState: "EXECUTED",
    checkpoint: {
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      knownIssues: exitStatus === "ok" ? undefined : `Execution status: ${exitStatus}`,
      nextExpectedStep: "Wait for ChatGPT review (PLAN, DONE or BLOCKED).",
    },
  });

  const message = buildExecutedMessage({
    taskId,
    iteration,
    changedFiles: input.changedFiles,
    tests: input.tests ?? null,
    exitStatus,
    connectorName: connected.connectorName,
  });
  return messageResult(scope, connected, updated, message);
}

export function handoffTask(scopeInput: TaskScope, input: HandoffTaskInput): TaskMessageResult {
  const scope = normalizeScope(scopeInput);
  const checkpoint = requireCheckpoint(scope);
  const taskId = normalizeTaskId(input.taskId);
  assertTaskId(checkpoint, taskId);
  assertState(
    checkpoint,
    ["INIT", "PLAN_RECEIVED", "EXECUTING", "EXECUTED_LOCAL", "EXECUTED_SENT"],
    "send a HANDOFF"
  );

  const connected = requireConnectedSession(scope.workspace.id);
  const message = buildHandoffMessage({
    taskId: checkpoint.taskId,
    iteration: checkpoint.iteration,
    protocolState: checkpoint.protocolState,
    originalGoal: checkpoint.originalGoal,
    completedSubtasks: checkpoint.completedSubtasks,
    knownIssues: checkpoint.knownIssues,
    nextExpectedStep: checkpoint.nextExpectedStep,
  });
  return messageResult(scope, connected, checkpoint, message);
}

export function finishTask(scopeInput: TaskScope, input: FinishTaskInput): TaskDoneResult {
  const scope = normalizeScope(scopeInput);
  const checkpoint = requireCheckpoint(scope);
  const taskId = normalizeTaskId(input.taskId);
  assertTaskId(checkpoint, taskId);

  clearAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession);
  return {
    ok: true,
    workspaceRoot: scope.workspace.root,
    workspaceName: scope.workspace.name,
    executor: scope.executor,
    agentSession: scope.agentSession,
    taskId: checkpoint.taskId,
    cleared: true,
  };
}

export function readTaskStatus(scopeInput: TaskScope): TaskStatusResult {
  const scope = normalizeScope(scopeInput);
  const checkpoint = readAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession);
  return {
    ok: true,
    workspaceRoot: scope.workspace.root,
    workspaceName: scope.workspace.name,
    executor: scope.executor,
    agentSession: scope.agentSession,
    active: Boolean(checkpoint),
    checkpoint: checkpoint ?? null,
  };
}
