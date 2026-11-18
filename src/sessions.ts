import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserBackend } from "./browser.js";
import { config } from "./config.js";
import { parseAssistantTurn } from "./tool-protocol.js";
import { buildProjectBootstrapTurn } from "./project-bootstrap.js";
import { compactionTurn, hasConversationCheckpoint, isCompactionRequest, prepareCompactionMessages } from "./compaction.js";
import { extractImageAttachments } from "./images.js";
import { buildDeltaPrompt, buildInitialPrompt, changedInstructionMessages, commonPrefixLength } from "./transcript.js";
import type { AssistantTurn, BrowserResponseUpdateHandler, ChatMessage, ToolDefinition } from "./types.js";

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get busy(): boolean {
    return this.pending > 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next.finally(() => { this.pending -= 1; });
  }
}

type Session = {
  id: string;
  page: Page;
  shadow: ChatMessage[];
  createdAt: number;
  touchedAt: number;
  queue: SerialQueue;
  conversationUrl?: string;
  bootstrapPending: boolean;
};

type PersistedSession = Omit<Session, "page" | "queue">;

export function validChatGptConversationUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.origin === "https://chatgpt.com" && /(?:^|\/)c\/[^/]+\/?$/.test(parsed.pathname)) {
      return parsed.toString();
    }
  } catch {
    // Ignore malformed persisted URL.
  }
  return undefined;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private pendingSessions = new Map<string, Promise<Session>>();
  private cleanupTimer?: NodeJS.Timeout;
  constructor(private readonly browser: BrowserBackend) {}

  async init(): Promise<void> {
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(config.stateDir, 0o700).catch(() => undefined);
  }

  startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.pendingSessions.values()]);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.page.close()));
    this.sessions.clear();
    this.pendingSessions.clear();
  }

  list() {
    return [...this.sessions.values()].map(({ id, createdAt, touchedAt, conversationUrl }) => ({ id, createdAt, touchedAt, conversationUrl }));
  }

  private statePath(id: string): string {
    const key = crypto.createHash("sha256").update(id).digest("hex");
    return path.join(config.stateDir, `${key}.json`);
  }

  private async readPersisted(id: string): Promise<PersistedSession | null> {
    try {
      const data = JSON.parse(await fs.readFile(this.statePath(id), "utf8")) as PersistedSession;
      if (data.id !== id || !Array.isArray(data.shadow)) return null;
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async persist(session: Session): Promise<void> {
    const data: PersistedSession = {
      id: session.id,
      shadow: session.shadow,
      createdAt: session.createdAt,
      touchedAt: session.touchedAt,
      conversationUrl: session.conversationUrl,
      bootstrapPending: session.bootstrapPending,
    };
    const target = this.statePath(session.id);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temp, target);
  }

  async reset(id: string): Promise<boolean> {
    let deleted = false;
    const existing = this.sessions.get(id);
    if (existing) {
      this.sessions.delete(id);
      await existing.page.close().catch(() => undefined);
      deleted = true;
    }
    try {
      await fs.unlink(this.statePath(id));
      deleted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return deleted;
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now() - config.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) {
        this.sessions.delete(id);
        await session.page.close().catch(() => undefined);
      }
    }
  }

  private validConversationUrl(url: string | undefined): string | undefined {
    return validChatGptConversationUrl(url);
  }

  private async getOrCreate(id: string): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.touchedAt = Date.now();
      return existing;
    }

    // OpenCode may issue the main completion and an auxiliary metadata request
    // for the same affinity ID almost simultaneously. Share one creation
    // promise so both requests use the same SerialQueue and can never create
    // competing pages or overwrite the same persisted shadow transcript.
    const pending = this.pendingSessions.get(id);
    if (pending) return pending;

    const creation = this.createSession(id);
    this.pendingSessions.set(id, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingSessions.get(id) === creation) this.pendingSessions.delete(id);
    }
  }

  private async createSession(id: string): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.touchedAt = Date.now();
      return existing;
    }

    if (this.sessions.size >= config.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (oldest) {
        this.sessions.delete(oldest.id);
        await oldest.page.close().catch(() => undefined);
      }
    }

    const persisted = await this.readPersisted(id);
    const restoredUrl = this.validConversationUrl(persisted?.conversationUrl);
    const page = await this.browser.newConversationPage(restoredUrl);
    if (persisted?.shadow.length && restoredUrl) {
      const actualUrl = this.validConversationUrl(page.url());
      const expectedPath = new URL(restoredUrl).pathname;
      const actualPath = actualUrl ? new URL(actualUrl).pathname : undefined;
      if (actualPath !== expectedPath) {
        await page.close().catch(() => undefined);
        throw new SessionRestoreError(`ChatGPT no longer opened the saved conversation for session ${id}. Reset the local session and start a new ChatGPT conversation.`);
      }
    }
    const now = Date.now();
    const session: Session = {
      id,
      page,
      shadow: persisted?.shadow ?? [],
      createdAt: persisted?.createdAt ?? now,
      touchedAt: now,
      queue: new SerialQueue(),
      conversationUrl: persisted?.conversationUrl,
      bootstrapPending: persisted?.bootstrapPending ?? false,
    };
    this.sessions.set(id, session);
    return session;
  }

  private async completeCompaction(messages: ChatMessage[]): Promise<AssistantTurn> {
    const page = await this.browser.newConversationPage();
    try {
      const prompt = buildInitialPrompt(prepareCompactionMessages(messages), []);
      // A checkpoint may legitimately quote tool-protocol markers from the
      // retained transcript. Compaction never offers tools, so treat its web
      // response as summary text instead of feeding it through the tool parser.
      // Do not stream service-only compaction: ChatGPT may revise earlier
      // Markdown while composing the checkpoint, which is not append-only.
      const content = await this.browser.sendPrompt(page, prompt);
      return compactionTurn(content);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async completeIsolated(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onUpdate?: BrowserResponseUpdateHandler,
  ): Promise<AssistantTurn> {
    const page = await this.browser.newConversationPage();
    try {
      const images = extractImageAttachments(messages);
      const content = await this.browser.sendPrompt(page, buildInitialPrompt(messages, tools), onUpdate, images);
      return parseAssistantTurn(content, tools);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async complete(
    id: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    onUpdate?: BrowserResponseUpdateHandler,
  ): Promise<AssistantTurn> {
    const session = await this.getOrCreate(id);
    const queuedBehindAnother = session.queue.busy;
    return session.queue.run(async () => {
      session.touchedAt = Date.now();

      // OpenCode compaction intentionally rewrites/reduces the transcript and
      // asks the provider for a summary. Run that one request in an isolated
      // ChatGPT conversation so it cannot diverge or mutate the live session.
      if (isCompactionRequest(messages)) {
        return this.completeCompaction(messages);
      }

      // OpenCode launches auxiliary no-tool requests (for example chat-title
      // generation) with the same affinity ID as the main completion. If one
      // waited behind the main request and has a different transcript, handle
      // it in its own disposable web conversation instead of returning 409 or
      // allowing it to mutate the main session.
      if (queuedBehindAnother && tools.length === 0 && session.shadow.length &&
          commonPrefixLength(session.shadow, messages) !== session.shadow.length) {
        return this.completeIsolated(messages, tools, onUpdate);
      }

      // On the first turn of a brand-new session, deterministically ask Pi to
      // collect a small, read-only project snapshot before ChatGPT sees the
      // user's request. The following request will include this synthetic
      // assistant tool call plus Pi's local tool result.
      if (session.shadow.length === 0 && !session.bootstrapPending && config.projectBootstrap) {
        const bootstrapTurn = buildProjectBootstrapTurn(tools);
        if (bootstrapTurn) {
          session.shadow = [
            ...messages,
            { role: "assistant", content: null, tool_calls: bootstrapTurn.toolCalls },
          ];
          session.bootstrapPending = true;
          await this.persist(session);
          return bootstrapTurn;
        }
      }

      let prompt: string;
      let forwardedMessages: ChatMessage[];
      if (session.bootstrapPending) {
        const prefix = commonPrefixLength(session.shadow, messages);
        if (prefix !== session.shadow.length) {
          throw new SessionDivergedError(`Session ${id} diverged while waiting for the automatic project snapshot at message ${prefix}. Reset it or start a new Pi session (or use a new explicit X-ChatGPT-Session value).`);
        }
        const delta = messages.slice(prefix);
        if (!delta.length) throw new SessionDivergedError(`Session ${id} is waiting for Pi's automatic project-snapshot tool result.`);
        const expectedCallId = session.shadow.at(-1)?.tool_calls?.[0]?.id;
        const hasBootstrapResult = delta.some((message) => message.role === "tool" && (!expectedCallId || message.tool_call_id === expectedCallId));
        if (!hasBootstrapResult) {
          throw new SessionDivergedError(`Session ${id} did not include the automatic project-snapshot tool result. Reset it or start a new Pi session (or use a new explicit X-ChatGPT-Session value).`);
        }
        // ChatGPT has not received anything for this session yet, so send the
        // complete client transcript: original request -> synthetic bash call
        // -> local snapshot result. ChatGPT can then continue the original task.
        prompt = buildInitialPrompt(messages, tools);
        forwardedMessages = messages;
      } else if (session.shadow.length === 0) {
        prompt = buildInitialPrompt(messages, tools);
        forwardedMessages = messages;
      } else {
        const prefix = commonPrefixLength(session.shadow, messages);
        if (prefix !== session.shadow.length) {
          if (!hasConversationCheckpoint(messages)) {
            throw new SessionDivergedError(`Session ${id} diverged at message ${prefix}. Reset it or start a new Pi session (or use a new explicit X-ChatGPT-Session value).`);
          }

          // A successful OpenCode compaction replaces the old transcript with
          // a checkpoint. Rotate the web conversation and seed the new one
          // from that checkpoint rather than weakening normal divergence checks.
          const oldPage = session.page;
          session.page = await this.browser.newConversationPage();
          await oldPage.close().catch(() => undefined);
          session.shadow = [];
          session.conversationUrl = undefined;
          session.bootstrapPending = false;
          prompt = buildInitialPrompt(messages, tools);
          forwardedMessages = messages;
        } else {
          const delta = messages.slice(prefix);
          if (!delta.length) throw new SessionDivergedError(`Session ${id} has no new messages; refusing to duplicate an old ChatGPT turn.`);
          const updatedInstructions = changedInstructionMessages(session.shadow, messages, prefix);
          prompt = buildDeltaPrompt([...updatedInstructions, ...delta], tools);
          forwardedMessages = delta;
        }
      }

      const images = extractImageAttachments(forwardedMessages);
      const turn = parseAssistantTurn(await this.browser.sendPrompt(session.page, prompt, onUpdate, images), tools);
      session.bootstrapPending = false;
      session.shadow = [...messages, { role: "assistant", content: turn.content, ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}) }];
      session.conversationUrl = this.validConversationUrl(session.page.url()) ?? session.conversationUrl;
      await this.persist(session);
      return turn;
    });
  }
}

export class SessionDivergedError extends Error { override name = "SessionDivergedError"; }
export class SessionRestoreError extends Error { override name = "SessionRestoreError"; }
