/**
 * Every ChatGPT DOM dependency lives here. Flows never inline selectors.
 *
 * Each logical element has an ordered candidate list: stable id first, then
 * semantic/attribute selectors, then structure. Random CSS class names are not
 * used. When nothing matches, the flow reports CHATGPT_UI_CHANGED instead of
 * interacting with the wrong element.
 */
export interface SelectorCandidates {
  composer: string[];
  sendButton: string[];
  stopButton: string[];
  message: string[];
  messageBody: string[];
  loginIndicator: string[];
}

export const SELECTORS: SelectorCandidates = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"]',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    "form button[type='submit']",
  ],
  stopButton: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label*="Stop"]',
  ],
  message: ["[data-message-author-role]"],
  messageBody: [".markdown"],
  loginIndicator: [
    'input[name="email"]',
    '[data-testid="login-button"]',
    'a[href*="/auth/login"]',
  ],
};

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const CHATGPT_NEW_CHAT_URL = "https://chatgpt.com/";

/** True for https chatgpt.com URLs (the C2C transport never drives another origin). */
export function isChatGptUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com";
  } catch {
    return false;
  }
}

/** A saved conversation URL (not the bare app root). */
export function isChatGptConversationUrl(url: string): boolean {
  if (!isChatGptUrl(url)) return false;
  const path = new URL(url).pathname;
  return path.startsWith("/c/") || path.startsWith("/g/");
}
