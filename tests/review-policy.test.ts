import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "../src/execution/records.js";
import { detectNoProgress, evaluateReviewReply, resolveReviewIterations } from "../src/protocol/review-policy.js";

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    taskId: "c2c_ab12cd",
    iteration: 1,
    changedFiles: ["src/a.ts"],
    tests: "38 passed",
    exitStatus: "ok",
    timestamp: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

describe("resolveReviewIterations", () => {
  it("returns the preference unchanged when no flag is given", () => {
    expect(resolveReviewIterations(3)).toBe(3);
    expect(resolveReviewIterations("until_done")).toBe("until_done");
    expect(resolveReviewIterations(5, null)).toBe(5);
    expect(resolveReviewIterations(5, "")).toBe(5);
    expect(resolveReviewIterations(5, "   ")).toBe(5);
  });

  it("uses a trimmed numeric flag override", () => {
    expect(resolveReviewIterations(3, "5")).toBe(5);
    expect(resolveReviewIterations("until_done", " 7 ")).toBe(7);
  });

  it("accepts until_done as a flag override", () => {
    expect(resolveReviewIterations(3, "until_done")).toBe("until_done");
    expect(resolveReviewIterations(3, " until_done ")).toBe("until_done");
  });

  it("rejects invalid flag values with a field-naming error", () => {
    for (const flag of ["0", "-2", "3.5", "abc", "until done", "1e3", "Infinity", "NaN"]) {
      expect(() => resolveReviewIterations(3, flag)).toThrow(/review-iterations must be/);
    }
  });
});

describe("detectNoProgress", () => {
  it("is false with fewer than two records", () => {
    expect(detectNoProgress([])).toBe(false);
    expect(detectNoProgress([record()])).toBe(false);
  });

  it("is true when the last two records match on files, tests and exit status", () => {
    expect(detectNoProgress([record({ iteration: 1 }), record({ iteration: 2 })])).toBe(true);
  });

  it("normalizes whitespace in the tests summary", () => {
    const previous = record({ tests: "38 passed\n2 skipped " });
    const latest = record({ tests: "38   passed 2 skipped" });
    expect(detectNoProgress([previous, latest])).toBe(true);
    expect(detectNoProgress([previous, record({ tests: "39 passed 2 skipped" })])).toBe(false);
  });

  it("treats null tests as equal only to null", () => {
    expect(detectNoProgress([record({ tests: null }), record({ tests: null })])).toBe(true);
    expect(detectNoProgress([record({ tests: null }), record({ tests: "38 passed" })])).toBe(false);
  });

  it("compares changed file arrays by length and order", () => {
    expect(detectNoProgress([record({ changedFiles: ["a", "b"] }), record({ changedFiles: ["a", "b"] })])).toBe(
      true
    );
    expect(detectNoProgress([record({ changedFiles: ["a", "b"] }), record({ changedFiles: ["b", "a"] })])).toBe(
      false
    );
    expect(detectNoProgress([record({ changedFiles: ["a"] }), record({ changedFiles: ["a", "b"] })])).toBe(false);
  });

  it("compares numeric changed file counts numerically and never against arrays", () => {
    expect(detectNoProgress([record({ changedFiles: 2 }), record({ changedFiles: 2 })])).toBe(true);
    expect(detectNoProgress([record({ changedFiles: 2 }), record({ changedFiles: 3 })])).toBe(false);
    expect(detectNoProgress([record({ changedFiles: ["a", "b"] }), record({ changedFiles: 2 })])).toBe(false);
  });

  it("compares exit status exactly", () => {
    expect(detectNoProgress([record({ exitStatus: "failed" }), record({ exitStatus: "failed" })])).toBe(true);
    expect(detectNoProgress([record({ exitStatus: "ok" }), record({ exitStatus: "failed" })])).toBe(false);
    expect(detectNoProgress([record({ exitStatus: "ok" }), record({ exitStatus: "ok " })])).toBe(false);
  });

  it("only compares the most recent two records in order", () => {
    expect(
      detectNoProgress([
        record({ iteration: 1, exitStatus: "failed" }),
        record({ iteration: 2, exitStatus: "ok" }),
        record({ iteration: 3, exitStatus: "ok" }),
      ])
    ).toBe(true);
    expect(
      detectNoProgress([
        record({ iteration: 1, exitStatus: "ok" }),
        record({ iteration: 2, exitStatus: "ok" }),
        record({ iteration: 3, exitStatus: "failed" }),
      ])
    ).toBe(false);
  });
});

describe("evaluateReviewReply", () => {
  it("continues on a PLAN within the limit and targets the next iteration", () => {
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 1, limit: 3, records: [] })).toEqual({
      action: "continue",
      iteration: 2,
      reason: "REVIEW_CONTINUE",
    });
  });

  it("flags the limit when the review round reaches it", () => {
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 3, limit: 3, records: [] })).toEqual({
      action: "limit_reached",
      iteration: 3,
      reason: "REVIEW_LIMIT_REACHED",
    });
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 4, limit: 3, records: [] }).action).toBe(
      "limit_reached"
    );
  });

  it("never reaches the limit for until_done", () => {
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 10, limit: "until_done", records: [] })).toEqual({
      action: "continue",
      iteration: 11,
      reason: "REVIEW_CONTINUE",
    });
  });

  it("terminates on DONE, BLOCKED and ERROR naming the state", () => {
    for (const replyState of ["DONE", "BLOCKED", "ERROR"] as const) {
      expect(evaluateReviewReply({ replyState, reviewRound: 2, limit: 3, records: [] })).toEqual({
        action: "terminal",
        iteration: 2,
        reason: `TERMINAL_REPLY_${replyState}`,
      });
    }
  });

  it("prefers no progress over a reached limit", () => {
    const records = [record({ iteration: 1 }), record({ iteration: 2 })];
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 3, limit: 3, records })).toEqual({
      action: "no_progress",
      iteration: 3,
      reason: "NO_PROGRESS_DETECTED",
    });
  });

  it("detects no progress below the limit too", () => {
    const records = [record({ iteration: 1 }), record({ iteration: 2 })];
    expect(evaluateReviewReply({ replyState: "PLAN", reviewRound: 1, limit: 3, records })).toEqual({
      action: "no_progress",
      iteration: 1,
      reason: "NO_PROGRESS_DETECTED",
    });
  });

  it("does not run the no-progress fuse for terminal replies", () => {
    const records = [record({ iteration: 1 }), record({ iteration: 2 })];
    expect(evaluateReviewReply({ replyState: "DONE", reviewRound: 2, limit: 3, records }).action).toBe("terminal");
  });
});
