import { useCallback, useEffect, useRef, useState } from 'react';
import QueryInput from './components/QueryInput.jsx';
import LiveResearchLog from './components/LiveResearchLog.jsx';
import ReportView from './components/ReportView.jsx';
import SettingsModal from './components/SettingsModal.jsx';

const now = () => new Date().toLocaleTimeString();

export default function App() {
  const [query, setQuery] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);
  const [entries, setEntries] = useState([{ ts: now(), text: 'Idle — configure a profile in Settings, then enter a query.' }]);
  const [reasoningByPhase, setReasoningByPhase] = useState({});
  const [streamByPhase, setStreamByPhase] = useState({});
  const [markdown, setMarkdown] = useState('');
  const [sources, setSources] = useState([]);
  const activeRun = useRef(null);

  const push = useCallback((text, extra = {}) => {
    setEntries((l) => [...l.slice(-400), { ts: now(), text, ...extra }]);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await window.electronAPI.listProfiles();
      setProfiles(list);
      // Drop a selection whose profile was deleted; otherwise startResearch
      // would send a dangling id that the main process must reject.
      setSelectedId((prev) => (list.some((p) => p.id === prev) ? prev : list[0]?.id || ''));
    } catch (e) {
      push(`Failed to load profiles: ${e?.message ?? e}`, { tone: 'error' });
    }
  }, [push]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const off = window.electronAPI.onResearchEvent(({ runId: rid, event }) => {
      // Strict match: ignore stale events from superseded runs (including the
      // window between clicking Start and the invoke resolving).
      if (rid !== activeRun.current) return;
      const ev = event;
      if (ev.kind === 'phase') push(ev.message, { phase: ev.phase });
      else if (ev.kind === 'phase-reset') {
        const ph = ev.phase;
        setStreamByPhase((m) => { if (!m[ph]) return m; const n = { ...m }; delete n[ph]; return n; });
        setReasoningByPhase((m) => { if (!m[ph]) return m; const n = { ...m }; delete n[ph]; return n; });
      }
      else if (ev.kind === 'log') push(ev.message);
      else if (ev.kind === 'reasoning_delta') {
        setReasoningByPhase((m) => ({ ...m, [ev.phase]: (m[ev.phase] ?? '') + ev.data }));
      } else if (ev.kind === 'text_delta') {
        if (ev.data) setStreamByPhase((m) => ({ ...m, [ev.phase]: (m[ev.phase] ?? '') + ev.data }));
      } else if (ev.kind === 'sources') {
        setSources(ev.sources);
        push(`Sources indexed: ${ev.sources.length}`, { tone: 'ok' });
      } else if (ev.kind === 'done') {
        setMarkdown(ev.markdown);
        setSources(ev.sources);
        setRunning(false);
        setRunId(null);
        activeRun.current = null;
        push(`Done — ${ev.sources.length} sources, stats: ${JSON.stringify(ev.stats)}`, { tone: 'ok' });
      } else if (ev.kind === 'error') {
        push(`Error: ${ev.message}`, { tone: 'error' });
        setRunning(false);
        setRunId(null);
        activeRun.current = null;
      }
    });
    return off;
  }, [push]);

  // Live streaming report = formatting stream, else synthesis stream
  const streamingReport = streamByPhase.formatting || streamByPhase.synthesis || '';
  const displayMarkdown = markdown || streamingReport;

  const start = async () => {
    if (!query.trim() || running) return;
    if (!profiles.length || !selectedId) {
      push('No profile configured — open Settings first.', { tone: 'error' });
      setSettingsOpen(true);
      return;
    }
    setMarkdown('');
    setSources([]);
    setStreamByPhase({});
    setReasoningByPhase({});
    push(`Starting deep research run…`);
    // Claim the active-run slot synchronously so late events from a previous
    // run can't interleave with the new one.
    const pending = `pending-${Date.now()}`;
    activeRun.current = pending;
    try {
      const r = await window.electronAPI.startResearch({ query: query.trim(), defaultProfileId: selectedId });
      if (!r.started) { push(`Could not start: ${r.error}`, { tone: 'error' }); activeRun.current = null; return; }
      activeRun.current = r.runId;
      setRunId(r.runId);
      setRunning(true);
    } catch (e) {
      push(`Start failed: ${e?.message ?? e}`, { tone: 'error' });
      if (activeRun.current === pending) activeRun.current = null;
    }
  };

  const cancel = async () => {
    if (runId) {
      try { await window.electronAPI.cancelResearch(runId); } catch { /* ignore */ }
      push('Cancelling…');
    }
  };

  return (
    <div className="dark min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">Ultra-Accurate Deep Research</h1>
          <p className="text-xs text-zinc-500">Adversarial pipeline · every claim traceable · speed irrelevant</p>
        </div>
        <button onClick={() => setSettingsOpen(true)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
          ⚙ Settings {profiles.length ? `(${profiles.length})` : ''}
        </button>
      </header>
      <main className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-5">
          <QueryInput
            query={query} setQuery={setQuery} running={running}
            onStart={start} onCancel={cancel}
            profiles={profiles} selectedId={selectedId} setSelectedId={setSelectedId}
          />
          <ReportView markdown={displayMarkdown} sources={sources} streaming={running} />
        </div>
        <div className="min-w-0">
          <LiveResearchLog entries={entries} reasoningByPhase={reasoningByPhase} />
        </div>
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} onChanged={refresh} />}
    </div>
  );
}
