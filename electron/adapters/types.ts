export type ProviderType = "openai-compatible" | "anthropic-compatible";

export interface ConnectionProfile {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  /** base64(safeStorage.encryptString(apiKey)) — never plaintext on disk */
  apiKeyEncrypted?: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  reasoningEnabled: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  thinkingBudgetTokens?: number;
  /** phase -> profileId override */
  phaseOverrides?: Record<string, string>;
}

export type PhaseName =
  | "decomposition"
  | "retrievalQueryGen"
  | "synthesis"
  | "redTeam"
  | "formatting";

export interface LLMRequest {
  profileId: string;
  systemPrompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  stream: boolean;
  reasoning?: { enabled: boolean; effort?: "low" | "medium" | "high"; budgetTokens?: number };
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (e: LLMStreamEvent) => void;
}

export interface LLMStreamEvent {
  type: "reasoning_delta" | "text_delta" | "done" | "error";
  data: string;
}

export interface SearchConfig {
  provider: "tavily" | "serper";
  apiKeyEncrypted?: string;
  baseUrlOverride?: string;
}

export type ResearchEvent =
  | { kind: "phase"; phase: string; message: string; profileName?: string; model?: string; extra?: string }
  | { kind: "phase-reset"; phase: string }
  | { kind: "log"; message: string }
  | { kind: "reasoning_delta"; phase: string; data: string }
  | { kind: "text_delta"; phase: string; data: string }
  | { kind: "sources"; sources: CitedSource[] }
  | { kind: "done"; markdown: string; sources: CitedSource[]; stats: Record<string, unknown> }
  | { kind: "error"; message: string };

export interface CitedSource {
  id: number;
  url: string;
  title: string;
  snippet?: string;
}

export interface ScrapedDoc {
  url: string;
  title: string;
  text: string;
  subQuestion: string;
  query: string;
}

export class LLMError extends Error {
  code: "AUTH_FAILURE" | "RATE_LIMIT" | "CONTEXT_EXCEEDED" | "NETWORK" | "PROVIDER" | "ABORTED";
  retryable: boolean;
  constructor(code: LLMError["code"], message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
