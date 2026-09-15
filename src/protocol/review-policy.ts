import type { ExecutionRecord } from "../execution/records.js";

export type ReviewIterations = number | "until_done";

export interface ReviewEvaluation {
  action: "continue" | "limit_reached" | "no_progress" | "terminal";
  iteration: number;
  reason: string;
}

/**
 * Review iteration limit resolution: a non-blank `--review-iterations` flag
 * wins over the preference. Invalid flags throw instead of silently falling
 * back, mirroring `src/config/prefs.ts`.
 */
export function resolveReviewIterations(pref: ReviewIterations, flag?: string | null): ReviewIterations {
  const value = flag?.trim() ?? "";
  if (value === "") return pref;
  if (value === "until_done") return "until_done";
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  throw new Error("review-iterations must be a positive integer or until_done");
}

function normalizeTests(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, " ").trim();
}

function changedFilesEqual(left: string[] | number, right: string[] | number): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (typeof left === "number" && typeof right === "number") return left === right;
  return false;
}

/** True when the last two records agree on changed files, tests and exit status. */
export function detectNoProgress(records: ExecutionRecord[]): boolean {
  if (records.length < 2) return false;
  const previous = records[records.length - 2];
  const latest = records[records.length - 1];
  return (
    changedFilesEqual(previous.changedFiles, latest.changedFiles) &&
    normalizeTests(previous.tests) === normalizeTests(latest.tests) &&
    previous.exitStatus === latest.exitStatus
  );
}

/**
 * Decide what a ChatGPT review reply means for the loop. `reviewRound` is the
 * 1-based number of the round being evaluated; `iteration` on the result is the
 * iteration the action applies to.
 */
export function evaluateReviewReply(input: {
  replyState: "PLAN" | "DONE" | "BLOCKED" | "ERROR";
  reviewRound: number;
  limit: ReviewIterations;
  records: ExecutionRecord[];
}): ReviewEvaluation {
  if (input.replyState !== "PLAN") {
    return {
      action: "terminal",
      iteration: input.reviewRound,
      reason: `TERMINAL_REPLY_${input.replyState}`,
    };
  }
  if (detectNoProgress(input.records)) {
    return { action: "no_progress", iteration: input.reviewRound, reason: "NO_PROGRESS_DETECTED" };
  }
  if (input.limit !== "until_done" && input.reviewRound >= input.limit) {
    return { action: "limit_reached", iteration: input.reviewRound, reason: "REVIEW_LIMIT_REACHED" };
  }
  return { action: "continue", iteration: input.reviewRound + 1, reason: "REVIEW_CONTINUE" };
}
