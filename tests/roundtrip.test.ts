import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import type { MachinePrefs } from "../src/config/prefs.js";
import { readRotationState, recordRoundtrip, recordTaskStarted } from "../src/conversation/rotation.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { markExecuted, markPlan, startTask, type TaskMessageResult, type TaskScope } from "../src/protocol/lifecycle.js";
import { buildExecutedMessage, buildInitMessage } from "../src/protocol/messages.js";
import { executedWithTransport, resumeWithTransport, startTaskWithTransport } from "../src/protocol/roundtrip.js";
import { readAgentSessionCheckpoint, saveAgentSessionCheckpoint } from "../src/session/agent-session.js";
import { writeSession, type TaskCheckpoint } from "../src/session/state.js";
import type {
  ChatGptTransport,
  DeliverInput,
  DeliverOutcome,
  SendOutcome,
} from "../src/transport/chatgpt-transport.js";
import { TransportError } from "../src/transport/errors.js";
import type { ChatGptReplyState, ParsedReply } from "../src/transport/reply.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const EXECUTOR = "opencode";
const SESSION = "rt-1";
const CONNECTOR = "Codex with ChatGPT · roundtrip";
const CONNECTED_URL = "https://chatgpt.com/c/connected";
const ROTATED_URL = "https://chatgpt.com/c/rotated";
const TASK_ID = "c2c_rt0001";
const GOAL = "Ship dark mode.";

const PREFS: MachinePrefs = {
  developerModeEnabled: false,
  setupMode: null,
  transport: null,
  defaultMode: "full",
  defaultReviewIterations: 3,
  maxTasksPerConversation: 10,
  maxProtocolRoundtrips: 30,
  maxAbnormalSignals: 3,
  replyTimeoutSeconds: 600,
};

type QueueEntry<T> = T | Error;

class FakeTransport {
  readonly deliverInputs: DeliverInput[] = [];
  readonly sendInputs: DeliverInput[] = [];
  readonly deliverQueue: QueueEntry<DeliverOutcome>[] = [];
  readonly sendQueue: QueueEntry<SendOutcome>[] = [];
  closeCalls = 0;

  async deliver(input: DeliverInput): Promise<DeliverOutcome> {
    this.deliverInputs.push(input);
    const next = this.deliverQueue.shift();
    if (!next) throw new Error("FakeTransport: no queued deliver outcome");
    if (next instanceof Error) throw next;
    return next;
  }

