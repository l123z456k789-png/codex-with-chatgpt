import { readMachinePrefs, type MachinePrefs } from "../config/prefs.js";
import {
  readRotationState,
  recordAbnormalSignals,
  recordRoundtrip,
  recordTaskStarted,
  rotationRecommendation,
} from "../conversation/rotation.js";
import { readExecutionRecords, type ExecutionRecord } from "../execution/records.js";
import {
  normalizeAgentSessionId,
  normalizeExecutorId,
  readAgentSessionCheckpoint,
  saveAgentSessionCheckpoint,
} from "../session/agent-session.js";
import { readConnectedSession } from "../session/connected.js";
import type { TaskCheckpoint } from "../session/state.js";
import type { ChatGptTransport, DeliverInput, DeliverOutcome, SendOutcome } from "../transport/chatgpt-transport.js";
import { isTransportError, type TransportError } from "../transport/errors.js";
import type { AbnormalSignalKind, ParsedReply } from "../transport/reply.js";
import {
  markExecuted,
  markPlan,
  startTask,
  type MarkExecutedInput,
  type StartTaskInput,
  type TaskMessageResult,
  type TaskScope,
  type TaskStateResult,
} from "./lifecycle.js";
import { buildExecutedMessage, buildInitMessage } from "./messages.js";
import {
  evaluateReviewReply,
  resolveReviewIterations,
  type ReviewEvaluation,
  type ReviewIterations,
} from "./review-policy.js";

/** Transport info for one successful exchange; absent in manual mode. */
export interface TransportExchange {
  ok: true;
  chatUrl: string;
  reply?: ParsedReply;
  replyText?: string;
  signals: AbnormalSignalKind[];
  reusedConfirmation: boolean;
  /** R3 `wait: false`: the message is confirmed but the reply is still pending. */
  awaitingReply?: boolean;
}

/** Transport failure that must not fail the core: the caller keeps the manual fallback. */
export interface TransportFailure {
  ok: false;
  code: string;
  detail?: string;
  manualFallback: string;
}

export interface RoundtripDeps {
  transport?: ChatGptTransport | null;
  prefs?: MachinePrefs;
  /** Default true; false is the `--no-wait` send-only path. */
  wait?: boolean;
  /** Reply timeout in ms; defaults to `prefs.replyTimeoutSeconds * 1000`. */
  timeoutMs?: number;
  /** Raw `--review-iterations` flag value. */
  reviewIterations?: string | null;
}

export interface StartTransportInput extends StartTaskInput {
  /** `--new-chat`: bootstrap a fresh conversation even without a rotation hint. */
  newChat?: boolean;
}

export interface RoundtripOutcome extends TaskStateResult {
  chatUrl: string | null;
  connectorName: string | null;
  message?: string;
  transport?: TransportExchange | TransportFailure;
  decision?: ReviewEvaluation;
  choices?: string[];
  rotation?: { recommended: boolean; reason: string | null };
}

export type StartOutcome = RoundtripOutcome;
export type ExecutedOutcome = RoundtripOutcome;
export type ResumeOutcome = RoundtripOutcome;

/** Hard failures never fall back to manual: the executor must not act on them. */
const THROWN_TRANSPORT_CODES: readonly string[] = ["PROTOCOL_IDENTITY_MISMATCH", "CHATGPT_RESPONSE_UNPARSEABLE"];

function resolvedPrefs(deps: RoundtripDeps): MachinePrefs {
  return deps.prefs ?? readMachinePrefs();
}

function replyTimeoutMs(deps: RoundtripDeps): number {
  return deps.timeoutMs ?? resolvedPrefs(deps).replyTimeoutSeconds * 1000;
}

