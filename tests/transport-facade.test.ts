import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBootstrapMessage } from "../src/protocol/messages.js";
import { ChatGptTransport, type DeliverInput, type TransportContext } from "../src/transport/chatgpt-transport.js";
import {
  confirmDelivery,
  contentHash,
  listDeliveries,
  markDeliverySent,
  prepareDelivery,
  readDelivery,
} from "../src/transport/delivery.js";
import { TransportError } from "../src/transport/errors.js";
import { CHATGPT_NEW_CHAT_URL } from "../src/transport/selectors.js";
import { FakePageDriver } from "./fake-page-driver.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const CONNECTOR = "Codex with ChatGPT · demo";
const WORKSPACE_ID = "demo";
const WORKSPACE_NAME = "demo-ws";
const CONTEXT: TransportContext = { workspaceId: WORKSPACE_ID, workspaceName: WORKSPACE_NAME, connectorName: CONNECTOR };
const CHAT_URL = "https://chatgpt.com/c/abc-123";
const FRESH_URL = "https://chatgpt.com/c/fresh-456";
const TASK_ID = "c2c_ab12cd";
const KEY = `${TASK_ID}:EXECUTED:2`;
const MESSAGE = ["[C2C]", "STATE: EXECUTED", `TASK_ID: ${TASK_ID}`, "ITERATION: 2", "", "RESULT:", "Execution finished."].join("\n");
const BOOTSTRAP = buildBootstrapMessage({ connectorName: CONNECTOR, workspaceName: WORKSPACE_NAME });
const READY_REPLY = ["[C2C]", "STATE: READY", `WORKSPACE: ${WORKSPACE_NAME}`, "WORKSPACE_OK"].join("\n");
const PLAN_REPLY = ["[C2C]", "STATE: PLAN", `TASK_ID: ${TASK_ID}`, "ITERATION: 2", "", "Plan body."].join("\n");
const DONE_REPLY = ["[C2C]", "STATE: DONE", `TASK_ID: ${TASK_ID}`, "ITERATION: 2", "", "Verdict body."].join("\n");

function expectTransportError(error: unknown, code: string): TransportError {
  expect(error).toBeInstanceOf(TransportError);
  const transportError = error as TransportError;
  expect(transportError.code).toBe(code);
  return transportError;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  );
}

function makeTransport(driver: FakePageDriver): ChatGptTransport {
  return new ChatGptTransport(driver, CONTEXT, { pollMs: 1, stabilityMs: 5 });
}

function deliverInput(overrides: Partial<DeliverInput> = {}): DeliverInput {
  return { taskId: TASK_ID, state: "EXECUTED", iteration: 2, message: MESSAGE, chatUrl: CHAT_URL, ...overrides };
}

function replyToSend(driver: FakePageDriver, replyText: string, url?: string): void {
  driver.onSendHook = (fake) => {
    fake.appendUserMessage(fake.composerText);
    fake.composerText = "";
    if (url) fake.url = url;
    fake.appendAssistantMessage(replyText);
  };
}

class ClosableFakeDriver extends FakePageDriver {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("ChatGptTransport.ensureConversation", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => {
    cleanup(stateDir);
    delete process.env.C2C_STATE_DIR;
  });

  it("bootstraps a new conversation and returns its /c/ URL", async () => {
    const driver = new FakePageDriver();
    replyToSend(driver, READY_REPLY, FRESH_URL);
    const transport = makeTransport(driver);

    await expect(transport.ensureConversation({ forceNewChat: true })).resolves.toBe(FRESH_URL);

    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
    expect(driver.typedTexts).toEqual([BOOTSTRAP]);
    expect(driver.sendClicks).toBe(1);
    expect(listDeliveries(WORKSPACE_ID)).toEqual([]);
  });

  it("bootstraps when there is no chat URL to reuse", async () => {
    const driver = new FakePageDriver();
    replyToSend(driver, READY_REPLY, FRESH_URL);
    const transport = makeTransport(driver);

    await expect(transport.ensureConversation({ chatUrl: null })).resolves.toBe(FRESH_URL);
    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
  });

  it("forces a new chat even when a chat URL is supplied", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, READY_REPLY, FRESH_URL);
    const transport = makeTransport(driver);

