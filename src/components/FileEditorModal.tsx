import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

interface FileEditorModalProps {
  path: string;
  initialContent: string;
  readOnly: boolean;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'xml':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export default function FileEditorModal({ path, initialContent, readOnly, onClose, onSave }: FileEditorModalProps) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== initialContent;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'vs-dark';
  const language = useMemo(() => languageForPath(path), [path]);

  useEffect(() => {
    setContent(initialContent);
    setError(null);
    setSaving(false);
  }, [initialContent, path]);

  const requestClose = () => {
    if (!readOnly && dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  const save = async () => {
    if (readOnly || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(content);
      setSaving(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="presentation">
      <div className="file-editor-modal" role="dialog" aria-modal="true" aria-label={readOnly ? 'File viewer' : 'File editor'}>
        <div className="modal-header file-editor-header">
          <span className="file-editor-title" title={path}>
            {path}
          </span>
          <div className="file-editor-actions">
            {!readOnly && (
              <button className="text-button primary" type="button" onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
            <button className="text-button" type="button" onClick={requestClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
        {error && <div className="file-editor-error">{error}</div>}
        <div className="file-editor-body">
          <Suspense fallback={<div className="detail-loading">Loading editor...</div>}>
            <MonacoEditor
              className="file-editor-monaco"
              language={language}
              theme={theme}
              value={content}
              onChange={(value) => setContent(value ?? '')}
              options={{
                readOnly,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
