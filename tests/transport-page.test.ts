import { describe, expect, it } from "vitest";
import { tsImport } from "tsx/esm/api";
import { TransportError } from "../src/transport/errors.js";
import { messageIdFor, parseMessageIndex } from "../src/transport/driver.js";
import {
  DEFAULT_POLL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_STABILITY_MS,
  DEFAULT_TIMEOUT_MS,
  openConversation,
  readSnapshot,
  sendMessage,
  startNewConversation,
  waitForPageReady,
  waitForReply,
  waitForReplyMessage,
} from "../src/transport/chatgpt-page.js";
import { CHATGPT_NEW_CHAT_URL, SELECTORS } from "../src/transport/selectors.js";
import { FakePageDriver } from "./fake-page-driver.js";

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

function composerAppearsAfter(driver: FakePageDriver, snapshots: number): void {
  let seen = 0;
  driver.onSnapshotHook = (fake) => {
    seen += 1;
    if (seen >= snapshots) fake.composerPresent = true;
  };
}

function steppingClock(stepMs: number): () => number {
  let current = 0;
  return () => {
    current += stepMs;
    return current;
  };
}

describe("messageIdFor", () => {
  it("is stable for the same index and normalized text", () => {
    const id = messageIdFor(3, "Hello   world\nsecond line");
    expect(id).toMatch(/^msg-3-[0-9a-f]{8}$/);
    expect(messageIdFor(3, "Hello world second line")).toBe(id);
    expect(messageIdFor(3, "  Hello world\nsecond line  ")).toBe(id);
  });

  it("changes when the index or the text changes", () => {
    expect(messageIdFor(4, "Hello")).not.toBe(messageIdFor(3, "Hello"));
    expect(messageIdFor(3, "Hello")).not.toBe(messageIdFor(3, "Hello!"));
  });

  it("round-trips the index through parseMessageIndex", () => {
    expect(parseMessageIndex(messageIdFor(12, "reply"))).toBe(12);
    expect(parseMessageIndex("msg-0-00000000")).toBe(0);
  });

  it("returns null for ids that were not built by messageIdFor", () => {
    expect(parseMessageIndex("msg-4-nohexhere")).toBeNull();
    expect(parseMessageIndex("user-msg-1")).toBeNull();
    expect(parseMessageIndex("")).toBeNull();
  });
});

describe("page flow defaults", () => {
  it("matches the design timings", () => {
    expect(DEFAULT_POLL_MS).toBe(800);
    expect(DEFAULT_STABILITY_MS).toBe(1_500);
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_READY_TIMEOUT_MS).toBe(15_000);
  });
});

describe("waitForPageReady", () => {
  const READY = { pollMs: 1, readyTimeoutMs: 10_000 };

  it("returns the snapshot once the composer hydrates after navigation", async () => {
    const driver = new FakePageDriver({ composerPresent: false });
    composerAppearsAfter(driver, 3);

    const snapshot = await waitForPageReady(driver, { ...READY, now: steppingClock(10) });

    expect(snapshot.composerPresent).toBe(true);
    expect(driver.snapshotCalls).toBe(3);
  });

  it("reports CHATGPT_LOGIN_REQUIRED while the page asks for login", async () => {
    const driver = new FakePageDriver({ loginRequired: true, composerPresent: false });

    expectTransportError(await caught(waitForPageReady(driver, { ...READY, now: steppingClock(10) })), "CHATGPT_LOGIN_REQUIRED");
    expect(driver.snapshotCalls).toBe(1);
  });

  it("reports CHATGPT_UI_CHANGED when the composer never appears", async () => {
    const driver = new FakePageDriver({ composerPresent: false });

    expectTransportError(
      await caught(waitForPageReady(driver, { pollMs: 1, readyTimeoutMs: 35, now: steppingClock(10) })),
      "CHATGPT_UI_CHANGED"
    );
    expect(driver.snapshotCalls).toBe(4);
  });
});