    await expect(transport.ensureConversation({ chatUrl: CHAT_URL, forceNewChat: true })).resolves.toBe(FRESH_URL);
    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
  });

  it("opens and returns an existing chat URL without sending anything", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const transport = makeTransport(driver);

    await expect(transport.ensureConversation({ chatUrl: CHAT_URL })).resolves.toBe(CHAT_URL);

    expect(driver.opened).toEqual([CHAT_URL]);
    expect(driver.typeCalls).toBe(0);
    expect(driver.sendClicks).toBe(0);
  });

  it("rejects a non-ChatGPT chat URL before touching the browser", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.ensureConversation({ chatUrl: "https://evil.example/c/abc" })), "INVALID_CONVERSATION_URL");
    expect(driver.opened).toEqual([]);
  });

  it("surfaces CHATGPT_LOGIN_REQUIRED when an opened chat URL asks for login", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL, loginRequired: true, composerPresent: false });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.ensureConversation({ chatUrl: CHAT_URL })), "CHATGPT_LOGIN_REQUIRED");
  });

  it("surfaces CHATGPT_LOGIN_REQUIRED instead of sending the bootstrap", async () => {
    const driver = new FakePageDriver({ loginRequired: true, composerPresent: false });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.ensureConversation({ forceNewChat: true })), "CHATGPT_LOGIN_REQUIRED");
    expect(driver.sendClicks).toBe(0);
  });

  it("fails when the bootstrap reply names another workspace", async () => {
    const driver = new FakePageDriver();
    replyToSend(driver, "[C2C]\nSTATE: READY\nWORKSPACE: other-workspace\nWORKSPACE_OK", FRESH_URL);
    const transport = makeTransport(driver);

    const error = expectTransportError(await caught(transport.ensureConversation({ forceNewChat: true })), "WORKSPACE_VERIFICATION_FAILED");
    expect(error.message).toContain("other-workspace");
  });

  it("fails when the bootstrap reply has no WORKSPACE line", async () => {
    const driver = new FakePageDriver();
    replyToSend(driver, "[C2C]\nSTATE: READY\nWORKSPACE_OK", FRESH_URL);
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.ensureConversation({ forceNewChat: true })), "WORKSPACE_VERIFICATION_FAILED");
  });

  it("fails when the bootstrap reply arrives without a /c/ conversation URL", async () => {
    const driver = new FakePageDriver();
    replyToSend(driver, READY_REPLY);
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.ensureConversation({ forceNewChat: true })), "CONVERSATION_NOT_FOUND");
  });
});