function reviewFlag(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function connectedInfo(workspaceId: string): { chatUrl: string | null; connectorName: string | null } {
  const connected = readConnectedSession(workspaceId);
  return { chatUrl: connected?.chatUrl ?? null, connectorName: connected?.connectorName ?? null };
}

/** R4: rotation's conversation wins; fall back to the connected session. */
function deliveryChatUrl(workspaceId: string): string | null {
  return readRotationState(workspaceId).chatUrl ?? readConnectedSession(workspaceId)?.chatUrl ?? null;
}

function stateForCheckpoint(scope: TaskScope, checkpoint: TaskCheckpoint): TaskStateResult {
  return {
    ok: true,
    workspaceRoot: scope.workspace.root,
    workspaceName: scope.workspace.name,
    executor: normalizeExecutorId(scope.executor),
    agentSession: normalizeAgentSessionId(scope.agentSession),
    taskId: checkpoint.taskId,
    iteration: checkpoint.iteration,
    protocolState: checkpoint.protocolState,
    waitingFor: checkpoint.waitingFor,
    checkpoint,
  };
}

function persistReviewLimit(
  scope: TaskScope,
  taskId: string,
  flagValue: string | null,
  prefs: MachinePrefs,
  current: TaskCheckpoint
): TaskCheckpoint {
  if (flagValue === null) return current;
  const limit = resolveReviewIterations(prefs.defaultReviewIterations, flagValue);
  return saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
    taskId,
    checkpoint: { reviewIterations: limit },
  });
}

function exchangeFromDeliver(outcome: DeliverOutcome): TransportExchange {
  return {
    ok: true,
    chatUrl: outcome.chatUrl,
    reply: outcome.reply,
    replyText: outcome.replyText,
    signals: outcome.signals,
    reusedConfirmation: outcome.reusedConfirmation,
  };
}

function exchangeFromSend(outcome: SendOutcome): TransportExchange {
  return {
    ok: true,
    chatUrl: outcome.chatUrl,
    signals: [],
    reusedConfirmation: outcome.reusedConfirmation,
    awaitingReply: true,
  };
}

function failureFrom(error: TransportError, manualFallback: string): TransportFailure {
  return {
    ok: false,
    code: error.code,
    detail: error.detail ?? error.message,
    manualFallback,
  };
}

function isHardTransportFailure(error: unknown): boolean {
  return isTransportError(error) && THROWN_TRANSPORT_CODES.includes(error.code);
}

/** Rotation counters for one successful delivery (chatUrl-bearing record first). */
function countRoundtrip(workspaceId: string, chatUrl: string, signals: number): void {
  recordRoundtrip(workspaceId, chatUrl);
  if (signals > 0) recordAbnormalSignals(workspaceId, signals);
}

/** Exact `c2c task resume` command shared by the limit choices and CLI hints. */
export function buildResumeCommand(executor: string, agentSession: string): string {
  return `c2c task resume --executor ${executor} --agent-session ${agentSession} --transport chrome`;
}

function reviewChoices(executor: string, agentSession: string, limit: number): string[] {
  const base = buildResumeCommand(executor, agentSession);
  return [
    `Continue 1 iteration: ${base} --review-iterations ${limit + 1}`,
    `Continue 3 iterations: ${base} --review-iterations ${limit + 3}`,
    `Continue until done: ${base} --review-iterations until_done`,
    "Stop: no command needed; the task stays paused (checkpoint kept).",
  ];
}

function reviewStateOf(reply: ParsedReply): "PLAN" | "DONE" | "BLOCKED" | "ERROR" {
  if (reply.state === "PLAN" || reply.state === "DONE" || reply.state === "BLOCKED") return reply.state;
  return "ERROR";
}

/** The no-progress fuse is per task: other tasks' records must not trip it. */
function taskRecords(workspaceId: string, taskId: string): ExecutionRecord[] {
  return readExecutionRecords(workspaceId, 20).filter((record) => record.taskId === taskId);
}

interface ReviewOutcome {
  state: TaskStateResult;
  decision: ReviewEvaluation;
  choices?: string[];
}

