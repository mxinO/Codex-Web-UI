import { DiffEditor } from '@monaco-editor/react';

interface DiffViewerProps {
  before?: string;
  after?: string;
  patch?: string;
  language?: string;
}

export default function DiffViewer({ before = '', after = '', patch, language }: DiffViewerProps) {
  if (patch !== undefined) {
    return (
      <div className="diff-viewer diff-viewer--patch" data-language={language ?? 'plaintext'}>
        <section className="diff-pane diff-pane--patch" aria-label="Patch">
          <div className="diff-title">Patch</div>
          <pre>{patch}</pre>
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