describe("ChatGptTransport.deliver", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => {
    cleanup(stateDir);
    delete process.env.C2C_STATE_DIR;
  });

  it("sends, confirms and records a full roundtrip", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, PLAN_REPLY);
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput());

    expect(driver.sendClicks).toBe(1);
    expect(outcome).toEqual({
      chatUrl: CHAT_URL,
      sentMessageId: driver.messages[0].id,
      reusedConfirmation: false,
      replyMessageId: driver.messages[1].id,
      replyText: PLAN_REPLY,
      reply: { state: "PLAN", taskId: TASK_ID, iteration: 2, hasMarker: true, text: PLAN_REPLY },
      signals: [],
    });

    const record = readDelivery(WORKSPACE_ID, KEY);
    expect(record?.contentHash).toBe(contentHash(MESSAGE));
    expect(record).toMatchObject({
      status: "responded",
      userMessageId: outcome.sentMessageId,
      conversationUrl: CHAT_URL,
      responseMessageId: outcome.replyMessageId,
      responseState: "PLAN",
    });
  });

  it("reuses a matching last user message instead of sending again and repairs the ledger", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const existing = driver.appendUserMessage(MESSAGE.replace(/\s+/g, " "));
    driver.appendAssistantMessage(DONE_REPLY);
    prepareDelivery(WORKSPACE_ID, { taskId: TASK_ID, state: "EXECUTED", iteration: 2, content: MESSAGE });
    markDeliverySent(WORKSPACE_ID, KEY);
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput());

    expect(outcome.reusedConfirmation).toBe(true);
    expect(outcome.sentMessageId).toBe(existing.id);
    expect(driver.sendClicks).toBe(0);
    expect(driver.typeCalls).toBe(0);
    expect(outcome.reply.state).toBe("DONE");

    const record = readDelivery(WORKSPACE_ID, KEY);
    expect(record).toMatchObject({ status: "responded", userMessageId: existing.id });
    expect(record?.sentAt).toBeTruthy();
    expect(record?.confirmedAt).toBeTruthy();
  });

  it("does not trust a stale confirmed record when the conversation does not match", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    driver.appendUserMessage("an earlier question from the user");
    replyToSend(driver, PLAN_REPLY);
    prepareDelivery(WORKSPACE_ID, { taskId: TASK_ID, state: "EXECUTED", iteration: 2, content: MESSAGE });
    markDeliverySent(WORKSPACE_ID, KEY);
    confirmDelivery(WORKSPACE_ID, KEY, { userMessageId: "msg-0-deadbeef", conversationUrl: CHAT_URL });
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput());

    expect(outcome.reusedConfirmation).toBe(false);
    expect(driver.sendClicks).toBe(1);
    expect(outcome.sentMessageId).toBe(driver.messages[1].id);
    expect(readDelivery(WORKSPACE_ID, KEY)?.userMessageId).toBe(outcome.sentMessageId);
  });

  it("records the response before throwing on a task identity mismatch", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, ["[C2C]", "STATE: PLAN", "TASK_ID: c2c_other", "ITERATION: 2"].join("\n"));
    const transport = makeTransport(driver);

    const error = expectTransportError(await caught(transport.deliver(deliverInput())), "PROTOCOL_IDENTITY_MISMATCH");
    expect(error.message).toContain("c2c_other");

    const record = readDelivery(WORKSPACE_ID, KEY);
    expect(record?.status).toBe("responded");
    expect(record?.responseMessageId).toBe(driver.messages[1].id);
    expect(record?.responseState).toBe("PLAN");
  });

  it("records the response before throwing on a backwards iteration", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, ["[C2C]", "STATE: PLAN", `TASK_ID: ${TASK_ID}`, "ITERATION: 1"].join("\n"));
    const transport = makeTransport(driver);

    const error = expectTransportError(await caught(transport.deliver(deliverInput())), "PROTOCOL_IDENTITY_MISMATCH");
    expect(error.message).toContain("iteration 1");
    expect(readDelivery(WORKSPACE_ID, KEY)?.status).toBe("responded");
  });

  it("records the response before throwing on an unparseable reply", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, "I could not find any protocol headers in this reply.");
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.deliver(deliverInput())), "CHATGPT_RESPONSE_UNPARSEABLE");

    const record = readDelivery(WORKSPACE_ID, KEY);
    expect(record?.status).toBe("responded");
    expect(record?.responseState).toBe("UNPARSEABLE");
  });

  it("returns abnormal signals for a reply with missing headers", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, ["[C2C]", "STATE: PLAN", "", "Plan without identity headers."].join("\n"));
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput());

    expect(outcome.reply.state).toBe("PLAN");
    expect(outcome.signals).toEqual(["missing_task_id", "missing_iteration"]);
  });

  it("returns an abnormal signal for a reply without the protocol marker", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    replyToSend(driver, ["STATE: PLAN", `TASK_ID: ${TASK_ID}`, "ITERATION: 2"].join("\n"));
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput());

    expect(outcome.signals).toEqual(["missing_marker"]);
  });

  it("honors the timeout override for the reply wait", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.deliver(deliverInput({ timeoutMs: 30 }))), "CHATGPT_RESPONSE_TIMEOUT");
    expect(readDelivery(WORKSPACE_ID, KEY)?.status).toBe("confirmed");
  });

  it("bootstraps and delivers into the fresh conversation when forced", async () => {
    const oldUrl = "https://chatgpt.com/c/old-999";
    const driver = new FakePageDriver({ url: oldUrl });
    driver.onSendHook = (fake) => {
      const text = fake.composerText;
      fake.appendUserMessage(text);
      fake.composerText = "";
      if (text === BOOTSTRAP) {
        fake.url = FRESH_URL;
        fake.appendAssistantMessage(READY_REPLY);
      } else {
        fake.appendAssistantMessage(PLAN_REPLY);
      }
    };
    const transport = makeTransport(driver);

    const outcome = await transport.deliver(deliverInput({ chatUrl: oldUrl, forceNewChat: true }));

    expect(outcome.chatUrl).toBe(FRESH_URL);
    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
    expect(driver.sendClicks).toBe(2);
    expect(readDelivery(WORKSPACE_ID, KEY)?.conversationUrl).toBe(FRESH_URL);
  });

  it("rejects a non-ChatGPT chat URL before sending", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.deliver(deliverInput({ chatUrl: "https://evil.example/c/abc" }))), "INVALID_CONVERSATION_URL");
    expect(driver.typedTexts).toEqual([]);
    expect(driver.sendClicks).toBe(0);
  });

  it("surfaces CHATGPT_LOGIN_REQUIRED instead of sending", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL, loginRequired: true, composerPresent: false });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.deliver(deliverInput())), "CHATGPT_LOGIN_REQUIRED");
    expect(driver.sendClicks).toBe(0);
  });

  it("wraps a non-TransportError snapshot failure as TRANSPORT_UNAVAILABLE", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    const original = driver.snapshot.bind(driver);
    let calls = 0;
    driver.snapshot = async () => {
      calls += 1;
      if (calls >= 2) throw new Error("CDP connection lost");
      return original();
    };
    const transport = makeTransport(driver);

    const error = expectTransportError(await caught(transport.deliver(deliverInput())), "TRANSPORT_UNAVAILABLE");
    expect(error.message).toContain("CDP connection lost");
  });

  it("wraps a non-TransportError navigation failure as TRANSPORT_UNAVAILABLE", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL });
    driver.open = async () => {
      throw new Error("cannot navigate");
    };
    const transport = makeTransport(driver);

    const error = expectTransportError(await caught(transport.deliver(deliverInput())), "TRANSPORT_UNAVAILABLE");
    expect(error.message).toContain("cannot navigate");
  });

  it("does not swallow TransportError failures from the page layer", async () => {
    const driver = new FakePageDriver({ url: CHAT_URL, composerPresent: false });
    const transport = makeTransport(driver);

    expectTransportError(await caught(transport.deliver(deliverInput())), "CHATGPT_UI_CHANGED");
  });
});

describe("ChatGptTransport.close", () => {
  it("disconnects the driver without touching Chrome", async () => {
    const driver = new ClosableFakeDriver();
    const transport = makeTransport(driver);

    await transport.close();
    expect(driver.closeCalls).toBe(1);
  });

  it("is a no-op for drivers without a close method", async () => {
    const transport = makeTransport(new FakePageDriver());
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