function applyReviewOutcome(
  scope: TaskScope,
  delivered: DeliverOutcome,
  current: TaskCheckpoint,
  options: { taskId: string; reviewRound: number; limit: ReviewIterations }
): ReviewOutcome {
  const decision = evaluateReviewReply({
    replyState: reviewStateOf(delivered.reply),
    reviewRound: options.reviewRound,
    limit: options.limit,
    records: taskRecords(scope.workspace.id, options.taskId),
  });

  if (decision.action === "terminal") {
    return { state: stateForCheckpoint(scope, current), decision };
  }

  // A reply without ITERATION is accepted; the PLAN it carries is for the next
  // round (the policy's continuation target), never the round just executed.
  const iteration = delivered.reply.iteration ?? options.reviewRound + 1;
  if (decision.action === "continue") {
    return { state: markPlan(scope, { taskId: options.taskId, iteration }), decision };
  }

  if (decision.action === "limit_reached") {
    // R1: the PLAN is still recorded, then the loop pauses for the user.
    markPlan(scope, { taskId: options.taskId, iteration });
    const checkpoint = saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
      taskId: options.taskId,
      checkpoint: { protocolState: "PLAN_RECEIVED", waitingFor: "USER" },
    });
    const choices = reviewChoices(
      normalizeExecutorId(scope.executor),
      normalizeAgentSessionId(scope.agentSession),
      options.limit as number
    );
    return { state: stateForCheckpoint(scope, checkpoint), decision, choices };
  }

  // R2: the no-progress fuse keeps the EXECUTED_SENT checkpoint and does not record a PLAN.
  const checkpoint = saveAgentSessionCheckpoint(scope.workspace.id, scope.executor, scope.agentSession, {
    taskId: options.taskId,
    checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "USER" },
  });
  return { state: stateForCheckpoint(scope, checkpoint), decision };
}

/** Rebuild the pending [C2C] message from the checkpoint (R5). */
function pendingMessage(scope: TaskScope, checkpoint: TaskCheckpoint): string | undefined {
  const connectorName = readConnectedSession(scope.workspace.id)?.connectorName ?? "";
  if (checkpoint.waitingFor === "GPT_PLAN" || checkpoint.protocolState === "INIT") {
    const goal = checkpoint.originalGoal?.trim();
    if (!goal) return undefined;
    return buildInitMessage({
      taskId: checkpoint.taskId,
      goal,
      connectorName,
      workspaceName: scope.workspace.name,
    });
  }

  const record = readExecutionRecords(scope.workspace.id, 50)
    .filter((candidate) => candidate.taskId === checkpoint.taskId && candidate.iteration === checkpoint.iteration)
    .at(-1);
  if (!record) return undefined;
  return buildExecutedMessage({
    taskId: checkpoint.taskId,
    iteration: record.iteration,
    changedFiles: record.changedFiles,
    tests: record.tests,
    exitStatus: record.exitStatus,
    connectorName,
  });
}

export async function startTaskWithTransport(
  scope: TaskScope,
  input: StartTransportInput,
  deps: RoundtripDeps = {}
): Promise<StartOutcome> {
  const transport = deps.transport ?? null;
  const prefs = resolvedPrefs(deps);
  const flagValue = reviewFlag(deps.reviewIterations);

  if (!transport) {
    const result = startTask(scope, { goal: input.goal, taskId: input.taskId });
    const checkpoint = persistReviewLimit(scope, result.taskId, flagValue, prefs, result.checkpoint);
    return { ...result, checkpoint };
  }

  const workspaceId = scope.workspace.id;
  const recommendation = rotationRecommendation(readRotationState(workspaceId), {
    maxTasksPerConversation: prefs.maxTasksPerConversation,
    maxProtocolRoundtrips: prefs.maxProtocolRoundtrips,
    maxAbnormalSignals: prefs.maxAbnormalSignals,
  });
  const rotation = { recommended: recommendation.recommended, reason: recommendation.reason };
  const forceNewChat = input.newChat === true || recommendation.recommended;

  const started: TaskMessageResult = startTask(scope, { goal: input.goal, taskId: input.taskId });
  const checkpoint = persistReviewLimit(scope, started.taskId, flagValue, prefs, started.checkpoint);
  const delivery: DeliverInput = {
    taskId: started.taskId,
    state: "INIT",
    iteration: 0,
    message: started.message,
    chatUrl: deliveryChatUrl(workspaceId),
    forceNewChat,
    timeoutMs: replyTimeoutMs(deps),
  };

  try {
    if (deps.wait === false) {
      const sent = await transport.send(delivery);
      recordTaskStarted(workspaceId, sent.chatUrl);
      countRoundtrip(workspaceId, sent.chatUrl, 0);
      return {
        ...stateForCheckpoint(scope, checkpoint),
        ...connectedInfo(workspaceId),
        message: started.message,
        rotation,
        transport: exchangeFromSend(sent),
      };
    }

    const delivered = await transport.deliver(delivery);
    recordTaskStarted(workspaceId, delivered.chatUrl);
    countRoundtrip(workspaceId, delivered.chatUrl, delivered.signals.length);

    if (delivered.reply.state === "PLAN") {
      const planned = markPlan(scope, {
        taskId: started.taskId,
        iteration: delivered.reply.iteration ?? checkpoint.iteration + 1,
      });
      return {
        ...planned,
        ...connectedInfo(workspaceId),
        message: started.message,
        rotation,
        transport: exchangeFromDeliver(delivered),
      };
    }

    return {
      ...stateForCheckpoint(scope, checkpoint),
      ...connectedInfo(workspaceId),
      message: started.message,
      rotation,
      transport: exchangeFromDeliver(delivered),
    };
  } catch (error) {
    if (isHardTransportFailure(error)) throw error;
    if (isTransportError(error)) {
      return {
        ...stateForCheckpoint(scope, checkpoint),
        ...connectedInfo(workspaceId),
        message: started.message,
        rotation,
        transport: failureFrom(error, started.message),
      };
    }
    throw error;
  }
}

