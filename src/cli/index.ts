import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import {
  mergeMachinePrefs,
  readMachinePrefs,
  resolveTransportMode,
  TASK_MODES,
  TRANSPORT_MODES,
  type MachinePrefsPatch,
  type SetupMode,
  type TaskMode,
  type TransportMode,
} from "../config/prefs.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { normalizeAgentSessionId, normalizeExecutorId } from "../session/agent-session.js";
import { requireConnectedSession } from "../session/connected.js";
import {
  finishTask,
  handoffTask,
  markExecuted,
  markPlan,
  readTaskStatus,
  startTask,
} from "../protocol/lifecycle.js";
import {
  buildResumeCommand,
  executedWithTransport,
  resumeWithTransport,
  startTaskWithTransport,
  type RoundtripOutcome,
} from "../protocol/roundtrip.js";
import { ChatGptTransport } from "../transport/chatgpt-transport.js";
import { checkChromeHealth, closeChrome, ensureChrome, openChromeForLogin, readChromeState } from "../transport/chrome.js";
import { createPlaywrightDriver } from "../transport/driver.js";
import { isTransportError, TransportError } from "../transport/errors.js";
import {
  claudeGuardHook,
  claudePostHook,
  claudePromptHook,
  installClaudeAdapter,
  readClaudeStatus,
  uninstallClaudeAdapter,
} from "../adapters/claude-code.js";
import {
  installOpenCodeAdapter,
  readOpenCodeStatus,
  uninstallOpenCodeAdapter,
} from "../adapters/opencode.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

/**
 * Decode nominated output as text. Windows tools (PowerShell, Notepad) write
 * UTF-16 logs; they must reach the sanitizer as real text, not mojibake that
 * evades secret patterns.
 */
function decodeOutputText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    if (body.length % 2 !== 0) return body.toString("utf8");
    body.swap16();
    return body.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  // BOM-less UTF-16: NUL bytes at consistent parity indicate UTF-16 text.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let zeros = 0;
  let zerosOdd = 0;
  for (let index = 0; index < sample.length; index++) {
    if (sample[index] === 0) {
      zeros++;
      if (index % 2 === 1) zerosOdd++;
    }
  }
  if (zeros > 0 && zeros / sample.length > 0.2) {
    if (zerosOdd >= zeros - zerosOdd) {
      return bytes.toString("utf16le");
    }
    const swapped = Buffer.from(bytes);
    if (swapped.length % 2 === 0) {
      swapped.swap16();
      return swapped.toString("utf16le");
    }
  }
  return bytes.toString("utf8");
}

