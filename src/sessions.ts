import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserBackend } from "./browser.js";
import { config } from "./config.js";
import { parseAssistantTurn } from "./tool-protocol.js";
import { buildProjectBootstrapTurn } from "./project-bootstrap.js";
import { compactionTurn, hasConversationCheckpoint, isCompactionRequest, prepareCompactionMessages } from "./compaction.js";
import { decodeEncodedAttachments, extractFileAttachments, MAX_FILES_PER_TURN, type EncodedAttachment } from "./attachments.js";
import { extractImageAttachments } from "./images.js";
import { buildDeltaPrompt, buildInitialPrompt, changedInstructionMessages, commonPrefixLength, contentToText } from "./transcript.js";
import type { AssistantTurn, BrowserResponseUpdateHandler, ChatMessage, FileAttachment, ToolDefinition } from "./types.js";

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
  private pendingAttachments = new Map<string, FileAttachment[]>();
  private browserQueue = new SerialQueue();
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
    this.pendingAttachments.clear();
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
    this.pendingAttachments.delete(id);
    try {
      await fs.unlink(this.statePath(id));
      deleted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return deleted;
  }

  queueAttachments(id: string, files: EncodedAttachment[]): number {
    const decoded = decodeEncodedAttachments(files);
    const current = this.pendingAttachments.get(id) ?? [];
    if (current.length + decoded.length > MAX_FILES_PER_TURN) {
      throw new Error(`A turn may contain at most ${MAX_FILES_PER_TURN} queued files.`);
    }
    this.pendingAttachments.set(id, [...current, ...decoded]);
    return decoded.length;
  }

  private async withConversation<T>(
    id: string,
    action: (page: Page, conversationUrl: string) => Promise<T>,
  ): Promise<{ found: boolean; result?: T }> {
    const existing = this.sessions.get(id);
    if (existing) {
      const url = this.validConversationUrl(existing.conversationUrl) ?? this.validConversationUrl(existing.page.url());
      if (!url) return { found: false };
      const result = await existing.queue.run(() => this.browserQueue.run(() => action(existing.page, url)));
      return { found: true, result };
    }

    const persisted = await this.readPersisted(id);
    const url = this.validConversationUrl(persisted?.conversationUrl);
    if (!url) return { found: false };
    const result = await this.browserQueue.run(async () => {
      const page = await this.browser.newLifecyclePage(url);
      try { return await action(page, url); }
      finally { await page.close().catch(() => undefined); }
    });
    return { found: true, result };
  }

  async setArchived(id: string, archived: boolean): Promise<{ found: boolean; state?: "changed" | "unchanged" }> {
    const outcome = await this.withConversation(id, (page, url) => this.browser.setConversationArchived(page, url, archived));
    return { found: outcome.found, state: outcome.result };
  }

  async deleteRemote(id: string): Promise<{ found: boolean; remote?: "deleted" | "missing"; localDeleted: boolean }> {
    const outcome = await this.withConversation(id, (page, url) => this.browser.deleteConversation(page, url));
    const localDeleted = await this.reset(id);
    return { found: outcome.found, remote: outcome.result, localDeleted };
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

  private async completeCompaction(page: Page, messages: ChatMessage[]): Promise<AssistantTurn> {
    const prompt = buildInitialPrompt(prepareCompactionMessages(messages), []);
    // Keep compaction in the session's existing ChatGPT conversation. A
    // checkpoint may quote tool markers, so treat the response as summary text
    // and do not stream it through the ordinary tool-aware response path.
    const content = await this.browserQueue.run(() => this.browser.sendPrompt(page, prompt));
    return compactionTurn(content);
  }

  private localAuxiliaryTurn(messages: ChatMessage[]): AssistantTurn {
    const candidate = messages
      .filter(message => message.role === "user")
      .map(message => contentToText(message.content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .find(text => text && !/\b(?:title|summary|summarize)\b/i.test(text));
    const content = candidate ? candidate.slice(0, 72) : "Сессия OpenCode";
    return { content, rawText: content, toolCalls: [], finishReason: "stop" };
  }

  async complete(
    id: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    onUpdate?: BrowserResponseUpdateHandler,
    requestKind?: string,
  ): Promise<AssistantTurn> {
    if (requestKind === "title") return this.localAuxiliaryTurn(messages);
    const session = await this.getOrCreate(id);
    const queuedBehindAnother = session.queue.busy;
    if (queuedBehindAnother && tools.length === 0 && !isCompactionRequest(messages)) {
      return this.localAuxiliaryTurn(messages);
    }
    return session.queue.run(async () => {
      session.touchedAt = Date.now();

      // OpenCode compaction intentionally rewrites/reduces the transcript and
      // asks the provider for a summary. Run that one request in an isolated
      // ChatGPT conversation so it cannot diverge or mutate the live session.
      if (isCompactionRequest(messages)) {
        const turn = await this.completeCompaction(session.page, messages);
        session.conversationUrl = this.validConversationUrl(session.page.url()) ?? session.conversationUrl;
        await this.persist(session);
        return turn;
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

          // OpenCode replaced its local transcript with a checkpoint. Keep the
          // same ChatGPT conversation and append that checkpoint plus the new
          // request, preserving a one-to-one OpenCode/Web-chat mapping.
          session.shadow = [];
          session.bootstrapPending = false;
          prompt = buildDeltaPrompt(messages, tools);
          forwardedMessages = messages;
        } else {
          const delta = messages.slice(prefix);
          if (!delta.length) throw new SessionDivergedError(`Session ${id} has no new messages; refusing to duplicate an old ChatGPT turn.`);
          const updatedInstructions = changedInstructionMessages(session.shadow, messages, prefix);
          prompt = buildDeltaPrompt([...updatedInstructions, ...delta], tools);
          forwardedMessages = delta;
        }
      }

      const inlineAttachments = [
        ...extractImageAttachments(forwardedMessages),
        ...extractFileAttachments(forwardedMessages),
      ];
      const queuedAttachments = this.pendingAttachments.get(id) ?? [];
      this.pendingAttachments.delete(id);
      let raw: string;
      try {
        raw = await this.browserQueue.run(() =>
          this.browser.sendPrompt(session.page, prompt, onUpdate, [...inlineAttachments, ...queuedAttachments])
        );
      } catch (error) {
        if (queuedAttachments.length) {
          this.pendingAttachments.set(id, [...queuedAttachments, ...(this.pendingAttachments.get(id) ?? [])]);
        }
        throw error;
      }
      const turn = parseAssistantTurn(raw, tools);
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
