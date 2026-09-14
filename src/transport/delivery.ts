import { createHash } from "node:crypto";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type DeliveryStatus = "prepared" | "sent" | "confirmed" | "responded";

export interface DeliveryRecord {
  key: string;
  taskId: string;
  state: string;
  iteration: number;
  contentHash: string;
  status: DeliveryStatus;
  preparedAt: string;
  sentAt?: string;
  confirmedAt?: string;
  userMessageId?: string;
  conversationUrl?: string;
  responseMessageId?: string;
  responseState?: string;
  respondedAt?: string;
}

interface DeliveryStore {
  records: DeliveryRecord[];
}

const MAX_RECORDS = 50;

/** Collapse whitespace so DOM rendering differences do not break identity. */
export function normalizeMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function contentHash(value: string): string {
  return createHash("sha256").update(normalizeMessageText(value)).digest("hex");
}

export function deliveryKey(taskId: string, state: string, iteration: number): string {
  return `${taskId}:${state.toUpperCase()}:${iteration}`;
}

function storeFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "transport", "deliveries"));
  return path.join(dir, `${workspaceId}.json`);
}

function readStore(workspaceId: string): DeliveryStore {
  const raw = readJsonIfExists<DeliveryStore>(storeFile(workspaceId));
  const records = Array.isArray(raw?.records) ? raw.records.filter(isRecord) : [];
  return { records };
}

function isRecord(value: unknown): value is DeliveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DeliveryRecord>;
  return (
    typeof record.key === "string" &&
    typeof record.taskId === "string" &&
    typeof record.state === "string" &&
    typeof record.iteration === "number" &&
    typeof record.contentHash === "string" &&
    typeof record.status === "string" &&
    typeof record.preparedAt === "string"
  );
}

function writeStore(workspaceId: string, store: DeliveryStore): void {
  const records = store.records.slice(0, MAX_RECORDS);
  writeSecureJson(storeFile(workspaceId), { records });
}

function upsert(workspaceId: string, next: DeliveryRecord): DeliveryRecord {
  const store = readStore(workspaceId);
  const records = store.records.filter((record) => record.key !== next.key);
  records.unshift(next);
  writeStore(workspaceId, { records });
  return next;
}

export function listDeliveries(workspaceId: string): DeliveryRecord[] {
  return readStore(workspaceId).records;
}

export function readDelivery(workspaceId: string, key: string): DeliveryRecord | null {
  return readStore(workspaceId).records.find((record) => record.key === key) ?? null;
}

export interface PrepareDeliveryInput {
  taskId: string;
  state: string;
  iteration: number;
  content: string;
}

export function prepareDelivery(workspaceId: string, input: PrepareDeliveryInput): DeliveryRecord {
  const existing = readDelivery(workspaceId, deliveryKey(input.taskId, input.state, input.iteration));
  return upsert(workspaceId, {
    key: deliveryKey(input.taskId, input.state, input.iteration),
    taskId: input.taskId,
    state: input.state.toUpperCase(),
    iteration: input.iteration,
    contentHash: contentHash(input.content),
    status: existing?.status === "responded" ? "responded" : "prepared",
    preparedAt: existing?.preparedAt ?? new Date().toISOString(),
    sentAt: existing?.sentAt,
    confirmedAt: existing?.confirmedAt,
    userMessageId: existing?.userMessageId,
    conversationUrl: existing?.conversationUrl,
    responseMessageId: existing?.responseMessageId,
    responseState: existing?.responseState,
    respondedAt: existing?.respondedAt,
  });
}

function update(workspaceId: string, key: string, patch: Partial<DeliveryRecord>): DeliveryRecord {
  const store = readStore(workspaceId);
  const index = store.records.findIndex((record) => record.key === key);
  if (index < 0) throw new Error(`No prepared delivery for key ${key}`);
  const next = { ...store.records[index], ...patch };
  store.records[index] = next;
  writeStore(workspaceId, store);
  return next;
}

export function markDeliverySent(workspaceId: string, key: string, at = new Date().toISOString()): DeliveryRecord {
  return update(workspaceId, key, { status: "sent", sentAt: at });
}

export function confirmDelivery(
  workspaceId: string,
  key: string,
  info: { userMessageId: string; conversationUrl?: string },
  at = new Date().toISOString()
): DeliveryRecord {
  return update(workspaceId, key, {
    status: "confirmed",
    confirmedAt: at,
    userMessageId: info.userMessageId,
    conversationUrl: info.conversationUrl,
  });
}

export function recordDeliveryResponse(
  workspaceId: string,
  key: string,
  info: { responseMessageId: string; responseState: string },
  at = new Date().toISOString()
): DeliveryRecord {
  return update(workspaceId, key, {
    status: "responded",
    responseMessageId: info.responseMessageId,
    responseState: info.responseState,
    respondedAt: at,
  });
}

/** Drop delivery history (used when a workspace starts a new conversation). */
export function clearDeliveries(workspaceId: string): void {
  writeStore(workspaceId, { records: [] });
}
