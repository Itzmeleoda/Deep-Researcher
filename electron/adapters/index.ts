import type { LLMRequest, LLMStreamEvent, PhaseName } from "./types";
import { LLMError } from "./types";
import { getProfileForMain } from "../store/profileStore";
import { runOpenAICompatible } from "./openaiCompatible";
import { runAnthropicCompatible } from "./anthropicCompatible";
import { planChunks as planChunksFn } from "./chunking";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redactKey(k?: string): string {
  return k ? "***" : "(none)";
}

export function resolveProfileId(defaultId: string, phase: PhaseName, overrideMap?: Record<string, string>): string {
  if (overrideMap?.[phase]) return overrideMap[phase];
  return defaultId;
}

export async function* run(req: LLMRequest): AsyncGenerator<LLMStreamEvent> {
  const p = getProfileForMain(req.profileId);
  // Redacted log only — never full keys.
  console.log(`[llm] profile="${p.name}" type=${p.providerType} model=${p.model} key=${redactKey((p as { apiKey?: string }).apiKey)} reasoning=${req.reasoning?.enabled ? "on" : "off"}`);
  const ctx = {
    baseUrl: p.baseUrl,
    apiKey: (p as { apiKey?: string }).apiKey,
    model: p.model,
    maxOutputTokens: req.maxOutputTokens ?? p.maxOutputTokens,
    temperature: req.temperature ?? p.temperature ?? 0.2,
  };
  const maxAttempts = 4;
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    let yielded = 0;
    try {
      const gen =
        p.providerType === "openai-compatible"
          ? runOpenAICompatible(req, ctx)
          : runAnthropicCompatible(req, ctx);
      for await (const ev of gen) {
        yielded += 1;
        yield ev;
      }
      return;
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMError && !e.retryable) throw e;
      if (req.signal?.aborted) throw new LLMError("ABORTED", "Aborted", false);
      // A retry after partial output would duplicate already-streamed text in
      // callers (and corrupt complete()). Only retry a pristine attempt;
      // otherwise surface the error so the pipeline can fail loudly.
      if (yielded > 0 || attempt >= maxAttempts) throw e;
      const backoff = Math.min(15000, 800 * 2 ** (attempt - 1) + Math.random() * 400);
      console.log(`[llm] transient error attempt ${attempt}/${maxAttempts}, backoff ${Math.round(backoff)}ms: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Collect a full completion (non-streaming use) while still forwarding deltas. */
export async function complete(req: LLMRequest): Promise<{ text: string; reasoning: string }> {
  let text = "";
  let reasoning = "";
  for await (const ev of run(req)) {
    if (ev.type === "text_delta") {
      text += ev.data;
      req.onEvent?.(ev);
    } else if (ev.type === "reasoning_delta") {
      reasoning += ev.data;
      req.onEvent?.(ev);
    } else if (ev.type === "done") {
      req.onEvent?.(ev);
    }
  }
  return { text, reasoning };
}

/**
 * Map-reduce summarization when payload exceeds the profile's context window.
 * Inner compression calls never forward display events (callers stream the
 * real phase output separately) — progress is console-logged only.
 */
export async function summarizeIfNeeded(
  rawText: string,
  opts: { profileId: string; phase: PhaseName; signal?: AbortSignal },
): Promise<{ text: string; summarized: boolean }> {
  const p = getProfileForMain(opts.profileId);
  const { fits, estimatedTokens, budgetTokens, chunks } = planChunksFn(rawText, p.contextWindow, {
    reserveOutput: p.maxOutputTokens,
  });
  if (fits) return { text: rawText, summarized: false };
  console.log(`[llm] map-reduce (${opts.phase}): ~${estimatedTokens}tok > budget ${budgetTokens}tok, ${chunks.length} chunks (profile=${p.name})`);
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    opts.signal?.throwIfAborted();
    const { text } = await complete({
      profileId: opts.profileId,
      systemPrompt:
        "You compress retrieved web text for a research pipeline. Preserve every verifiable fact, number, name, date, and URL. Drop boilerplate/ads. Output concise bullet facts. Do not add anything not in the input.",
      messages: [{ role: "user", content: `Chunk ${i + 1}/${chunks.length} — compress:\n\n${chunks[i]}` }],
      stream: false,
      temperature: 0.1,
      signal: opts.signal,
    });
    partials.push(`[Chunk ${i + 1}/${chunks.length} summary]\n${text}`);
  }
  const combined = partials.join("\n\n");
  // Second-level reduce if still too big
  const re = planChunksFn(combined, p.contextWindow, { reserveOutput: p.maxOutputTokens });
  if (re.fits) return { text: combined, summarized: true };
  const { text: reduced } = await complete({
    profileId: opts.profileId,
    systemPrompt: "Merge chunk summaries into one deduplicated fact list. Keep facts, numbers, dates, URLs. No new claims.",
    messages: [{ role: "user", content: combined.slice(0, 100000) }],
    stream: false,
    temperature: 0.1,
    signal: opts.signal,
  });
  return { text: reduced, summarized: true };
}

export async function testConnection(profileId: string): Promise<{ ok: boolean; info: string }> {
  const p = getProfileForMain(profileId);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (p.providerType === "openai-compatible") {
      const headers: Record<string, string> = {};
      const key = (p as { apiKey?: string }).apiKey;
      if (key) headers.Authorization = `Bearer ${key}`;
      const r = await fetch(`${p.baseUrl}/models`, { headers, signal: ctrl.signal });
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { data?: { id: string }[] };
        const ids = (j?.data ?? []).map((m) => m.id);
        const found = ids.includes(p.model);
        return {
          ok: true,
          info: `models OK (${ids.length} models)${found ? `, "${p.model}" found` : `, "${p.model}" not listed — may still work via custom gateway`}`,
        };
      }
      const r2 = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model: p.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }),
      });
      if (!r2.ok) throw new Error(`HTTP ${r2.status}: ${(await r2.text()).slice(0, 300)}`);
      return { ok: true, info: `chat/completions reachable for "${p.model}"` };
    }
    const key = (p as { apiKey?: string }).apiKey;
    const r = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(key ? { "x-api-key": key } : {}),
      },
      body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { ok: true, info: `messages endpoint reachable for "${p.model}"` };
  } catch (e) {
    const err = e as Error;
    return { ok: false, info: err?.name === "AbortError" ? "Timeout after 15s — check base URL" : String(err?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export { planChunksFn as planChunks };
