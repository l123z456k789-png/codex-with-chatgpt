import { buildBootstrapMessage } from "../protocol/messages.js";
import {
  openConversation,
  readSnapshot,
  sendMessage,
  startNewConversation,
  waitForReplyMessage,
  type PageFlowOptions,
} from "./chatgpt-page.js";
import {
  confirmDelivery,
  contentHash,
  deliveryKey,
  markDeliverySent,
  prepareDelivery,
  recordDeliveryResponse,
} from "./delivery.js";
import type { PageDriver, PageMessage } from "./driver.js";
import { isTransportError, TransportError } from "./errors.js";
import {
  parseChatGptReply,
  parseReadinessWorkspace,
  validateReplyIdentity,
  type AbnormalSignalKind,
  type ParsedReply,
} from "./reply.js";
import { isChatGptConversationUrl } from "./selectors.js";

export interface TransportContext {
  workspaceId: string;
  workspaceName: string;
  connectorName: string;
}

export interface DeliverInput {
  taskId: string;
  state: string;
  iteration: number;
  message: string;
  chatUrl?: string | null;
  forceNewChat?: boolean;
  timeoutMs?: number;
}

export interface SendOutcome {
  chatUrl: string;
  sentMessageId: string;
  reusedConfirmation: boolean;
}

export interface DeliverOutcome extends SendOutcome {
  replyMessageId: string;
  replyText: string;
  reply: ParsedReply;
  signals: AbnormalSignalKind[];
}

export interface ChatGptTransportOptions {
  pollMs?: number;
  stabilityMs?: number;
  now?: () => number;
}

const LOGIN_MESSAGE =
  "ChatGPT requires a manual login. Complete login, CAPTCHA or 2FA in the C2C Chrome window, then retry.";

async function asTransportError<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isTransportError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new TransportError("TRANSPORT_UNAVAILABLE", `${action} failed: ${reason}`);
  }
}

function lastUserMessage(messages: PageMessage[]): PageMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return null;
}

/**
 * Facade over the ChatGPT page flows and the delivery ledger. It owns
 * conversation reuse/bootstrap, idempotent delivery with crash recovery and
 * reply identity validation. T6/T7 compose this class.
 */
export class ChatGptTransport {
  private readonly driver: PageDriver;
  private readonly context: TransportContext;
  private readonly options: ChatGptTransportOptions;

  constructor(driver: PageDriver, context: TransportContext, options: ChatGptTransportOptions = {}) {
    this.driver = driver;
    this.context = context;
    this.options = options;
  }

  private flowOptions(timeoutMs?: number): PageFlowOptions {
    return {
      pollMs: this.options.pollMs,
      stabilityMs: this.options.stabilityMs,
      timeoutMs,
      now: this.options.now,
    };
  }

  /** Reuse the saved conversation or bootstrap a fresh one; returns a chatgpt.com URL. */
  async ensureConversation(input: { chatUrl?: string | null; forceNewChat?: boolean } = {}): Promise<string> {
    const chatUrl = input.chatUrl;
    if (!input.forceNewChat && chatUrl) {
      await asTransportError("Opening the ChatGPT conversation", () => openConversation(this.driver, chatUrl));
      const snapshot = await asTransportError("Reading the conversation", () => readSnapshot(this.driver));
      if (!isChatGptConversationUrl(snapshot.url)) {
        throw new TransportError(
          "CONVERSATION_NOT_FOUND",
          `The saved ChatGPT conversation is no longer available: the page landed on ${JSON.stringify(snapshot.url)}. Start a fresh conversation with --new-chat.`
        );
      }
      return chatUrl;
    }
    return this.bootstrap();
  }