function readCappedText(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return decodeOutputText(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

/** Machine-wide commands ignore `-w` so a Skill that always passes it cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          results.push(`安全连接地址已更换，需要更新「${boundName}」`);
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    const machine = readMachinePrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs, ...machine }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
    if (machine.transport === "chrome") say("传输方式：chrome（内置 Chrome）");
    else if (machine.transport === "manual") say("传输方式：manual（手动复制粘贴）");
    else say("传输方式：尚未选择（默认 manual）");
    say(`任务模式：${machine.defaultMode}`);
    say(`审查轮数上限：${machine.defaultReviewIterations}`);
    say(`单对话任务上限：${machine.maxTasksPerConversation}`);
    say(`协议轮次上限：${machine.maxProtocolRoundtrips}`);
    say(`异常信号上限：${machine.maxAbnormalSignals}`);
    say(`回复超时：${machine.replyTimeoutSeconds} 秒`);
  });

function parseTransportOption(value: string): TransportMode {
  return parsePrefModeOption("transport", value, TRANSPORT_MODES);
}

function parseTaskModeOption(value: string): TaskMode {
  return parsePrefModeOption("default-mode", value, TASK_MODES);
}

function parseSetupModeOption(value: string): SetupMode {
  return parsePrefModeOption("setup-mode", value, SETUP_MODES);
}

function parsePrefModeOption<T extends string>(field: string, value: string, modes: readonly T[]): T {
  const normalized = value.trim().toLowerCase();
  if (!(modes as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must be one of ${modes.join(", ")}`);
  }
  return normalized as T;
}

function parseReviewIterationsOption(value: string): number | "until_done" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "until_done") return "until_done";
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("review-iterations must be a positive integer or until_done");
  }
  return parsed;
}

function parsePrefPositiveInteger(field: string, value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function buildMachinePrefsPatch(opts: {
  transport?: string;
  defaultMode?: string;
  reviewIterations?: string;
  maxTasksPerConversation?: string;
  maxRoundtrips?: string;
  replyTimeout?: string;
}): MachinePrefsPatch {
  const patch: MachinePrefsPatch = {};
  if (opts.transport !== undefined) patch.transport = parseTransportOption(opts.transport);
  if (opts.defaultMode !== undefined) patch.defaultMode = parseTaskModeOption(opts.defaultMode);
  if (opts.reviewIterations !== undefined) {
    patch.defaultReviewIterations = parseReviewIterationsOption(opts.reviewIterations);
  }
  if (opts.maxTasksPerConversation !== undefined) {
    patch.maxTasksPerConversation = parsePrefPositiveInteger(
      "max-tasks-per-conversation",
      opts.maxTasksPerConversation
    );
  }
  if (opts.maxRoundtrips !== undefined) {
    patch.maxProtocolRoundtrips = parsePrefPositiveInteger("max-roundtrips", opts.maxRoundtrips);
  }
  if (opts.replyTimeout !== undefined) {
    patch.replyTimeoutSeconds = parsePrefPositiveInteger("reply-timeout", opts.replyTimeout);
  }
  return patch;
}

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("set")
    .description("Save a ChatGPT setup choice for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--transport <mode>", "manual or chrome")
    .option("--default-mode <mode>", "full, review or off")
    .option("--review-iterations <value>", "positive integer or until_done")
    .option("--max-tasks-per-conversation <n>", "rotation threshold, positive integer")
    .option("--max-roundtrips <n>", "protocol roundtrip limit, positive integer")
    .option("--reply-timeout <seconds>", "reply timeout, positive integer")
    .option("--json", "machine-readable output", false)
)
  .action(
    (opts: {
      developerMode: boolean;
      setupMode?: string;
      transport?: string;
      defaultMode?: string;
      reviewIterations?: string;
      maxTasksPerConversation?: string;
      maxRoundtrips?: string;
      replyTimeout?: string;
      json: boolean;
    }) => {
      try {
        const setupMode = opts.setupMode !== undefined ? parseSetupModeOption(opts.setupMode) : undefined;
        if (
          !opts.developerMode &&
          setupMode === undefined &&
          opts.transport === undefined &&
          opts.defaultMode === undefined &&
          opts.reviewIterations === undefined &&
          opts.maxTasksPerConversation === undefined &&
          opts.maxRoundtrips === undefined &&
          opts.replyTimeout === undefined
        ) {
          throw new Error("nothing to save: pass at least one preference flag");
        }
        const patch = buildMachinePrefsPatch(opts);
        const prefs = mergeMachinePrefs({
          developerModeEnabled: opts.developerMode ? true : undefined,
          setupMode,
          ...patch,
        });
        if (opts.json) {
          say(JSON.stringify({ ok: true, ...readUiPrefs(), ...prefs }));
          return;
        }
        if (opts.developerMode) check("已记住开发人员模式已开启");
        if (setupMode === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
        if (setupMode === "manual") check("已记住配置方式：手动教学配置");
        if (patch.transport !== undefined) check(`已记住传输方式：${patch.transport}`);
        if (patch.defaultMode !== undefined) check(`已记住任务模式：${patch.defaultMode}`);
        if (patch.defaultReviewIterations !== undefined) check(`已记住审查轮数上限：${patch.defaultReviewIterations}`);
        if (patch.maxTasksPerConversation !== undefined) check(`已记住单对话任务上限：${patch.maxTasksPerConversation}`);
        if (patch.maxProtocolRoundtrips !== undefined) check(`已记住协议轮次上限：${patch.maxProtocolRoundtrips}`);
        if (patch.replyTimeoutSeconds !== undefined) check(`已记住回复超时：${patch.replyTimeoutSeconds} 秒`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

// ---------------------------------------------------------------- task (generic agent protocol)

function parseTaskExecutor(value: string): string {
  try {
    return normalizeExecutorId(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

function parseTaskAgentSession(value: string): string {
  try {
    return normalizeAgentSessionId(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

interface PrintableTaskResult {
  taskId: string;
  iteration: number;
  protocolState: string;
  workspaceName: string;
  workspaceRoot: string;
  chatUrl?: string | null;
  connectorName?: string | null;
  message?: string;
}

function printTaskResult(result: PrintableTaskResult): void {
  check(`Task ${result.taskId} · ${result.protocolState} (iteration ${result.iteration})`);
  say(`Workspace: ${result.workspaceName} (${result.workspaceRoot})`);
  if (result.chatUrl) say(`ChatGPT: ${result.chatUrl}`);
  if (result.connectorName) say(`Connector: ${result.connectorName}`);
  if (result.message) {
    say("");
    say("Send this message to ChatGPT:");
    say(result.message);
  }
}

function printTransportResult(result: RoundtripOutcome): void {
  check(`Task ${result.taskId} · ${result.protocolState} (iteration ${result.iteration})`);
  say(`Workspace: ${result.workspaceName} (${result.workspaceRoot})`);
  if (result.chatUrl) say(`ChatGPT: ${result.chatUrl}`);
  if (result.connectorName) say(`Connector: ${result.connectorName}`);

  const transport = result.transport;
  if (transport?.ok) {
    if (transport.chatUrl && transport.chatUrl !== result.chatUrl) say(`Conversation: ${transport.chatUrl}`);
    if (transport.awaitingReply) {
      say(
        transport.reusedConfirmation
          ? "The pending message was already confirmed in the conversation; nothing was sent again."
          : "Message sent; ChatGPT has not replied yet."
      );
      if (result.message) {
        say("");
        say("Pending [C2C] message:");
        say(result.message);
      }
      say("");
      say(`Resume with: ${buildResumeCommand(result.executor, result.agentSession)}`);
      return;
    }
    say(
      `ChatGPT replied: ${transport.reply?.state ?? "UNPARSEABLE"}${
        transport.reusedConfirmation ? " (reused an already-sent message)" : ""
      }`
    );
    if (transport.replyText) {
      say("");
      say(transport.replyText);
    }
    if (result.decision) {
      say("");
      say(`Review decision: ${result.decision.action} (${result.decision.reason})`);
    }
    if (result.choices && result.choices.length > 0) {
      say("");
      say("Review limit reached. Choose one:");
      for (const choice of result.choices) say(`- ${choice}`);
    }
    if (result.decision?.action === "no_progress") {
      say("");
      say("No progress detected between the last two review rounds; the task is paused.");
      say(`Resume with: ${buildResumeCommand(result.executor, result.agentSession)}`);
    }
    return;
  }

  if (transport && !transport.ok) {
    cross(`chrome transport failed: ${transport.code}${transport.detail ? ` — ${transport.detail}` : ""}`);
    say("");
    say("Fall back to manual. Send this message to ChatGPT yourself:");
    say("");
    say(transport.manualFallback);
    return;
  }

  if (result.message) {
    say("");
    say("Send this message to ChatGPT:");
    say(result.message);
  }
  if (result.protocolState === "PLAN_RECEIVED" && result.waitingFor === "none") {
    say(`Plan accepted; execute iteration ${result.iteration} and record it with \`c2c task executed\`.`);
  }
}

async function openChromeTransport(workspace: Workspace): Promise<ChatGptTransport> {
  const connected = requireConnectedSession(workspace.id);
  const { instance } = await ensureChrome();
  const driver = await createPlaywrightDriver(instance.port);
  return new ChatGptTransport(driver, {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    connectorName: connected.connectorName,
  });
}

/** R6: a failed Chrome startup becomes a manual fallback, never a hard failure. */
async function tryOpenChromeTransport(
  workspace: Workspace
): Promise<{ transport: ChatGptTransport | null; failure: TransportError | null }> {
  try {
    return { transport: await openChromeTransport(workspace), failure: null };
  } catch (error) {
    if (isTransportError(error)) return { transport: null, failure: error };
    const reason = error instanceof Error ? error.message : String(error);
    return {
      transport: null,
      failure: new TransportError("TRANSPORT_UNAVAILABLE", `Cannot attach to Chrome: ${reason}`),
    };
  }
}

interface TaskActionOptions {
  workspace: Workspace;
  transportFlag?: string;
  wait: boolean;
  timeoutMs?: number;
  reviewIterations?: string;
  json: boolean;
  run: (transport: ChatGptTransport | null) => Promise<RoundtripOutcome>;
}

async function runTaskAction(options: TaskActionOptions): Promise<void> {
  const mode = resolveTransportMode(options.transportFlag);
  if (mode === "manual") {
    const result = await options.run(null);
    if (options.json) {
      say(JSON.stringify(result));
      return;
    }
    printTaskResult(result);
    if (!result.message && result.protocolState === "PLAN_RECEIVED" && result.waitingFor === "none") {
      say(`Plan accepted; execute iteration ${result.iteration} and record it with \`c2c task executed\`.`);
    }
    return;
  }

  const { transport, failure } = await tryOpenChromeTransport(options.workspace);
  try {
    const result = await options.run(transport);
    if (failure) {
      const transportFailure = {
        ok: false as const,
        code: failure.code,
        detail: failure.detail ?? failure.message,
        manualFallback: result.message ?? "",
      };
      if (options.json) {
        say(JSON.stringify({ ...result, transport: transportFailure }));
        return;
      }
      cross(`chrome transport failed: ${failure.code} — ${failure.detail ?? failure.message}`);
      printTaskResult(result);
      return;
    }
    if (options.json) {
      say(JSON.stringify(result));
      return;
    }
    printTransportResult(result);
  } finally {
    if (transport) await transport.close().catch(() => undefined);
  }
}

function parseWaitSecondsOption(value: string): number {
  return parsePrefPositiveInteger("wait-seconds", value);
}

function waitSecondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

const taskCmd = program
  .command("task")
  .description("Drive the agent-neutral C2C task protocol (INIT/PLAN/EXECUTED/HANDOFF/DONE)");

taskCmd
  .command("start")
  .description("Start a task for this agent session and print the INIT message")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .requiredOption("--goal <text>", "task goal, one paragraph")
  .option("--task <id>", "explicit task id (default: generated)")
  .option("--transport <mode>", "manual (default) or chrome")
  .option("--wait-seconds <n>", "reply timeout in seconds (chrome only)", parseWaitSecondsOption)
  .option("--review-iterations <value>", "positive integer or until_done")
  .option("--new-chat", "bootstrap a fresh ChatGPT conversation for this task", false)
  .option("--no-wait", "send without waiting for the ChatGPT reply (chrome)")
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      executor: string;
      agentSession: string;
      goal: string;
      task?: string;
      transport?: string;
      waitSeconds?: number;
      reviewIterations?: string;
      newChat: boolean;
      wait: boolean;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const scope = { workspace, executor: opts.executor, agentSession: opts.agentSession };
        const prefs = readMachinePrefs();
        const timeoutMs = waitSecondsToMs(opts.waitSeconds);
        await runTaskAction({
          workspace,
          transportFlag: opts.transport,
          wait: opts.wait,
          timeoutMs,
          reviewIterations: opts.reviewIterations,
          json: opts.json,
          run: (transport) =>
            startTaskWithTransport(
              scope,
              { goal: opts.goal, taskId: opts.task, newChat: opts.newChat },
              { transport, prefs, wait: opts.wait, timeoutMs, reviewIterations: opts.reviewIterations }
            ),
        });
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

taskCmd
  .command("plan")
  .description("Record ChatGPT's PLAN for this task iteration")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "iteration from ChatGPT's PLAN", parseNonNegativeInteger)
  .option("--next-step <text>", "what the executor will do next")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: {
      workspace?: string;
      executor: string;
      agentSession: string;
      task: string;
      iteration: number;
      nextStep?: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const result = markPlan(
          { workspace, executor: opts.executor, agentSession: opts.agentSession },
          { taskId: opts.task, iteration: opts.iteration, nextStep: opts.nextStep }
        );
        if (opts.json) say(JSON.stringify(result));
        else printTaskResult(result);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

taskCmd
  .command("executed")
  .description("Record the execution, append evidence, and print the EXECUTED message")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '176 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .option("--transport <mode>", "manual (default) or chrome")
  .option("--wait-seconds <n>", "reply timeout in seconds (chrome only)", parseWaitSecondsOption)
  .option("--review-iterations <value>", "positive integer or until_done")
  .option("--no-wait", "send without waiting for the ChatGPT reply (chrome)")
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      executor: string;
      agentSession: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
      transport?: string;
      waitSeconds?: number;
      reviewIterations?: string;
      wait: boolean;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const scope = { workspace, executor: opts.executor, agentSession: opts.agentSession };
        const prefs = readMachinePrefs();
        const timeoutMs = waitSecondsToMs(opts.waitSeconds);
        const rawOutput =
          opts.outputFile !== undefined
            ? readCappedText(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
            : opts.output;
        const output =
          opts.command && rawOutput !== undefined
            ? { command: opts.command, raw: rawOutput, exitCode: opts.exitCode ?? null }
            : undefined;
        await runTaskAction({
          workspace,
          transportFlag: opts.transport,
          wait: opts.wait,
          timeoutMs,
          reviewIterations: opts.reviewIterations,
          json: opts.json,
          run: (transport) =>
            executedWithTransport(
              scope,
              {
                taskId: opts.task,
                iteration: opts.iteration,
                changedFiles: parseChangedFiles(opts.changedFiles),
                tests: opts.tests ?? null,
                exitStatus: opts.exitStatus,
                notes: opts.notes,
                output,
              },
              { transport, prefs, wait: opts.wait, timeoutMs, reviewIterations: opts.reviewIterations }
            ),
        });
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

taskCmd
  .command("handoff")
  .description("Print the HANDOFF message for this task's checkpoint")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .requiredOption("--task <id>")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: { workspace?: string; executor: string; agentSession: string; task: string; json: boolean }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const result = handoffTask(
          { workspace, executor: opts.executor, agentSession: opts.agentSession },
          { taskId: opts.task }
        );
        if (opts.json) say(JSON.stringify(result));
        else printTaskResult(result);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

taskCmd
  .command("done")
  .description("Clear the checkpoint after ChatGPT replied DONE")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .requiredOption("--task <id>")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: { workspace?: string; executor: string; agentSession: string; task: string; json: boolean }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const result = finishTask(
          { workspace, executor: opts.executor, agentSession: opts.agentSession },
          { taskId: opts.task }
        );
        if (opts.json) say(JSON.stringify(result));
        else check(`Task ${result.taskId} finished; checkpoint cleared.`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

taskCmd
  .command("status")
  .description("Show the active checkpoint for this agent session")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; executor: string; agentSession: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const result = readTaskStatus({ workspace, executor: opts.executor, agentSession: opts.agentSession });
      if (opts.json) {
        say(JSON.stringify(result));
      } else if (!result.active || !result.checkpoint) {
        say(`No active checkpoint for executor "${result.executor}" session "${result.agentSession}".`);
      } else {
        printTaskResult({
          taskId: result.checkpoint.taskId,
          iteration: result.checkpoint.iteration,
          protocolState: result.checkpoint.protocolState,
          workspaceName: result.workspaceName,
          workspaceRoot: result.workspaceRoot,
        });
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

taskCmd
  .command("resume")
  .description("Resume the active task through the transport without resending a delivered message")
  .option("-w, --workspace <path>")
  .requiredOption("--executor <id>", "executor id, e.g. opencode", parseTaskExecutor)
  .requiredOption("--agent-session <id>", "stable id of this agent session", parseTaskAgentSession)
  .option("--transport <mode>", "manual (default) or chrome")
  .option("--wait-seconds <n>", "reply timeout in seconds (chrome only)", parseWaitSecondsOption)
  .option("--review-iterations <value>", "positive integer or until_done")
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      executor: string;
      agentSession: string;
      transport?: string;
      waitSeconds?: number;
      reviewIterations?: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const scope = { workspace, executor: opts.executor, agentSession: opts.agentSession };
        const prefs = readMachinePrefs();
        const timeoutMs = waitSecondsToMs(opts.waitSeconds);
        await runTaskAction({
          workspace,
          transportFlag: opts.transport,
          wait: true,
          timeoutMs,
          reviewIterations: opts.reviewIterations,
          json: opts.json,
          run: (transport) =>
            resumeWithTransport(scope, {
              transport,
              prefs,
              timeoutMs,
              reviewIterations: opts.reviewIterations,
            }),
        });
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

// ---------------------------------------------------------------- browser (C2C Chrome)

const browserCmd = program.command("browser").description("Inspect, log in to or close the C2C-owned Chrome instance");

browserCmd
  .command("status", { isDefault: true })
  .description("Show the recorded C2C Chrome instance and probe its debugging port")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const instance = readChromeState();
      const healthy = instance ? await checkChromeHealth(instance.port) : false;
      if (opts.json) {
        say(JSON.stringify({ ok: true, instance, healthy }));
        return;
      }
      if (!instance) {
        say("No C2C Chrome instance is running.");
        return;
      }
      if (healthy) check(`Chrome is running (pid ${instance.pid}, port ${instance.port}).`);
      else cross(`Chrome pid ${instance.pid} is recorded, but port ${instance.port} is not responding.`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

browserCmd
  .command("close")
  .description("Terminate the C2C-owned Chrome instance")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const result = await closeChrome();
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...result }));
        return;
      }
      if (result.closed) check(`Chrome closed (pid ${result.pid}).`);
      else say("No C2C Chrome instance was running.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

browserCmd
  .command("login")
  .description("Open the C2C Chrome profile for the one-time manual ChatGPT login (no debugging port)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const result = openChromeForLogin();
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...result }));
        return;
      }
      check("Chrome opened with the C2C profile.");
      say(
        "Log in to ChatGPT in the opened window (Google sign-in works here because this launch has no debugging port). Close the window when done; the C2C profile keeps the session."
      );
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- claude adapter

