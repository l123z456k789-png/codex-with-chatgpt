import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportError } from "../src/transport/errors.js";
import {
  checkChromeHealth,
  chromeStateFile,
  closeChrome,
  ensureChrome,
  findChromeBinary,
  openChromeForLogin,
  readChromeState,
  type ChromeInstance,
} from "../src/transport/chrome.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const DEAD_PID = 2_147_483_647;
const NEW_PID = 2_147_483_646;
const LIVE_PID = 4_242;
const STARTED_AT = "2026-01-02T03:04:05.000Z";
const START_URL = "https://chatgpt.com/";

const dirs: string[] = [];
const envKeys = ["C2C_CHROME_PATH", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] as const;
const savedEnv = new Map<string, string | undefined>();
let stateDir = "";

function tmpDir(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function fakeChromeInstall(base: string): string {
  const file = path.join(base, "Google", "Chrome", "Application", "chrome.exe");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "fake chrome");
  return file;
}

function chromeProfileDir(): string {
  return path.join(stateDir, "chrome-profile");
}

function instance(pid: number, port: number, overrides: Partial<ChromeInstance> = {}): ChromeInstance {
  return { pid, port, profileDir: chromeProfileDir(), startedAt: STARTED_AT, ...overrides };
}

function writeState(value: ChromeInstance | string): void {
  write(stateDir, "transport/chrome.json", typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

interface SpawnRecord {
  binary: string;
  args: string[];
}

function recordingSpawn(pid: number, calls: SpawnRecord[]) {
  return (binary: string, args: string[]): { pid: number; unref: () => void } => {
    calls.push({ binary, args });
    return { pid, unref: () => {} };
  };
}

function spyProcessKill(alivePids: number[]): { sent: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> } {
  const sent: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0) {
      if (alivePids.includes(pid)) return true;
      const error: NodeJS.ErrnoException = new Error("kill ESRCH");
      error.code = "ESRCH";
      throw error;
    }
    sent.push({ pid, signal });
    return true;
  });
  return { sent };
}

