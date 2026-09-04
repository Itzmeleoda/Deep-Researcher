/** Token estimation + map-reduce chunking (provider-agnostic). */

export function estimateTokens(text: string): number {
  // ~4 chars/token heuristic (conservative for English). Never underestimates badly.
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/** Split text into chunks each <= maxChars, preferring paragraph/sentence boundaries. */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const p of paras) {
    if ((cur + "\n\n" + p).length <= maxChars) {
      cur = cur ? cur + "\n\n" + p : p;
      continue;
    }
    if (cur) flush();
    if (p.length <= maxChars) {
      cur = p;
    } else {
      // hard-split long paragraph on sentences then chars
      const sentences = p.split(/(?<=[.!?])\s+/);
      let s = "";
      for (const sent of sentences) {
        if ((s + " " + sent).length <= maxChars) {
          s = s ? s + " " + sent : sent;
        } else {
          if (s) chunks.push(s);
          if (sent.length <= maxChars) s = sent;
          else {
            for (let i = 0; i < sent.length; i += maxChars) chunks.push(sent.slice(i, i + maxChars));
            s = "";
          }
        }
      }
      if (s.trim()) chunks.push(s.trim());
      cur = "";
    }
  }
  flush();
  return chunks.filter(Boolean);
}

export interface ChunkPlan {
  fits: boolean;
  estimatedTokens: number;
  budgetTokens: number;
  chunks: string[];
}

/** Decide whether payload fits the profile's context window (with safety margin). */
export function planChunks(
  text: string,
  contextWindow: number,
  opts: { reserveOutput?: number; safetyMargin?: number } = {},
): ChunkPlan {
  const reserveOutput = opts.reserveOutput ?? 4096;
  const safetyMargin = opts.safetyMargin ?? 0.85;
  const budgetTokens = Math.max(2048, Math.floor((contextWindow - reserveOutput) * safetyMargin));
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= budgetTokens) return { fits: true, estimatedTokens, budgetTokens, chunks: [text] };
  // Size chunks relative to the profile's budget so each chunk request
  // (chunk + prompt + reserved output) fits even small-context profiles.
  // ~3.5 chars/token; target half the budget per chunk.
  const maxChars = Math.max(2000, Math.floor((budgetTokens / 2) * 3.2));
  return { fits: false, estimatedTokens, budgetTokens, chunks: splitIntoChunks(text, maxChars) };
}
