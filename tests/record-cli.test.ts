import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords, type ExecutionRecord } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runRecord(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "record", "--workspace", root, "--task", "c2c_test", ...args],
    { cwd: projectRoot, encoding: "utf8", env: process.env }
  );
}

function withRecordEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;

  try {
    run(root, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

describe("c2c record", () => {
  it("records valid numeric options and command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "2",
        "--changed-files",
        "3",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 2 }),
      ]);
    });
  });

  it("records the executor that ran the iteration", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--executor", "opencode"]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 1, executor: "opencode" }),
      ]);
    });
  });

  it("keeps recording when no executor is given, so older callers still work", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1"]);

      expect(result.status).toBe(0);
      const [record] = readExecutionRecords(workspace.id);
      expect(record.taskId).toBe("c2c_test");
      expect(record.executor).toBeUndefined();
    });
  });

  it("still parses legacy records that were written before executor existed", () => {
    withRecordEnvironment((_root, workspace) => {
      const file = path.join(process.env.C2C_STATE_DIR!, "executions", `${workspace.id}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(
        file,
        JSON.stringify({
          taskId: "c2c_legacy",
          iteration: 1,
          changedFiles: 2,
          tests: "12 passed",
          exitStatus: "ok",
          timestamp: new Date().toISOString(),
        }) + "\n"
      );

      const [record] = readExecutionRecords(workspace.id);
      expect(record.taskId).toBe("c2c_legacy");
      expect(record.executor).toBeUndefined();
    });
  });

  it("rejects a non-integer iteration without recording the execution", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "abc"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects an unsafe changed-file count before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--changed-files",
        "9".repeat(400),
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("rejects a negative changed-file count", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--changed-files=-1"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects a non-integer exit code before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "abc",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("decodes UTF-16 output files before sanitizing (private keys stay restricted)", () => {
    withRecordEnvironment((root, workspace) => {
      const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretmaterial\n-----END RSA PRIVATE KEY-----";
      const le = path.join(root, "key-utf16le.txt");
      fs.writeFileSync(le, Buffer.from(key, "utf16le"));
      const leBom = path.join(root, "key-utf16le-bom.txt");
      fs.writeFileSync(leBom, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(key, "utf16le")]));
      const swapped = Buffer.from(key, "utf16le");
      swapped.swap16();
      const beBom = path.join(root, "key-utf16be-bom.txt");
      fs.writeFileSync(beBom, Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]));

      const files = [le, leBom, beBom];
      for (const [index, file] of files.entries()) {
        const result = runRecord(root, [
          "--iteration",
          String(index + 1),
          "--command",
          `print-key-${index}`,
          "--output-file",
          file,
        ]);
        expect(result.status).toBe(0);
      }

      const outputs = listExecutionOutputs(workspace.id);
      expect(outputs.map((item) => item.allowed)).toEqual([false, false, false]);
      expect(outputs.map((item) => item.restrictedReason)).toEqual(["private_key", "private_key", "private_key"]);
    });
  });

  it("decodes UTF-16 log text into readable evidence", () => {
    withRecordEnvironment((root, workspace) => {
      const log = path.join(root, "utf16-log.txt");
      fs.writeFileSync(log, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("32 tests passed\n", "utf16le")]));

      const result = runRecord(root, ["--iteration", "1", "--command", "pnpm test", "--output-file", log]);
      expect(result.status).toBe(0);

      const [item] = listExecutionOutputs(workspace.id);
      expect(item.allowed).toBe(true);
      const body = readExecutionOutput(workspace.id, item.id);
      expect(body.ok).toBe(true);
      if (body.ok) expect(body.text).toContain("32 tests passed");
    });
  });
});

describe("execution record persistence", () => {
  it("rejects invalid records at the write boundary", () => {
    withRecordEnvironment((_root, workspace) => {
      const invalidRecord: ExecutionRecord = {
        taskId: "c2c_invalid",
        iteration: Number.NaN,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      };

      expect(() => appendExecutionRecord(workspace.id, invalidRecord)).toThrow();
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});
