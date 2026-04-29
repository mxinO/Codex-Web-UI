import { DiffEditor } from '@monaco-editor/react';

interface DiffViewerProps {
  before?: string;
  after?: string;
  patch?: string;
  language?: string;
}

interface PatchLine {
  kind: 'hunk' | 'context' | 'add' | 'delete' | 'meta';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

function parseUnifiedPatch(patch: string): PatchLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const rows: PatchLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let inHunk = false;

  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', oldLine: null, newLine: null, text: line });
      continue;
    }

    if (!inHunk || line === '\\ No newline at end of file') {
      rows.push({ kind: 'meta', oldLine: null, newLine: null, text: line });
      continue;
    }

    const marker = line[0];
    if (marker === ' ') {
      rows.push({ kind: 'context', oldLine, newLine, text: line });
      oldLine = oldLine === null ? null : oldLine + 1;
      newLine = newLine === null ? null : newLine + 1;
    } else if (marker === '-') {
      rows.push({ kind: 'delete', oldLine, newLine: null, text: line });
      oldLine = oldLine === null ? null : oldLine + 1;
    } else if (marker === '+') {
      rows.push({ kind: 'add', oldLine: null, newLine, text: line });
      newLine = newLine === null ? null : newLine + 1;
    } else {
      rows.push({ kind: 'meta', oldLine: null, newLine: null, text: line });
    }
  }

  return rows;
}

export default function DiffViewer({ before = '', after = '', patch, language }: DiffViewerProps) {
  if (patch !== undefined) {
    const rows = parseUnifiedPatch(patch);
    return (
      <div className="diff-viewer diff-viewer--patch" data-language={language ?? 'plaintext'}>
        <section className="diff-pane diff-pane--patch" aria-label="Patch">
          <div className="diff-title">Patch</div>
          <div className="diff-patch" role="table" aria-label="Patch lines">
            {rows.map((row, index) => (
              <div className={`diff-line diff-line--${row.kind}`} role="row" key={`${index}:${row.text}`}>
                <span className="diff-line__old" aria-label={row.oldLine === null ? undefined : `Old line ${row.oldLine}`}>
                  {row.oldLine ?? ''}
                </span>
                <span className="diff-line__new" aria-label={row.newLine === null ? undefined : `New line ${row.newLine}`}>
                  {row.newLine ?? ''}
                </span>
                <code className="diff-line__code">{row.text}</code>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="diff-viewer" data-language={language ?? 'plaintext'}>
      <DiffEditor
        original={before}
        modified={after}
        language={language ?? 'plaintext'}
        theme={document.documentElement.dataset.theme === 'light' ? 'light' : 'vs-dark'}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          renderSideBySide: false,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
      <div className="diff-accessible">
        <pre aria-label="Before">{before}</pre>
        <pre aria-label="After">{after}</pre>
      </div>
    </div>
  );
}
