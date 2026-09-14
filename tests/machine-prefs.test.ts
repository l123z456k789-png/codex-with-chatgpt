import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeMachinePrefs,
  prefsFile,
  readMachinePrefs,
  resolveTransportMode,
} from "../src/config/prefs.js";
import { mergeUiPrefs, readUiPrefs } from "../src/config/ui-prefs.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("machine prefs", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_TRANSPORT;
  });

  it("defaults to manual transport and the documented review settings", () => {
    dirs.push(isolateStateDir());
    expect(readMachinePrefs()).toEqual({
      developerModeEnabled: false,
      setupMode: null,
      transport: null,
      defaultMode: "full",
      defaultReviewIterations: 3,
      maxTasksPerConversation: 10,
      maxProtocolRoundtrips: 30,
      maxAbnormalSignals: 3,
      replyTimeoutSeconds: 600,
    });
  });

  it("persists transport and review settings next to the existing ui prefs", () => {
    dirs.push(isolateStateDir());
    mergeMachinePrefs({
      transport: "chrome",
      defaultMode: "review",
      defaultReviewIterations: "until_done",
      maxTasksPerConversation: 4,
      maxProtocolRoundtrips: 12,
      maxAbnormalSignals: 2,
      replyTimeoutSeconds: 120,
    });
    const prefs = readMachinePrefs();
    expect(prefs.transport).toBe("chrome");
    expect(prefs.defaultMode).toBe("review");
    expect(prefs.defaultReviewIterations).toBe("until_done");
    expect(prefs.maxTasksPerConversation).toBe(4);
    expect(prefs.maxProtocolRoundtrips).toBe(12);
    expect(prefs.maxAbnormalSignals).toBe(2);
    expect(prefs.replyTimeoutSeconds).toBe(120);

    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Record<string, unknown>;
    expect(raw.transport).toBe("chrome");
    expect(raw.defaultReviewIterations).toBe("until_done");
    expect(typeof raw.updatedAt).toBe("string");
  });

  it("only ever persists developer mode as on", () => {
    dirs.push(isolateStateDir());
    mergeMachinePrefs({ transport: "chrome" });
    mergeMachinePrefs({ developerModeEnabled: true });
    expect(readMachinePrefs().developerModeEnabled).toBe(true);
    expect(readMachinePrefs().transport).toBe("chrome");

    fs.writeFileSync(prefsFile(), JSON.stringify({ developerModeEnabled: false, transport: "manual" }), { mode: 0o600 });
    expect(readMachinePrefs().developerModeEnabled).toBe(false);

    mergeMachinePrefs({ transport: "chrome" });
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Record<string, unknown>;
    expect(raw.developerModeEnabled).toBeUndefined();
    expect(readMachinePrefs().developerModeEnabled).toBe(false);
    expect(readMachinePrefs().transport).toBe("chrome");
  });

  it("rejects invalid values naming the field", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeMachinePrefs({ transport: "browser" as "chrome" })).toThrow(/transport/);
    expect(() => mergeMachinePrefs({ defaultMode: "quick" as "full" })).toThrow(/default-mode/);
    expect(() => mergeMachinePrefs({ defaultReviewIterations: 0 })).toThrow(/review-iterations/);
    expect(() => mergeMachinePrefs({ defaultReviewIterations: "later" as "until_done" })).toThrow(/review-iterations/);
    expect(() => mergeMachinePrefs({ maxTasksPerConversation: 0 })).toThrow(/max-tasks-per-conversation/);
    expect(() => mergeMachinePrefs({ maxProtocolRoundtrips: -1 })).toThrow(/max-roundtrips/);
    expect(() => mergeMachinePrefs({ maxAbnormalSignals: 1.5 })).toThrow(/max-abnormal-signals/);
    expect(() => mergeMachinePrefs({ replyTimeoutSeconds: 0 })).toThrow(/reply-timeout/);
    expect(readMachinePrefs().transport).toBeNull();
  });

  it("ignores invalid stored values instead of failing the read", () => {
    dirs.push(isolateStateDir());
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ transport: "browser", defaultMode: "quick", defaultReviewIterations: 0 }),
      { mode: 0o600 }
    );
    const prefs = readMachinePrefs();
    expect(prefs.transport).toBeNull();
    expect(prefs.defaultMode).toBe("full");
    expect(prefs.defaultReviewIterations).toBe(3);
  });

  it("resolves transport mode flag > env > prefs > manual", () => {
    dirs.push(isolateStateDir());
    expect(resolveTransportMode()).toBe("manual");
    expect(resolveTransportMode(null)).toBe("manual");

    mergeMachinePrefs({ transport: "chrome" });
    expect(resolveTransportMode()).toBe("chrome");
    expect(resolveTransportMode("manual")).toBe("manual");

    process.env.C2C_TRANSPORT = "manual";
    expect(resolveTransportMode()).toBe("manual");
    expect(resolveTransportMode("chrome")).toBe("chrome");
    expect(resolveTransportMode(" CHROME ")).toBe("chrome");

    process.env.C2C_TRANSPORT = "browser";
    expect(() => resolveTransportMode()).toThrow(/C2C_TRANSPORT/);
    expect(resolveTransportMode("manual")).toBe("manual");
    expect(() => resolveTransportMode("browser")).toThrow(/transport/);
  });
});

