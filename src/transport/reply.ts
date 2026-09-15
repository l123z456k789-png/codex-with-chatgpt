export type ChatGptReplyState = "PLAN" | "DONE" | "BLOCKED" | "ERROR" | "READY";

export const REPLY_STATES: readonly ChatGptReplyState[] = ["PLAN", "DONE", "BLOCKED", "ERROR", "READY"];

export interface ParsedReply {
  state: ChatGptReplyState | null;
  taskId: string | null;
  iteration: number | null;
  hasMarker: boolean;
  text: string;
}

export type AbnormalSignalKind =
  | "missing_marker"
  | "missing_task_id"
  | "missing_iteration"
  | "invalid_iteration"
  | "unparseable";

export interface ReplyValidation {
  ok: true;
  reply: ParsedReply;
  signals: AbnormalSignalKind[];
}

export interface ReplyValidationFailure {
  ok: false;
  code: "PROTOCOL_IDENTITY_MISMATCH" | "CHATGPT_RESPONSE_UNPARSEABLE";
  reason: string;
  reply: ParsedReply;
  signals: AbnormalSignalKind[];
}

const STATE_PATTERN = /^\s*STATE:\s*([A-Za-z_]+)\s*$/m;
const TASK_ID_PATTERN = /^\s*TASK_ID:\s*(\S+)\s*$/m;
const ITERATION_PATTERN = /^\s*ITERATION:\s*(\d+)\s*$/m;

/** Parse a ChatGPT reply. Tolerant about surrounding prose, strict about headers. */
export function parseChatGptReply(raw: string): ParsedReply {
  const text = raw.trim();
  const stateMatch = text.match(STATE_PATTERN);
  const stateValue = stateMatch?.[1]?.toUpperCase() ?? null;
  const state =
    stateValue && (REPLY_STATES as readonly string[]).includes(stateValue)
      ? (stateValue as ChatGptReplyState)
      : null;
  const taskIdMatch = text.match(TASK_ID_PATTERN);
  const iterationMatch = text.match(ITERATION_PATTERN);
  return {
    state,
    taskId: taskIdMatch?.[1] ?? null,
    iteration: iterationMatch ? Number(iterationMatch[1]) : null,
    hasMarker: /\[C2C\]/i.test(text),
    text,
  };
}

export interface ReplyIdentityExpectation {
  taskId: string;
  /** The reply must not point backwards: reply.iteration >= minIteration. */
  minIteration: number;
}

/**
 * Validate identity and shape of a task reply. A wrong TASK_ID or a backwards
 * ITERATION is a hard failure (the executor must not act on it). Missing
 * headers are accepted but recorded as an abnormal signal.
 */
export function validateReplyIdentity(
  reply: ParsedReply,
  expected: ReplyIdentityExpectation
): ReplyValidation | ReplyValidationFailure {
  const signals: AbnormalSignalKind[] = [];
  if (!reply.hasMarker) signals.push("missing_marker");

  if (reply.state === null) {
    return {
      ok: false,
      code: "CHATGPT_RESPONSE_UNPARSEABLE",
      reason: "ChatGPT reply has no recognizable STATE header.",
      reply,
      signals: [...signals, "unparseable"],
    };
  }

  if (reply.taskId === null) {
    signals.push("missing_task_id");
  } else if (reply.taskId !== expected.taskId) {
    return {
      ok: false,
      code: "PROTOCOL_IDENTITY_MISMATCH",
      reason: `ChatGPT replied for task ${reply.taskId}, but the active task is ${expected.taskId}.`,
      reply,
      signals,
    };
  }

  if (reply.iteration === null) {
    signals.push("missing_iteration");
  } else if (reply.iteration < expected.minIteration) {
    return {
      ok: false,
      code: "PROTOCOL_IDENTITY_MISMATCH",
      reason: `ChatGPT replied with iteration ${reply.iteration}, behind the active iteration ${expected.minIteration}.`,
      reply,
      signals: [...signals, "invalid_iteration"],
    };
  }

  return { ok: true, reply, signals };
}

/** Marker the bootstrap verification reply must contain. */
export function parseReadinessWorkspace(text: string): string | null {
  const match = text.match(/^\s*WORKSPACE:\s*(.+?)\s*$/m);
  const workspace = match?.[1]?.trim() ?? "";
  return workspace === "" ? null : workspace;
}