describe("openConversation", () => {
  it("opens a chatgpt.com conversation URL", async () => {
    const driver = new FakePageDriver();
    await openConversation(driver, "https://chatgpt.com/c/abc-123");
    expect(driver.opened).toEqual(["https://chatgpt.com/c/abc-123"]);
  });

  it("rejects any other origin before touching the browser", async () => {
    const driver = new FakePageDriver();
    expectTransportError(await caught(openConversation(driver, "https://evil.example/c/abc-123")), "INVALID_CONVERSATION_URL");
    expect(driver.opened).toEqual([]);
  });

  it("rejects non-https chatgpt.com URLs", async () => {
    const driver = new FakePageDriver();
    expectTransportError(await caught(openConversation(driver, "http://chatgpt.com/c/abc-123")), "INVALID_CONVERSATION_URL");
    expect(driver.opened).toEqual([]);
  });

  it("surfaces CHATGPT_LOGIN_REQUIRED after opening a login page", async () => {
    const driver = new FakePageDriver({ loginRequired: true, composerPresent: false });
    expectTransportError(await caught(openConversation(driver, "https://chatgpt.com/")), "CHATGPT_LOGIN_REQUIRED");
    expect(driver.opened).toEqual(["https://chatgpt.com/"]);
  });

  it("waits for the composer to hydrate after opening a conversation", async () => {
    const driver = new FakePageDriver({ composerPresent: false });
    composerAppearsAfter(driver, 2);

    await openConversation(driver, "https://chatgpt.com/c/abc-123", {
      pollMs: 1,
      readyTimeoutMs: 10_000,
      now: steppingClock(10),
    });

    expect(driver.opened).toEqual(["https://chatgpt.com/c/abc-123"]);
    expect(driver.snapshotCalls).toBe(2);
  });

  it("reports CHATGPT_UI_CHANGED when the composer never hydrates after opening", async () => {
    const driver = new FakePageDriver({ composerPresent: false });

    expectTransportError(
      await caught(openConversation(driver, "https://chatgpt.com/", { pollMs: 1, readyTimeoutMs: 25, now: steppingClock(10) })),
      "CHATGPT_UI_CHANGED"
    );
    expect(driver.snapshotCalls).toBe(3);
  });
});

describe("startNewConversation", () => {
  it("opens the ChatGPT root", async () => {
    const driver = new FakePageDriver();
    await startNewConversation(driver);
    expect(CHATGPT_NEW_CHAT_URL).toBe("https://chatgpt.com/");
    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
  });

  it("waits for the composer to hydrate and returns the ready snapshot", async () => {
    const driver = new FakePageDriver({ composerPresent: false });
    composerAppearsAfter(driver, 2);

    const snapshot = await startNewConversation(driver, { pollMs: 1, readyTimeoutMs: 10_000, now: steppingClock(10) });

    expect(snapshot.composerPresent).toBe(true);
    expect(driver.opened).toEqual([CHATGPT_NEW_CHAT_URL]);
    expect(driver.snapshotCalls).toBe(2);
  });

  it("reports CHATGPT_UI_CHANGED when the new chat never hydrates", async () => {
    const driver = new FakePageDriver({ composerPresent: false });

    expectTransportError(
      await caught(startNewConversation(driver, { pollMs: 1, readyTimeoutMs: 25, now: steppingClock(10) })),
      "CHATGPT_UI_CHANGED"
    );
  });
});

describe("readSnapshot", () => {
  it("returns the snapshot when the composer is present", async () => {
    const driver = new FakePageDriver({ composerText: "draft" });
    const snapshot = await readSnapshot(driver);
    expect(snapshot.composerPresent).toBe(true);
    expect(snapshot.composerText).toBe("draft");
  });

  it("reports CHATGPT_LOGIN_REQUIRED when the page asks for login", async () => {
    const driver = new FakePageDriver({ loginRequired: true });
    expectTransportError(await caught(readSnapshot(driver)), "CHATGPT_LOGIN_REQUIRED");
  });

  it("reports CHATGPT_UI_CHANGED when the composer is missing while logged in", async () => {
    const driver = new FakePageDriver({ composerPresent: false });
    expectTransportError(await caught(readSnapshot(driver)), "CHATGPT_UI_CHANGED");
  });
});

