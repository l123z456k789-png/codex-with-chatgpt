import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { writeSession } from "../src/session/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const CONNECTOR = "Codex with ChatGPT · cli-transport";
const CHROME_MISSING = "CHROME_NOT_FOUND";
const windowsOnly = it.skipIf(process.platform !== "win32");

interface TransportTestEnv {
  root: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
}

function runTask(root: string, args: string[], env: NodeJS.ProcessEnv) {
  return runCli(["task", ...args, "--workspace", root], env);
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

function connect(target: Workspace): void {
  writeSession(target.id, {
    url: "https://chatgpt.com/c/cli-transport-chat",
    conversationMode: "long-chat",
    connectorName: CONNECTOR,
    savedAt: new Date().toISOString(),
  });
  writeLastEndpoint({
    workspaceId: target.id,
    port: 48765,
    publicUrl: null,
    mcpUrl: null,
    connectorName: CONNECTOR,
  });
}

/**
 * win32 synthesizes ProgramFiles (and ProgramFiles(x86)) from ProgramW6432 in
 * child env blocks, so deleting only the documented ProgramFiles keys is not
 * enough: every root `findChromeBinary` reads must go, including ProgramW6432.
 */
const CHROME_LOCATION_KEYS = new Set(["programfiles", "programfiles(x86)", "programw6432", "localappdata"]);

/** Copy the environment without anything that could point at a real Chrome install. */
function chromeFreeEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (CHROME_LOCATION_KEYS.has(lower) || lower === "c2c_chrome_path" || lower === "c2c_transport") continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

const chromePreflightScript = [
  `import(${JSON.stringify(pathToFileURL(path.join(projectRoot, "src", "transport", "chrome.ts")).href)})`,
  `.then((module) => { process.stdout.write(JSON.stringify(module.findChromeBinary())); })`,
  `.catch((error) => { console.error(error); process.exit(1); });`,
].join("");

/**
 * Safety gate: the spawned env must not let `findChromeBinary` see the real
 * machine install. If it does, fail here — before any chrome-mode CLI command
 * can launch Chrome.
 */
function assertChromeNeverFindable(env: NodeJS.ProcessEnv): void {
  const preflight = spawnSync(process.execPath, ["--import", "tsx", "-e", chromePreflightScript], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  expect(preflight.status, `findChromeBinary preflight crashed: ${preflight.stderr}`).toBe(0);
  expect(
    preflight.stdout.trim(),
    "the spawned env can see a real Chrome install; refusing to run any CLI command with it"
  ).toBe("null");
}

/** Isolated workspace + state dir; the spawned env cannot see any Chrome install (win32 preflight). */
function withTransportEnvironment(run: (context: TransportTestEnv) => void): void {
  const root = makeTmpDir("task-transport-workspace");
  const stateDir = makeTmpDir("task-transport-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;

  try {
    const workspace = new Workspace(root);
    connect(workspace);
    const env = chromeFreeEnv({ C2C_STATE_DIR: stateDir, C2C_TRANSPORT: "", C2C_CHROME_PATH: "" });
    if (process.platform === "win32") assertChromeNeverFindable(env);
    run({ root, stateDir, env });
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

describe("c2c task transport flags", () => {
  it("keeps --transport manual output identical to the default", () => {
    withTransportEnvironment(({ root, env }) => {
      const commonArgs = ["--executor", "opencode", "--task", "c2c_m00001", "--goal", "Ship dark mode.", "--json"];
      const plain = runTask(root, ["start", "--agent-session", "cli-plain", ...commonArgs], env);
      const manual = runTask(root, ["start", "--agent-session", "cli-manual", "--transport", "manual", ...commonArgs], env);

      expect(plain.status, `plain stdout: ${plain.stdout} stderr: ${plain.stderr}`).toBe(0);
      expect(manual.status, `manual stdout: ${manual.stdout} stderr: ${manual.stderr}`).toBe(0);

      const scrub = (stdout: string) => {
        const json = lastJson(stdout);
        delete json.agentSession;
        const checkpoint = json.checkpoint as Record<string, unknown>;
        checkpoint.updatedAt = "scrubbed";
        return json;
      };
      expect(scrub(manual.stdout)).toEqual(scrub(plain.stdout));
      expect("transport" in lastJson(manual.stdout)).toBe(false);
    });
  });

  windowsOnly("falls back to manual when Chrome is missing (task start)", () => {
    withTransportEnvironment(({ root, stateDir, env }) => {
      const result = runTask(
        root,
        [
          "start",
          "--executor",
          "opencode",
          "--agent-session",
          "cli-chrome",
          "--task",
          "c2c_ch00001",
          "--goal",
          "Ship dark mode.",
          "--transport",
          "chrome",
          "--no-wait",
          "--json",
        ],
        env
      );

      expect(result.status).toBe(0);
      const json = lastJson(result.stdout);
      expect(json.ok).toBe(true);
      expect(json.protocolState).toBe("INIT");
      expect(json.message).toContain("[C2C]\nSTATE: INIT");
      expect(json.transport).toMatchObject({ ok: false, code: CHROME_MISSING });
      const transport = json.transport as Record<string, unknown>;
      expect(String(transport.detail)).toContain("Chrome");
      expect(transport.manualFallback).toBe(json.message);
      expect(fs.existsSync(path.join(stateDir, "transport", "chrome.json"))).toBe(false);
    });
  });

  windowsOnly("falls back to manual when Chrome is missing (task executed)", () => {
    withTransportEnvironment(({ root, env }) => {
      const started = runTask(
        root,
        ["start", "--executor", "opencode", "--agent-session", "cli-chrome", "--task", "c2c_ch00002", "--goal", "Ship dark mode.", "--json"],
        env
      );
      expect(started.status).toBe(0);
      const planned = runTask(
        root,
        ["plan", "--executor", "opencode", "--agent-session", "cli-chrome", "--task", "c2c_ch00002", "--iteration", "1", "--json"],
        env
      );
      expect(planned.status).toBe(0);

      const executed = runTask(
        root,
        [
          "executed",
          "--executor",
          "opencode",
          "--agent-session",
          "cli-chrome",
          "--task",
          "c2c_ch00002",
          "--iteration",
          "1",
          "--changed-files",
          "2",
          "--tests",
          "176 passed",
          "--transport",
          "chrome",
          "--no-wait",
          "--json",
        ],
        env
      );

      expect(executed.status).toBe(0);
      const json = lastJson(executed.stdout);
      expect(json.protocolState).toBe("EXECUTED_SENT");
      expect(json.message).toContain("[C2C]\nSTATE: EXECUTED");
      expect(json.transport).toMatchObject({ ok: false, code: CHROME_MISSING });
    });
  });

  it("resumes in manual mode with the rebuilt pending message", () => {
    withTransportEnvironment(({ root, env }) => {
      const started = runTask(
        root,
        ["start", "--executor", "opencode", "--agent-session", "cli-resume", "--task", "c2c_rs00001", "--goal", "Ship dark mode.", "--json"],
        env
      );
      expect(started.status).toBe(0);

      const resumed = runTask(
        root,
        ["resume", "--executor", "opencode", "--agent-session", "cli-resume", "--transport", "manual", "--json"],
        env
      );

      expect(resumed.status).toBe(0);
      const json = lastJson(resumed.stdout);
      expect("transport" in json).toBe(false);
      expect(json.protocolState).toBe("INIT");
      expect(json.message).toContain("[C2C]\nSTATE: INIT");
      expect(json.message).toContain("TASK_ID: c2c_rs00001");
    });
  });

  it("returns a stable JSON error when resuming without a checkpoint", () => {
    withTransportEnvironment(({ root, env }) => {
      const resumed = runTask(
        root,
        ["resume", "--executor", "opencode", "--agent-session", "nobody", "--transport", "manual", "--json"],
        env
      );

      expect(resumed.status).toBe(1);
      const json = lastJson(resumed.stdout);
      expect(json.ok).toBe(false);
      expect(String(json.error)).toMatch(/checkpoint/i);
    });
  });
});

describe("c2c browser", () => {
  it("reports no instance and closes nothing when no state exists", () => {
    withTransportEnvironment(({ env }) => {
      const status = runCli(["browser", "status", "--json"], env);
      expect(status.status).toBe(0);
      expect(lastJson(status.stdout)).toEqual({ ok: true, instance: null, healthy: false });

      const closed = runCli(["browser", "close", "--json"], env);
      expect(closed.status).toBe(0);
      expect(lastJson(closed.stdout)).toEqual({ ok: true, closed: false });
    });
  });
});
