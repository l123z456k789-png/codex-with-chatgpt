import { afterEach, describe, expect, it } from "vitest";
import { TransportError, isTransportError } from "../src/transport/errors.js";
import { isChatGptConversationUrl, isChatGptUrl } from "../src/transport/selectors.js";
import {
  parseChatGptReply,
  parseReadinessWorkspace,
  validateReplyIdentity,
  type ParsedReply,
} from "../src/transport/reply.js";
import {
  clearDeliveries,
  confirmDelivery,
  contentHash,
  deliveryKey,
  listDeliveries,
  markDeliverySent,
  prepareDelivery,
  readDelivery,
  recordDeliveryResponse,
} from "../src/transport/delivery.js";
import { cleanup, isolateStateDir, write } from "./helpers.js";

describe("parseChatGptReply", () => {
  it("finds the STATE header among surrounding prose", () => {
    const raw = [
      "I checked the workspace and the git diff.",
      "",
      "[C2C]",
      "STATE: PLAN",
      "TASK_ID: c2c_ab12cd",
      "ITERATION: 3",
      "",
      "The plan is attached below.",
    ].join("\n");

    const reply = parseChatGptReply(raw);
    expect(reply.state).toBe("PLAN");
    expect(reply.taskId).toBe("c2c_ab12cd");
    expect(reply.iteration).toBe(3);
    expect(reply.hasMarker).toBe(true);
  });

  it("recognizes every supported reply state", () => {
    for (const state of ["PLAN", "DONE", "BLOCKED", "ERROR", "READY"] as const) {
      expect(parseChatGptReply(`[C2C]\nSTATE: ${state}`).state).toBe(state);
    }
  });

  it("accepts a lower-case state value", () => {
    expect(parseChatGptReply("[C2C]\nSTATE: done").state).toBe("DONE");
  });

  it("treats unknown or protocol-only states as null", () => {
    expect(parseChatGptReply("[C2C]\nSTATE: MAYBE").state).toBeNull();
    expect(parseChatGptReply("[C2C]\nSTATE: EXECUTED").state).toBeNull();
  });

  it("matches the [C2C] marker case-insensitively", () => {
    expect(parseChatGptReply("[c2c]\nSTATE: DONE").hasMarker).toBe(true);
    expect(parseChatGptReply("STATE: DONE").hasMarker).toBe(false);
  });

  it("parses TASK_ID and numeric ITERATION but rejects non-numeric iterations", () => {
    const reply = parseChatGptReply("[C2C]\nTASK_ID: c2c_zz99\nITERATION: 7");
    expect(reply.taskId).toBe("c2c_zz99");
    expect(reply.iteration).toBe(7);
    expect(parseChatGptReply("[C2C]\nITERATION: two").iteration).toBeNull();
  });
});

describe("validateReplyIdentity", () => {
  const expected = { taskId: "c2c_ab12cd", minIteration: 3 };

  function reply(overrides: Partial<ParsedReply> = {}): ParsedReply {
    return {
      state: "PLAN",
      taskId: "c2c_ab12cd",
      iteration: 3,
      hasMarker: true,
      text: "",
      ...overrides,
    };
  }

  it("accepts a matching reply at the expected iteration", () => {
    const result = validateReplyIdentity(reply(), expected);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply.state).toBe("PLAN");
      expect(result.signals).toEqual([]);
    }
  });

  it("accepts an iteration ahead of the expected minimum", () => {
    const result = validateReplyIdentity(reply({ iteration: 5 }), expected);
    expect(result.ok).toBe(true);
  });

  it("fails hard when the reply belongs to a different task", () => {
    const result = validateReplyIdentity(reply({ taskId: "c2c_other" }), expected);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROTOCOL_IDENTITY_MISMATCH");
      expect(result.reason).toContain("c2c_other");
    }
  });

  it("fails hard when the reply iteration is behind the expected minimum", () => {
    const result = validateReplyIdentity(reply({ iteration: 2 }), expected);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROTOCOL_IDENTITY_MISMATCH");
      expect(result.signals).toContain("invalid_iteration");
    }
  });

  it("records a missing marker while still accepting the reply", () => {
    const result = validateReplyIdentity(reply({ hasMarker: false }), expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signals).toContain("missing_marker");
  });

  it("records a missing TASK_ID while still accepting the reply", () => {
    const result = validateReplyIdentity(reply({ taskId: null }), expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signals).toContain("missing_task_id");
  });

  it("records a missing ITERATION while still accepting the reply", () => {
    const result = validateReplyIdentity(reply({ iteration: null }), expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signals).toContain("missing_iteration");
  });

  it("rejects an unknown state as unparseable", () => {
    const result = validateReplyIdentity(reply({ state: null }), expected);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CHATGPT_RESPONSE_UNPARSEABLE");
      expect(result.signals).toContain("unparseable");
    }
  });
});

