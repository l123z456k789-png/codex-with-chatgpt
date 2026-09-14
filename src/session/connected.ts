import { readSession, resolveConversation } from "./state.js";
import { readLastEndpoint } from "../config/endpoint.js";

/**
 * Agent-neutral connection check: the workspace must have a saved ChatGPT
 * chat plus a connector whose name matches the recorded endpoint.
 */
export interface ConnectedSession {
  chatUrl: string;
  connectorName: string;
}

export function readConnectedSession(workspaceId: string): ConnectedSession | null {
  const saved = readSession(workspaceId);
  const view = resolveConversation(saved);
  if (!saved || !view.chatUrl || !view.connectorName) return null;
  const endpoint = readLastEndpoint(workspaceId);
  if (!endpoint || endpoint.connectorName !== view.connectorName) return null;
  return { chatUrl: view.chatUrl, connectorName: view.connectorName };
}

export function requireConnectedSession(workspaceId: string): ConnectedSession {
  const connected = readConnectedSession(workspaceId);
  if (!connected) {
    throw new Error(
      "This workspace has no verified ChatGPT chat/connector yet. Run `c2c doctor -w <workspace> --json` and save the chat with `c2c session set` first."
    );
  }
  return connected;
}
