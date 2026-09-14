import { messageIdFor, type PageDriver, type PageMessage, type PageSnapshot } from "../src/transport/driver.js";

export interface FakePageInit {
  url?: string;
  composerPresent?: boolean;
  composerText?: string;
  generating?: boolean;
  loginRequired?: boolean;
  messages?: PageMessage[];
}

export class FakePageDriver implements PageDriver {
  url: string;
  composerPresent: boolean;
  composerText: string;
  generating: boolean;
  loginRequired: boolean;
  messages: PageMessage[];

  opened: string[] = [];
  focusCalls = 0;
  typeCalls = 0;
  sendClicks = 0;
  snapshotCalls = 0;
  typedTexts: string[] = [];
  readComposerResult: string | null = null;
  sendBehavior: "confirm" | "ignore" = "confirm";
  onSnapshotHook: ((driver: FakePageDriver) => void) | null = null;
  onSendHook: ((driver: FakePageDriver) => void) | null = null;

  constructor(init: FakePageInit = {}) {
    this.url = init.url ?? "https://chatgpt.com/";
    this.composerPresent = init.composerPresent ?? true;
    this.composerText = init.composerText ?? "";
    this.generating = init.generating ?? false;
    this.loginRequired = init.loginRequired ?? false;
    this.messages = init.messages ?? [];
  }

  appendUserMessage(text: string): PageMessage {
    const message: PageMessage = { id: messageIdFor(this.messages.length, text), role: "user", text };
    this.messages.push(message);
    return message;
  }

  appendAssistantMessage(text: string): PageMessage {
    const message: PageMessage = { id: messageIdFor(this.messages.length, text), role: "assistant", text };
    this.messages.push(message);
    return message;
  }

  async open(url: string): Promise<void> {
    this.opened.push(url);
    this.url = url;
  }

  async snapshot(): Promise<PageSnapshot> {
    this.snapshotCalls += 1;
    this.onSnapshotHook?.(this);
    return {
      url: this.url,
      composerPresent: this.composerPresent,
      composerText: this.composerText,
      generating: this.generating,
      loginRequired: this.loginRequired,
      messages: this.messages.map((message) => ({ ...message })),
    };
  }

  async focusComposer(): Promise<void> {
    this.focusCalls += 1;
  }

  async typeText(text: string): Promise<void> {
    this.typeCalls += 1;
    this.typedTexts.push(text);
    this.composerText += text;
  }

  async readComposerText(): Promise<string> {
    return this.readComposerResult ?? this.composerText;
  }

  async clickSend(): Promise<void> {
    this.sendClicks += 1;
    if (this.onSendHook) {
      this.onSendHook(this);
      return;
    }
    if (this.sendBehavior === "ignore") return;
    if (this.composerText !== "") {
      this.appendUserMessage(this.composerText);
      this.composerText = "";
    }
  }
}
