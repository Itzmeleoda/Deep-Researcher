import { useEffect, useState } from 'react';
import { Field, TextInput, NumberInput, Select, PrimaryButton, GhostButton } from './ui/controls.jsx';

const PHASES = [
  { id: 'decomposition', label: 'Phase 1 · Decomposition' },
  { id: 'retrievalQueryGen', label: 'Phase 2 · Query gen' },
  { id: 'synthesis', label: 'Phase 3 · Synthesis' },
  { id: 'redTeam', label: 'Phase 4 · Red-Team' },
  { id: 'formatting', label: 'Phase 6 · Formatting' },
];

const empty = {
  name: '', providerType: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '', model: '', contextWindow: 128000, maxOutputTokens: 4096, temperature: 0.2,
  reasoningEnabled: false, reasoningEffort: 'medium', thinkingBudgetTokens: 8000, phaseOverrides: {},
};

export default function SettingsModal({ onClose, onChanged }) {
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const [msg, setMsg] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [search, setSearch] = useState({ provider: 'tavily', apiKey: '', baseUrlOverride: '', hasKey: false });

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const load = async () => {
    try {
      setProfiles(await window.electronAPI.listProfiles());
      setSearch(await window.electronAPI.getSearch());
    } catch (e) { setMsg(String(e?.message ?? e)); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setMsg('');
    try {
      if (!form.model.trim()) { setMsg('Model name is required.'); return; }
      try { new URL(form.baseUrl); } catch { setMsg('Base URL must be a well-formed http(s) URL.'); return; }
      const payload = { ...form, id: editingId ?? undefined };
      if (clearKey) {
        payload.clearApiKey = true;
        delete payload.apiKey;
      } else if (!payload.apiKey) {
        delete payload.apiKey; // blank = keep the stored key
      }
      const { id } = await window.electronAPI.saveProfile(payload);
      setEditingId(id);
      setClearKey(false);
      setMsg('Saved. Click Test Connection to verify before use.');
      await load();
      onChanged?.();
    } catch (e) { setMsg(`Save failed: ${e?.message ?? e}`); }
  };

  const test = async () => {
    setMsg('Testing…');
    try {
      const id = editingId ?? form.id;
      if (!id) { setMsg('Save first, then Test.'); return; }
      const r = await window.electronAPI.testProfile(id);
      setMsg(`${r.ok ? '✅' : '❌'} ${r.info}`);
    } catch (e) { setMsg(`❌ ${e?.message ?? e}`); }
  };

  const saveSearch = async () => {
    try {
      const payload = { provider: search.provider, baseUrlOverride: search.baseUrlOverride };
      if (search.apiKey) payload.apiKey = search.apiKey;
      await window.electronAPI.saveSearch(payload);
      setMsg('Search config saved.');
      await load();
    } catch (e) { setMsg(`Search save failed: ${e?.message ?? e}`); }
  };

  const edit = (p) => {
    setForm({ ...empty, ...p, apiKey: '', phaseOverrides: p.phaseOverrides ?? {} });
    setEditingId(p.id);
    setClearKey(false);
    setMsg(p.hasKey
      ? 'Editing — a key is stored. Leave the key field blank to keep it, type a new one to replace it, or tick “remove stored key”.'
      : 'Editing — no key stored (local / keyless endpoint).');
  };
  const editingHasKey = profiles.find((p) => p.id === editingId)?.hasKey;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings — Connection Profiles</h2>
          <GhostButton onClick={onClose}>✕ Close</GhostButton>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Profile name"><TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. OpenRouter — DeepSeek" /></Field>
          <Field label="Provider type">
            <Select value={form.providerType} onChange={(e) => set('providerType', e.target.value)}>
              <option value="openai-compatible">openai-compatible (/chat/completions)</option>
              <option value="anthropic-compatible">anthropic-compatible (/v1/messages)</option>
            </Select>
          </Field>
          <Field label="Base URL" hint="Must be http(s). Examples: https://openrouter.ai/api/v1, https://api.anthropic.com, http://localhost:11434/v1">
            <TextInput value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
          </Field>
          <Field label="Model name (free text)" hint="Any model ID your endpoint exposes.">
            <TextInput value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="e.g. deepseek/deepseek-chat, claude-3-5-sonnet-20241022, llama3.1" />
          </Field>
          <div className="md:col-span-2">
            <Field label="API key (masked, optional for local models)" hint="Stored encrypted via safeStorage. Never leaves the main process. Blank on edit = keep existing.">
              <TextInput type="password" value={form.apiKey} onChange={(e) => { set('apiKey', e.target.value); if (e.target.value) setClearKey(false); }} placeholder="sk-… (blank = no auth / keep stored)" autoComplete="off" />
            </Field>
            {editingId && editingHasKey && (
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} className="h-3.5 w-3.5" />
                Remove stored key on save (for keyless local endpoints)
              </label>
            )}
          </div>
          <Field label="Context window (tokens)"><NumberInput value={form.contextWindow} min={1024} onChange={(e) => set('contextWindow', +e.target.value)} /></Field>
          <Field label="Max output tokens"><NumberInput value={form.maxOutputTokens} min={256} onChange={(e) => set('maxOutputTokens', +e.target.value)} /></Field>
          <Field label="Temperature (0–1, default 0.2)"><NumberInput value={form.temperature} step="0.05" min={0} max={1} onChange={(e) => set('temperature', +e.target.value)} /></Field>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={form.reasoningEnabled} onChange={(e) => set('reasoningEnabled', e.target.checked)} className="h-4 w-4" />
              Reasoning / Thinking enabled
            </label>
          </div>
          {form.providerType === 'openai-compatible' && form.reasoningEnabled && (
            <Field label="reasoning_effort"><Select value={form.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value)}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </Select></Field>
          )}
          {form.providerType === 'anthropic-compatible' && form.reasoningEnabled && (
            <Field label={`thinking.budget_tokens = ${form.thinkingBudgetTokens}`}>
              <input type="range" min={1024} max={32000} step={1024} value={form.thinkingBudgetTokens}
                onChange={(e) => set('thinkingBudgetTokens', +e.target.value)} className="w-full" />
            </Field>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-zinc-800 p-3">
          <h3 className="mb-2 text-sm font-medium text-zinc-300">Per-phase overrides (optional)</h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {PHASES.map((ph) => (
              <Field key={ph.id} label={ph.label}>
                <Select
                  value={form.phaseOverrides?.[ph.id] ?? ''}
                  onChange={(e) => set('phaseOverrides', { ...(form.phaseOverrides ?? {}), [ph.id]: e.target.value || undefined })}
                >
                  <option value="">(use default profile)</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.model}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <PrimaryButton onClick={save}>{editingId ? 'Update profile' : 'Save profile'}</PrimaryButton>
          <GhostButton onClick={test}>Test Connection</GhostButton>
          <GhostButton onClick={() => { setForm(empty); setEditingId(null); setClearKey(false); setMsg('New profile draft.'); }}>+ New</GhostButton>
        </div>
        {msg && <p className="mt-2 font-mono text-xs text-zinc-400">{msg}</p>}

        <h3 className="mb-2 mt-6 text-sm font-medium text-zinc-300">Saved profiles</h3>
        <ul className="space-y-1.5">
          {profiles.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{p.name} {p.hasKey ? <span title="key stored">🔑</span> : <span title="no key" className="text-zinc-500">(no key)</span>}</div>
                <div className="truncate font-mono text-xs text-zinc-500">{p.model} · {p.providerType} · ctx {p.contextWindow}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <GhostButton onClick={() => edit(p)}>Edit</GhostButton>
                <GhostButton onClick={async () => { await window.electronAPI.deleteProfile(p.id); if (editingId === p.id) { setEditingId(null); setForm(empty); setClearKey(false); } await load(); onChanged?.(); }} className="text-red-300">Delete</GhostButton>
              </div>
            </li>
          ))}
          {profiles.length === 0 && <li className="text-sm text-zinc-500">No profiles yet.</li>}
        </ul>

        <h3 className="mb-2 mt-6 text-sm font-medium text-zinc-300">Web Search</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Provider"><Select value={search.provider} onChange={(e) => setSearch((s) => ({ ...s, provider: e.target.value }))}>
            <option value="tavily">Tavily</option><option value="serper">Serper.dev</option>
          </Select></Field>
          <Field label={`API key ${search.hasKey ? '(stored 🔑 — blank keeps it)' : ''}`}>
            <TextInput type="password" value={search.apiKey} onChange={(e) => setSearch((s) => ({ ...s, apiKey: e.target.value }))} placeholder="search API key" autoComplete="off" />
          </Field>
          <div className="md:col-span-2"><Field label="Base URL override (optional)"><TextInput value={search.baseUrlOverride} onChange={(e) => setSearch((s) => ({ ...s, baseUrlOverride: e.target.value }))} placeholder="blank = default" /></Field></div>
        </div>
        <div className="mt-3"><GhostButton onClick={saveSearch}>Save search config</GhostButton></div>
      </div>
    </div>
  );
}
