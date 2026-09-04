import { useEffect, useRef, useState } from 'react';

const PHASE_LABEL = {
  decomposition: 'Phase 1 · Decomposition',
  retrieval: 'Phase 2 · Retrieval',
  synthesis: 'Phase 3 · Synthesis',
  redteam: 'Phase 4 · Red-Team',
  formatting: 'Phase 6 · Formatting',
};

export default function LiveResearchLog({ entries, reasoningByPhase }) {
  const [showReasoning, setShowReasoning] = useState({});
  const toggle = (k) => setShowReasoning((s) => ({ ...s, [k]: !s[k] }));
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, reasoningByPhase]);

  return (
    <aside className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900">
      <h2 className="border-b border-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300">Live Research Log</h2>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="max-h-[46vh] min-h-[220px] flex-1 space-y-1.5 overflow-auto p-3 font-mono text-xs text-zinc-400">
        {entries.map((e, i) => (
          <div key={i} className="leading-relaxed">
            <span className="text-zinc-600">[{e.ts}]</span>{' '}
            {e.phase && <span className="text-zinc-500">[{PHASE_LABEL[e.phase] ?? e.phase}]</span>}{' '}
            <span className={e.tone === 'error' ? 'text-red-400' : e.tone === 'ok' ? 'text-emerald-400' : ''}>{e.text}</span>
          </div>
        ))}
      </div>
      {Object.keys(reasoningByPhase).length > 0 && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          {Object.entries(reasoningByPhase).map(([phase, text]) => (
            text ? (
              <div key={phase} className="rounded border border-purple-900/60 bg-purple-950/30 p-2">
                <button onClick={() => toggle(phase)} className="text-xs text-purple-300 hover:text-purple-100">
                  🧠 {showReasoning[phase] ? 'Hide' : 'Show'} reasoning — {PHASE_LABEL[phase] ?? phase} ({text.length} chars)
                </button>
                {showReasoning[phase] && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-purple-200/80">{text.slice(-6000)}</pre>
                )}
              </div>
            ) : null
          ))}
        </div>
      )}
    </aside>
  );
}