export async function executedWithTransport(
  scope: TaskScope,
  input: MarkExecutedInput,
  deps: RoundtripDeps = {}
): Promise<ExecutedOutcome> {
  const transport = deps.transport ?? null;
  const prefs = resolvedPrefs(deps);
  const flagValue = reviewFlag(deps.reviewIterations);

  if (!transport) {
    const result = markExecuted(scope, input);
    const checkpoint = persistReviewLimit(scope, result.taskId, flagValue, prefs, result.checkpoint);
    return { ...result, checkpoint };
  }

  const workspaceId = scope.workspace.id;
  const executed: TaskMessageResult = markExecuted(scope, input);
  const checkpoint = persistReviewLimit(scope, executed.taskId, flagValue, prefs, executed.checkpoint);
  const limit = resolveReviewIterations(checkpoint.reviewIterations ?? prefs.defaultReviewIterations, flagValue);
  const delivery: DeliverInput = {
    taskId: executed.taskId,
    state: "EXECUTED",
    iteration: executed.iteration,
    message: executed.message,
    chatUrl: deliveryChatUrl(workspaceId),
    timeoutMs: replyTimeoutMs(deps),
  };
  const base = stateForCheckpoint(scope, checkpoint);

  try {
    if (deps.wait === false) {
      const sent = await transport.send(delivery);
      countRoundtrip(workspaceId, sent.chatUrl, 0);
      return { ...base, ...connectedInfo(workspaceId), message: executed.message, transport: exchangeFromSend(sent) };
    }

    const delivered = await transport.deliver(delivery);
    countRoundtrip(workspaceId, delivered.chatUrl, delivered.signals.length);
    const applied = applyReviewOutcome(scope, delivered, checkpoint, {
      taskId: executed.taskId,
      reviewRound: executed.iteration,
      limit,
    });
    return {
      ...applied.state,
      ...connectedInfo(workspaceId),
      message: executed.message,
      transport: exchangeFromDeliver(delivered),
      decision: applied.decision,
      ...(applied.choices ? { choices: applied.choices } : {}),
    };
  } catch (error) {
    if (isHardTransportFailure(error)) throw error;
    if (isTransportError(error)) {
      return {
        ...base,
        ...connectedInfo(workspaceId),
        message: executed.message,
        transport: failureFrom(error, executed.message),
      };
    }
    throw error;
  }
}

