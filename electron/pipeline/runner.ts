import type { CitedSource, PhaseName, ResearchEvent, ScrapedDoc } from "../adapters/types";
import { getProfileForMain, hasProfile } from "../store/profileStore";
import { complete, resolveProfileId, summarizeIfNeeded } from "../adapters";
import { webSearch, scrapeUrl } from "../search/searchClient";
import { extractJson } from "./json";
import { P_DECOMPOSE, P_QUERY_GEN, P_SYNTH, P_REDTEAM, P_REWRITE, P_FORMAT } from "./prompts";

export interface RunOpts {
  query: string;
  defaultProfileId: string;
  signal?: AbortSignal;
  emit: (e: ResearchEvent) => void;
}

function profileLabel(id: string): { profileName: string; model: string; reasoning: string } {
  try {
    const p = getProfileForMain(id);
    const r = !p.reasoningEnabled
      ? "reasoning off"
      : p.providerType === "anthropic-compatible"
        ? `thinking budget ${(p.thinkingBudgetTokens ?? 8000)} tokens`
        : `reasoning_effort ${p.reasoningEffort ?? "medium"}`;
    return { profileName: p.name, model: p.model, reasoning: r };
  } catch {
    return { profileName: id, model: "", reasoning: "" };
  }
}

function reasoningArgs(id: string) {
  const p = getProfileForMain(id);
  if (!p.reasoningEnabled) return { enabled: false } as const;
  return {
    enabled: true,
    effort: p.reasoningEffort ?? "medium",
    budgetTokens: p.thinkingBudgetTokens ?? 8000,
  } as const;
}

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { code: "ABORTED" });
}

const normUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * Fit red-team input WITHOUT summarization: the red-team must check the draft
 * against raw source text, and summaries would destroy the verbatim evidence
 * (false PASS) or drop backing sentences (false FAIL loop). Keep the full
 * draft; include as many complete source texts as the budget allows.
 */
function fitRedTeamInput(draft: string, rawCorpus: string, contextWindow: number, reserveOutput: number): string {
  const head = `DRAFT:\n${draft}\n\nRAW SOURCES (verbatim — check every draft sentence against these):\n`;
  const budgetChars = Math.max(8000, Math.floor((contextWindow - reserveOutput - 2000) * 0.85 * 3.2));
  const room = budgetChars - head.length;
  if (rawCorpus.length <= room) return head + rawCorpus;
  const cut = rawCorpus.slice(0, room);
  const lastBreak = Math.max(cut.lastIndexOf("\n\n---\n\n"), cut.lastIndexOf("\n\n"));
  return `${head + (lastBreak > room * 0.5 ? cut.slice(0, lastBreak) : cut)}\n\n[NOTE: source list truncated to fit context — ${rawCorpus.length - room} further chars omitted. Only PASS claims backed by the sources shown above.]`;
}

