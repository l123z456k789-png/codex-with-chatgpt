import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRotationState,
  recordAbnormalSignals,
  recordRoundtrip,
  recordTaskStarted,
  resetConversation,
  rotationRecommendation,
  type RotationState,
} from "../src/conversation/rotation.js";
import { cleanup, isolateStateDir, write } from "./helpers.js";

describe("conversation rotation state", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  const CHAT_URL = "https://chatgpt.com/c/abc-123";
  const OTHER_URL = "https://chatgpt.com/c/def-456";

  it("starts from a zeroed default state when nothing is stored", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    const state = readRotationState("demo");
    expect(state.chatUrl).toBeNull();
    expect(state.tasks).toBe(0);
    expect(state.roundtrips).toBe(0);
    expect(state.abnormalSignals).toBe(0);
    expect(Number.isNaN(Date.parse(state.updatedAt))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "transport", "conversations", "demo.json"))).toBe(false);
  });

  it("persists the chat url and increments the task count", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    const first = recordTaskStarted("demo", CHAT_URL);
    expect(first.chatUrl).toBe(CHAT_URL);
    expect(first.tasks).toBe(1);
    expect(first.roundtrips).toBe(0);
    expect(first.abnormalSignals).toBe(0);
    expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);

    const file = path.join(stateDir, "transport", "conversations", "demo.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(first);

    const second = recordTaskStarted("demo", CHAT_URL);
    expect(second.tasks).toBe(2);
    expect(readRotationState("demo")).toEqual(second);
  });

  it("counts roundtrips and abnormal signals for the active conversation", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    expect(recordRoundtrip("demo", CHAT_URL).roundtrips).toBe(1);
    expect(recordRoundtrip("demo", CHAT_URL).roundtrips).toBe(2);

    const state = recordAbnormalSignals("demo", 2);
    expect(state.abnormalSignals).toBe(2);
    expect(state.tasks).toBe(1);
    expect(state.roundtrips).toBe(2);
    expect(readRotationState("demo")).toEqual(state);
  });

  it("resets counters when recordTaskStarted switches to a new chat url", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    recordRoundtrip("demo", CHAT_URL);
    recordAbnormalSignals("demo", 2);

    const next = recordTaskStarted("demo", OTHER_URL);
    expect(next.chatUrl).toBe(OTHER_URL);
    expect(next.tasks).toBe(1);
    expect(next.roundtrips).toBe(0);
    expect(next.abnormalSignals).toBe(0);
  });

  it("resets counters when recordRoundtrip switches to a new chat url", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    recordRoundtrip("demo", CHAT_URL);
    recordAbnormalSignals("demo", 2);

    const next = recordRoundtrip("demo", OTHER_URL);
    expect(next.chatUrl).toBe(OTHER_URL);
    expect(next.tasks).toBe(0);
    expect(next.roundtrips).toBe(1);
    expect(next.abnormalSignals).toBe(0);
  });

  it("keeps counters when the chat url is unchanged", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    recordRoundtrip("demo", CHAT_URL);
    recordAbnormalSignals("demo", 1);

    const next = recordRoundtrip("demo", CHAT_URL);
    expect(next.chatUrl).toBe(CHAT_URL);
    expect(next.tasks).toBe(1);
    expect(next.roundtrips).toBe(2);
    expect(next.abnormalSignals).toBe(1);
  });

  it("resetConversation stores the url with zeroed counters", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    recordRoundtrip("demo", CHAT_URL);
    recordAbnormalSignals("demo", 3);

    const reset = resetConversation("demo", OTHER_URL);
    expect(reset.chatUrl).toBe(OTHER_URL);
    expect(reset.tasks).toBe(0);
    expect(reset.roundtrips).toBe(0);
    expect(reset.abnormalSignals).toBe(0);
    expect(readRotationState("demo")).toEqual(reset);
    expect(recordTaskStarted("demo", OTHER_URL).tasks).toBe(1);
  });

  it("rejects an invalid abnormal signal count without changing the counters", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("demo", CHAT_URL);
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => recordAbnormalSignals("demo", invalid)).toThrow(/abnormal-signals/);
    }
    expect(readRotationState("demo").abnormalSignals).toBe(0);
    expect(recordAbnormalSignals("demo", 0).abnormalSignals).toBe(0);
  });

  it("treats a corrupt or malformed state file as the default state", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    write(stateDir, "transport/conversations/demo.json", "{ this is not json");
    const corrupt = readRotationState("demo");
    expect(corrupt.chatUrl).toBeNull();
    expect(corrupt.tasks).toBe(0);
    expect(corrupt.roundtrips).toBe(0);
    expect(corrupt.abnormalSignals).toBe(0);
    expect(Number.isNaN(Date.parse(corrupt.updatedAt))).toBe(false);

    write(stateDir, "transport/conversations/demo.json", "[1,2,3]");
    const malformed = readRotationState("demo");
    expect(malformed.chatUrl).toBeNull();
    expect(malformed.tasks).toBe(0);
  });

  it("falls back per field when stored values have the wrong type", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    write(
      stateDir,
      "transport/conversations/demo.json",
      JSON.stringify({ chatUrl: 42, tasks: "many", roundtrips: -2, abnormalSignals: 1.5, updatedAt: 7 })
    );
    const state = readRotationState("demo");
    expect(state.chatUrl).toBeNull();
    expect(state.tasks).toBe(0);
    expect(state.roundtrips).toBe(0);
    expect(state.abnormalSignals).toBe(0);
    expect(Number.isNaN(Date.parse(state.updatedAt))).toBe(false);
  });

  it("keeps a valid chat url and counters when other fields are missing", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    write(
      stateDir,
      "transport/conversations/demo.json",
      JSON.stringify({ chatUrl: CHAT_URL, tasks: 2, abnormalSignals: 1 })
    );
    expect(readRotationState("demo")).toMatchObject({
      chatUrl: CHAT_URL,
      tasks: 2,
      roundtrips: 0,
      abnormalSignals: 1,
    });
  });

  it("keeps workspaces isolated", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    recordTaskStarted("one", CHAT_URL);
    expect(readRotationState("one").tasks).toBe(1);
    expect(readRotationState("two")).toMatchObject({ chatUrl: null, tasks: 0, roundtrips: 0, abnormalSignals: 0 });
    expect(fs.existsSync(path.join(stateDir, "transport", "conversations", "one.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "transport", "conversations", "two.json"))).toBe(false);
  });

  describe("rotationRecommendation", () => {
    const THRESHOLDS = { maxTasksPerConversation: 10, maxProtocolRoundtrips: 30, maxAbnormalSignals: 3 };
    const BASE: RotationState = {
      chatUrl: CHAT_URL,
      tasks: 0,
      roundtrips: 0,
      abnormalSignals: 0,
      updatedAt: "2026-01-02T03:04:05.000Z",
    };

    it("recommends rotation when any threshold is reached and names the trigger", () => {
      expect(rotationRecommendation({ ...BASE, tasks: 10 }, THRESHOLDS)).toEqual({
        recommended: true,
        reason: "max_tasks_per_conversation",
      });
      expect(rotationRecommendation({ ...BASE, roundtrips: 30 }, THRESHOLDS)).toEqual({
        recommended: true,
        reason: "max_protocol_roundtrips",
      });
      expect(rotationRecommendation({ ...BASE, abnormalSignals: 3 }, THRESHOLDS)).toEqual({
        recommended: true,
        reason: "max_abnormal_signals",
      });
    });

    it("does not recommend rotation below every threshold", () => {
      const state: RotationState = { ...BASE, tasks: 9, roundtrips: 29, abnormalSignals: 2 };
      expect(rotationRecommendation(state, THRESHOLDS)).toEqual({ recommended: false, reason: null });
    });

    it("reports the first exceeded trigger in tasks, roundtrips, signals order", () => {
      const state: RotationState = { ...BASE, tasks: 1, roundtrips: 1, abnormalSignals: 1 };
      const thresholds = { maxTasksPerConversation: 1, maxProtocolRoundtrips: 1, maxAbnormalSignals: 1 };
      expect(rotationRecommendation(state, thresholds)).toEqual({
        recommended: true,
        reason: "max_tasks_per_conversation",
      });
    });
  });
});
