import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { TransportError } from "./errors.js";

export interface ChromeInstance {
  pid: number;
  port: number;
  profileDir: string;
  startedAt: string;
}

export type ChromeSpawnFn = (binary: string, args: string[]) => { pid?: number; unref?: () => void };

export interface ChromeDeps {
  spawnFn?: ChromeSpawnFn;
  probe?: (port: number) => Promise<boolean>;
  findBinary?: () => string | null;
  platform?: NodeJS.Platform;
  waitPort?: (profileDir: string) => Promise<number | null>;
  now?: () => Date;
}

const START_URL = "https://chatgpt.com/";
const PROFILE_DIR_NAME = "chrome-profile";
const STATE_FILE_NAME = path.join("transport", "chrome.json");
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const PORT_WAIT_TIMEOUT_MS = 20_000;
const PORT_POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_LAUNCH_ATTEMPTS = 2;

function chromeProfileDir(): string {
  return path.join(getStateDir(), PROFILE_DIR_NAME);
}

export function chromeStateFile(): string {
  return path.join(getStateDir(), STATE_FILE_NAME);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function windowsChromeCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ProgramFiles ?? env.PROGRAMFILES,
    env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA,
  ];
  return roots
    .filter((root): root is string => typeof root === "string" && root.trim() !== "")
    .map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
}

function chromeCandidates(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "win32":
      return windowsChromeCandidates(process.env);
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      ];
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
  }
}

export function findChromeBinary(deps: ChromeDeps = {}): string | null {
  if (deps.findBinary) return deps.findBinary();
  const override = process.env.C2C_CHROME_PATH?.trim();
  if (override && isFile(override)) return override;
  for (const candidate of chromeCandidates(deps.platform ?? process.platform)) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isChromeInstance(value: unknown): value is ChromeInstance {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    Number.isInteger(record.port) &&
    (record.port as number) > 0 &&
    (record.port as number) <= 65_535 &&
    typeof record.profileDir === "string" &&
    record.profileDir !== "" &&
    typeof record.startedAt === "string" &&
    record.startedAt !== ""
  );
}

export function readChromeState(): ChromeInstance | null {
  const value = readJsonIfExists<unknown>(chromeStateFile());
  return isChromeInstance(value) ? value : null;
}

async function probeChromePort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const healthy = response.ok;
    await response.body?.cancel().catch(() => undefined);
    return healthy;
  } catch {
    return false;
  }
}

function readDevToolsPort(profileDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, DEVTOOLS_PORT_FILE), "utf8");
    const port = Number.parseInt(raw.split(/\r?\n/)[0], 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    return null;
  } catch {
    return null;
  }
}

async function waitForDevToolsPort(profileDir: string): Promise<number | null> {
  const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;
  for (;;) {
    const port = readDevToolsPort(profileDir);
    if (port !== null) return port;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }
}

function spawnChrome(binary: string, args: string[]): { pid?: number; unref?: () => void } {
  return spawn(binary, args, { detached: true, stdio: "ignore" });
}

function chromeArgs(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    START_URL,
  ];
}

function loginChromeArgs(profileDir: string): string[] {
  return [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", START_URL];
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process exited between the state check and the kill.
  }
}

function removeStateFile(): void {
  try {
    fs.rmSync(chromeStateFile(), { force: true });
  } catch {
    // best effort
  }
}

function clearDevToolsPort(profileDir: string): void {
  try {
    fs.rmSync(path.join(profileDir, DEVTOOLS_PORT_FILE), { force: true });
  } catch {
    // best effort
  }
}

