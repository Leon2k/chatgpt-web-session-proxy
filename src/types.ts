export type TextContentPart = { type: "text" | "input_text"; text: string };
export type ImageUrlContentPart = {
  type: "image_url" | "input_image";
  image_url: string | { url: string; detail?: "auto" | "low" | "high" };
};
export type FileContentPart = {
  type: "file" | "input_file";
  file?: { filename?: string; file_data?: string };
  filename?: string;
  file_data?: string;
};
export type VideoUrlContentPart = {
  type: "video_url" | "input_video";
  video_url: string | { url: string };
};
export type ChatContentPart = TextContentPart | ImageUrlContentPart | FileContentPart | VideoUrlContentPart;

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type ToolDefinition = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
};

export type AssistantTurn = {
  rawText: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls";
};

export type BrowserResponseUpdate = {
  text: string;
  markdown: string;
  progress?: {
    percent: number;
  };
};

export type BrowserResponseUpdateHandler = (update: BrowserResponseUpdate) => void | Promise<void>;

export type FileAttachment = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type ImageAttachment = FileAttachment;