function selfCommand(): string {
  return `node ${JSON.stringify(path.resolve(process.argv[1] ?? "c2c"))}`;
}

function readHookInput(): Record<string, unknown> {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

const claudeCmd = program
  .command("claude")
  .description("Use ChatGPT planning and review from Claude Code");

claudeCmd
  .command("install")
  .description("Install or refresh the project-local Claude Code C2C rules, skill and hooks")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const result = installClaudeAdapter(resolveWorkspace(opts.workspace), selfCommand());
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check(`Claude Code adapter installed (${result.workspaceRoot})`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

claudeCmd
  .command("uninstall")
  .description("Remove the managed Claude Code rules, skill and hooks")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const result = uninstallClaudeAdapter(resolveWorkspace(opts.workspace));
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check("Claude Code adapter removed");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

claudeCmd
  .command("status")
  .description("Show Claude adapter and saved ChatGPT session status")
  .option("-w, --workspace <path>")
  .option("--agent-session <id>", "Claude chat/session id")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; agentSession?: string; json: boolean }) => {
    try {
      const result = readClaudeStatus({
        workspaceRoot: resolveWorkspace(opts.workspace),
        agentSessionId: opts.agentSession,
      });
      if (opts.json) say(JSON.stringify(result));
      else if (result.ready) check(`Claude adapter ready (${result.workspaceName})`);
      else say("Claude adapter is not ready; install it and verify the ChatGPT chat for this workspace.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

claudeCmd
  .command("prompt-hook", { hidden: true })
  .description("Inject and start the mandatory C2C workflow for matching prompts")
  .option("--workspace-root <path>", "canonical workspace bound at install time")
  .action((opts: { workspaceRoot?: string }) => {
    try {
      const input = readHookInput();
      const result = claudePromptHook({
        workspaceRoot: resolveWorkspace(
          opts.workspaceRoot ?? (typeof input.cwd === "string" ? input.cwd : undefined)
        ),
        prompt: typeof input.prompt === "string" ? input.prompt : "",
        command: selfCommand(),
        agentSessionId: typeof input.session_id === "string" ? input.session_id : undefined,
      });
      say(JSON.stringify(result));
    } catch {
      say("{}");
    }
  });

claudeCmd
  .command("guard-hook", { hidden: true })
  .description("Prevent implementation before the ChatGPT PLAN is recorded")
  .option("--workspace-root <path>", "canonical workspace bound at install time")
  .action((opts: { workspaceRoot?: string }) => {
    try {
      const input = readHookInput();
      const result = claudeGuardHook({
        workspaceRoot: resolveWorkspace(
          opts.workspaceRoot ?? (typeof input.cwd === "string" ? input.cwd : undefined)
        ),
        toolName: typeof input.tool_name === "string" ? input.tool_name : "",
        toolInput:
          input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
            ? (input.tool_input as Record<string, unknown>)
            : {},
        agentSessionId: typeof input.session_id === "string" ? input.session_id : undefined,
      });
      say(JSON.stringify(result));
    } catch (error) {
      say(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `C2C guard failed: ${(error as Error).message}`,
          },
        })
      );
    }
  });