export async function resumeWithTransport(scope: TaskScope, deps: RoundtripDeps = {}): Promise<ResumeOutcome> {
  const transport = deps.transport ?? null;
  const prefs = resolvedPrefs(deps);
  const flagValue = reviewFlag(deps.reviewIterations);
  const workspaceId = scope.workspace.id;

  const executor = normalizeExecutorId(scope.executor);
  const agentSession = normalizeAgentSessionId(scope.agentSession);
  const checkpoint = readAgentSessionCheckpoint(workspaceId, executor, agentSession);
  if (!checkpoint) {
    throw new Error(
      `No active checkpoint for executor "${executor}" session "${agentSession}" in this workspace. Run \`c2c task start\` first.`
    );
  }

  // R1: paused at the review limit — applying the user's choice is transport-independent.
  if (checkpoint.protocolState === "PLAN_RECEIVED" && checkpoint.waitingFor === "USER") {
    const updated = saveAgentSessionCheckpoint(workspaceId, executor, agentSession, {
      taskId: checkpoint.taskId,
      checkpoint: {
        protocolState: "PLAN_RECEIVED",
        waitingFor: "none",
        ...(flagValue !== null
          ? { reviewIterations: resolveReviewIterations(prefs.defaultReviewIterations, flagValue) }
          : {}),
      },
    });
    return { ...stateForCheckpoint(scope, updated), ...connectedInfo(workspaceId) };
  }

  const needsDelivery =
    checkpoint.waitingFor === "GPT_PLAN" ||
    checkpoint.waitingFor === "GPT_REVIEW" ||
    (checkpoint.waitingFor === "USER" && checkpoint.protocolState === "EXECUTED_SENT");

  if (!transport || !needsDelivery) {
    const current = needsDelivery ? persistReviewLimit(scope, checkpoint.taskId, flagValue, prefs, checkpoint) : checkpoint;
    const message = needsDelivery ? pendingMessage(scope, current) : undefined;
    return {
      ...stateForCheckpoint(scope, current),
      ...connectedInfo(workspaceId),
      ...(message !== undefined ? { message } : {}),
    };
  }

  const isInit = checkpoint.waitingFor === "GPT_PLAN";
  const message = pendingMessage(scope, checkpoint);
  if (message === undefined) {
    throw new Error(
      `Cannot rebuild the pending [C2C] message for task ${checkpoint.taskId}: the checkpoint or its execution record is incomplete.`
    );
  }

  const persisted = persistReviewLimit(scope, checkpoint.taskId, flagValue, prefs, checkpoint);
  const limit = resolveReviewIterations(persisted.reviewIterations ?? prefs.defaultReviewIterations, null);
  const delivery: DeliverInput = {
    taskId: checkpoint.taskId,
    state: isInit ? "INIT" : "EXECUTED",
    iteration: checkpoint.iteration,
    message,
    chatUrl: deliveryChatUrl(workspaceId),
    timeoutMs: replyTimeoutMs(deps),
  };
  const base = stateForCheckpoint(scope, persisted);

  try {
    if (deps.wait === false) {
      const sent = await transport.send(delivery);
      countRoundtrip(workspaceId, sent.chatUrl, 0);
      return { ...base, ...connectedInfo(workspaceId), message, transport: exchangeFromSend(sent) };
    }

    const delivered = await transport.deliver(delivery);
    countRoundtrip(workspaceId, delivered.chatUrl, delivered.signals.length);

    if (isInit) {
      if (delivered.reply.state === "PLAN") {
        const planned = markPlan(scope, {
          taskId: checkpoint.taskId,
          iteration: delivered.reply.iteration ?? checkpoint.iteration + 1,
        });
        return {
          ...planned,
          ...connectedInfo(workspaceId),
          message,
          transport: exchangeFromDeliver(delivered),
        };
      }
      return {
        ...base,
        ...connectedInfo(workspaceId),
        message,
        transport: exchangeFromDeliver(delivered),
      };
    }

    const applied = applyReviewOutcome(scope, delivered, persisted, {
      taskId: checkpoint.taskId,
      reviewRound: checkpoint.iteration,
      limit,
    });
    return {
      ...applied.state,
      ...connectedInfo(workspaceId),
      message,
      transport: exchangeFromDeliver(delivered),
      decision: applied.decision,
      ...(applied.choices ? { choices: applied.choices } : {}),
    };
  } catch (error) {
    if (isHardTransportFailure(error)) throw error;
    if (isTransportError(error)) {
      return {
        ...base,
        ...connectedInfo(workspaceId),
        message,
        transport: failureFrom(error, message),
      };
    }
    throw error;
  }
}
