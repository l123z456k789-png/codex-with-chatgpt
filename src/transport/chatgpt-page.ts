import { normalizeMessageText } from "./delivery.js";
import { parseMessageIndex, type PageDriver, type PageMessage, type PageSnapshot } from "./driver.js";
import { TransportError } from "./errors.js";
import { CHATGPT_NEW_CHAT_URL, isChatGptUrl } from "./selectors.js";

export { messageIdFor, parseMessageIndex } from "./driver.js";

export const DEFAULT_POLL_MS = 800;
export const DEFAULT_STABILITY_MS = 1_500;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_READY_TIMEOUT_MS = 15_000;

export interface PageFlowOptions {
  pollMs?: number;
  stabilityMs?: number;
  timeoutMs?: number;
  readyTimeoutMs?: number;
  now?: () => number;
}

interface ResolvedTiming {
  pollMs: number;
  stabilityMs: number;
  timeoutMs: number;
  readyTimeoutMs: number;
  now: () => number;
}

function resolveTiming(options: PageFlowOptions): ResolvedTiming {
  return {
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    stabilityMs: options.stabilityMs ?? DEFAULT_STABILITY_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    now: options.now ?? Date.now,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOGIN_MESSAGE =
  "ChatGPT requires a manual login. Complete login, CAPTCHA or 2FA in the C2C Chrome window, then retry.";

function assertReady(snapshot: PageSnapshot): void {
  if (snapshot.loginRequired) {
    throw new TransportError("CHATGPT_LOGIN_REQUIRED", LOGIN_MESSAGE);
  }
  if (!snapshot.composerPresent) {
    throw new TransportError("CHATGPT_UI_CHANGED", "The ChatGPT composer was not found; the page layout may have changed.");
  }
}

export async function readSnapshot(driver: PageDriver): Promise<PageSnapshot> {
  const snapshot = await driver.snapshot();
  assertReady(snapshot);
  return snapshot;
}

/**
 * Bounded readiness poll for a freshly opened page: ChatGPT hydrates the
 * composer after the navigation commits, so a single snapshot can race the
 * app. Resolves with the first ready snapshot, or fails on login / deadline.
 */
export async function waitForPageReady(driver: PageDriver, options: PageFlowOptions = {}): Promise<PageSnapshot> {
  const timing = resolveTiming(options);
  const deadline = timing.now() + timing.readyTimeoutMs;

  for (;;) {
    const snapshot = await driver.snapshot();
    if (snapshot.loginRequired) {
      throw new TransportError("CHATGPT_LOGIN_REQUIRED", LOGIN_MESSAGE);
    }
    if (snapshot.composerPresent) return snapshot;
    if (timing.now() >= deadline) {
      throw new TransportError("CHATGPT_UI_CHANGED", "The ChatGPT composer was not found; the page layout may have changed.");
    }
    await sleep(timing.pollMs);
  }
}

export async function openConversation(driver: PageDriver, url: string, options: PageFlowOptions = {}): Promise<void> {
  if (!isChatGptUrl(url)) {
    throw new TransportError("INVALID_CONVERSATION_URL", `Refusing to open a non-ChatGPT URL: ${url}`);
  }
  await driver.open(url);
  await waitForPageReady(driver, options);
}

export async function startNewConversation(driver: PageDriver, options: PageFlowOptions = {}): Promise<PageSnapshot> {
  await driver.open(CHATGPT_NEW_CHAT_URL);
  return waitForPageReady(driver, options);
}

function findLastMessageByText(messages: PageMessage[], role: PageMessage["role"], text: string): PageMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === role && normalizeMessageText(message.text) === text) return message;
  }
  return null;
}

export async function sendMessage(driver: PageDriver, text: string, options: PageFlowOptions = {}): Promise<string> {
  const timing = resolveTiming(options);
  const expected = normalizeMessageText(text);

  const before = await readSnapshot(driver);
  const knownUserMessageIds = new Set(
    before.messages.filter((message) => message.role === "user").map((message) => message.id)
  );

  await driver.focusComposer();
  await driver.clearComposer();
  await driver.typeText(text);

  const typed = normalizeMessageText(await driver.readComposerText());
  if (typed !== expected) {
    throw new TransportError(
      "CHATGPT_COMPOSER_VERIFY_FAILED",
      `The composer did not hold the typed message (expected ${JSON.stringify(expected)}, found ${JSON.stringify(typed)}).`
    );
  }

  await driver.clickSend();

  const deadline = timing.now() + timing.timeoutMs;
  for (;;) {
    const snapshot = await driver.snapshot();
    const composerEmpty = normalizeMessageText(snapshot.composerText) === "";
    const userMessage = findLastMessageByText(snapshot.messages, "user", expected);
    if (composerEmpty && userMessage && !knownUserMessageIds.has(userMessage.id)) return userMessage.id;
    if (timing.now() >= deadline) {
      throw new TransportError(
        "CHATGPT_SEND_UNCONFIRMED",
        "The message was typed and sent, but no matching user message appeared. Do not resend; inspect the conversation and retry later."
      );
    }
    await sleep(timing.pollMs);
  }
}

function findReplyAfter(messages: PageMessage[], afterIndex: number): PageMessage | null {
  let found: PageMessage | null = null;
  for (const message of messages) {
    const index = parseMessageIndex(message.id);
    if (index === null || index <= afterIndex) continue;
    if (message.role !== "assistant") continue;
    if (normalizeMessageText(message.text) === "") continue;
    found = message;
  }
  return found;
}

export interface ReplyMessage {
  id: string;
  text: string;
}

export async function waitForReplyMessage(driver: PageDriver, afterMessageId: string, options: PageFlowOptions = {}): Promise<ReplyMessage> {
  const timing = resolveTiming(options);
  const afterIndex = parseMessageIndex(afterMessageId);
  if (afterIndex === null) {
    throw new TransportError("CHATGPT_UI_CHANGED", `Cannot resolve the message to wait after: ${afterMessageId}`);
  }

  const deadline = timing.now() + timing.timeoutMs;
  let candidateId: string | null = null;
  let candidateText = "";
  let candidateSince = 0;

  for (;;) {
    const snapshot = await driver.snapshot();
    const reply = findReplyAfter(snapshot.messages, afterIndex);
    if (reply && !snapshot.generating) {
      if (candidateId === reply.id && candidateText === reply.text) {
        if (timing.now() - candidateSince >= timing.stabilityMs) return { id: reply.id, text: reply.text };
      } else {
        candidateId = reply.id;
        candidateText = reply.text;
        candidateSince = timing.now();
      }
    } else {
      candidateId = null;
      candidateText = "";
      candidateSince = 0;
    }

    if (timing.now() >= deadline) {
      throw new TransportError("CHATGPT_RESPONSE_TIMEOUT", `No stable ChatGPT reply arrived within ${timing.timeoutMs} ms.`);
    }
    await sleep(timing.pollMs);
  }
}

export async function waitForReply(driver: PageDriver, afterMessageId: string, options: PageFlowOptions = {}): Promise<string> {
  return (await waitForReplyMessage(driver, afterMessageId, options)).text;
}