describe("sendMessage", () => {
  it("types, verifies, sends and confirms the new user message", async () => {
    const driver = new FakePageDriver();
    const id = await sendMessage(driver, "hello from c2c");

    expect(driver.focusCalls).toBe(1);
    expect(driver.typedTexts).toEqual(["hello from c2c"]);
    expect(driver.sendClicks).toBe(1);
    expect(driver.composerText).toBe("");
    expect(driver.messages).toHaveLength(1);
    expect(driver.messages[0]).toMatchObject({ role: "user", text: "hello from c2c" });
    expect(id).toBe(driver.messages[0].id);
    expect(id).toMatch(/^msg-\d+-[0-9a-f]{8}$/);
  });

  it("confirms against normalized message text", async () => {
    const driver = new FakePageDriver();
    driver.onSendHook = (fake) => {
      fake.appendUserMessage("hello   from\nc2c");
      fake.composerText = "";
    };

    const id = await sendMessage(driver, "hello from c2c");
    expect(id).toBe(driver.messages[0].id);
  });

  it("fails with CHATGPT_COMPOSER_VERIFY_FAILED when the composer text does not match", async () => {
    const driver = new FakePageDriver();
    driver.readComposerResult = "hello from c2";

    expectTransportError(await caught(sendMessage(driver, "hello from c2c")), "CHATGPT_COMPOSER_VERIFY_FAILED");
    expect(driver.sendClicks).toBe(0);
  });

  it("reports CHATGPT_LOGIN_REQUIRED instead of typing when the page asks for login", async () => {
    const driver = new FakePageDriver({ loginRequired: true, composerPresent: false });

    expectTransportError(await caught(sendMessage(driver, "blocked")), "CHATGPT_LOGIN_REQUIRED");
    expect(driver.focusCalls).toBe(0);
    expect(driver.typeCalls).toBe(0);
    expect(driver.sendClicks).toBe(0);
  });

  it("fails with CHATGPT_SEND_UNCONFIRMED when no matching user message appears", async () => {
    const driver = new FakePageDriver();
    driver.sendBehavior = "ignore";

    expectTransportError(await caught(sendMessage(driver, "lost message", { pollMs: 1, timeoutMs: 40 })), "CHATGPT_SEND_UNCONFIRMED");
    expect(driver.sendClicks).toBe(1);
    expect(driver.typedTexts).toEqual(["lost message"]);
  });

  it("does not false-confirm an older identical user message as the new send", async () => {
    const driver = new FakePageDriver();
    const existing = driver.appendUserMessage("hello from c2c");
    driver.onSendHook = (fake) => {
      fake.composerText = "";
    };

    expectTransportError(await caught(sendMessage(driver, "hello from c2c", { pollMs: 1, timeoutMs: 40 })), "CHATGPT_SEND_UNCONFIRMED");
    expect(driver.sendClicks).toBe(1);
    expect(driver.messages).toHaveLength(1);
    expect(driver.messages[0].id).toBe(existing.id);
  });

  it("confirms the new message even when the identical text already exists", async () => {
    const driver = new FakePageDriver();
    const existing = driver.appendUserMessage("hello from c2c");

    const id = await sendMessage(driver, "hello from c2c", { pollMs: 1, timeoutMs: 200 });
    expect(driver.messages).toHaveLength(2);
    expect(id).toBe(driver.messages[1].id);
    expect(id).not.toBe(existing.id);
  });

  it("keeps polling while the composer still holds the text", async () => {
    const driver = new FakePageDriver();
    driver.onSendHook = (fake) => {
      fake.appendUserMessage(fake.composerText);
    };

    expectTransportError(await caught(sendMessage(driver, "stuck", { pollMs: 1, timeoutMs: 40 })), "CHATGPT_SEND_UNCONFIRMED");
    expect(driver.messages).toHaveLength(1);
    expect(driver.snapshotCalls).toBeGreaterThan(1);
  });
});