describe("parseReadinessWorkspace", () => {
  it("extracts the workspace name from a readiness reply", () => {
    const text = ["[C2C]", "STATE: READY", "WORKSPACE: demo-workspace", "", "Connector is active."].join("\n");
    expect(parseReadinessWorkspace(text)).toBe("demo-workspace");
  });

  it("trims surrounding whitespace on the value line", () => {
    expect(parseReadinessWorkspace("WORKSPACE:   demo  ")).toBe("demo");
  });

  it("returns null when the line is absent", () => {
    expect(parseReadinessWorkspace("[C2C]\nSTATE: READY")).toBeNull();
    expect(parseReadinessWorkspace("")).toBeNull();
  });

  it("returns null when the workspace name is empty", () => {
    expect(parseReadinessWorkspace("WORKSPACE:")).toBeNull();
  });
});

describe("delivery ledger", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  const TASK = "c2c_ab12cd";
  const KEY = "c2c_ab12cd:EXECUTED:2";

  it("runs the prepare -> sent -> confirmed -> responded lifecycle", () => {
    dirs.push(isolateStateDir());
    const workspace = "demo";
    const t1 = "2026-01-02T03:04:05.000Z";
    const t2 = "2026-01-02T03:05:05.000Z";
    const t3 = "2026-01-02T03:06:05.000Z";

    const prepared = prepareDelivery(workspace, {
      taskId: TASK,
      state: "executed",
      iteration: 2,
      content: "The exact message body",
    });
    expect(prepared.status).toBe("prepared");
    expect(prepared.key).toBe(KEY);
    expect(prepared.state).toBe("EXECUTED");
    expect(readDelivery(workspace, KEY)?.status).toBe("prepared");

    const sent = markDeliverySent(workspace, KEY, t1);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBe(t1);

    const confirmed = confirmDelivery(
      workspace,
      KEY,
      { userMessageId: "user-msg-1", conversationUrl: "https://chatgpt.com/c/abc-123" },
      t2
    );
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.userMessageId).toBe("user-msg-1");
    expect(confirmed.conversationUrl).toBe("https://chatgpt.com/c/abc-123");
    expect(confirmed.confirmedAt).toBe(t2);

    const responded = recordDeliveryResponse(
      workspace,
      KEY,
      { responseMessageId: "assistant-msg-1", responseState: "PLAN" },
      t3
    );
    expect(responded.status).toBe("responded");
    expect(responded.responseMessageId).toBe("assistant-msg-1");
    expect(responded.responseState).toBe("PLAN");
    expect(responded.respondedAt).toBe(t3);

    const listed = listDeliveries(workspace);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(responded);
    expect(readDelivery(workspace, KEY)).toEqual(responded);
    expect(readDelivery(workspace, "c2c_missing:PLAN:0")).toBeNull();
  });

  it("keys records by taskId:STATE:iteration and lists newest first", () => {
    dirs.push(isolateStateDir());
    expect(deliveryKey(TASK, "executed", 2)).toBe(KEY);
    expect(deliveryKey(TASK, "Executed", 2)).toBe(KEY);

    prepareDelivery("demo", { taskId: TASK, state: "PLAN", iteration: 1, content: "first" });
    prepareDelivery("demo", { taskId: TASK, state: "PLAN", iteration: 2, content: "second" });

    const listed = listDeliveries("demo");
    expect(listed.map((record) => record.key)).toEqual([`${TASK}:PLAN:2`, `${TASK}:PLAN:1`]);
    expect(readDelivery("demo", `${TASK}:PLAN:1`)?.iteration).toBe(1);
    expect(listDeliveries("other-workspace")).toEqual([]);
  });

  it("hashes whitespace-only differences as equal and real changes as different", () => {
    expect(contentHash("Hello   world\n\nSecond line ")).toBe(contentHash("Hello world Second line"));
    expect(contentHash("Hello world")).not.toBe(contentHash("Hello worlds"));
  });

  it("keeps a responded record responded when the same key is prepared again", () => {
    dirs.push(isolateStateDir());
    const workspace = "demo";
    const t1 = "2026-01-02T03:04:05.000Z";
    const t2 = "2026-01-02T03:05:05.000Z";
    const t3 = "2026-01-02T03:06:05.000Z";

    const first = prepareDelivery(workspace, {
      taskId: TASK,
      state: "EXECUTED",
      iteration: 2,
      content: "original body",
    });
    markDeliverySent(workspace, KEY, t1);
    confirmDelivery(workspace, KEY, { userMessageId: "user-msg-1" }, t2);
    recordDeliveryResponse(workspace, KEY, { responseMessageId: "assistant-msg-1", responseState: "DONE" }, t3);

    const again = prepareDelivery(workspace, {
      taskId: TASK,
      state: "EXECUTED",
      iteration: 2,
      content: "retry body that must not be sent",
    });
    expect(again.status).toBe("responded");
    expect(again.preparedAt).toBe(first.preparedAt);
    expect(again.sentAt).toBe(t1);
    expect(again.confirmedAt).toBe(t2);
    expect(again.respondedAt).toBe(t3);
    expect(again.userMessageId).toBe("user-msg-1");
    expect(again.responseMessageId).toBe("assistant-msg-1");
    expect(again.responseState).toBe("DONE");
  });

  it("clears all deliveries for a workspace", () => {
    dirs.push(isolateStateDir());
    prepareDelivery("demo", { taskId: TASK, state: "PLAN", iteration: 1, content: "one" });
    prepareDelivery("demo", { taskId: TASK, state: "PLAN", iteration: 2, content: "two" });

    clearDeliveries("demo");
    expect(listDeliveries("demo")).toEqual([]);
    expect(readDelivery("demo", `${TASK}:PLAN:1`)).toBeNull();
  });

  it("treats a corrupt store file as empty instead of throwing", () => {
    const stateDir = isolateStateDir();
    write(stateDir, "transport/deliveries/demo.json", "{ this is not json");

    expect(() => listDeliveries("demo")).not.toThrow();
    expect(listDeliveries("demo")).toEqual([]);
    expect(readDelivery("demo", KEY)).toBeNull();

    const prepared = prepareDelivery("demo", {
      taskId: TASK,
      state: "PLAN",
      iteration: 1,
      content: "after corruption",
    });
    expect(prepared.status).toBe("prepared");
    expect(listDeliveries("demo")).toHaveLength(1);
  });
});

