import { getSearchForMain } from "../store/profileStore";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  content?: string;
}

function baseUrl(provider: "tavily" | "serper", override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  return provider === "tavily" ? "https://api.tavily.com" : "https://google.serper.dev";
}

/** Merge the caller's signal with a timeout so a hung provider can't stall a phase forever. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return { signal: timeout, cleanup: () => {} };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([signal, timeout]), cleanup: () => {} };
  }
  // Fallback for runtimes without AbortSignal.any.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  const onTimeout = () => ctrl.abort(new Error("Search timed out"));
  signal.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(onTimeout, ms);
  if (signal.aborted) ctrl.abort(signal.reason);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function webSearch(query: string, opts: { maxResults?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  const cfg = getSearchForMain();
  if (!cfg.apiKey) throw new Error(`No ${cfg.provider} API key configured — open Settings → Web Search.`);
  const maxResults = opts.maxResults ?? 8;

  if (cfg.provider === "tavily") {
    const { signal, cleanup } = withTimeout(opts.signal, 45000);
    try {
      const res = await fetch(`${baseUrl("tavily", cfg.baseUrlOverride)}/search`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          api_key: cfg.apiKey,
          query,
          max_results: maxResults,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: "text",
        }),
      });
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const j = (await res.json()) as { results?: Array<{ url: string; title: string; content?: string; raw_content?: string }> };
      return (j.results ?? []).map((r) => ({
        url: r.url,
        title: r.title ?? r.url,
        snippet: (r.content ?? "").slice(0, 1200),
        content: r.raw_content ?? r.content ?? "",
      }));
    } finally {
      cleanup();
    }
  }

  // Serper
  const { signal, cleanup } = withTimeout(opts.signal, 45000);
  try {
    const res = await fetch(`${baseUrl("serper", cfg.baseUrlOverride)}/search`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "X-API-KEY": cfg.apiKey },
      body: JSON.stringify({ q: query, num: maxResults }),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as { organic?: Array<{ link: string; title: string; snippet: string }> };
    const hits = (j.organic ?? []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet, content: "" }));
    // Serper returns snippets only — scrape top pages for full text (best-effort).
    // Keep unscraped hits too: their snippets are still evidence.
    const top = hits.slice(0, 5);
    const rest = hits.slice(5);
    const enriched = await Promise.all(
      top.map(async (h) => ({ ...h, content: (await scrapeUrl(h.url, opts.signal)).slice(0, 12000) })),
    );
    return [...enriched, ...rest];
  } finally {
    cleanup();
  }
}

/** Minimal HTML→text scraper (Serper path + fallback). Tavily already returns content. */
export async function scrapeUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (UltraDeepResearch/0.1)" },
      });
      if (!res.ok) return "";
      // Don't download huge binaries/pages into memory.
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > 5_000_000) return "";
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype && !/text|html|xml|json/i.test(ctype)) return "";
      const html = await res.text();
      return htmlToText(html).slice(0, 15000);
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return "";
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