describe("waitForReply", () => {
  const FAST = { pollMs: 1, stabilityMs: 10, timeoutMs: 3_000 };

  function withAnchor() {
    const driver = new FakePageDriver();
    const anchor = driver.appendUserMessage("[C2C]\nSTATE: EXECUTED");
    return { driver, anchor };
  }

  it("returns the assistant reply once the text stabilizes", async () => {
    const { driver, anchor } = withAnchor();
    driver.generating = true;
    const chunks = ["[C2C]\nST", "ATE: PLAN\nTA", "SK_ID: c2c_ab12cd\nITERATION: 2\n\nPlan body."];
    let cursor = 0;
    driver.onSnapshotHook = (fake) => {
      if (cursor < chunks.length) {
        const text = chunks.slice(0, cursor + 1).join("");
        cursor += 1;
        if (fake.messages.length === 1) fake.appendAssistantMessage(text);
        else fake.messages[fake.messages.length - 1].text = text;
      } else {
        fake.generating = false;
      }
    };

    await expect(waitForReply(driver, anchor.id, FAST)).resolves.toBe(chunks.join(""));
    expect(driver.snapshotCalls).toBeGreaterThan(chunks.length + 1);
  });

  it("reports the reply id alongside its text", async () => {
    const { driver, anchor } = withAnchor();
    const reply = driver.appendAssistantMessage("[C2C]\nSTATE: DONE\nTASK_ID: c2c_ab12cd\nITERATION: 2");

    await expect(waitForReplyMessage(driver, anchor.id, FAST)).resolves.toEqual({
      id: reply.id,
      text: "[C2C]\nSTATE: DONE\nTASK_ID: c2c_ab12cd\nITERATION: 2",
    });
    await expect(waitForReply(driver, anchor.id, FAST)).resolves.toBe("[C2C]\nSTATE: DONE\nTASK_ID: c2c_ab12cd\nITERATION: 2");
  });

  it("returns a prose-only reply unchanged", async () => {
    const { driver, anchor } = withAnchor();
    const prose = "This is a plain answer without protocol headers.";
    driver.appendAssistantMessage(prose);

    await expect(waitForReply(driver, anchor.id, FAST)).resolves.toBe(prose);
  });

  it("resolves the reply relative to the anchor, not whatever is last", async () => {
    const driver = new FakePageDriver();
    driver.appendAssistantMessage("old reply before the task");
    const anchor = driver.appendUserMessage("[C2C]\nSTATE: EXECUTED");
    driver.appendAssistantMessage("first draft");
    driver.appendAssistantMessage("");
    driver.onSnapshotHook = (fake) => {
      const target = fake.messages[fake.messages.length - 1];
      if (target.text === "") target.text = "the stable answer for iteration 2";
    };

    await expect(waitForReply(driver, anchor.id, FAST)).resolves.toBe("the stable answer for iteration 2");
  });

  it("times out while the reply is still generating", async () => {
    const { driver, anchor } = withAnchor();
    driver.appendAssistantMessage("looks complete");
    driver.generating = true;

    expectTransportError(await caught(waitForReply(driver, anchor.id, { pollMs: 1, stabilityMs: 5, timeoutMs: 50 })), "CHATGPT_RESPONSE_TIMEOUT");
    expect(driver.snapshotCalls).toBeGreaterThan(1);
  });

  it("times out while the reply text keeps changing", async () => {
    const { driver, anchor } = withAnchor();
    driver.appendAssistantMessage("x");
    driver.onSnapshotHook = (fake) => {
      fake.messages[fake.messages.length - 1].text += "x";
    };

    expectTransportError(
      await caught(waitForReply(driver, anchor.id, { pollMs: 1, stabilityMs: 20, timeoutMs: 50 })),
      "CHATGPT_RESPONSE_TIMEOUT"
    );
  });

  it("times out when no assistant message ever appears", async () => {
    const { driver, anchor } = withAnchor();

    expectTransportError(await caught(waitForReply(driver, anchor.id, { pollMs: 1, stabilityMs: 5, timeoutMs: 50 })), "CHATGPT_RESPONSE_TIMEOUT");
    expect(driver.snapshotCalls).toBeGreaterThan(1);
  });

  it("never returns a user message as the reply", async () => {
    const { driver, anchor } = withAnchor();
    driver.appendUserMessage("this is not a reply");

    expectTransportError(await caught(waitForReply(driver, anchor.id, { pollMs: 1, stabilityMs: 5, timeoutMs: 40 })), "CHATGPT_RESPONSE_TIMEOUT");
  });

  it("rejects an anchor id it cannot resolve", async () => {
    const driver = new FakePageDriver();
    driver.appendAssistantMessage("reply");

    expectTransportError(await caught(waitForReply(driver, "not-a-message-id", FAST)), "CHATGPT_UI_CHANGED");
    expect(driver.snapshotCalls).toBe(0);
  });
});

