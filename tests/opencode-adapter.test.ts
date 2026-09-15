import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENCODE_EXECUTOR_ID,
  OPENCODE_SKILL_PATH,
  installOpenCodeAdapter,
  opencodeAdapterInstalled,
  readOpenCodeStatus,
  renderOpenCodeSkill,
  uninstallOpenCodeAdapter,
} from "../src/adapters/opencode.js";
import { startTask } from "../src/protocol/lifecycle.js";
import { readSession, writeSession } from "../src/session/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

const FORBIDDEN_CONTENT = /model|deepseek|openai|anthropic|gemini|gpt-[0-9]|claude-[0-9]|sonnet|opus|haiku/i;

describe("OpenCode adapter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function project(): { root: string; workspace: Workspace } {
    const root = makeTmpDir("opencode-adapter");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);
    const workspace = new Workspace(root);
    const connectorName = `Codex with ChatGPT · ${workspace.name}`;
    writeSession(workspace.id, {
      conversationMode: "long-chat",
      url: "https://chatgpt.com/c/verified-chat",
      connectorName,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://c2c-project.example.com",
      mcpUrl: "https://c2c-project.example.com/mcp",
      connectorName,
    });
    return { root, workspace };
  }

  it("renders the managed skill with a valid name and the exact transport commands", () => {
    const skill = renderOpenCodeSkill("c2c");
    const frontmatter = skill.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
    expect(frontmatter?.[1]).toBe("c2c");
    expect(frontmatter?.[2].startsWith("Use when ")).toBe(true);
    expect(frontmatter?.[2].length).toBeLessThanOrEqual(1024);
    expect(skill).toContain(
      'c2c task start --executor opencode --agent-session <session-id> --goal "<goal>" --transport chrome'
    );
    expect(skill).toContain(
      'c2c task executed --executor opencode --agent-session <session-id> --task <task-id> --iteration <n> --changed-files <files|count> --tests "<summary>" --transport chrome'
    );
    expect(skill).toContain(
      "c2c task resume --executor opencode --agent-session <session-id> --transport chrome"
    );
    expect(skill).toContain("--transport manual");
    expect(skill).toContain("c2c browser status");
    expect(skill).toContain("c2c browser close");
    expect(skill).toContain("c2c prefs set");
    expect(skill).toContain("until_done");
    expect(skill).toContain("stable");
  });

  it("never names a model, a provider or a vendor in generated files", () => {
    const { root } = project();
    const installed = installOpenCodeAdapter(root);
    expect(installed.created).toEqual([OPENCODE_SKILL_PATH]);
    for (const relative of installed.created) {
      const content = fs.readFileSync(path.join(root, relative), "utf8");
      expect(content).not.toMatch(FORBIDDEN_CONTENT);
    }
  });

  it("installs only the managed skill and leaves other OpenCode content alone", () => {
    const { root } = project();
    const otherSkill = path.join(root, ".opencode", "skill", "other", "SKILL.md");
    fs.mkdirSync(path.dirname(otherSkill), { recursive: true });
    fs.writeFileSync(otherSkill, "keep me\n");
    fs.writeFileSync(path.join(root, "opencode.json"), '{ "keep": true }\n');

    const first = installOpenCodeAdapter(root);
    expect(first.created).toEqual([OPENCODE_SKILL_PATH]);
    expect(first.updated).toEqual([]);
    expect(first.unchanged).toEqual([]);
    expect(fs.readFileSync(otherSkill, "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(root, "opencode.json"), "utf8")).toBe('{ "keep": true }\n');
    expect(opencodeAdapterInstalled(root)).toBe(true);

    const second = installOpenCodeAdapter(root);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual([OPENCODE_SKILL_PATH]);
    expect(fs.readFileSync(otherSkill, "utf8")).toBe("keep me\n");
  });

  it("uninstalls only the managed skill file", () => {
    const { root } = project();
    installOpenCodeAdapter(root);
    const unrelated = path.join(root, ".opencode", "plugin", "keep.js");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, "export const keep = true;\n");

    const removed = uninstallOpenCodeAdapter(root);
    expect(removed.removedFiles).toEqual([OPENCODE_SKILL_PATH]);
    expect(opencodeAdapterInstalled(root)).toBe(false);
    expect(fs.existsSync(path.join(root, OPENCODE_SKILL_PATH))).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("export const keep = true;\n");

    const again = uninstallOpenCodeAdapter(root);
    expect(again.removedFiles).toEqual([]);
  });

  it("reports installed and ready status for a connected workspace", () => {
    const { root, workspace } = project();
    const before = readOpenCodeStatus({ workspaceRoot: root });
    expect(before.installed).toBe(false);
    expect(before.ready).toBe(false);
    expect(before.chatUrl).toBe("https://chatgpt.com/c/verified-chat");

    installOpenCodeAdapter(root);
    const installed = readOpenCodeStatus({ workspaceRoot: root, agentSessionId: "oc-session" });
    expect(installed.installed).toBe(true);
    expect(installed.connectionMatches).toBe(true);
    expect(installed.ready).toBe(true);
    expect(installed.active).toBe(false);

    startTask(
      { workspace, executor: OPENCODE_EXECUTOR_ID, agentSession: "oc-session" },
      { goal: "Implement dark mode" }
    );
    const active = readOpenCodeStatus({ workspaceRoot: root, agentSessionId: "oc-session" });
    expect(active.active).toBe(true);
    expect(active.checkpoint?.taskId).toMatch(/^c2c_/);
    expect(readSession(workspace.id)?.checkpoint).toBeUndefined();
  });

  it("wires install, status and uninstall through the CLI", () => {
    const { root } = project();
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
        env: process.env,
      });

    const install = run(["opencode", "install", "--workspace", root, "--json"]);
    expect(install.status).toBe(0);
    expect(JSON.parse(install.stdout.trim()).ok).toBe(true);
    expect(opencodeAdapterInstalled(root)).toBe(true);

    const status = run(["opencode", "status", "--workspace", root, "--agent-session", "cli-session", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout.trim()).installed).toBe(true);

    const uninstall = run(["opencode", "uninstall", "--workspace", root, "--json"]);
    expect(uninstall.status).toBe(0);
    expect(JSON.parse(uninstall.stdout.trim()).removedFiles).toEqual([OPENCODE_SKILL_PATH]);
    expect(opencodeAdapterInstalled(root)).toBe(false);
  });
});