claudeCmd
  .command("post-hook", { hidden: true })
  .description("Remind Claude to send the recorded execution for independent review")
  .option("--workspace-root <path>", "canonical workspace bound at install time")
  .action((opts: { workspaceRoot?: string }) => {
    try {
      const input = readHookInput();
      const result = claudePostHook({
        workspaceRoot: resolveWorkspace(
          opts.workspaceRoot ?? (typeof input.cwd === "string" ? input.cwd : undefined)
        ),
        agentSessionId: typeof input.session_id === "string" ? input.session_id : undefined,
      });
      say(JSON.stringify(result));
    } catch {
      say("{}");
    }
  });

// ---------------------------------------------------------------- opencode adapter

const opencodeCmd = program
  .command("opencode")
  .description("Use ChatGPT planning and review from OpenCode");

opencodeCmd
  .command("install")
  .description("Install or refresh the project-local OpenCode C2C skill")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const result = installOpenCodeAdapter(resolveWorkspace(opts.workspace), selfCommand());
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check(`OpenCode adapter installed (${result.workspaceRoot})`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

opencodeCmd
  .command("uninstall")
  .description("Remove the managed OpenCode C2C skill")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const result = uninstallOpenCodeAdapter(resolveWorkspace(opts.workspace));
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check("OpenCode adapter removed");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

opencodeCmd
  .command("status")
  .description("Show OpenCode adapter and saved ChatGPT session status")
  .option("-w, --workspace <path>")
  .option("--agent-session <id>", "OpenCode session id")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; agentSession?: string; json: boolean }) => {
    try {
      const result = readOpenCodeStatus({
        workspaceRoot: resolveWorkspace(opts.workspace),
        agentSessionId: opts.agentSession,
      });
      if (opts.json) say(JSON.stringify(result));
      else if (result.ready) check(`OpenCode adapter ready (${result.workspaceName})`);
      else say("OpenCode adapter is not ready; install it and verify the ChatGPT chat for this workspace.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record an execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--executor <id>", "id of the executor that ran this iteration, e.g. codex")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      executor?: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedText(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: opts.task,
          iteration: opts.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        executor: opts.executor?.slice(0, 80),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  tunnelCmd
    .command("login")
    .description("Open the Cloudflare login window used by a named hostname")
    .option("--json", "machine-readable output", false)
)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
