import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export type TransportMode = "manual" | "chrome";
export type TaskMode = "full" | "review" | "off";
export type SetupMode = "auto" | "manual";

export const TRANSPORT_MODES: readonly TransportMode[] = ["manual", "chrome"];
export const TASK_MODES: readonly TaskMode[] = ["full", "review", "off"];
export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];

export const C2C_TRANSPORT_ENV = "C2C_TRANSPORT";

const DEFAULT_REVIEW_ITERATIONS = 3;
const DEFAULT_MAX_TASKS_PER_CONVERSATION = 10;
const DEFAULT_MAX_PROTOCOL_ROUNDTRIPS = 30;
const DEFAULT_MAX_ABNORMAL_SIGNALS = 3;
const DEFAULT_REPLY_TIMEOUT_SECONDS = 600;

/** Machine-wide preferences shared by the UI prompts, CLI and transport. */
export interface MachinePrefs {
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  transport: TransportMode | null;
  defaultMode: TaskMode;
  defaultReviewIterations: number | "until_done";
  maxTasksPerConversation: number;
  maxProtocolRoundtrips: number;
  maxAbnormalSignals: number;
  replyTimeoutSeconds: number;
}

export interface MachinePrefsPatch {
  developerModeEnabled?: true;
  setupMode?: SetupMode | null;
  transport?: TransportMode;
  defaultMode?: TaskMode;
  defaultReviewIterations?: number | "until_done";
  maxTasksPerConversation?: number;
  maxProtocolRoundtrips?: number;
  maxAbnormalSignals?: number;
  replyTimeoutSeconds?: number;
}

interface StoredPrefs {
  developerModeEnabled?: boolean;
  setupMode?: string;
  transport?: string;
  defaultMode?: string;
  defaultReviewIterations?: number | string;
  maxTasksPerConversation?: number;
  maxProtocolRoundtrips?: number;
  maxAbnormalSignals?: number;
  replyTimeoutSeconds?: number;
  updatedAt?: string;
}

export function prefsFile(): string {
  return path.join(getStateDir(), "prefs.json");
}

function readStored(): StoredPrefs | null {
  const raw = readJsonIfExists<StoredPrefs>(prefsFile());
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

function chooseMode<T extends string>(value: unknown, modes: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (modes as readonly string[]).includes(normalized) ? (normalized as T) : null;
}

function chooseReviewIterations(value: unknown): number | "until_done" | null {
  if (value === "until_done") return "until_done";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return null;
}

function chooseLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

export function readMachinePrefs(): MachinePrefs {
  const stored = readStored();
  return {
    developerModeEnabled: stored?.developerModeEnabled === true,
    setupMode: chooseMode(stored?.setupMode, SETUP_MODES),
    transport: chooseMode(stored?.transport, TRANSPORT_MODES),
    defaultMode: chooseMode(stored?.defaultMode, TASK_MODES) ?? "full",
    defaultReviewIterations: chooseReviewIterations(stored?.defaultReviewIterations) ?? DEFAULT_REVIEW_ITERATIONS,
    maxTasksPerConversation: chooseLimit(stored?.maxTasksPerConversation, DEFAULT_MAX_TASKS_PER_CONVERSATION),
    maxProtocolRoundtrips: chooseLimit(stored?.maxProtocolRoundtrips, DEFAULT_MAX_PROTOCOL_ROUNDTRIPS),
    maxAbnormalSignals: chooseLimit(stored?.maxAbnormalSignals, DEFAULT_MAX_ABNORMAL_SIGNALS),
    replyTimeoutSeconds: chooseLimit(stored?.replyTimeoutSeconds, DEFAULT_REPLY_TIMEOUT_SECONDS),
  };
}

function requireMode<T extends string>(field: string, value: string, modes: readonly T[]): T {
  const mode = chooseMode(value, modes);
  if (!mode) throw new Error(`${field} must be one of ${modes.join(", ")}`);
  return mode;
}

function requirePositiveInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function requireReviewIterations(field: string, value: number | "until_done"): number | "until_done" {
  if (value === "until_done") return value;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer or until_done`);
  }
  return value;
}

export function mergeMachinePrefs(patch: MachinePrefsPatch): MachinePrefs {
  const previous = readStored();
  const stored: StoredPrefs = {
    updatedAt: new Date().toISOString(),
  };
  // Only persist "confirmed on". Never write false — that would skip the
  // Security page on a new ChatGPT account or a machine restore.
  if (patch.developerModeEnabled === true || previous?.developerModeEnabled === true) {
    stored.developerModeEnabled = true;
  }
  if (patch.setupMode !== undefined) {
    if (patch.setupMode !== null) {
      stored.setupMode = requireMode("setup-mode", patch.setupMode, SETUP_MODES);
    }
  } else if (typeof previous?.setupMode === "string") {
    const previousSetupMode = chooseMode(previous.setupMode, SETUP_MODES);
    if (previousSetupMode) stored.setupMode = previousSetupMode;
  }
  if (patch.transport !== undefined) {
    stored.transport = requireMode("transport", patch.transport, TRANSPORT_MODES);
  } else if (typeof previous?.transport === "string") {
    const previousTransport = chooseMode(previous.transport, TRANSPORT_MODES);
    if (previousTransport) stored.transport = previousTransport;
  }
  if (patch.defaultMode !== undefined) {
    stored.defaultMode = requireMode("default-mode", patch.defaultMode, TASK_MODES);
  } else if (typeof previous?.defaultMode === "string") {
    const previousDefaultMode = chooseMode(previous.defaultMode, TASK_MODES);
    if (previousDefaultMode) stored.defaultMode = previousDefaultMode;
  }
  if (patch.defaultReviewIterations !== undefined) {
    stored.defaultReviewIterations = requireReviewIterations(
      "review-iterations",
      patch.defaultReviewIterations
    );
  } else if (
    typeof previous?.defaultReviewIterations === "number" ||
    previous?.defaultReviewIterations === "until_done"
  ) {
    const previousIterations = chooseReviewIterations(previous.defaultReviewIterations);
    if (previousIterations !== null) stored.defaultReviewIterations = previousIterations;
  }
  const numericFields = [
    ["max-tasks-per-conversation", "maxTasksPerConversation"],
    ["max-roundtrips", "maxProtocolRoundtrips"],
    ["max-abnormal-signals", "maxAbnormalSignals"],
    ["reply-timeout", "replyTimeoutSeconds"],
  ] as const;
  for (const [field, key] of numericFields) {
    const value = patch[key];
    if (value !== undefined) {
      stored[key] = requirePositiveInteger(field, value);
    } else {
      const previousValue = previous?.[key];
      if (typeof previousValue === "number" && Number.isSafeInteger(previousValue) && previousValue >= 1) {
        stored[key] = previousValue;
      }
    }
  }
  writeSecureJson(prefsFile(), stored);
  return readMachinePrefs();
}

/**
 * Transport resolution: CLI flag > C2C_TRANSPORT env > prefs > manual.
 * Unknown values throw instead of silently falling back.
 */
export function resolveTransportMode(flag?: string | null): TransportMode {
  const trimmedFlag = flag?.trim() ?? "";
  if (trimmedFlag !== "") return requireMode("transport", trimmedFlag, TRANSPORT_MODES);
  const fromEnv = process.env[C2C_TRANSPORT_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return requireMode(C2C_TRANSPORT_ENV, fromEnv, TRANSPORT_MODES);
  }
  return readMachinePrefs().transport ?? "manual";
}
