import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { mergeSession, type SavedSession, type SessionPatch, type TaskCheckpoint } from "./state.js";

const EXECUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AGENT_SESSION_MAX_CHARS = 256;

export function normalizeExecutorId(value: string): string {
  const normalized = value.trim();
  if (!EXECUTOR_ID_PATTERN.test(normalized)) {
    throw new Error("executor id must match [a-z0-9][a-z0-9._-]{0,63}");
  }
  return normalized;
}

export function normalizeAgentSessionId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("agent session id must not be empty");
  if (normalized.length > AGENT_SESSION_MAX_CHARS) {
    throw new Error(`agent session id must be at most ${AGENT_SESSION_MAX_CHARS} characters`);
  }
  return normalized;
}

export interface AgentSessionRecord {
  executor: string;
  agentSession: string;
  checkpoint: TaskCheckpoint;
  savedAt: string;
}

/** Collision-resistant storage key: the key includes both identities. */
function storageKey(executor: string, agentSession: string): string {
  return createHash("sha256").update(`${executor}\u0000${agentSession}`).digest("hex").slice(0, 32);
}

export function agentSessionFile(workspaceId: string, executor: string, agentSession: string): string {
  return path.join(getStateDir(), "agent-sessions", workspaceId, `${storageKey(executor, agentSession)}.json`);
}

export function readAgentSessionRecord(
  workspaceId: string,
  executorInput: string,
  agentSessionInput: string
): AgentSessionRecord | null {
  const executor = normalizeExecutorId(executorInput);
  const agentSession = normalizeAgentSessionId(agentSessionInput);
  const value = readJsonIfExists<AgentSessionRecord>(agentSessionFile(workspaceId, executor, agentSession));
  if (!value || value.executor !== executor || value.agentSession !== agentSession || !value.checkpoint) return null;
  return value;
}

export function readAgentSessionCheckpoint(
  workspaceId: string,
  executor: string,
  agentSession: string
): TaskCheckpoint | null {
  return readAgentSessionRecord(workspaceId, executor, agentSession)?.checkpoint ?? null;
}

/** Create or merge the checkpoint for one (executor, agent session) pair. */
export function saveAgentSessionCheckpoint(
  workspaceId: string,
  executorInput: string,
  agentSessionInput: string,
  patch: SessionPatch
): TaskCheckpoint {
  const executor = normalizeExecutorId(executorInput);
  const agentSession = normalizeAgentSessionId(agentSessionInput);
  const previous = readAgentSessionRecord(workspaceId, executor, agentSession);
  const base: SavedSession | null = previous
    ? { checkpoint: previous.checkpoint, savedAt: previous.savedAt }
    : null;
  const merged = mergeSession(base, patch);
  if (!merged.checkpoint) throw new Error("checkpoint was not created");
  const record: AgentSessionRecord = {
    executor,
    agentSession,
    checkpoint: merged.checkpoint,
    savedAt: new Date().toISOString(),
  };
  writeSecureJson(agentSessionFile(workspaceId, executor, agentSession), record);
  return record.checkpoint;
}

export function clearAgentSessionCheckpoint(
  workspaceId: string,
  executorInput: string,
  agentSessionInput: string
): boolean {
  const executor = normalizeExecutorId(executorInput);
  const agentSession = normalizeAgentSessionId(agentSessionInput);
  const file = agentSessionFile(workspaceId, executor, agentSession);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}