beforeEach(() => {
  for (const key of envKeys) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  stateDir = isolateStateDir();
  dirs.push(stateDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  delete process.env.C2C_STATE_DIR;
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("findChromeBinary", () => {
  it("prefers C2C_CHROME_PATH over the standard install locations", () => {
    const programFiles = tmpDir("pf");
    const localAppData = tmpDir("lad");
    fakeChromeInstall(programFiles);
    fakeChromeInstall(localAppData);
    const override = fakeChromeInstall(tmpDir("override"));
    process.env.ProgramFiles = programFiles;
    process.env.LOCALAPPDATA = localAppData;
    process.env.C2C_CHROME_PATH = override;

    expect(findChromeBinary({ platform: "win32" })).toBe(override);
  });

  it("searches the Windows Chrome locations in order", () => {
    const programFiles = tmpDir("pf");
    const programFilesX86 = tmpDir("pf86");
    const localAppData = tmpDir("lad");
    const first = fakeChromeInstall(programFiles);
    const second = fakeChromeInstall(programFilesX86);
    const third = fakeChromeInstall(localAppData);
    process.env.ProgramFiles = programFiles;
    process.env["ProgramFiles(x86)"] = programFilesX86;
    process.env.LOCALAPPDATA = localAppData;

    expect(findChromeBinary({ platform: "win32" })).toBe(first);
    fs.rmSync(first);
    expect(findChromeBinary({ platform: "win32" })).toBe(second);
    fs.rmSync(second);
    expect(findChromeBinary({ platform: "win32" })).toBe(third);
    fs.rmSync(third);
    expect(findChromeBinary({ platform: "win32" })).toBeNull();
  });

  it("ignores a blank C2C_CHROME_PATH", () => {
    const programFiles = tmpDir("pf");
    const expected = fakeChromeInstall(programFiles);
    process.env.ProgramFiles = programFiles;
    process.env.C2C_CHROME_PATH = "   ";

    expect(findChromeBinary({ platform: "win32" })).toBe(expected);
  });

  it("falls back to standard locations when C2C_CHROME_PATH is not a file", () => {
    const programFiles = tmpDir("pf");
    const expected = fakeChromeInstall(programFiles);
    process.env.ProgramFiles = programFiles;
    process.env.C2C_CHROME_PATH = path.join(tmpDir("missing"), "chrome.exe");

    expect(findChromeBinary({ platform: "win32" })).toBe(expected);
  });

  it("uses the injected findBinary seam", () => {
    process.env.C2C_CHROME_PATH = path.join(tmpDir("ignored"), "chrome.exe");
    const seam = path.join(tmpDir("seam"), "chrome.exe");

    expect(findChromeBinary({ findBinary: () => seam })).toBe(seam);
  });

  it("never returns a browser that is not Google Chrome", () => {
    const programFiles = tmpDir("pf");
    const edge = path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe");
    fs.mkdirSync(path.dirname(edge), { recursive: true });
    fs.writeFileSync(edge, "fake edge");
    process.env.ProgramFiles = programFiles;

    expect(findChromeBinary({ platform: "win32" })).toBeNull();
  });
});

describe("ensureChrome", () => {
  it("launches Chrome into the isolated C2C profile and writes state", async () => {
    const calls: SpawnRecord[] = [];
    const binary = path.join(tmpDir("bin"), "chrome.exe");
    const profileDir = chromeProfileDir();
    const probe = vi.fn(async (port: number) => port === 9_333);
    const waitPort = vi.fn(async (dir: string) => (dir === profileDir ? 9_333 : null));

    const result = await ensureChrome({
      findBinary: () => binary,
      spawnFn: recordingSpawn(DEAD_PID, calls),
      waitPort,
      probe,
      platform: "win32",
      now: () => new Date(STARTED_AT),
    });

    expect(result.reused).toBe(false);
    expect(result.instance).toEqual({ pid: DEAD_PID, port: 9_333, profileDir, startedAt: STARTED_AT });
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe(binary);
    const args = calls[0].args;
    expect(args[0]).toBe(`--user-data-dir=${profileDir}`);
    expect(args.filter((arg) => arg.startsWith("--user-data-dir"))).toHaveLength(1);
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args[args.length - 1]).toBe(START_URL);
    expect(args.join(" ")).not.toContain("User Data");
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(chromeStateFile()).toBe(path.join(stateDir, "transport", "chrome.json"));
    expect(readChromeState()).toEqual(result.instance);
    expect(waitPort).toHaveBeenCalledWith(profileDir);
    expect(probe).toHaveBeenCalledWith(9_333);
  });

  it("reuses a healthy running instance without spawning", async () => {
    const existing = instance(LIVE_PID, 9_222);
    writeState(existing);
    const { sent } = spyProcessKill([LIVE_PID]);
    const calls: SpawnRecord[] = [];
    const findBinary = vi.fn(() => path.join(tmpDir("bin"), "chrome.exe"));
    const probe = vi.fn(async (port: number) => port === 9_222);

    const result = await ensureChrome({ findBinary, spawnFn: recordingSpawn(NEW_PID, calls), probe });

    expect(result).toEqual({ instance: existing, reused: true });
    expect(calls).toHaveLength(0);
    expect(findBinary).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(probe).toHaveBeenCalledWith(9_222);
    expect(readChromeState()).toEqual(existing);
  });

  it("replaces a stale instance whose pid is dead", async () => {
    writeState(instance(DEAD_PID, 9_222));
    const calls: SpawnRecord[] = [];
    const probe = vi.fn(async (port: number) => port === 9_333);

    const result = await ensureChrome({
      findBinary: () => path.join(tmpDir("bin"), "chrome.exe"),
      spawnFn: recordingSpawn(NEW_PID, calls),
      waitPort: async () => 9_333,
      probe,
    });

    expect(result.reused).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result.instance.pid).toBe(NEW_PID);
    expect(result.instance.port).toBe(9_333);
    expect(probe).not.toHaveBeenCalledWith(9_222);
    expect(readChromeState()?.pid).toBe(NEW_PID);
  });

  it("kills a stale instance whose pid is alive but whose port is unhealthy", async () => {
    writeState(instance(LIVE_PID, 9_222));
    const { sent } = spyProcessKill([LIVE_PID]);
    const calls: SpawnRecord[] = [];
    const probe = vi.fn(async (port: number) => port === 9_333);

    const result = await ensureChrome({
      findBinary: () => path.join(tmpDir("bin"), "chrome.exe"),
      spawnFn: recordingSpawn(NEW_PID, calls),
      waitPort: async () => 9_333,
      probe,
    });

    expect(result.reused).toBe(false);
    expect(sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
    expect(calls).toHaveLength(1);
    expect(readChromeState()?.pid).toBe(NEW_PID);
  });

  it("retries once and then reports CHROME_LAUNCH_FAILED", async () => {
    const calls: SpawnRecord[] = [];

    const error = await ensureChrome({
      findBinary: () => path.join(tmpDir("bin"), "chrome.exe"),
      spawnFn: recordingSpawn(DEAD_PID, calls),
      waitPort: async () => null,
      probe: async () => false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("CHROME_LAUNCH_FAILED");
    expect(calls).toHaveLength(2);
    expect(readChromeState()).toBeNull();
  });

  it("recovers on the single relaunch attempt", async () => {
    const calls: SpawnRecord[] = [];
    let waits = 0;

    const result = await ensureChrome({
      findBinary: () => path.join(tmpDir("bin"), "chrome.exe"),
      spawnFn: recordingSpawn(NEW_PID, calls),
      waitPort: async () => (++waits === 1 ? null : 9_333),
      probe: async (port) => port === 9_333,
    });

    expect(calls).toHaveLength(2);
    expect(result.reused).toBe(false);
    expect(result.instance.port).toBe(9_333);
    expect(readChromeState()?.port).toBe(9_333);
  });

  it("reports CHROME_NOT_FOUND when no Google Chrome binary exists", async () => {
    const calls: SpawnRecord[] = [];

    const error = await ensureChrome({
      findBinary: () => null,
      spawnFn: recordingSpawn(DEAD_PID, calls),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("CHROME_NOT_FOUND");
    expect(calls).toHaveLength(0);
    expect(readChromeState()).toBeNull();
  });

  it("honours the C2C_CHROME_PATH override", async () => {
    const binary = path.join(tmpDir("custom"), "chrome.exe");
    fs.writeFileSync(binary, "fake chrome");
    process.env.C2C_CHROME_PATH = binary;
    const calls: SpawnRecord[] = [];

    await ensureChrome({
      platform: "win32",
      spawnFn: recordingSpawn(DEAD_PID, calls),
      waitPort: async () => 9_333,
      probe: async () => true,
    });

    expect(calls[0]?.binary).toBe(binary);
  });

  it("survives a spawn failure and still reports CHROME_LAUNCH_FAILED", async () => {
    let spawns = 0;

    const error = await ensureChrome({
      findBinary: () => "chrome",
      spawnFn: () => {
        spawns += 1;
        throw new Error("ENOENT");
      },
      waitPort: async () => null,
      probe: async () => false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("CHROME_LAUNCH_FAILED");
    expect(spawns).toBe(2);
  });

  it("reads the port from the profile's DevToolsActivePort file", async () => {
    const calls: SpawnRecord[] = [];
    const spawnFn = (binary: string, args: string[]): { pid: number; unref: () => void } => {
      calls.push({ binary, args });
      const profileArg = args.find((arg) => arg.startsWith("--user-data-dir="));
      const profileDir = profileArg!.slice("--user-data-dir=".length);
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "DevToolsActivePort"), "9333\n/devtools/browser/abc-123\n");
      return { pid: DEAD_PID, unref: () => {} };
    };
    const probe = vi.fn(async (port: number) => port === 9_333);

    const result = await ensureChrome({
      findBinary: () => path.join(tmpDir("bin"), "chrome.exe"),
      spawnFn,
      probe,
      now: () => new Date(STARTED_AT),
    });

    expect(calls).toHaveLength(1);
    expect(result.instance.port).toBe(9_333);
    expect(readChromeState()?.port).toBe(9_333);
  });
});

describe("checkChromeHealth", () => {
  it("returns the injected probe result for a valid port", async () => {
    const probe = vi.fn(async (port: number) => port === 9_333);

    await expect(checkChromeHealth(9_333, { probe })).resolves.toBe(true);
    await expect(checkChromeHealth(9_222, { probe })).resolves.toBe(false);
    expect(probe).toHaveBeenCalledWith(9_333);
    expect(probe).toHaveBeenCalledWith(9_222);
  });

  it("never probes an invalid port", async () => {
    const probe = vi.fn(async () => true);

    await expect(checkChromeHealth(0, { probe })).resolves.toBe(false);
    await expect(checkChromeHealth(65_536, { probe })).resolves.toBe(false);
    await expect(checkChromeHealth(Number.NaN, { probe })).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports unhealthy when the probe throws", async () => {
    const probe = async (): Promise<boolean> => {
      throw new Error("connection refused");
    };

    await expect(checkChromeHealth(9_333, { probe })).resolves.toBe(false);
  });
});

describe("chrome state", () => {
  it("treats a malformed state file as absent", () => {
    writeState("{ this is not json");
    expect(readChromeState()).toBeNull();
  });

  it("rejects structurally invalid state", () => {
    const invalid: unknown[] = [
      {},
      { pid: 1 },
      { pid: "1", port: 9_222, profileDir: "x", startedAt: STARTED_AT },
      { pid: 1, port: 0, profileDir: "x", startedAt: STARTED_AT },
      { pid: 1, port: 9_222, profileDir: "", startedAt: STARTED_AT },
      { pid: 1, port: 9_222, profileDir: "x", startedAt: 5 },
    ];

    for (const value of invalid) {
      writeState(JSON.stringify(value));
      expect(readChromeState()).toBeNull();
    }
  });

  it("launches fresh when the state file is malformed", async () => {
    writeState("{ this is not json");
    const calls: SpawnRecord[] = [];

    const result = await ensureChrome({
      findBinary: () => "chrome",
      spawnFn: recordingSpawn(NEW_PID, calls),
      waitPort: async () => 9_333,
      probe: async () => true,
      now: () => new Date(STARTED_AT),
    });

    expect(result.reused).toBe(false);
    expect(calls).toHaveLength(1);
    expect(readChromeState()?.pid).toBe(NEW_PID);
  });

  it("round-trips a written instance", () => {
    const value = instance(LIVE_PID, 9_222);
    writeState(value);
    expect(readChromeState()).toEqual(value);
  });
});

describe("openChromeForLogin", () => {
  it("opens the C2C profile as a plain window without a debugging port", async () => {
    const calls: SpawnRecord[] = [];
    const binary = path.join(tmpDir("bin"), "chrome.exe");
    const profileDir = chromeProfileDir();
    const { sent } = spyProcessKill([LIVE_PID]);
    const probe = vi.fn(async () => true);

    const result = await openChromeForLogin({ findBinary: () => binary, spawnFn: recordingSpawn(LIVE_PID, calls), probe });

    expect(result).toEqual({ pid: LIVE_PID, binary, profileDir, closedPrior: false });
    expect(probe).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe(binary);
    const args = calls[0].args;
    expect(args[0]).toBe(`--user-data-dir=${profileDir}`);
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args[args.length - 1]).toBe(START_URL);
    expect(args.join(" ")).not.toContain("remote-debugging-port");
    expect(readChromeState()).toBeNull();
    expect(fs.existsSync(chromeStateFile())).toBe(false);
  });

  it("closes a live recorded instance before opening the plain login window", async () => {
    writeState(instance(LIVE_PID, 9_222));
    const { sent } = spyProcessKill([LIVE_PID]);
    const calls: SpawnRecord[] = [];
    const binary = path.join(tmpDir("bin"), "chrome.exe");
    const probe = vi.fn(async (port: number) => port === 9_222);

    const result = await openChromeForLogin({ findBinary: () => binary, spawnFn: recordingSpawn(NEW_PID, calls), probe });

    expect(result).toEqual({ pid: NEW_PID, binary, profileDir: chromeProfileDir(), closedPrior: true });
    expect(probe).toHaveBeenCalledWith(9_222);
    expect(sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
    expect(readChromeState()).toBeNull();
    expect(fs.existsSync(chromeStateFile())).toBe(false);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe(`--user-data-dir=${chromeProfileDir()}`);
    expect(args[args.length - 1]).toBe(START_URL);
    expect(args.join(" ")).not.toContain("remote-debugging-port");
  });

  it("reports CHROME_NOT_FOUND when no Google Chrome binary exists", async () => {
    const calls: SpawnRecord[] = [];
    let error: unknown;
    try {
      await openChromeForLogin({ findBinary: () => null, spawnFn: recordingSpawn(LIVE_PID, calls) });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("CHROME_NOT_FOUND");
    expect(calls).toHaveLength(0);
    expect(readChromeState()).toBeNull();
  });
});

describe("closeChrome", () => {
  it("kills the recorded pid and clears the state file", async () => {
    writeState(instance(LIVE_PID, 9_222));
    const { sent } = spyProcessKill([LIVE_PID]);

    const result = await closeChrome();

    expect(result).toEqual({ closed: true, pid: LIVE_PID });
    expect(sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
    expect(readChromeState()).toBeNull();
    expect(fs.existsSync(chromeStateFile())).toBe(false);
  });

  it("reports closed: false when nothing is running", async () => {
    const { sent } = spyProcessKill([]);

    expect(await closeChrome()).toEqual({ closed: false });
    expect(sent).toEqual([]);
  });

  it("clears a stale state file without killing a dead pid", async () => {
    writeState(instance(DEAD_PID, 9_222));
    const { sent } = spyProcessKill([]);

    expect(await closeChrome()).toEqual({ closed: false });
    expect(sent).toEqual([]);
    expect(readChromeState()).toBeNull();
  });
});