  async send(input: DeliverInput): Promise<SendOutcome> {
    this.sendInputs.push(input);
    const next = this.sendQueue.shift();
    if (!next) throw new Error("FakeTransport: no queued send outcome");
    if (next instanceof Error) throw next;
    return next;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function asTransport(fake: FakeTransport): ChatGptTransport {
  return fake as unknown as ChatGptTransport;
}

function exchange(
  state: ChatGptReplyState,
  taskId: string | null,
  iteration: number | null,
  body: string
): { replyText: string; reply: ParsedReply } {
  const replyText = [`[C2C]`, `STATE: ${state}`, `TASK_ID: ${taskId}`, `ITERATION: ${iteration}`, "", body].join("\n");
  return { replyText, reply: { state, taskId, iteration, hasMarker: true, text: replyText } };
}

function deliverOutcome(over: Partial<DeliverOutcome> & Pick<DeliverOutcome, "reply" | "replyText">): DeliverOutcome {
  return {
    chatUrl: CONNECTED_URL,
    sentMessageId: "msg-0-aaaaaaaa",
    reusedConfirmation: false,
    replyMessageId: "msg-1-bbbbbbbb",
    signals: [],
    ...over,
  };
}

describe("roundtrip", () => {
  let stateDir = "";
  let root = "";
  let workspace: Workspace;

  function scope(agentSession = SESSION): TaskScope {
    return { workspace, executor: EXECUTOR, agentSession };
  }

  function seedPlan(taskId = TASK_ID, iteration = 1): TaskCheckpoint {
    startTask(scope(), { goal: GOAL, taskId });
    return markPlan(scope(), { taskId, iteration }).checkpoint;
  }

  function seedExecuted(taskId = TASK_ID, iteration = 1, changedFiles: string[] | number = ["src/a.ts"]): TaskCheckpoint {
    seedPlan(taskId, iteration);
    return markExecuted(scope(), {
      taskId,
      iteration,
      changedFiles,
      tests: "5 passed",
      exitStatus: "ok",
    }).checkpoint;
  }

  beforeEach(() => {
    stateDir = isolateStateDir();
    root = makeTmpDir("roundtrip-workspace");
    workspace = new Workspace(root);
    writeSession(workspace.id, {
      url: CONNECTED_URL,
      conversationMode: "long-chat",
      connectorName: CONNECTOR,
      savedAt: new Date().toISOString(),
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: null,
      mcpUrl: null,
      connectorName: CONNECTOR,
    });
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(root);
    delete process.env.C2C_STATE_DIR;
  });

  describe("startTaskWithTransport", () => {
    it("manual mode returns the plain lifecycle result without a transport key", async () => {
      const input = { goal: GOAL, taskId: TASK_ID };
      const viaRoundtrip = await startTaskWithTransport(scope("manual-a"), input, { transport: null });
      const direct = startTask(scope("manual-b"), input);

      expect("transport" in viaRoundtrip).toBe(false);
      const scrub = (value: TaskMessageResult | typeof viaRoundtrip) => ({
        ...value,
        agentSession: "scrubbed",
        checkpoint: { ...value.checkpoint, updatedAt: "scrubbed" },
      });
      expect(scrub(viaRoundtrip)).toEqual(scrub(direct));
    });

    it("manual mode persists an explicit review limit", async () => {
      await startTaskWithTransport(scope("manual-a"), { goal: GOAL, taskId: TASK_ID }, { transport: null, prefs: PREFS, reviewIterations: "5" });
      expect(readAgentSessionCheckpoint(workspace.id, EXECUTOR, "manual-a")?.reviewIterations).toBe(5);
    });

    it("delivers INIT and records the PLAN reply", async () => {
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.waitingFor).toBe("none");
      expect(outcome.iteration).toBe(1);
      expect(outcome.checkpoint.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.chatUrl).toBe(CONNECTED_URL);
      expect(outcome.connectorName).toBe(CONNECTOR);
      expect(outcome.transport).toMatchObject({
        ok: true,
        chatUrl: CONNECTED_URL,
        reusedConfirmation: false,
        signals: [],
      });
      expect(outcome.transport?.replyText).toBe(plan.replyText);
      expect(outcome.transport?.reply?.state).toBe("PLAN");
      expect(outcome.rotation).toEqual({ recommended: false, reason: null });

      const sent = fake.deliverInputs[0];
      expect(sent).toMatchObject({
        taskId: TASK_ID,
        state: "INIT",
        iteration: 0,
        chatUrl: CONNECTED_URL,
        forceNewChat: false,
        timeoutMs: 600_000,
      });
      expect(sent.message).toContain("[C2C]\nSTATE: INIT");

      const rotation = readRotationState(workspace.id);
      expect(rotation).toMatchObject({ tasks: 1, roundtrips: 1, abnormalSignals: 0, chatUrl: CONNECTED_URL });
    });

    it("returns non-PLAN replies without touching the checkpoint", async () => {
      const fake = new FakeTransport();
      const done = exchange("DONE", TASK_ID, 0, "Nothing to do.");
      fake.deliverQueue.push(deliverOutcome({ reply: done.reply, replyText: done.replyText }));

      const outcome = await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(outcome.protocolState).toBe("INIT");
      expect(outcome.waitingFor).toBe("GPT_PLAN");
      expect(outcome.transport?.reply?.state).toBe("DONE");
      expect(readRotationState(workspace.id).roundtrips).toBe(1);
    });

    it("records abnormal signals against the conversation rotation", async () => {
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan without identity headers.");
      fake.deliverQueue.push(
        deliverOutcome({
          reply: { ...plan.reply, taskId: null, iteration: null },
          replyText: plan.replyText,
          signals: ["missing_task_id", "missing_iteration"],
        })
      );

      const outcome = await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(outcome.transport?.signals).toEqual(["missing_task_id", "missing_iteration"]);
      expect(readRotationState(workspace.id).abnormalSignals).toBe(2);
    });

    it("forces a new chat when rotation recommends it", async () => {
      for (let index = 0; index < 10; index += 1) recordTaskStarted(workspace.id, CONNECTED_URL);
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(fake.deliverInputs[0].forceNewChat).toBe(true);
      expect(outcome.rotation).toEqual({ recommended: true, reason: "max_tasks_per_conversation" });
    });

    it("honors --new-chat even without a rotation recommendation", async () => {
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await startTaskWithTransport(
        scope(),
        { goal: GOAL, taskId: TASK_ID, newChat: true },
        { transport: asTransport(fake), prefs: PREFS }
      );

      expect(fake.deliverInputs[0].forceNewChat).toBe(true);
      expect(outcome.rotation).toEqual({ recommended: false, reason: null });
    });

    it("delivers into the conversation recorded by rotation before the connected session", async () => {
      recordRoundtrip(workspace.id, ROTATED_URL);
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      fake.deliverQueue.push(deliverOutcome({ chatUrl: ROTATED_URL, reply: plan.reply, replyText: plan.replyText }));

      await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(fake.deliverInputs[0].chatUrl).toBe(ROTATED_URL);
    });

    it("wait:false sends INIT and returns an awaitingReply marker", async () => {
      const fake = new FakeTransport();
      fake.sendQueue.push({ chatUrl: CONNECTED_URL, sentMessageId: "msg-0-aaaaaaaa", reusedConfirmation: true });

      const outcome = await startTaskWithTransport(
        scope(),
        { goal: GOAL, taskId: TASK_ID },
        { transport: asTransport(fake), prefs: PREFS, wait: false }
      );

      expect(outcome.transport).toMatchObject({
        ok: true,
        awaitingReply: true,
        chatUrl: CONNECTED_URL,
        reusedConfirmation: true,
        signals: [],
      });
      expect(outcome.protocolState).toBe("INIT");
      expect(outcome.waitingFor).toBe("GPT_PLAN");
      expect(fake.deliverInputs).toHaveLength(0);
      expect(fake.sendInputs[0]).toMatchObject({ state: "INIT", iteration: 0, chatUrl: CONNECTED_URL });
      expect(readRotationState(workspace.id)).toMatchObject({ tasks: 1, roundtrips: 1 });
    });

    it("returns a transport failure with the pending message instead of throwing", async () => {
      const fake = new FakeTransport();
      fake.deliverQueue.push(new TransportError("CHROME_NOT_RUNNING", "Chrome is not running."));

      const outcome = await startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS });

      expect(outcome.transport).toEqual({
        ok: false,
        code: "CHROME_NOT_RUNNING",
        detail: "Chrome is not running.",
        manualFallback: outcome.message,
      });
      expect(outcome.message).toContain("[C2C]\nSTATE: INIT");
      expect(outcome.protocolState).toBe("INIT");
      expect(outcome.waitingFor).toBe("GPT_PLAN");
      expect(readRotationState(workspace.id).roundtrips).toBe(0);
    });

    it("throws PROTOCOL_IDENTITY_MISMATCH and CHATGPT_RESPONSE_UNPARSEABLE", async () => {
      const mismatch = new FakeTransport();
      mismatch.deliverQueue.push(new TransportError("PROTOCOL_IDENTITY_MISMATCH", "Reply is for another task."));
      await expect(
        startTaskWithTransport(scope("hard-a"), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(mismatch), prefs: PREFS })
      ).rejects.toMatchObject({ name: "TransportError", code: "PROTOCOL_IDENTITY_MISMATCH" });

      const unparseable = new FakeTransport();
      unparseable.deliverQueue.push(new TransportError("CHATGPT_RESPONSE_UNPARSEABLE", "No STATE header."));
      await expect(
        startTaskWithTransport(scope("hard-b"), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(unparseable), prefs: PREFS })
      ).rejects.toMatchObject({ name: "TransportError", code: "CHATGPT_RESPONSE_UNPARSEABLE" });
    });

