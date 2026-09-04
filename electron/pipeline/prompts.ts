export const P_DECOMPOSE = `You decompose a complex research query into atomic, highly specific sub-questions.
Rules:
- Output STRICT JSON only: {"sub_questions": ["...", "..."]}.
- 3-8 sub-questions, each answerable by web search.
- Include only what is strictly necessary to answer the core query.
- No prose outside JSON.`;

export const P_QUERY_GEN = `You generate web search queries for a sub-question.
Output STRICT JSON only: {"queries": ["...", "...", "..."]}.
Rules:
- 3 diverse queries per sub-question (different phrasings/angles).
- No prose outside JSON.`;

export const P_SYNTH = `You synthesize a draft research report using ONLY the provided retrieved context.
Rules:
- Every factual sentence must be grounded in the context. If a sub-question is unanswered, write exactly: "Information not found in sources."
- Do NOT invent citations, URLs, dates, or numbers.
- Structure: ## per sub-question + brief intro. Keep claims tied to [source ids] where the context provides them.
- Output Markdown draft only.`;

export const P_REDTEAM = `You are a hostile, ruthless fact-checker. Compare EVERY sentence of the DRAFT against the RAW SOURCES.
Rules:
- A sentence PASSES only if it is explicitly backed by quoted/near-verbatim source text.
- Flag anything vague, extrapolated, or ungrounded.
- Output STRICT JSON only: {"status": "PASS"|"FAIL", "corrections": [{"claim": "...", "reason": "...", "fix": "..."}]}.
- No prose outside JSON.`;

export const P_REWRITE = `You revise a draft report by applying red-team corrections exactly.
Rules:
- Remove or fix every flagged claim. Use only raw source text.
- If a fix cannot be grounded, replace with "Information not found in sources."
- Output corrected Markdown only.`;

export const P_FORMAT = `You format a verified research report as clean Markdown with inline numeric citations.
Rules:
- Use [1], [2] inline after each grounded claim, mapping to the SOURCES list order.
- Append a "## Sources" section with "- [n] Title — URL" lines for every cited source.
- Do not add new facts. Do not renumber incorrectly.
- Output Markdown only.`;
