export type TransportErrorCode =
  | "CHROME_NOT_FOUND"
  | "CHROME_LAUNCH_FAILED"
  | "CHROME_NOT_RUNNING"
  | "TRANSPORT_UNAVAILABLE"
  | "CHATGPT_LOGIN_REQUIRED"
  | "CHATGPT_UI_CHANGED"
  | "CHATGPT_COMPOSER_VERIFY_FAILED"
  | "CHATGPT_SEND_UNCONFIRMED"
  | "CHATGPT_RESPONSE_TIMEOUT"
  | "CHATGPT_RESPONSE_UNPARSEABLE"
  | "PROTOCOL_IDENTITY_MISMATCH"
  | "WORKSPACE_VERIFICATION_FAILED"
  | "CONNECTOR_NOT_ACTIVE"
  | "INVALID_CONVERSATION_URL"
  | "CONVERSATION_NOT_FOUND";

/**
 * A transport failure. `code` is stable and machine-readable; `detail` may
 * carry the pending [C2C] message so callers can offer the manual fallback.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly detail?: string;

  constructor(code: TransportErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.detail = detail;
  }
}

export function isTransportError(value: unknown): value is TransportError {
  return value instanceof TransportError;
}
