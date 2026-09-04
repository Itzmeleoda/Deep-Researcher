import type { LLMRequest, LLMStreamEvent } from "./types";
import { LLMError } from "./types";

export interface Ctx {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
}

async function* sseLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new LLMError("NETWORK", "Empty response body", true);
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new LLMError("ABORTED", "Aborted", false);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

function buildBody(req: LLMRequest, ctx: Ctx, omitTemperature = false) {
  const messages = [
    { role: "system" as const, content: req.systemPrompt },
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const body: Record<string, unknown> = {
    model: ctx.model,
    messages,
    max_tokens: req.maxOutputTokens ?? ctx.maxOutputTokens ?? 4096,
    stream: true,
    // NOTE: no stream_options — strict OpenAI-compatible servers (llama.cpp,
    // some vLLM builds) reject unknown fields with 400.
  };
  if (!omitTemperature) body.temperature = req.temperature ?? ctx.temperature ?? 0.2;
  if (req.reasoning?.enabled) {
    const effort = req.reasoning.effort ?? "medium";
    // Most OpenAI-compatible gateways accept `reasoning_effort`; some (OpenRouter) accept `reasoning: {effort}`.
    // Send both — unknown fields are ignored by tolerant servers.
    (body as Record<string, unknown>).reasoning_effort = effort;
    (body as Record<string, unknown>).reasoning = { effort };
  }
  return body;
}

function classifyStatus(status: number, text: string): LLMError {
  if (status === 401 || status === 403) return new LLMError("AUTH_FAILURE", `Auth failure (HTTP ${status}): ${text.slice(0, 400)}`, false);
  if (status === 429) return new LLMError("RATE_LIMIT", `Rate limited (HTTP 429): ${text.slice(0, 400)}`, true);
  if (status === 400 && /context|too many tokens|maximum context|prompt is too long/i.test(text))
    return new LLMError("CONTEXT_EXCEEDED", text.slice(0, 800), false);
  if (status >= 500) return new LLMError("NETWORK", `Server error (HTTP ${status}): ${text.slice(0, 400)}`, true);
  return new LLMError("PROVIDER", `Provider error (HTTP ${status}): ${text.slice(0, 500)}`, false);
}

export async function* runOpenAICompatible(req: LLMRequest, ctx: Ctx): AsyncGenerator<LLMStreamEvent> {
  const url = `${ctx.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ctx.apiKey) {
    headers.Authorization = `Bearer ${ctx.apiKey}`;
    headers["HTTP-Referer"] = "https://localhost/ultra-deep-research";
    headers["X-Title"] = "Ultra-Accurate Deep Research";
  }
  for (const omitTemperature of [false, true]) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req, ctx, omitTemperature)),
      signal: req.signal,
    }).catch((e: unknown) => {
      if ((e as Error)?.name === "AbortError") throw new LLMError("ABORTED", "Aborted", false);
      throw new LLMError("NETWORK", `Network failure: ${String((e as Error)?.message ?? e)}`, true);
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Reasoning-only models (o1/o3, R1-distill, …) reject non-default
      // temperature. Retry once without the field before giving up.
      if (!omitTemperature && res.status === 400 && /temperature|unsupported|reasoning/i.test(text)) continue;
      throw classifyStatus(res.status, text);
    }
    if (!res.body) throw new LLMError("NETWORK", "Empty SSE stream", true);
    yield* readOpenAIStream(res, req.signal);
    return;
  }
}

async function* readOpenAIStream(res: Response, signal?: AbortSignal): AsyncGenerator<LLMStreamEvent> {

  // Consecutive `data:` lines belong to one SSE event (joined with \n per
  // spec) — flush only on blank/comment/non-data lines, not per line.
  let dataLines: string[] = [];
  const flushData = function* (): Generator<LLMStreamEvent> {
    if (!dataLines.length) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const choices = (json.choices as Array<Record<string, unknown>>) ?? [];
    const delta = (choices[0]?.delta as Record<string, unknown>) ?? {};
    // Reasoning variants across vendors. NOTE: `delta.reasoning` may be an
    // object ({content}|{effort}) on some gateways — only accept strings.
    let reasoning = "";
    if (typeof delta.reasoning_content === "string") reasoning = delta.reasoning_content;
    else if (typeof delta.reasoning === "string") reasoning = delta.reasoning;
    else if (
      delta.reasoning !== null &&
      typeof delta.reasoning === "object" &&
      typeof (delta.reasoning as Record<string, unknown>).content === "string"
    ) {
      reasoning = (delta.reasoning as Record<string, unknown>).content as string;
    }
    if (reasoning) yield { type: "reasoning_delta", data: String(reasoning) };
    const content = (delta.content as string) ?? "";
    if (content) yield { type: "text_delta", data: String(content) };
  };

  for await (const raw of sseLines(res, signal)) {
    const line = raw.trim();
    if (!line || line.startsWith(":")) {
      yield* flushData(); // blank line / keepalive ends the current event
      continue;
    }
    if (line === "data: [DONE]") {
      yield* flushData();
      yield { type: "done", data: "" };
      return;
    }
    if (line.startsWith("data:")) {
      const piece = line.slice(5).trim();
      if (piece === "[DONE]") {
        yield* flushData();
        yield { type: "done", data: "" };
        return;
      }
      dataLines.push(piece);
      continue;
    }
    if (line.startsWith("{")) {
      // Tolerant: some gateways emit bare JSON lines instead of SSE.
      yield* flushData();
      dataLines = [line];
      yield* flushData();
      continue;
    }
    // Any other field (event:, id:, retry:) terminates the pending data block.
    yield* flushData();
  }
  yield* flushData();
  yield { type: "done", data: "" };
}