async function launchOnce(binary: string, profileDir: string, deps: ChromeDeps): Promise<ChromeInstance | null> {
  ensureDir(profileDir);
  clearDevToolsPort(profileDir);

  let child: { pid?: number; unref?: () => void };
  try {
    child = (deps.spawnFn ?? spawnChrome)(binary, chromeArgs(profileDir));
  } catch {
    return null;
  }
  const pid = child.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  child.unref?.();

  const port = await (deps.waitPort ?? waitForDevToolsPort)(profileDir);
  if (port === null) {
    killPid(pid);
    return null;
  }

  if (!(await (deps.probe ?? probeChromePort)(port))) {
    killPid(pid);
    return null;
  }

  const now = deps.now ?? (() => new Date());
  return { pid, port, profileDir, startedAt: now().toISOString() };
}

export async function ensureChrome(deps: ChromeDeps = {}): Promise<{ instance: ChromeInstance; reused: boolean }> {
  const probe = deps.probe ?? probeChromePort;
  const existing = readChromeState();
  if (existing) {
    if (isPidAlive(existing.pid)) {
      if (await probe(existing.port)) return { instance: existing, reused: true };
      killPid(existing.pid);
    }
    removeStateFile();
  }

  const binary = findChromeBinary(deps);
  if (!binary) {
    throw new TransportError(
      "CHROME_NOT_FOUND",
      "Google Chrome was not found. Install Google Chrome or set C2C_CHROME_PATH to chrome.exe."
    );
  }

  const profileDir = chromeProfileDir();
  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    const instance = await launchOnce(binary, profileDir, deps);
    if (instance) {
      writeSecureJson(chromeStateFile(), instance);
      return { instance, reused: false };
    }
  }

  throw new TransportError(
    "CHROME_LAUNCH_FAILED",
    "Chrome did not expose a healthy debugging port. Close other Chrome windows using the C2C profile and try again."
  );
}

/** Thin, injectable wrapper over the debugging-port probe for `browser status`. */
export async function checkChromeHealth(port: number, deps: ChromeDeps = {}): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return false;
  try {
    return await (deps.probe ?? probeChromePort)(port);
  } catch {
    return false;
  }
}

export interface ChromeLoginLaunch {
  pid?: number;
  binary: string;
  profileDir: string;
  closedPrior: boolean;
}

/**
 * Chrome's process singleton is scoped to `--user-data-dir`, so a live
 * transport instance would delegate a plain login launch to its debug-port
 * window and exit. Detect a recorded live instance (state + probe) and close
 * it (kill + clear state) before the login window is opened.
 */
async function closePriorLoginInstance(deps: ChromeDeps): Promise<boolean> {
  const existing = readChromeState();
  if (!existing || !isPidAlive(existing.pid)) return false;
  const healthy = await (deps.probe ?? probeChromePort)(existing.port);
  if (!healthy) return false;
  return (await closeChrome(deps)).closed;
}

/**
 * Open the C2C Chrome profile as a plain user-facing window for the one-time
 * login. Deliberately no debugging port: Google sign-in rejects a browser
 * launched with `--remote-debugging-port`, and this window is never attached
 * to or tracked in `chrome.json` — the user logs in and closes it.
 */
export async function openChromeForLogin(deps: ChromeDeps = {}): Promise<ChromeLoginLaunch> {
  const binary = findChromeBinary(deps);
  if (!binary) {
    throw new TransportError(
      "CHROME_NOT_FOUND",
      "Google Chrome was not found. Install Google Chrome or set C2C_CHROME_PATH to chrome.exe."
    );
  }

  const closedPrior = await closePriorLoginInstance(deps);

  const profileDir = chromeProfileDir();
  ensureDir(profileDir);
  const child = (deps.spawnFn ?? spawnChrome)(binary, loginChromeArgs(profileDir));
  child.unref?.();
  return { pid: child.pid, binary, profileDir, closedPrior };
}

export async function closeChrome(_deps: ChromeDeps = {}): Promise<{ closed: boolean; pid?: number }> {
  const existing = readChromeState();
  if (!existing) return { closed: false };
  const alive = isPidAlive(existing.pid);
  if (alive) killPid(existing.pid);
  removeStateFile();
  return alive ? { closed: true, pid: existing.pid } : { closed: false };
}
