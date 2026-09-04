import { PrimaryButton, GhostButton } from './ui/controls.jsx';

export default function QueryInput({ query, setQuery, running, onStart, onCancel, profiles, selectedId, setSelectedId }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-zinc-400">Research query</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="max-w-[320px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
          title="Default profile for all phases (overridable per-phase in Settings)"
        >
          {profiles.length === 0 && <option value="">No profiles — open Settings</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — {p.model}</option>
          ))}
        </select>
      </div>
      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        rows={5}
        placeholder="e.g. What is the clinical evidence for creatine monohydrate in older adults? Include doses, effects, and risks."
        className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-500"
      />
      <div className="flex gap-2">
        {!running
          ? <PrimaryButton onClick={onStart} disabled={!query.trim()}>Start Deep Research</PrimaryButton>
          : <GhostButton onClick={onCancel} className="border-red-800 text-red-300 hover:bg-red-950">Cancel run</GhostButton>}
        <span className="self-center text-xs text-zinc-500">Accuracy-first: a run may take many minutes. Every claim must trace to a source.</span>
      </div>
    </section>
  );
}
