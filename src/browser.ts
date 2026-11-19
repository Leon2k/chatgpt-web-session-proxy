import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { config } from "./config.js";
import { persistentContextOptions } from "./browser-launch.js";
import { cdpLooksHeadless, cdpReachable, ensureRuntimeProfile, launchChromeForCdp, terminateChromeProcess, waitForCdp, waitForCdpToStop } from "./chrome-launch.js";
import { startXvfb, stopXvfb, type XvfbHandle } from "./xvfb.js";
import { hideNativeChrome } from "./native-visibility.js";
import { responseMarkdown } from "./response-markdown.js";
import type { BrowserResponseUpdateHandler, FileAttachment } from "./types.js";

const PROMPT_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'textarea[placeholder*="Message"]',
];
const ASSISTANT_SELECTORS = [
  '[data-chatgpt-search-unit-key$=":assistant"] [data-dil-response]',
  '[data-chatgpt-search-unit-key$=":assistant"] [data-response-body]',
  '[data-response-body]',
  '[data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
];
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label^="Send"]',
  'button.composer-submit-btn',
];
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label^="Stop"]',
];

export type AssistantResponseSnapshot = {
  id: string;
  text: string;
  html: string;
  state: string | null;
};

export function selectNewAssistantResponse(
  responses: AssistantResponseSnapshot[],
  before: ReadonlySet<string>,
): AssistantResponseSnapshot | undefined {
  // ChatGPT can append an empty completed placeholder after the real answer,
  // sometimes reusing an older response ID. Select the newest non-empty node
  // created by this turn instead of assuming the final DOM node is the answer.
  return responses.findLast(response =>
    !before.has(response.id) && (response.text.trim().length > 0 || /<img\b/i.test(response.html))
  );
}

export class BrowserBackend {
  private browser?: Browser;
  private context?: BrowserContext;
  private externalBrowser = false;
  private ownsChromeProcess = false;
  private chromePid?: number;
  private xvfb?: XvfbHandle;