    it("rejects an invalid review-iterations flag", async () => {
      const fake = new FakeTransport();
      await expect(
        startTaskWithTransport(scope(), { goal: GOAL, taskId: TASK_ID }, { transport: asTransport(fake), prefs: PREFS, reviewIterations: "0" })
      ).rejects.toThrow(/review-iterations/);
    });
  });

  describe("executedWithTransport", () => {
    it("manual mode returns the plain lifecycle result without a transport key", async () => {
      seedPlan("c2c_manual", 1);
      const viaRoundtrip = await executedWithTransport(
        scope(),
        { taskId: "c2c_manual", iteration: 1, changedFiles: 2, tests: "5 passed" },
        { transport: null }
      );
      expect("transport" in viaRoundtrip).toBe(false);
      expect(viaRoundtrip.protocolState).toBe("EXECUTED_SENT");
    });

    it("records the PLAN and continues the review loop", async () => {
      seedPlan(TASK_ID, 1);
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 2, "Round 2 plan.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(fake), prefs: PREFS }
      );

      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.waitingFor).toBe("none");
      expect(outcome.iteration).toBe(2);
      expect(outcome.decision).toEqual({ action: "continue", iteration: 2, reason: "REVIEW_CONTINUE" });
      expect(outcome.transport).toMatchObject({ ok: true, chatUrl: CONNECTED_URL });
      expect(outcome.transport?.replyText).toBe(plan.replyText);
      expect(fake.deliverInputs[0]).toMatchObject({ state: "EXECUTED", iteration: 1, chatUrl: CONNECTED_URL });
      expect(fake.deliverInputs[0].message).toContain("[C2C]\nSTATE: EXECUTED");
      expect(readRotationState(workspace.id).roundtrips).toBe(1);
    });

    it("records the terminal reply and keeps waiting", async () => {
      seedPlan(TASK_ID, 1);
      const fake = new FakeTransport();
      const done = exchange("DONE", TASK_ID, 1, "All good.");
      fake.deliverQueue.push(deliverOutcome({ reply: done.reply, replyText: done.replyText }));

      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(fake), prefs: PREFS }
      );

      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("GPT_REVIEW");
      expect(outcome.decision).toEqual({ action: "terminal", iteration: 1, reason: "TERMINAL_REPLY_DONE" });
      expect(outcome.transport?.reply?.state).toBe("DONE");
    });

    it("pauses with the four resume choices when the review limit is reached", async () => {
      seedPlan(TASK_ID, 1);
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "One more round.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(fake), prefs: PREFS, reviewIterations: "1" }
      );

      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.waitingFor).toBe("USER");
      expect(outcome.iteration).toBe(1);
      expect(outcome.decision).toEqual({ action: "limit_reached", iteration: 1, reason: "REVIEW_LIMIT_REACHED" });
      expect(outcome.choices).toEqual([
        "Continue 1 iteration: c2c task resume --executor opencode --agent-session rt-1 --transport chrome --review-iterations 2",
        "Continue 3 iterations: c2c task resume --executor opencode --agent-session rt-1 --transport chrome --review-iterations 4",
        "Continue until done: c2c task resume --executor opencode --agent-session rt-1 --transport chrome --review-iterations until_done",
        "Stop: no command needed; the task stays paused (checkpoint kept).",
      ]);
      expect(readAgentSessionCheckpoint(workspace.id, EXECUTOR, SESSION)?.reviewIterations).toBe(1);
    });

    it("pauses on the no-progress fuse without recording a new PLAN", async () => {
      seedPlan(TASK_ID, 1);
      const roundOne = new FakeTransport();
      const planTwo = exchange("PLAN", TASK_ID, 2, "Continue.");
      roundOne.deliverQueue.push(deliverOutcome({ reply: planTwo.reply, replyText: planTwo.replyText }));
      await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/a.ts"], tests: "5 passed" },
        { transport: asTransport(roundOne), prefs: PREFS }
      );

      appendExecutionRecord(workspace.id, {
        taskId: "c2c_other",
        iteration: 9,
        changedFiles: ["other.ts"],
        tests: "1 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        executor: EXECUTOR,
      });

      const fake = new FakeTransport();
      const planThree = exchange("PLAN", TASK_ID, 3, "Same state as before.");
      fake.deliverQueue.push(deliverOutcome({ reply: planThree.reply, replyText: planThree.replyText }));
      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 2, changedFiles: ["src/a.ts"], tests: "5 passed" },
        { transport: asTransport(fake), prefs: PREFS }
      );

      expect(outcome.decision).toEqual({ action: "no_progress", iteration: 2, reason: "NO_PROGRESS_DETECTED" });
      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("USER");
      expect(outcome.iteration).toBe(2);
      expect(outcome.choices).toBeUndefined();
    });

    it("wait:false sends EXECUTED and skips the review evaluation", async () => {
      seedPlan(TASK_ID, 1);
      const fake = new FakeTransport();
      fake.sendQueue.push({ chatUrl: CONNECTED_URL, sentMessageId: "msg-0-aaaaaaaa", reusedConfirmation: false });

      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(fake), prefs: PREFS, wait: false }
      );

      expect(outcome.transport).toMatchObject({ ok: true, awaitingReply: true, signals: [] });
      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("GPT_REVIEW");
      expect(outcome.decision).toBeUndefined();
      expect(fake.deliverInputs).toHaveLength(0);
      expect(fake.sendInputs[0]).toMatchObject({ state: "EXECUTED", iteration: 1 });
    });

    it("returns a transport failure with the pending EXECUTED message", async () => {
      seedPlan(TASK_ID, 1);
      const fake = new FakeTransport();
      fake.deliverQueue.push(new TransportError("CHATGPT_RESPONSE_TIMEOUT", "No stable reply within 100 ms."));

      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(fake), prefs: PREFS }
      );

      expect(outcome.transport).toEqual({
        ok: false,
        code: "CHATGPT_RESPONSE_TIMEOUT",
        detail: "No stable reply within 100 ms.",
        manualFallback: outcome.message,
      });
      expect(outcome.message).toContain("[C2C]\nSTATE: EXECUTED");
      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("GPT_REVIEW");
      expect(outcome.decision).toBeUndefined();
    });

    it("uses the checkpoint review limit on later rounds without repeating the flag", async () => {
      seedPlan(TASK_ID, 1);
      const first = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "One more round.");
      first.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));
      await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/b.ts"], tests: "6 passed" },
        { transport: asTransport(first), prefs: PREFS, reviewIterations: "1" }
      );
      expect(readAgentSessionCheckpoint(workspace.id, EXECUTOR, SESSION)?.waitingFor).toBe("USER");

      // Resume without a new limit keeps the stored one; the next round honors it.
      const resumed = await resumeWithTransport(scope(), {
        transport: asTransport(new FakeTransport()),
        prefs: PREFS,
      });
      expect(resumed.waitingFor).toBe("none");
      expect(readAgentSessionCheckpoint(workspace.id, EXECUTOR, SESSION)?.reviewIterations).toBe(1);

      const second = new FakeTransport();
      const plan2 = exchange("PLAN", TASK_ID, 2, "Round two.");
      second.deliverQueue.push(deliverOutcome({ reply: plan2.reply, replyText: plan2.replyText }));
      const outcome = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 1, changedFiles: ["src/c.ts"], tests: "7 passed" },
        { transport: asTransport(second), prefs: PREFS }
      );

      expect(outcome.decision?.action).toBe("limit_reached");
      expect(outcome.choices?.[0]).toContain("--review-iterations 2");
    });
  });

  describe("resumeWithTransport", () => {
    it("throws when there is no active checkpoint", async () => {
      await expect(resumeWithTransport(scope("nobody"), { transport: asTransport(new FakeTransport()), prefs: PREFS })).rejects.toThrow(
        /No active checkpoint/
      );
    });

    it("rebuilds the INIT message when waiting for the plan", async () => {
      startTask(scope(), { goal: GOAL, taskId: TASK_ID });
      const fake = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));

      const outcome = await resumeWithTransport(scope(), { transport: asTransport(fake), prefs: PREFS });

      expect(fake.deliverInputs[0]).toMatchObject({ taskId: TASK_ID, state: "INIT", iteration: 0, chatUrl: CONNECTED_URL });
      expect(fake.deliverInputs[0].message).toBe(
        buildInitMessage({ taskId: TASK_ID, goal: GOAL, connectorName: CONNECTOR, workspaceName: workspace.name })
      );
      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.iteration).toBe(1);
      expect(outcome.transport?.replyText).toBe(plan.replyText);
    });

    it("resumes an awaiting message with the same delivery identity so it is never resent", async () => {
      const first = new FakeTransport();
      first.sendQueue.push({ chatUrl: CONNECTED_URL, sentMessageId: "msg-0-aaaaaaaa", reusedConfirmation: false });
      const started = await startTaskWithTransport(
        scope(),
        { goal: GOAL, taskId: TASK_ID },
        { transport: asTransport(first), prefs: PREFS, wait: false }
      );
      expect(started.transport).toMatchObject({ ok: true, awaitingReply: true });

      const second = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 1, "Plan body.");
      second.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText, reusedConfirmation: true }));

      const outcome = await resumeWithTransport(scope(), { transport: asTransport(second), prefs: PREFS });

      // Same ledger key (taskId:STATE:iteration) as the original send, so the
      // transport's reuse path confirms instead of resending; reusedConfirmation
      // is surfaced to the caller.
      expect(first.sendInputs[0]).toMatchObject({ taskId: TASK_ID, state: "INIT", iteration: 0 });
      expect(second.deliverInputs[0]).toMatchObject({ taskId: TASK_ID, state: "INIT", iteration: 0 });
      expect(outcome.transport).toMatchObject({ ok: true, reusedConfirmation: true });
      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.transport?.replyText).toBe(plan.replyText);
      expect(readRotationState(workspace.id).roundtrips).toBe(2);
    });

    it("rebuilds the EXECUTED message from the latest execution record when waiting for review", async () => {
      seedExecuted(TASK_ID, 3, ["src/a.ts"]);
      const fake = new FakeTransport();
      const done = exchange("DONE", TASK_ID, 3, "Review verdict.");
      fake.deliverQueue.push(deliverOutcome({ reply: done.reply, replyText: done.replyText }));

      const outcome = await resumeWithTransport(scope(), { transport: asTransport(fake), prefs: PREFS });

      expect(fake.deliverInputs[0]).toMatchObject({ taskId: TASK_ID, state: "EXECUTED", iteration: 3 });
      expect(fake.deliverInputs[0].message).toBe(
        buildExecutedMessage({
          taskId: TASK_ID,
          iteration: 3,
          changedFiles: ["src/a.ts"],
          tests: "5 passed",
          exitStatus: "ok",
          connectorName: CONNECTOR,
        })
      );
      expect(outcome.decision).toEqual({ action: "terminal", iteration: 3, reason: "TERMINAL_REPLY_DONE" });
      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("GPT_REVIEW");
    });

    it("manual mode rebuilds the pending message without a transport key", async () => {
      startTask(scope(), { goal: GOAL, taskId: TASK_ID });
      const outcome = await resumeWithTransport(scope(), { transport: null });
      expect("transport" in outcome).toBe(false);
      expect(outcome.message).toBe(
        buildInitMessage({ taskId: TASK_ID, goal: GOAL, connectorName: CONNECTOR, workspaceName: workspace.name })
      );
      expect(outcome.protocolState).toBe("INIT");
    });

    it("applies the chosen limit when paused at the review limit", async () => {
      seedPlan(TASK_ID, 1);
      saveAgentSessionCheckpoint(workspace.id, EXECUTOR, SESSION, {
        taskId: TASK_ID,
        checkpoint: { protocolState: "PLAN_RECEIVED", waitingFor: "USER" },
      });
      const fake = new FakeTransport();

      const outcome = await resumeWithTransport(scope(), {
        transport: asTransport(fake),
        prefs: PREFS,
        reviewIterations: "5",
      });

      expect(fake.deliverInputs).toHaveLength(0);
      expect(outcome.transport).toBeUndefined();
      expect(outcome.protocolState).toBe("PLAN_RECEIVED");
      expect(outcome.waitingFor).toBe("none");
      expect(outcome.checkpoint.reviewIterations).toBe(5);
      expect(readAgentSessionCheckpoint(workspace.id, EXECUTOR, SESSION)).toMatchObject({
        waitingFor: "none",
        reviewIterations: 5,
      });
    });

    it("re-evaluates the latest reply when paused on the no-progress fuse", async () => {
      seedExecuted(TASK_ID, 1, ["src/a.ts"]);
      markPlan(scope(), { taskId: TASK_ID, iteration: 2 });
      const first = new FakeTransport();
      const plan = exchange("PLAN", TASK_ID, 3, "Same state as before.");
      first.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));
      const paused = await executedWithTransport(
        scope(),
        { taskId: TASK_ID, iteration: 2, changedFiles: ["src/a.ts"], tests: "5 passed" },
        { transport: asTransport(first), prefs: PREFS }
      );
      expect(paused.waitingFor).toBe("USER");

      const fake = new FakeTransport();
      fake.deliverQueue.push(deliverOutcome({ reply: plan.reply, replyText: plan.replyText }));
      const outcome = await resumeWithTransport(scope(), { transport: asTransport(fake), prefs: PREFS });

      expect(fake.deliverInputs).toHaveLength(1);
      expect(fake.deliverInputs[0]).toMatchObject({ state: "EXECUTED", iteration: 2 });
      expect(fake.deliverInputs[0].message).toContain("[C2C]\nSTATE: EXECUTED");
      expect(outcome.decision).toEqual({ action: "no_progress", iteration: 2, reason: "NO_PROGRESS_DETECTED" });
      expect(outcome.protocolState).toBe("EXECUTED_SENT");
      expect(outcome.waitingFor).toBe("USER");
    });

    it("returns a transport failure with the rebuilt pending message", async () => {
      startTask(scope(), { goal: GOAL, taskId: TASK_ID });
      const fake = new FakeTransport();
      fake.deliverQueue.push(new TransportError("CHATGPT_LOGIN_REQUIRED", "Log in first."));

      const outcome = await resumeWithTransport(scope(), { transport: asTransport(fake), prefs: PREFS });

      expect(outcome.transport).toEqual({
        ok: false,
        code: "CHATGPT_LOGIN_REQUIRED",
        detail: "Log in first.",
        manualFallback: outcome.message,
      });
      expect(outcome.message).toContain("[C2C]\nSTATE: INIT");
    });
  });
});
