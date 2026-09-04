import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ConnectionProfile, SearchConfig } from "../adapters/types";

const profilesFile = () => path.join(app.getPath("userData"), "profiles.enc");
const searchFile = () => path.join(app.getPath("userData"), "search.enc");

export function assertValidBaseUrl(u: string): string {
  const trimmed = (u || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a well-formed http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Base URL must use http(s)");
  }
  return trimmed.replace(/\/+$/, "");
}

function encryptJson(obj: unknown): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption unavailable (safeStorage). Cannot store keys securely.");
  }
  return safeStorage.encryptString(JSON.stringify(obj));
}

function decryptJson<T>(buf: Buffer): T {
  return JSON.parse(safeStorage.decryptString(buf)) as T;
}

function readEnc<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return decryptJson<T>(fs.readFileSync(file));
  } catch {
    // Never silently discard user data: quarantine the corrupt file.
    try {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.error(`[store] encrypted store unreadable, quarantined to ${backup}; starting fresh`);
    } catch {
      console.error("[store] encrypted store unreadable and backup failed; starting fresh");
    }
    return fallback;
  }
}

function writeEnc(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encryptJson(obj), { mode: 0o600 });
}

function loadRawProfiles(): ConnectionProfile[] {
  return readEnc<ConnectionProfile[]>(profilesFile(), []);
}

/** Masked list for renderer — never includes keys. */
export function listProfiles() {
  return loadRawProfiles().map((p) => ({
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    baseUrl: p.baseUrl,
    model: p.model,
    contextWindow: p.contextWindow,
    maxOutputTokens: p.maxOutputTokens,
    temperature: p.temperature,
    reasoningEnabled: p.reasoningEnabled,
    reasoningEffort: p.reasoningEffort,
    thinkingBudgetTokens: p.thinkingBudgetTokens,
    phaseOverrides: p.phaseOverrides ?? {},
    hasKey: !!p.apiKeyEncrypted,
  }));
}

export function saveProfile(input: Record<string, unknown>): { id: string } {
  const baseUrl = assertValidBaseUrl(String(input.baseUrl ?? ""));
  const model = String(input.model ?? "").trim();
  if (!model) throw new Error("Model name is required (free-text model ID)");
  const name = String(input.name ?? "").trim() || `${model}`;
  const providerType = input.providerType === "anthropic-compatible" ? "anthropic-compatible" : "openai-compatible";

  const all = loadRawProfiles();
  const id = typeof input.id === "string" && input.id ? String(input.id) : crypto.randomUUID();
  const prev = all.find((p) => p.id === id);

  let apiKeyEncrypted = prev?.apiKeyEncrypted;
  if (input.clearApiKey === true) {
    apiKeyEncrypted = undefined;
  } else if (typeof input.apiKey === "string") {
    // Empty string clears the key (local models). Otherwise re-encrypt.
    const k = (input.apiKey as string).trim();
    if (!k) apiKeyEncrypted = undefined;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption unavailable");
      apiKeyEncrypted = safeStorage.encryptString(k).toString("base64");
    }
  }

  const tempRaw = typeof input.temperature === "number" ? (input.temperature as number) : 0.2;
  const temperature = Number.isFinite(tempRaw) ? Math.min(2, Math.max(0, tempRaw)) : 0.2;
  const effortRaw = input.reasoningEffort as string;
  const reasoningEffort = (["low", "medium", "high"].includes(effortRaw) ? effortRaw : "medium") as ConnectionProfile["reasoningEffort"];
  // Sanitize overrides: drop empty values and self/unknown ids are resolved
  // at runtime, but falsy entries are always meaningless.
  const rawOverrides = (input.phaseOverrides as Record<string, unknown>) ?? prev?.phaseOverrides ?? {};
  const phaseOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (typeof v === "string" && v.trim()) phaseOverrides[k] = v.trim();
  }

  const record: ConnectionProfile = {
    id,
    name,
    providerType,
    baseUrl,
    apiKeyEncrypted,
    model,
    contextWindow: Math.max(1024, Number(input.contextWindow) || 128000),
    maxOutputTokens: Math.max(256, Number(input.maxOutputTokens) || 4096),
    temperature,
    reasoningEnabled: !!input.reasoningEnabled,
    reasoningEffort,
    thinkingBudgetTokens: Math.min(32000, Math.max(1024, Number(input.thinkingBudgetTokens) || 8000)),
    phaseOverrides,
  };
  const idx = all.findIndex((p) => p.id === id);
  if (idx >= 0) all[idx] = record;
  else all.push(record);
  writeEnc(profilesFile(), all);
  return { id };
}

export function deleteProfile(id: string): void {
  writeEnc(profilesFile(), loadRawProfiles().filter((p) => p.id !== id));
}

/** True when a profile id exists in the encrypted store. */
export function hasProfile(id: string): boolean {
  return loadRawProfiles().some((p) => p.id === id);
}

/** Main-process only: includes decrypted key in memory. Never send to renderer. */
export function getProfileForMain(id: string): ConnectionProfile & { apiKey?: string } {
  const p = loadRawProfiles().find((x) => x.id === id);
  if (!p) throw new Error(`Profile not found: ${id}`);
  let apiKey: string | undefined;
  if (p.apiKeyEncrypted) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(p.apiKeyEncrypted, "base64"));
    } catch {
      apiKey = undefined;
    }
  }
  return { ...p, apiKey };
}

export function getSearchConfigMasked() {
  const s = readEnc<Record<string, unknown>>(searchFile(), { provider: "tavily" });
  return {
    provider: s.provider === "serper" ? "serper" : "tavily",
    baseUrlOverride: (s.baseUrlOverride as string) ?? "",
    hasKey: !!(s.apiKeyEncrypted as string),
  };
}

export function saveSearchConfig(input: { provider: "tavily" | "serper"; apiKey?: string; baseUrlOverride?: string }) {
  const prev = readEnc<Record<string, unknown>>(searchFile(), {});
  let apiKeyEncrypted = prev.apiKeyEncrypted as string | undefined;
  if (typeof input.apiKey === "string") {
    const k = input.apiKey.trim();
    if (!k) apiKeyEncrypted = undefined;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption unavailable");
      apiKeyEncrypted = safeStorage.encryptString(k).toString("base64");
    }
  }
  let baseUrlOverride = "";
  if (input.baseUrlOverride?.trim()) baseUrlOverride = assertValidBaseUrl(input.baseUrlOverride);
  writeEnc(searchFile(), { provider: input.provider, apiKeyEncrypted, baseUrlOverride });
}

export function getSearchForMain(): { provider: "tavily" | "serper"; apiKey?: string; baseUrlOverride?: string } {
  const s = readEnc<Record<string, unknown>>(searchFile(), { provider: "tavily" });
  let apiKey: string | undefined;
  if (s.apiKeyEncrypted) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(s.apiKeyEncrypted as string, "base64"));
    } catch {
      apiKey = undefined;
    }
  }
  return {
    provider: s.provider === "serper" ? "serper" : "tavily",
    apiKey,
    baseUrlOverride: (s.baseUrlOverride as string) || undefined,
  };
}
