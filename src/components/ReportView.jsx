export function renderMarkdownLite(md) {
  // Minimal safe renderer: escape HTML, then handle headings, bold, links, citations, lists, code.
  // Escape first so model output can never break out of attributes/tags.
  const esc = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const lines = esc.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { html += '<ul class="ml-5 list-disc space-y-1">'; inList = true; }
      html += `<li>${inline(line.replace(/^\s*-\s+/, ''))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^###\s+/.test(line)) html += `<h3 class="mt-4 text-base font-semibold">${inline(line.replace(/^###\s+/, ''))}</h3>`;
    else if (/^##\s+/.test(line)) html += `<h2 class="mt-5 text-lg font-semibold">${inline(line.replace(/^##\s+/, ''))}</h2>`;
    else if (/^#\s+/.test(line)) html += `<h1 class="mt-5 text-xl font-bold">${inline(line.replace(/^#\s+/, ''))}</h1>`;
    else if (line.trim() === '') html += '<div class="h-2"></div>';
    else html += `<p class="my-1.5 leading-relaxed">${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="rounded bg-zinc-800 px-1">$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="text-sky-400">[$1]</sup>')
    .replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noreferrer" class="text-sky-400 underline">$1</a>');
}

export default function ReportView({ markdown, sources, streaming }) {
  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'deep-research-report.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown); } catch { /* clipboard may be blocked */ }
  };
  if (!markdown && !streaming) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
        Verified report streams here. Streaming text appears as it is generated; reasoning stays collapsed in the log.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">{streaming ? 'Streaming verified report…' : 'Verified report'}</h2>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">Copy MD</button>
          <button onClick={download} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">Download .md</button>
        </div>
      </div>
      <div className="prose-sm text-zinc-200" dangerouslySetInnerHTML={{ __html: renderMarkdownLite(markdown || '') }} />
      {sources?.length > 0 && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Traceable sources ({sources.length})</h3>
          <ol className="space-y-1 text-xs text-zinc-400">
            {sources.map((s) => (
              <li key={s.id}>[{s.id}] <a className="text-sky-400 underline" href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                <span className="block truncate text-zinc-600">{s.url}</span></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