describe("readDomSnapshot serialization", () => {
  interface RawSnapshotShape {
    url: string;
    composerPresent: boolean;
    composerText: string;
    generating: boolean;
    loginRequired: boolean;
    messages: Array<{ role: string | null; text: string }>;
  }

  it("stays free of transpiler helpers when Playwright serializes it into a page", async () => {
    // Load the module through tsx (the runtime bin/c2c.js uses in dev) because
    // vitest/Vite transpiles with keepNames disabled, while tsx enables it.
    // Only the tsx copy reproduces the `__name(...)` helpers that Playwright
    // would serialize into the page.
    const { readDomSnapshot } = (await tsImport("../src/transport/driver.ts", import.meta.url)) as {
      readDomSnapshot: (selectors: typeof SELECTORS) => RawSnapshotShape;
    };

    const build = new Function(
      "document",
      "location",
      "HTMLTextAreaElement",
      "HTMLInputElement",
      `return (${readDomSnapshot.toString()});`
    );
    const evaluate = build(
      { querySelector: () => null, querySelectorAll: () => [] },
      { href: "https://chatgpt.com/c/abc-123", pathname: "/c/abc-123" },
      class StubTextAreaElement {},
      class StubInputElement {}
    ) as (selectors: typeof SELECTORS) => RawSnapshotShape;

    expect(evaluate(SELECTORS)).toEqual({
      url: "https://chatgpt.com/c/abc-123",
      composerPresent: false,
      composerText: "",
      generating: false,
      loginRequired: false,
      messages: [],
    });

    expect(readDomSnapshot.toString()).not.toMatch(/\b__name\b/);
  });

  it("preserves composer line breaks by preferring innerText over textContent", async () => {
    const { readDomSnapshot } = (await tsImport("../src/transport/driver.ts", import.meta.url)) as {
      readDomSnapshot: (selectors: typeof SELECTORS) => RawSnapshotShape;
    };

    const newlineText = "[C2C]\nSTATE: BOOTSTRAP\nINSTRUCTION: x";
    const composer = { innerText: newlineText, textContent: "[C2C]STATE:BOOTSTRAPINSTRUCTION:x" };

    const build = new Function(
      "document",
      "location",
      "HTMLTextAreaElement",
      "HTMLInputElement",
      `return (${readDomSnapshot.toString()});`
    );
    const evaluate = build(
      {
        querySelector: (selector: string) => (selector === "#prompt-textarea" ? composer : null),
        querySelectorAll: () => [],
      },
      { href: "https://chatgpt.com/c/abc-123", pathname: "/c/abc-123" },
      class StubTextAreaElement {},
      class StubInputElement {}
    ) as (selectors: typeof SELECTORS) => RawSnapshotShape;

    const snapshot = evaluate(SELECTORS);
    expect(snapshot.composerPresent).toBe(true);
    expect(snapshot.composerText).toBe(newlineText);
  });
});