describe("ui prefs delegate to the machine prefs file", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_TRANSPORT;
  });

  it("shares one file so setting transport never drops developer mode or setup mode", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ developerModeEnabled: true, setupMode: "auto" });
    mergeMachinePrefs({ transport: "chrome", defaultReviewIterations: 5 });

    expect(readUiPrefs().developerModeEnabled).toBe(true);
    expect(readUiPrefs().setupMode).toBe("auto");
    expect(readMachinePrefs().transport).toBe("chrome");
    expect(readMachinePrefs().defaultReviewIterations).toBe(5);

    mergeUiPrefs({ setupMode: "manual" });
    expect(readMachinePrefs().transport).toBe("chrome");
    expect(readMachinePrefs().defaultReviewIterations).toBe(5);
    expect(readUiPrefs().setupMode).toBe("manual");
  });
});

describe("c2c prefs machine settings", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_TRANSPORT;
  });

  it("prefs get shows transport and review settings as text", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "get"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("传输方式：尚未选择（默认 manual）");
    expect(result.stdout).toContain("任务模式：full");
    expect(result.stdout).toContain("审查轮数上限：3");
    expect(result.stdout).toContain("单对话任务上限：10");
    expect(result.stdout).toContain("协议轮次上限：30");
    expect(result.stdout).toContain("异常信号上限：3");
    expect(result.stdout).toContain("回复超时：600 秒");
  });

  it("prefs get --json includes the machine settings", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "get", "--json"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });

    expect(result.status).toBe(0);
    const payload = lastJson(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.transport).toBeNull();
    expect(payload.defaultMode).toBe("full");
    expect(payload.defaultReviewIterations).toBe(3);
    expect(payload.maxTasksPerConversation).toBe(10);
    expect(payload.maxProtocolRoundtrips).toBe(30);
    expect(payload.maxAbnormalSignals).toBe(3);
    expect(payload.replyTimeoutSeconds).toBe(600);
  });

  it("prefs set stores the new flags with the existing output style", () => {
    dirs.push(isolateStateDir());
    const result = runCli(
      [
        "prefs",
        "set",
        "--transport",
        "chrome",
        "--default-mode",
        "review",
        "--review-iterations",
        "until_done",
        "--max-tasks-per-conversation",
        "4",
        "--max-roundtrips",
        "12",
        "--reply-timeout",
        "120",
        "--developer-mode",
        "--setup-mode",
        "auto",
      ],
      { C2C_STATE_DIR: process.env.C2C_STATE_DIR }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ 已记住传输方式：chrome");
    expect(result.stdout).toContain("✓ 已记住任务模式：review");
    expect(result.stdout).toContain("✓ 已记住审查轮数上限：until_done");
    expect(result.stdout).toContain("✓ 已记住单对话任务上限：4");
    expect(result.stdout).toContain("✓ 已记住协议轮次上限：12");
    expect(result.stdout).toContain("✓ 已记住回复超时：120 秒");
    expect(result.stdout).toContain("✓ 已记住开发人员模式已开启");
    expect(result.stdout).toContain("✓ 已记住配置方式：AI 自动化配置（预览版）");

    const prefs = readMachinePrefs();
    expect(prefs.transport).toBe("chrome");
    expect(prefs.defaultMode).toBe("review");
    expect(prefs.defaultReviewIterations).toBe("until_done");
    expect(prefs.maxTasksPerConversation).toBe(4);
    expect(prefs.maxProtocolRoundtrips).toBe(12);
    expect(prefs.replyTimeoutSeconds).toBe(120);
    expect(prefs.developerModeEnabled).toBe(true);
    expect(prefs.setupMode).toBe("auto");

    const followUp = runCli(["prefs", "set", "--transport", "manual"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });
    expect(followUp.status).toBe(0);
    expect(readMachinePrefs().developerModeEnabled).toBe(true);
    expect(readMachinePrefs().setupMode).toBe("auto");
    expect(readMachinePrefs().defaultMode).toBe("review");
  });

  it("prefs set --json reports the saved values", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "set", "--transport", "chrome", "--review-iterations", "5", "--json"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });

    expect(result.status).toBe(0);
    const payload = lastJson(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.transport).toBe("chrome");
    expect(payload.defaultReviewIterations).toBe(5);
    expect(payload.replyTimeoutSeconds).toBe(600);
  });

  it("prefs set rejects invalid values naming the field", () => {
    dirs.push(isolateStateDir());
    const transport = runCli(["prefs", "set", "--transport", "browser"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });
    expect(transport.status).toBe(1);
    expect(transport.stdout).toContain("✗ transport must be one of manual, chrome");

    const iterations = runCli(["prefs", "set", "--review-iterations", "0"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });
    expect(iterations.status).toBe(1);
    expect(iterations.stdout).toContain("✗ review-iterations must be a positive integer or until_done");

    const timeout = runCli(["prefs", "set", "--reply-timeout", "-5"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });
    expect(timeout.status).toBe(1);
    expect(timeout.stdout).toContain("✗ reply-timeout must be a positive integer");

    expect(readMachinePrefs().transport).toBeNull();
  });

  it("prefs set with no flags still refuses to save", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "set"], { C2C_STATE_DIR: process.env.C2C_STATE_DIR });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✗ nothing to save: pass at least one preference flag");
  });
});
