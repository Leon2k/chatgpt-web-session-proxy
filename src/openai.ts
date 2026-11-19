import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { IncrementalMarkdown } from "./streaming-text.js";
import type { AssistantTurn, BrowserResponseUpdate } from "./types.js";

const completionId = () => `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
export const STREAM_CONTENT_CHUNK_CHARS = 16 * 1024;

export function splitStreamContent(content: string, chunkChars = STREAM_CONTENT_CHUNK_CHARS): string[] {
  if (!content) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += chunkChars) {
    chunks.push(content.slice(offset, offset + chunkChars));
  }
  return chunks;
}

export function jsonCompletion(model: string, turn: AssistantTurn) {
  return {
    id: completionId(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: turn.content, ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}) }, finish_reason: turn.finishReason }],
    usage: null,
  };
}

export class OpenAICompletionStream {
  private readonly id = completionId();
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly incremental: IncrementalMarkdown;
  private started = false;
  private ended = false;
  private lastProgress = -1;

  constructor(
    private readonly reply: FastifyReply,
    private readonly model: string,
    toolAware: boolean,
  ) {
    this.incremental = new IncrementalMarkdown(toolAware);
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.reply.hijack();
    this.reply.raw.statusCode = 200;
    this.reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    this.reply.raw.setHeader("Connection", "keep-alive");
    this.reply.raw.flushHeaders();
    this.send({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ended) return;
    this.reply.raw.write(`data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      ...payload,
    })}\n\n`);
  }

  private sendContent(content: string): void {
    for (const chunk of splitStreamContent(content)) {
      this.send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
    }
  }

  update(update: BrowserResponseUpdate): void {
    if (update.progress && (this.lastProgress < 0 || update.progress.percent >= this.lastProgress + 5 || update.progress.percent === 100)) {
      this.lastProgress = update.progress.percent;
      this.begin();
      this.send({
        choices: [{
          index: 0,
          delta: { reasoning_content: `Генерация изображения: ${update.progress.percent}%\n` },
          finish_reason: null,
        }],
      });
    }
    const content = this.incremental.update(update.text, update.markdown);
    if (!content) return;
    this.begin();
    this.sendContent(content);
  }

  finish(turn: AssistantTurn): void {
    if (this.ended) return;
    this.begin();
    if (turn.toolCalls.length) {
      if (this.incremental.hasEmittedText) {
        throw new Error("A tool call was detected after assistant text had already been streamed.");
      }
      turn.toolCalls.forEach((call, index) => this.send({
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }, finish_reason: null }],
      }));
    } else {
      const content = this.incremental.finish(turn.content ?? "");
      if (content) this.sendContent(content);
    }
    this.send({ choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason }] });
    this.reply.raw.write("data: [DONE]\n\n");
    this.reply.raw.end();
    this.ended = true;
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.begin();
    this.reply.raw.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : "ChatGPT web backend failed", type: "upstream_error" } })}\n\n`);
    this.reply.raw.write("data: [DONE]\n\n");
    this.reply.raw.end();
    this.ended = true;
  }

  get hasStarted(): boolean {
    return this.started;
  }
}

export function streamCompletion(reply: FastifyReply, model: string, turn: AssistantTurn): void {
  new OpenAICompletionStream(reply, model, turn.toolCalls.length > 0).finish(turn);
}