  async start(): Promise<void> {
    if (this.context) return;

    if (config.browser === "chrome") {
      const expectedHeadless = config.chromeRuntimeMode === "headless";
      if (await cdpReachable(config.cdpUrl)) {
        if (config.chromeRuntimeMode === "virtual" || config.chromeRuntimeMode === "hidden") {
          throw new Error(
            `Chrome is already listening at runtime CDP ${config.cdpUrl}. ` +
            `For ${config.chromeRuntimeMode} mode the proxy must start Chrome itself so it can guarantee that the browser stays invisible. ` +
            `Stop the existing runtime Chrome and retry.`,
          );
        }
        const actualHeadless = await cdpLooksHeadless(config.cdpUrl);
        if (actualHeadless !== expectedHeadless) {
          throw new Error(
            `Chrome is already listening at runtime CDP ${config.cdpUrl}, but its mode does not match ` +
            `CHATGPT_CHROME_RUNTIME_MODE=${config.chromeRuntimeMode}. Stop that Chrome and retry.`,
          );
        }
        this.browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 10_000 });
        this.externalBrowser = true;
      } else {
        try {
          ensureRuntimeProfile();
          if (config.chromeRuntimeMode === "virtual") this.xvfb = await startXvfb();
          const launched = launchChromeForCdp({
            mode: config.chromeRuntimeMode,
            profileDir: config.chromeRuntimeProfileDir,
            cdpUrl: config.cdpUrl,
          });
          this.chromePid = launched.pid;
          await waitForCdp(config.cdpUrl);
          if (config.chromeRuntimeMode === "hidden") hideNativeChrome(this.chromePid);
          const actualHeadless = await cdpLooksHeadless(config.cdpUrl);
          if (actualHeadless !== expectedHeadless) {
            throw new Error(
              `Chrome started at ${config.cdpUrl}, but its detected mode does not match ${config.chromeRuntimeMode}.`,
            );
          }
          this.browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 10_000 });
          this.ownsChromeProcess = true;
          this.externalBrowser = false;
        } catch (launchError) {
          if (this.chromePid) {
            await terminateChromeProcess(this.chromePid).catch(() => undefined);
            await waitForCdpToStop(config.cdpUrl, 3_000).catch(() => undefined);
          }
          this.chromePid = undefined;
          await stopXvfb(this.xvfb).catch(() => undefined);
          this.xvfb = undefined;
          throw new Error(
            `Could not auto-start authenticated Chrome in ${config.chromeRuntimeMode} mode at ${config.cdpUrl}. ` +
            `Run "npm run login" to refresh the login, then retry. ` +
            `Launch error: ${launchError instanceof Error ? launchError.message : String(launchError)}`,
          );
        }
      }
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error(`Chrome at ${config.cdpUrl} has no default browser context.`);
      return;
    }

    this.context = await chromium.launchPersistentContext(
      config.profileDir,
      persistentContextOptions(),
    );
  }

  async close(): Promise<void> {
    if (config.browser === "chrome") {
      // Closing a Playwright CDP connection is not always the same as exiting Chrome.
      // Send Chrome's Browser.close command so the profile lock is released.
      if (this.browser) {
        try {
          const session = await this.browser.newBrowserCDPSession();
          await session.send("Browser.close");
        } catch {
          await this.browser.close().catch(() => undefined);
        }
      }
      try {
        await waitForCdpToStop(config.cdpUrl, 5_000);
      } catch {
        if (this.ownsChromeProcess) {
          await terminateChromeProcess(this.chromePid);
          await waitForCdpToStop(config.cdpUrl, 5_000).catch(() => undefined);
        }
      } finally {
        await stopXvfb(this.xvfb).catch(() => undefined);
      }
    } else {
      await this.context?.close().catch(() => undefined);
    }
    this.browser = undefined;
    this.context = undefined;
    this.externalBrowser = false;
    this.ownsChromeProcess = false;
    this.chromePid = undefined;
    this.xvfb = undefined;
  }

  async newConversationPage(url = config.chatgptUrl): Promise<Page> {
    await this.start();
    const page = await this.context!.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (config.browser === "chrome" && config.chromeRuntimeMode === "hidden" && this.ownsChromeProcess) {
      // Re-apply after the first real page exists. Windows creates its top-level window lazily.
      hideNativeChrome(this.chromePid);
    }
    await this.assertLoggedIn(page);
    return page;
  }

  async newLifecyclePage(url: string): Promise<Page> {
    await this.start();
    const page = await this.context!.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const body = (await page.locator("body").innerText({ timeout: 15_000 }).catch(() => "")).slice(0, 2_000);
    if (/log in|sign up|continue with google|continue with microsoft|continue with apple/i.test(body)) {
      await page.close().catch(() => undefined);
      throw new Error("The ChatGPT lifecycle page is not authenticated.");
    }
    return page;
  }

  private async firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = await candidates.count();
      for (let i = 0; i < count; i++) {
        const locator = candidates.nth(i);
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    return null;
  }

  private async fallbackPrompt(page: Page): Promise<Locator | null> {
    const candidates = page.getByRole("textbox");
    const count = await candidates.count().catch(() => 0);
    let best: { locator: Locator; y: number } | undefined;
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const box = await locator.boundingBox().catch(() => null);
      if (!box) continue;
      if (!best || box.y > best.y) best = { locator, y: box.y };
    }
    return best?.locator ?? null;
  }

  private async findPrompt(page: Page): Promise<Locator | null> {
    return (await this.firstVisible(page, PROMPT_SELECTORS)) ?? this.fallbackPrompt(page);
  }

  private async waitForPrompt(page: Page, timeoutMs = 30_000): Promise<Locator> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const prompt = await this.findPrompt(page);
      if (prompt) return prompt;
      await page.waitForTimeout(250);
    }
    throw new Error("Timed out waiting for the ChatGPT prompt editor.");
  }

  private async pageDiagnostic(page: Page): Promise<string> {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const body = (await page.locator("body").innerText({ timeout: 1000 }).catch(() => ""))
      .replace(/\s+/g, " ")
      .slice(0, 400);
    const challenge = /verify you are human|checking your browser|just a moment|cloudflare|captcha|security check/i.test(`${title} ${body}`);
    const login = /log in|sign up|continue with google|continue with microsoft|continue with apple/i.test(body);
    if (challenge) return `The attached Chrome tab appears to be on a bot/security challenge (${title || url}).`;
    if (login) return `The attached Chrome profile does not appear to be logged in to ChatGPT (${title || url}).`;
    return `No ChatGPT prompt editor was found. URL=${url}${title ? ` title=${JSON.stringify(title)}` : ""}. The ChatGPT UI may have changed.`;
  }

  async assertLoggedIn(page: Page): Promise<void> {
    if (await this.waitForPrompt(page, 15_000).catch(() => null)) return;
    const diagnostic = await this.pageDiagnostic(page);
    const chromeHint = config.browser === "chrome"
      ? (config.chromeRuntimeMode === "headless"
        ? ` Headless Chrome is currently hitting ChatGPT's security challenge. This proxy does not attempt to bypass it. Use the default auto runtime instead, run "npm run login", then retry Pi.`
        : ` Stop the proxy, run "npm run login", verify ChatGPT works in the headed browser, press Enter so Chrome closes completely, then retry Pi.`)
      : " Run \"npm run login:chromium\" first and finish login in the browser.";
    throw new Error(`${diagnostic}${chromeHint}`);
  }

  private async enterPrompt(page: Page, text: string): Promise<Locator> {
    let prompt = await this.waitForPrompt(page);
    await prompt.click();

    // ChatGPT can replace the ProseMirror/Lexical node as soon as it receives
    // focus. Re-resolve it before writing so a large compaction prompt is not
    // sent to a detached locator until Playwright's timeout expires.
    prompt = await this.waitForPrompt(page, 5_000);
    try {
      await prompt.fill(text, { timeout: 15_000 });
      return prompt;
    } catch {
      prompt = await this.waitForPrompt(page, 5_000);
      await prompt.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(text);
      return this.waitForPrompt(page, 5_000);
    }
  }

  private async uploadAttachments(page: Page, attachments: FileAttachment[]): Promise<void> {
    if (!attachments.length) return;
    const imagesOnly = attachments.every(attachment => attachment.mimeType.startsWith("image/"));
    const selectors = imagesOnly ? [
      'input[type="file"][aria-label="Attach photos"]',
      'input[type="file"][accept="image/*"][multiple]',
      'input[type="file"][accept*="image"]',
      'input[type="file"][aria-label="Attach files"]',
    ] : [
      'input[type="file"][aria-label="Attach files"]',
      'input[type="file"]:not([accept])',
    ];
    let input: Locator | null = null;
    for (const selector of selectors) {
      const candidate = page.locator(selector).last();
      if (await candidate.count()) { input = candidate; break; }
    }
    if (!input) throw new Error("ChatGPT file attachment input was not found. The web UI may have changed.");
    let processed = 0;
    let settleUpload!: () => void;
    let failUpload!: (error: Error) => void;
    const uploadsComplete = new Promise<void>((resolve, reject) => {
      settleUpload = resolve;
      failUpload = reject;
    });
    const timeout = setTimeout(() => failUpload(new Error("Timed out waiting for ChatGPT to process file attachments.")), 90_000);
    const onResponse = (response: import("playwright").Response) => {
      if (!response.url().includes("/backend-api/files/process_upload_stream")) return;
      if (!response.ok()) {
        failUpload(new Error(`ChatGPT rejected a file attachment with HTTP ${response.status()}.`));
        return;
      }
      processed += 1;
      if (processed >= attachments.length) settleUpload();
    };
    page.on("response", onResponse);
    try {
      await input.setInputFiles(attachments.map(attachment => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        buffer: attachment.buffer,
      })));
      await uploadsComplete;
    } finally {
      clearTimeout(timeout);
      page.off("response", onResponse);
    }
    await page.waitForFunction((names: string[]) => names.every(name =>
      [...document.querySelectorAll("button[aria-label]")]
        .some(button => button.getAttribute("aria-label") === `Remove ${name}`)
    ), attachments.map(attachment => attachment.name), { timeout: 45_000 });
  }

  private async prepareLifecyclePage(page: Page, conversationUrl: string): Promise<void> {
    let sameConversation = false;
    try { sameConversation = new URL(page.url()).pathname === new URL(conversationUrl).pathname; } catch { /* navigate below */ }
    if (!sameConversation) await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
  }

  private async openConversationMenu(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    const button = page.locator('button.conversation-header-control[aria-haspopup="menu"]').first();
    await button.waitFor({ state: "visible", timeout: 30_000 });
    await button.click();
  }

  async setConversationArchived(page: Page, conversationUrl: string, archived: boolean): Promise<"changed" | "unchanged"> {
    await this.prepareLifecyclePage(page, conversationUrl);
    await this.openConversationMenu(page);
    const desired = archived ? "Archive" : "Unarchive";
    const opposite = archived ? "Unarchive" : "Archive";
    const desiredItem = page.getByRole("menuitem", { name: desired, exact: true }).last();
    if (await desiredItem.isVisible().catch(() => false)) {
      await desiredItem.click();
      await page.waitForTimeout(700);
      return "changed";
    }
    if (await page.getByRole("menuitem", { name: opposite, exact: true }).last().isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return "unchanged";
    }
    throw new Error(`ChatGPT conversation menu did not expose ${desired} or ${opposite}.`);
  }

  async deleteConversation(page: Page, conversationUrl: string): Promise<"deleted" | "missing"> {
    await this.prepareLifecyclePage(page, conversationUrl);
    if (page.url() !== conversationUrl) {
      try {
        if (new URL(page.url()).pathname !== new URL(conversationUrl).pathname) return "missing";
      } catch { /* continue to the normal selector error */ }
    }
    await this.openConversationMenu(page);
    const item = page.getByRole("menuitem", { name: "Delete", exact: true }).last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Delete", exact: true }).last();
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    await confirm.click();
    await page.waitForTimeout(700);
    return "deleted";
  }

  private async assistantResponses(page: Page) {
    return page.locator(ASSISTANT_SELECTORS.join(",")).evaluateAll(async nodes =>
      Promise.all(nodes.filter(node =>
        node.hasAttribute("data-dil-response") ||
        (node.hasAttribute("data-response-body") && !node.querySelector("[data-dil-response]")) ||
        !node.querySelector("[data-response-body], [data-dil-response]")
      ).map(async (node, index) => {
        const state = node.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state") ?? null;
        const clone = node.cloneNode(true) as HTMLElement;

        // ChatGPT renders generated images with browser-local blob: URLs. Once the
        // turn is complete, make those images portable before serializing the DOM.
        if (state === null || state === "complete") {
          const sourceImages = [...node.querySelectorAll("img")];
          const clonedImages = [...clone.querySelectorAll("img")];
          await Promise.all(sourceImages.map(async (image, imageIndex) => {
            if (!image.src.startsWith("blob:")) return;
            try {
              const response = await fetch(image.src);
              const blob = await response.blob();
              if (!response.ok || !blob.type.startsWith("image/") || blob.size > 16 * 1024 * 1024) return;
              let portableBlob = blob;
              if (image.closest('[data-testid="generated-image-preview"]')) {
                try {
                  const bitmap = await createImageBitmap(blob);
                  const scale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height));
                  const canvas = document.createElement("canvas");
                  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                  const resized = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.78));
                  bitmap.close();
                  if (resized) portableBlob = resized;
                } catch {
                  // Fall back to the original generated image.
                }
              }
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(portableBlob);
              });
              clonedImages[imageIndex]?.setAttribute("src", dataUrl);
            } catch {
              // Keep the original blob URL; responseMarkdown will discard it.
            }
          }));
        }

        return {
          id: node.getAttribute("data-response-body") ||
          node.getAttribute("data-message-id") ||
          node.closest("[data-chatgpt-search-unit-key]")?.getAttribute("data-chatgpt-search-unit-key") ||
          node.closest("[data-turn-key]")?.getAttribute("data-turn-key") ||
          node.closest("article")?.getAttribute("data-testid") ||
          `legacy-${index}`,
          text: (node as HTMLElement).innerText.trim(),
          html: clone.innerHTML,
          state,
        };
      }))
    );
  }

  async sendPrompt(
    page: Page,
    text: string,
    onUpdate?: BrowserResponseUpdateHandler,
    attachments: FileAttachment[] = [],
  ): Promise<string> {
    const before = new Set((await this.assistantResponses(page)).map(response => response.id));
    await this.uploadAttachments(page, attachments);
    const prompt = await this.enterPrompt(page, text);

    const send = await this.firstVisible(page, SEND_SELECTORS);
    if (send) await send.click();
    else {
      await prompt.click();
      await page.keyboard.press("Enter");
    }

    const deadline = Date.now() + config.turnTimeoutMs;
    let last = "";
    let lastId = "";
    let lastMarkdown = "";
    let stableSince = Date.now();
    let lastProgress = -1;

    while (Date.now() < deadline) {
      if (onUpdate) {
        const progress = await page.locator("body").evaluate(() => {
          const roots = [...document.querySelectorAll('[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])')];
          for (const root of roots.reverse()) {
            const elements = [...root.querySelectorAll("*")].reverse();
            for (const element of elements) {
              if (element.children.length) continue;
              const match = (element.textContent ?? "").trim().match(/^(\d{1,3})\s*%$/);
              const percent = match ? Number.parseInt(match[1], 10) : -1;
              if (percent >= 0 && percent <= 100) return percent;
            }
          }
          return -1;
        }).catch(() => -1);
        if (progress >= 0 && progress !== lastProgress) {
          lastProgress = progress;
          await onUpdate({ text: "", markdown: "", progress: { percent: progress } });
        }
      }

      const responses = await this.assistantResponses(page);
      const current = selectNewAssistantResponse(responses, before);

      if (current) {
        if (current.id !== lastId || current.text !== last) {
          lastId = current.id;
          last = current.text;
          stableSince = Date.now();
        }

        const markdown = responseMarkdown(current.text, current.html);
        if (markdown && markdown !== lastMarkdown) {
          lastMarkdown = markdown;
          await onUpdate?.({ text: current.text, markdown });
        }

        const running = Boolean(await this.firstVisible(page, STOP_SELECTORS));
        const complete = current.state === null || current.state === "complete";

        if (markdown && complete && !running && Date.now() - stableSince >= config.settleMs) {
          return markdown;
        }
      }

      await page.waitForTimeout(250);
    }

    throw new Error("Timed out waiting for a complete new ChatGPT response.");
  }
}
