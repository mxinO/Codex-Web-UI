import { DiffEditor } from '@monaco-editor/react';

export default function DiffViewer({ before, after, language }: { before: string; after: string; language?: string }) {
  return (
    <DiffEditor
      height="70vh"
      language={language ?? 'plaintext'}
      theme={document.documentElement.dataset.theme === 'light' ? 'light' : 'vs-dark'}
      original={before}
      modified={after}
      options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, renderSideBySide: true }}
    />
  );
}
