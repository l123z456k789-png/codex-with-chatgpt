import { mergeMachinePrefs, prefsFile, readMachinePrefs } from "./prefs.js";
import type { SetupMode } from "./prefs.js";

export { prefsFile };
export type { SetupMode };

export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];

/** Shown once, before the first ChatGPT connection on this machine. */
export const SETUP_CHOICE_PROMPT = [
  "首次连接 ChatGPT 前，请选择一种配置方式（选一次即可，之后默认沿用）：",
  "",
  "**1. AI 自动化配置（预览版）**",
  "由我在内置浏览器里完成全部设置，你只需在需要登录、验证码或二次确认时操作一次。",
  "优点：几乎不用自己点页面。",
  "缺点：步骤多，整体更慢；若自动设置连续两次无法完成，会改为「手动教学配置」。",
  "",
  "**2. 手动教学配置**",
  "我逐步告诉你打开哪个页面、填写哪几项，由你在浏览器里完成点击。",
  "优点：大约 3 分钟可以完成，过程可控、更稳定。",
  "缺点：需要你按提示操作，不能完全放手。",
  "",
  "请回复「1」或「2」。未说明时，不要自行开始配置。",
].join("\n");

export interface UiPrefsView {
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  setupChoicePrompt: string;
  remembered: {
    developerMode: boolean;
    setupMode: boolean;
  };
}

/** Compatibility view over the machine-wide prefs.json (owned by prefs.ts). */
export function readUiPrefs(): UiPrefsView {
  const machine = readMachinePrefs();
  const developerModeEnabled = machine.developerModeEnabled;
  const setupMode = machine.setupMode;
  return {
    developerModeEnabled,
    setupMode,
    setupChoicePrompt: SETUP_CHOICE_PROMPT,
    remembered: {
      developerMode: developerModeEnabled,
      setupMode: setupMode !== null,
    },
  };
}

export interface UiPrefsPatch {
  developerModeEnabled?: true;
  setupMode?: SetupMode;
}

/** Writes through prefs.ts so transport/review settings are never dropped. */
export function mergeUiPrefs(patch: UiPrefsPatch): UiPrefsView {
  if (patch.setupMode !== undefined && !SETUP_MODES.includes(patch.setupMode)) {
    throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
  }
  mergeMachinePrefs({
    developerModeEnabled: patch.developerModeEnabled,
    setupMode: patch.setupMode,
  });
  return readUiPrefs();
}