  private async bootstrap(): Promise<string> {
    const message = buildBootstrapMessage({
      connectorName: this.context.connectorName,
      workspaceName: this.context.workspaceName,
    });
    return asTransportError("Bootstrapping the ChatGPT conversation", async () => {
      await startNewConversation(this.driver);
      const sentMessageId = await sendMessage(this.driver, message, this.flowOptions());
      const reply = await waitForReplyMessage(this.driver, sentMessageId, this.flowOptions());

      const workspace = parseReadinessWorkspace(reply.text);
      if (workspace !== this.context.workspaceName) {
        throw new TransportError(
          "WORKSPACE_VERIFICATION_FAILED",
          `The bootstrap reply reported workspace ${JSON.stringify(workspace)}, but this workspace is ${JSON.stringify(this.context.workspaceName)}.`
        );
      }

      const snapshot = await this.driver.snapshot();
      if (snapshot.loginRequired) {
        throw new TransportError("CHATGPT_LOGIN_REQUIRED", LOGIN_MESSAGE);
      }
      if (!isChatGptConversationUrl(snapshot.url)) {
        throw new TransportError(
          "CONVERSATION_NOT_FOUND",
          `The new ChatGPT conversation did not expose a /c/ URL (found ${JSON.stringify(snapshot.url)}).`
        );
      }
      return snapshot.url;
    });
  }

  /**
   * Send one [C2C] message and confirm it, without waiting for a reply. The
   * ledger key is `taskId:STATE:iteration`; the conversation is inspected first
   * so a crash between send and confirm resumes waiting instead of resending an
   * identical message.
   */
  async send(input: DeliverInput): Promise<SendOutcome> {
    const chatUrl = await this.ensureConversation({ chatUrl: input.chatUrl, forceNewChat: input.forceNewChat });
    const key = deliveryKey(input.taskId, input.state, input.iteration);
    const prepared = prepareDelivery(this.context.workspaceId, {
      taskId: input.taskId,
      state: input.state,
      iteration: input.iteration,
      content: input.message,
    });

    const snapshot = await asTransportError("Reading the conversation", () => readSnapshot(this.driver));
    const lastUser = lastUserMessage(snapshot.messages);

    let sentMessageId: string;
    let reusedConfirmation = false;
    if (lastUser && contentHash(lastUser.text) === prepared.contentHash) {
      sentMessageId = lastUser.id;
      reusedConfirmation = true;
      if (prepared.status !== "responded") {
        markDeliverySent(this.context.workspaceId, key);
        confirmDelivery(this.context.workspaceId, key, { userMessageId: sentMessageId, conversationUrl: chatUrl });
      }
    } else {
      sentMessageId = await asTransportError("Sending the [C2C] message", () =>
        sendMessage(this.driver, input.message, this.flowOptions(input.timeoutMs))
      );
      markDeliverySent(this.context.workspaceId, key);
      confirmDelivery(this.context.workspaceId, key, { userMessageId: sentMessageId, conversationUrl: chatUrl });
    }

    return { chatUrl, sentMessageId, reusedConfirmation };
  }

  /** Send one [C2C] message, wait for the reply, then parse and validate it. */
  async deliver(input: DeliverInput): Promise<DeliverOutcome> {
    const sent = await this.send(input);
    const key = deliveryKey(input.taskId, input.state, input.iteration);

    const reply = await asTransportError("Waiting for the ChatGPT reply", () =>
      waitForReplyMessage(this.driver, sent.sentMessageId, this.flowOptions(input.timeoutMs))
    );
    const parsed = parseChatGptReply(reply.text);
    recordDeliveryResponse(this.context.workspaceId, key, {
      responseMessageId: reply.id,
      responseState: parsed.state ?? "UNPARSEABLE",
    });

    const validation = validateReplyIdentity(parsed, { taskId: input.taskId, minIteration: input.iteration });
    if (!validation.ok) {
      throw new TransportError(validation.code, validation.reason);
    }

    return {
      ...sent,
      replyMessageId: reply.id,
      replyText: reply.text,
      reply: validation.reply,
      signals: validation.signals,
    };
  }

  /** Disconnect the driver only; Chrome stays alive for the next command. */
  async close(): Promise<void> {
    await asTransportError("Disconnecting from Chrome", async () => {
      await this.driver.close?.();
    });
  }
}
