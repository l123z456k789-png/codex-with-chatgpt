import { createHash } from "node:crypto";
import { normalizeMessageText } from "./delivery.js";
import { TransportError } from "./errors.js";
import { SELECTORS, type SelectorCandidates } from "./selectors.js";

export type PageRole = "user" | "assistant";

export interface PageMessage {
  id: string;
  role: PageRole;
  text: string;
}

export interface PageSnapshot {
  url: string;
  composerPresent: boolean;
  composerText: string;
  generating: boolean;
  loginRequired: boolean;
  messages: PageMessage[];
}

export interface PageDriver {
  open(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  focusComposer(): Promise<void>;
  typeText(text: string): Promise<void>;
  readComposerText(): Promise<string>;
  clickSend(): Promise<void>;
  close?(): Promise<void>;
}

export function messageIdFor(index: number, text: string): string {
  const digest = createHash("sha256")
    .update(`${index}:${normalizeMessageText(text)}`)
    .digest("hex")
    .slice(0, 8);
  return `msg-${index}-${digest}`;
}

export function parseMessageIndex(id: string): number | null {
  const match = /^msg-(\d+)-[0-9a-f]{8}$/.exec(id);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

interface RawMessage {
  role: string | null;
  text: string;
}

interface RawSnapshot {
  url: string;
  composerPresent: boolean;
  composerText: string;
  generating: boolean;
  loginRequired: boolean;
  messages: RawMessage[];
}

/**
 * Exported for regression testing. Playwright serializes this function's source
 * into the page via `page.evaluate`, so it must stay free of named function
 * bindings and any other transpiler helper references: tsx/esbuild runs with
 * keepNames, which turns inner `const fn = (...) => ...` bindings into
 * `__name(...)` calls that do not exist in the page context.
 */
export function readDomSnapshot(selectors: SelectorCandidates): RawSnapshot {
  const composer =
    selectors.composer
      .map((candidate) => document.querySelector(candidate))
      .find((element) => element !== null) ?? null;
  const stopButton =
    selectors.stopButton
      .map((candidate) => document.querySelector(candidate))
      .find((element) => element !== null) ?? null;
  const loginIndicator =
    selectors.loginIndicator
      .map((candidate) => document.querySelector(candidate))
      .find((element) => element !== null) ?? null;
  const messages = Array.from(document.querySelectorAll(selectors.message.join(","))).map((element) => {
    const roleHost = element.hasAttribute("data-message-author-role")
      ? element
      : element.querySelector("[data-message-author-role]");
    const role = roleHost?.getAttribute("data-message-author-role") ?? null;
    const body = element.querySelector(selectors.messageBody.join(","));
    const target: Element | null = body ?? element;
    return {
      role,
      text:
        target === null
          ? ""
          : target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
            ? target.value
            : (target as HTMLElement).innerText ?? target.textContent ?? "",
    };
  });
  return {
    url: location.href,
    composerPresent: composer !== null,
    composerText:
      composer === null
        ? ""
        : composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : (composer as HTMLElement).innerText ?? composer.textContent ?? "",
    generating: stopButton !== null,
    loginRequired: loginIndicator !== null || location.pathname.startsWith("/auth/"),
    messages,
  };
}

export async function createPlaywrightDriver(port: number): Promise<PageDriver> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TransportError("TRANSPORT_UNAVAILABLE", `Invalid Chrome debugging port: ${port}`);
  }

  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  const findLocator = async (candidates: string[]) => {
    for (const candidate of candidates) {
      const locator = page.locator(candidate).first();
      if ((await locator.count()) > 0) return locator;
    }
    throw new TransportError("CHATGPT_UI_CHANGED", `No ChatGPT element matched: ${candidates.join(", ")}`);
  };

  return {
    async open(url: string): Promise<void> {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },

    async snapshot(): Promise<PageSnapshot> {
      const raw = await page.evaluate(readDomSnapshot, SELECTORS);
      const messages: PageMessage[] = [];
      for (const message of raw.messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        messages.push({ id: messageIdFor(messages.length, message.text), role: message.role, text: message.text });
      }
      return {
        url: raw.url,
        composerPresent: raw.composerPresent,
        composerText: raw.composerText,
        generating: raw.generating,
        loginRequired: raw.loginRequired,
        messages,
      };
    },

    async focusComposer(): Promise<void> {
      await (await findLocator(SELECTORS.composer)).click();
    },

    async typeText(text: string): Promise<void> {
      await page.keyboard.insertText(text);
    },

    async readComposerText(): Promise<string> {
      const composer = await findLocator(SELECTORS.composer);
      return composer.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
        return (element as HTMLElement).innerText ?? element.textContent ?? "";
      });
    },

    async clickSend(): Promise<void> {
      await (await findLocator(SELECTORS.sendButton)).click();
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