describe("isChatGptUrl", () => {
  it("accepts https chatgpt.com URLs", () => {
    expect(isChatGptUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGptUrl("https://chatgpt.com/c/abc-123")).toBe(true);
    expect(isChatGptUrl("https://chatgpt.com/?tab=chats")).toBe(true);
    expect(isChatGptUrl("https://www.chatgpt.com/g/g-xyz")).toBe(true);
  });

  it("rejects http and other hosts", () => {
    expect(isChatGptUrl("http://chatgpt.com/")).toBe(false);
    expect(isChatGptUrl("http://www.chatgpt.com/")).toBe(false);
    expect(isChatGptUrl("https://chat.openai.com/")).toBe(false);
    expect(isChatGptUrl("https://chatgpt.org/")).toBe(false);
    expect(isChatGptUrl("https://chatgpt.com.evil.example/")).toBe(false);
    expect(isChatGptUrl("https://evil.example/chatgpt.com")).toBe(false);
  });

  it("rejects malformed and non-http URLs", () => {
    expect(isChatGptUrl("not a url")).toBe(false);
    expect(isChatGptUrl("")).toBe(false);
    expect(isChatGptUrl("javascript:alert(1)")).toBe(false);
    expect(isChatGptUrl("ftp://chatgpt.com/")).toBe(false);
  });
});

describe("isChatGptConversationUrl", () => {
  it("accepts saved /c/ and /g/ conversation URLs", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/c/abc-123")).toBe(true);
    expect(isChatGptConversationUrl("https://www.chatgpt.com/g/g-xyz")).toBe(true);
    expect(isChatGptConversationUrl("https://chatgpt.com/c/abc-123?tab=chats")).toBe(true);
  });

  it("rejects the app root and non-conversation paths", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/")).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/c")).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/gpts")).toBe(false);
  });

  it("rejects non-chatgpt origins", () => {
    expect(isChatGptConversationUrl("https://evil.example/c/abc")).toBe(false);
    expect(isChatGptConversationUrl("http://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("TransportError", () => {
  it("carries a stable code, name and optional pending message", () => {
    const error = new TransportError("CHATGPT_LOGIN_REQUIRED", "Log in to continue.", "[C2C]\nSTATE: INIT");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransportError");
    expect(error.code).toBe("CHATGPT_LOGIN_REQUIRED");
    expect(error.message).toBe("Log in to continue.");
    expect(error.detail).toBe("[C2C]\nSTATE: INIT");
  });

  it("recognizes transport errors and ignores other values", () => {
    expect(isTransportError(new TransportError("TRANSPORT_UNAVAILABLE", "x"))).toBe(true);
    expect(isTransportError(new Error("x"))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});
