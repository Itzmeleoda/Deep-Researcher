/** Robust JSON extraction from model output (phases depend on strict JSON). */

/** Extract the first balanced {...} object starting at or after `from`. */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Parse T from text: direct parse, else first balanced object, else greedy span. */
export function extractJson<T>(text: string): T {
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new Error("Empty model output — expected JSON");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through to scanning
  }
  // Try each balanced object candidate (handles prose + multiple objects).
  let idx = trimmed.indexOf("{");
  while (idx >= 0) {
    const cand = balancedObject(trimmed, idx);
    if (!cand) break;
    try {
      return JSON.parse(cand) as T;
    } catch {
      idx = trimmed.indexOf("{", idx + 1);
    }
  }
  // Last resort: greedy first-{ to last-} (legacy behavior).
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
  throw new Error("No JSON object in model output");
}
