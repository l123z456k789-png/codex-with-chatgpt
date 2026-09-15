import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export interface RotationThresholds {
  maxTasksPerConversation: number;
  maxProtocolRoundtrips: number;
  maxAbnormalSignals: number;
}

export interface RotationState {
  chatUrl: string | null;
  tasks: number;
  roundtrips: number;
  abnormalSignals: number;
  updatedAt: string;
}

/** Conversation counters per workspace, under `<state>/transport/conversations`. */
function stateFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "transport", "conversations"));
  return path.join(dir, `${workspaceId}.json`);
}

function defaultState(): RotationState {
  return {
    chatUrl: null,
    tasks: 0,
    roundtrips: 0,
    abnormalSignals: 0,
    updatedAt: new Date().toISOString(),
  };
}

interface StoredRotationState {
  chatUrl?: unknown;
  tasks?: unknown;
  roundtrips?: unknown;
  abnormalSignals?: unknown;
  updatedAt?: unknown;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readRotationState(workspaceId: string): RotationState {
  const raw = readJsonIfExists<StoredRotationState>(stateFile(workspaceId));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultState();
  return {
    chatUrl: typeof raw.chatUrl === "string" && raw.chatUrl.trim() !== "" ? raw.chatUrl : null,
    tasks: isCounter(raw.tasks) ? raw.tasks : 0,
    roundtrips: isCounter(raw.roundtrips) ? raw.roundtrips : 0,
    abnormalSignals: isCounter(raw.abnormalSignals) ? raw.abnormalSignals : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function persist(workspaceId: string, state: RotationState): RotationState {
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeSecureJson(stateFile(workspaceId), next);
  return next;
}

/** Counters belong to one conversation; a different chat url starts from zero. */
function loadForConversation(workspaceId: string, chatUrl: string): RotationState {
  const state = readRotationState(workspaceId);
  if (state.chatUrl === chatUrl) return state;
  return { ...defaultState(), chatUrl };
}

export function recordTaskStarted(workspaceId: string, chatUrl: string): RotationState {
  const state = loadForConversation(workspaceId, chatUrl);
  return persist(workspaceId, { ...state, tasks: state.tasks + 1 });
}

export function recordRoundtrip(workspaceId: string, chatUrl: string): RotationState {
  const state = loadForConversation(workspaceId, chatUrl);
  return persist(workspaceId, { ...state, roundtrips: state.roundtrips + 1 });
}

export function recordAbnormalSignals(workspaceId: string, count: number): RotationState {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("abnormal-signals must be a non-negative integer");
  }
  const state = readRotationState(workspaceId);
  return persist(workspaceId, { ...state, abnormalSignals: state.abnormalSignals + count });
}

export function resetConversation(workspaceId: string, chatUrl: string): RotationState {
  return persist(workspaceId, { ...defaultState(), chatUrl });
}

export function rotationRecommendation(
  state: RotationState,
  thresholds: RotationThresholds
): { recommended: boolean; reason: string | null } {
  if (state.tasks >= thresholds.maxTasksPerConversation) {
    return { recommended: true, reason: "max_tasks_per_conversation" };
  }
  if (state.roundtrips >= thresholds.maxProtocolRoundtrips) {
    return { recommended: true, reason: "max_protocol_roundtrips" };
  }
  if (state.abnormalSignals >= thresholds.maxAbnormalSignals) {
    return { recommended: true, reason: "max_abnormal_signals" };
  }
  return { recommended: false, reason: null };
}