export async function runDeepResearch(opts: RunOpts): Promise<{ markdown: string; sources: CitedSource[] }> {
  const { query, defaultProfileId, signal, emit } = opts;
  const started = Date.now();
  if (!hasProfile(defaultProfileId)) throw new Error(`Default profile not found (was it deleted?): ${defaultProfileId}`);
  const base = getProfileForMain(defaultProfileId);
  const overrides: Record<string, string> = base.phaseOverrides ?? {};
  // Validate overrides upfront: a dangling id (deleted profile) must fall
  // back loudly, not crash the run hours in.
  const pid = (ph: PhaseName) => {
    const id = resolveProfileId(defaultProfileId, ph, overrides);
    if (!hasProfile(id)) {
      emit({ kind: "log", message: `⚠ phase "${ph}" override points to a deleted profile — falling back to default` });
      return defaultProfileId;
    }
    return id;
  };

  const forward = (phase: string) => (e: { type: string; data: string }) => {
    if (e.type === "reasoning_delta") emit({ kind: "reasoning_delta", phase, data: e.data });
    else if (e.type === "text_delta" && e.data) emit({ kind: "text_delta", phase, data: e.data });
  };

  // ---------- Phase 1: decomposition ----------
  {
    const id = pid("decomposition");
    const l = profileLabel(id);
    emit({ kind: "phase", phase: "decomposition", message: `Decomposing query... (Profile: ${l.profileName} — ${l.model}, ${l.reasoning})`, profileName: l.profileName, model: l.model });
  }
  const { text: decompRaw } = await complete({
    profileId: pid("decomposition"),
    systemPrompt: P_DECOMPOSE,
    messages: [{ role: "user", content: query }],
    stream: false,
    temperature: 0.2,
    reasoning: reasoningArgs(pid("decomposition")),
    signal,
    onEvent: forward("decomposition"),
  });
  check(signal);
  let subQuestions: string[];
  try {
    subQuestions = (extractJson<{ sub_questions: string[] }>(decompRaw).sub_questions ?? []).map((s) => String(s)).filter(Boolean).slice(0, 8);
  } catch {
    subQuestions = [query];
  }
  if (!subQuestions.length) subQuestions = [query];
  emit({ kind: "log", message: `Decomposed into ${subQuestions.length} sub-question(s)` });

  // ---------- Phase 2: retrieval ----------
  const docs: ScrapedDoc[] = [];
  const seen = new Set<string>();
  const docKeys = new Set<string>();
  for (let i = 0; i < subQuestions.length; i++) {
    const sq = subQuestions[i];
    check(signal);
    emit({ kind: "phase", phase: "retrieval", message: `Searching for sub-question ${i + 1} of ${subQuestions.length}: ${sq.slice(0, 90)}` });
    const { text: qRaw } = await complete({
      profileId: pid("retrievalQueryGen"),
      systemPrompt: P_QUERY_GEN,
      messages: [{ role: "user", content: `Sub-question: ${sq}` }],
      stream: false,
      temperature: 0.3,
      reasoning: reasoningArgs(pid("retrievalQueryGen")),
      signal,
      onEvent: forward("retrieval"),
    });
    let queries: string[];
    try {
      queries = extractJson<{ queries: string[] }>(qRaw).queries.map(String).filter(Boolean).slice(0, 4);
    } catch {
      emit({ kind: "log", message: "  query-gen output was not JSON — searching the sub-question verbatim" });
      queries = [sq];
    }
    if (!queries.length) queries = [sq];

    // Per-sub-question evidence accounting: a URL already stored under an
    // earlier sub-question still counts as evidence here (judge on corpus
    // attribution, not just fresh downloads).
    const attributed = new Set<string>();
    for (let attempt = 1; attempt <= 3; attempt++) {
      check(signal);
      emit({ kind: "log", message: `  retrieval pass ${attempt}/3 — ${queries.length} querie(s)` });
      for (const q of queries) {
        check(signal);
        emit({ kind: "log", message: `  searching: "${q.slice(0, 80)}"` });
        let hits: Awaited<ReturnType<typeof webSearch>> = [];
        try {
          hits = await webSearch(q, { maxResults: 6, signal });
        } catch (e) {
          emit({ kind: "log", message: `  search error: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
          continue;
        }
        for (const h of hits.slice(0, 6)) {
          if (!h.url || !/^https?:\/\//i.test(h.url)) continue;
          const key = normUrl(h.url);
          if (!seen.has(key)) {
            seen.add(key);
            let text = (h.content ?? "").trim() || (h.snippet ?? "").trim();
            if (text.length < 600) {
              const scraped = await scrapeUrl(h.url, signal);
              if (scraped) text = scraped;
            }
            if (text) {
              docs.push({ url: h.url, title: h.title || h.url, text: text.slice(0, 14000), subQuestion: sq, query: q });
              docKeys.add(key);
            }
          }
          // Attribute only corpus-backed URLs (text retrievable now or earlier).
          if (docKeys.has(key)) attributed.add(key);
        }
      }
      // Enough distinct evidence for this sub-question?
      if (attributed.size >= 3) break;
      if (attempt === 3) break;
      // Reformulate and try once more with fresh queries.
      const { text: rq } = await complete({
        profileId: pid("retrievalQueryGen"),
        systemPrompt: "Reformulate failed web searches. Output STRICT JSON {\"queries\": [...]} with 2 new more specific queries.",
        messages: [{ role: "user", content: `Sub-question: ${sq}\nPrior queries: ${queries.join(" | ")}\nRetrieved too little. Generate 2 different queries.` }],
        stream: false,
        temperature: 0.5,
        signal,
      });
      try {
        const next = extractJson<{ queries: string[] }>(rq).queries.map(String).filter(Boolean).slice(0, 2);
        if (!next.length) break;
        queries = next;
      } catch {
        break; // reformulation unusable — stop rather than re-searching stale queries
      }
    }
    if (attributed.size === 0) emit({ kind: "log", message: `  ⚠ no sources found for sub-question ${i + 1} — will mark "Information not found in sources."` });
  }

  const sources: CitedSource[] = [];
  const urlToId = new Map<string, number>();
  for (const d of docs) {
    const k = d.url.replace(/\/+$/, "");
    if (!urlToId.has(k)) {
      const id = urlToId.size + 1;
      urlToId.set(k, id);
      sources.push({ id, url: d.url, title: d.title, snippet: d.text.slice(0, 300) });
    }
  }
  emit({ kind: "sources", sources });
  emit({ kind: "log", message: `Retrieved ${docs.length} doc(s) from ${sources.length} unique URL(s)` });

  const rawCorpus = docs
    .map((d) => `[SOURCE ${(urlToId.get(d.url.replace(/\/+$/, "")) ?? 0)}] URL: ${d.url}\nTITLE: ${d.title}\nSUB-Q: ${d.subQuestion}\nTEXT:\n${d.text}`)
    .join("\n\n---\n\n");

  // ---------- Phase 3-5: synthesis + red-team loop ----------
  let draft = "";
  const maxIters = 5;
  let pass = false;
  let lastCorrections: Array<Record<string, string>> = [];
  for (let iter = 1; iter <= maxIters; iter++) {
    check(signal);
    {
      const id = pid("synthesis");
      const l = profileLabel(id);
      emit({ kind: "phase-reset", phase: "synthesis" });
      emit({
        kind: "phase", phase: "synthesis",
        message: iter === 1
          ? `Synthesizing draft from ${docs.length} doc(s)... (Profile: ${l.profileName} — ${l.model})`
          : `Revising draft (Attempt ${iter}/${maxIters})... (Profile: ${l.profileName})`,
        profileName: l.profileName, model: l.model,
      });
    }
    const synthProfile = getProfileForMain(pid("synthesis"));
    const { text: contextForModel, summarized } = await summarizeIfNeeded(
      iter === 1
        ? `SUB-QUESTIONS:\n${subQuestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nRETRIEVED CONTEXT:\n${rawCorpus || "(no context retrieved)"}`
        : `SUB-QUESTIONS:\n${subQuestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nRETRIEVED CONTEXT:\n${rawCorpus || "(no context retrieved)"}\n\nRED-TEAM CORRECTIONS TO APPLY:\n${JSON.stringify(lastCorrections).slice(0, 20000)}\n\nPREVIOUS DRAFT:\n${draft.slice(0, 30000)}`,
      { profileId: pid("synthesis"), phase: "synthesis", signal },
    );
    if (summarized) emit({ kind: "log", message: "  context exceeded profile window — map-reduce summaries used for synthesis" });
    const sys = iter === 1 ? P_SYNTH : P_REWRITE;
    // Budget-aware cap (not a fixed 180k chars): never silently truncate
    // beyond what the synthesis profile can actually read.
    const synthBudgetChars = Math.max(12000, Math.floor((synthProfile.contextWindow - synthProfile.maxOutputTokens) * 0.85 * 3.2));
    const { text } = await complete({
      profileId: pid("synthesis"),
      systemPrompt: sys,
      messages: [{ role: "user", content: `ORIGINAL QUERY: ${query}\n\n${contextForModel}`.slice(0, synthBudgetChars) }],
      stream: true,
      temperature: 0.2,
      reasoning: reasoningArgs(pid("synthesis")),
      signal,
      onEvent: forward("synthesis"),
    });
    if (!text.trim()) {
      emit({ kind: "log", message: `  ⚠ synthesis returned empty output (attempt ${iter}) — retrying once` });
      const { text: retry } = await complete({
        profileId: pid("synthesis"),
        systemPrompt: sys,
        messages: [{ role: "user", content: `ORIGINAL QUERY: ${query}\n\n${contextForModel}`.slice(0, synthBudgetChars) }],
        stream: true,
        temperature: 0.2,
        reasoning: reasoningArgs(pid("synthesis")),
        signal,
        onEvent: forward("synthesis"),
      });
      if (!retry.trim()) throw new Error("Synthesis repeatedly returned empty output — aborting (check model/profile)");
      draft = retry;
    } else {
      draft = text;
    }
    check(signal);

    // Phase 4: red-team (reasoning model recommended)
    {
      const id = pid("redTeam");
      const l = profileLabel(id);
      emit({ kind: "phase-reset", phase: "redteam" });
      emit({
        kind: "phase", phase: "redteam",
        message: `🧠 Red Team reviewing draft (Attempt ${iter}/${maxIters}) — ${l.reasoning} (Profile: ${l.profileName} — ${l.model})`,
        profileName: l.profileName, model: l.model, extra: l.reasoning,
      });
    }
    // NEVER summarize here: the verdict is only valid against raw sources.
    const rtProfile = getProfileForMain(pid("redTeam"));
    const rtInput = fitRedTeamInput(draft, rawCorpus || "(none)", rtProfile.contextWindow, rtProfile.maxOutputTokens);
    const { text: verdictRaw } = await complete({
      profileId: pid("redTeam"),
      systemPrompt: P_REDTEAM,
      messages: [{ role: "user", content: rtInput }],
      stream: false,
      temperature: 0.1,
      reasoning: reasoningArgs(pid("redTeam")),
      signal,
      onEvent: forward("redteam"),
    });
    let verdict: { status: string; corrections?: Array<Record<string, string>> };
    try {
      verdict = extractJson(verdictRaw);
    } catch {
      verdict = { status: "FAIL", corrections: [{ claim: "(unparseable verdict — re-ground draft)", reason: "Red-team output was not valid JSON", fix: "Remove ungrounded claims" }] };
    }
    if (String(verdict.status).toUpperCase() === "PASS") {
      pass = true;
      emit({ kind: "log", message: `Red Team: PASS on attempt ${iter}` });
      break;
    }
    lastCorrections = (verdict.corrections ?? []) as Array<Record<string, string>>;
    emit({ kind: "log", message: `Red Team: FAIL (${lastCorrections.length} correction(s)) — refining...` });
  }
  if (!pass) emit({ kind: "log", message: `Red Team never fully passed after ${maxIters} attempts — delivering best-effort grounded draft` });

  // ---------- Phase 6: formatting ----------
  check(signal);
  const fmtProfile = getProfileForMain(pid("formatting"));
  {
    const l = profileLabel(pid("formatting"));
    emit({ kind: "phase-reset", phase: "formatting" });
    emit({ kind: "phase", phase: "formatting", message: `Formatting final report with citations... (Profile: ${l.profileName})`, profileName: l.profileName, model: l.model });
  }
  const sourceList = sources.map((s) => `[${s.id}] ${s.title} — ${s.url}`).join("\n");
  const fmtBudgetChars = Math.max(12000, Math.floor((fmtProfile.contextWindow - fmtProfile.maxOutputTokens) * 0.85 * 3.2));
  const fmtInput = `ORIGINAL QUERY: ${query}\n\nVERIFIED DRAFT:\n${draft}\n\nSOURCES (use these ids/URLs exactly):\n${sourceList || "(no sources)"}`;
  if (fmtInput.length > fmtBudgetChars) {
    emit({ kind: "log", message: `  ⚠ verified draft exceeds formatting budget — formatting head + tail sections (citations preserved)` });
  }
  const { text: formatted } = await complete({
    profileId: pid("formatting"),
    systemPrompt: P_FORMAT,
    messages: [{ role: "user", content: fmtInput.slice(0, fmtBudgetChars) }],
    stream: true,
    temperature: 0.1,
    reasoning: reasoningArgs(pid("formatting")),
    signal,
    onEvent: forward("formatting"),
  });
  let markdown = formatted.trim() || draft;
  if (!/## Sources/i.test(markdown) && sources.length) {
    markdown += `\n\n## Sources\n${sources.map((s) => `- [${s.id}] ${s.title} — ${s.url}`).join("\n")}\n`;
  }

  const stats = { subQuestions: subQuestions.length, docs: docs.length, sources: sources.length, ms: Date.now() - started, redTeamPass: pass };
  emit({ kind: "done", markdown, sources, stats });
  return { markdown, sources };
}
