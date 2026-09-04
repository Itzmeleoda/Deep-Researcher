import type { LLMRequest, LLMStreamEvent } from "./types";
import { LLMError } from "./types";
import type { Ctx } from "./openaiCompatible";

async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<{ name: string; data: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new LLMError("NETWORK", "Empty response body", true);
  const decoder = new TextDecoder();
  let buf = "";
  let curEvent = "message";
  let dataLines: string[] = [];
  const flush = function* () {
    if (dataLines.length) {
      yield { name: curEvent, data: dataLines.join("\n") };
      dataLines = [];
      curEvent = "message";
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new LLMError("ABORTED", "Aborted", false);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === "") {
          yield* flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          curEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
          continue;
        }
      }
    }
    if (buf.trim()) dataLines.push(buf.trim());
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

export async function* runAnthropicCompatible(req: LLMRequest, ctx: Ctx): AsyncGenerator<LLMStreamEvent> {
  const url = `${ctx.baseUrl}/v1/messages`;
  const thinking = req.reasoning?.enabled
    ? { budget_tokens: Math.min(32000, Math.max(1024, req.reasoning.budgetTokens ?? 8000)) }
    : null;
  // Anthropic requires budget_tokens < max_tokens, and temperature must be 1
  // when thinking is enabled — otherwise every thinking call 400s.
  const maxTokens = thinking
    ? Math.max(req.maxOutputTokens ?? ctx.maxOutputTokens ?? 4096, thinking.budget_tokens + 1024)
    : (req.maxOutputTokens ?? ctx.maxOutputTokens ?? 4096);
  const body: Record<string, unknown> = {
    model: ctx.model,
    system: req.systemPrompt,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
    temperature: thinking ? 1 : (req.temperature ?? ctx.temperature ?? 0.2),
    stream: true,
  };
  if (thinking) body.thinking = { type: "enabled", budget_tokens: thinking.budget_tokens };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}),
    } as Record<string, string>,
    body: JSON.stringify(body),
    signal: req.signal,
  }).catch((e: unknown) => {
    if ((e as Error)?.name === "AbortError") throw new LLMError("ABORTED", "Aborted", false);
    throw new LLMError("NETWORK", `Network failure: ${String((e as Error)?.message ?? e)}`, true);
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new LLMError("AUTH_FAILURE", text.slice(0, 500), false);
    if (res.status === 429) throw new LLMError("RATE_LIMIT", text.slice(0, 500), true);
    if (res.status === 400 && /context|too many tokens|maximum context|prompt is too long/i.test(text))
      throw new LLMError("CONTEXT_EXCEEDED", text.slice(0, 800), false);
    if (res.status >= 500) throw new LLMError("NETWORK", text.slice(0, 500), true);
    throw new LLMError("PROVIDER", `HTTP ${res.status}: ${text.slice(0, 500)}`, false);
  }

  for await (const ev of sseEvents(res, req.signal)) {
    if (!ev.data) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const handled = ev.name === "content_block_delta" || ev.name === "message";
    if (handled) {
      const delta = (json.delta as Record<string, unknown>) ?? {};
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        yield { type: "reasoning_delta", data: delta.thinking };
      } else if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "text_delta", data: delta.text };
      } else if (typeof (delta as Record<string, unknown>).text === "string") {
        // Tolerant: proxies that omit delta.type on text deltas.
        yield { type: "text_delta", data: String((delta as Record<string, unknown>).text) };
      } else if (typeof (delta as Record<string, unknown>).thinking === "string") {
        yield { type: "reasoning_delta", data: String((delta as Record<string, unknown>).thinking) };
      } else if (ev.name === "message" && typeof json.text === "string") {
        yield { type: "text_delta", data: json.text as string };
      }
    } else if (ev.name === "message_stop") {
      yield { type: "done", data: "" };
      return;
    } else if (ev.name === "error" || (json.type as string) === "error") {
      const err = (json.error as Record<string, unknown>) ?? json;
      throw new LLMError("PROVIDER", String(err.message ?? ev.data).slice(0, 800), false);
    }
  }
  yield { type: "done", data: "" };
}
