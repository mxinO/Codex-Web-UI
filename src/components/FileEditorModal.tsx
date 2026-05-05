import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));
const MarkdownView = lazy(() => import('./MarkdownView'));
const MARKDOWN_PREVIEW_MAX_BYTES = 1024 * 1024;

interface FileEditorModalProps {
  path: string;
  initialContent: string;
  sizeBytes?: number | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? '';
}

export function languageForPath(path: string): string {
  const name = baseName(path);
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
  if (name === 'makefile' || name.endsWith('.mk')) return 'makefile';
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name === '.bashrc' || name === '.zshrc' || name === '.profile' || name === '.bash_profile') return 'shell';

  switch (extension) {
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'fish':
      return 'shell';
    case 'c':
    case 'h':
      return 'c';
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'cu':
    case 'cuh':
      return 'cpp';
    case 'css':
      return 'css';
    case 'go':
      return 'go';
    case 'html':
    case 'htm':
      return 'html';
    case 'ini':
    case 'cfg':
    case 'conf':
      return 'ini';
    case 'java':
      return 'java';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonl':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'php':
      return 'php';
    case 'py':
    case 'pyi':
      return 'python';
    case 'r':
      return 'r';
    case 'rb':
      return 'ruby';
    case 'rs':
      return 'rust';
    case 'sql':
      return 'sql';
    case 'swift':
      return 'swift';
    case 'toml':
      return 'toml';
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

export default function FileEditorModal({ path, initialContent, sizeBytes, readOnly, onClose, onSave }: FileEditorModalProps) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');
  const dirty = content !== initialContent;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'vs-dark';
  const language = useMemo(() => languageForPath(path), [path]);
  const isMarkdown = language === 'markdown';
  const markdownPreviewAllowed = !isMarkdown || sizeBytes === null || sizeBytes === undefined || sizeBytes <= MARKDOWN_PREVIEW_MAX_BYTES;

  useEffect(() => {
    setContent(initialContent);
    setError(null);
    setSaving(false);
    setViewMode('source');
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
            {readOnly && isMarkdown && markdownPreviewAllowed && (
              <div className="file-editor-segments" role="group" aria-label="Markdown view mode">
                <button className={viewMode === 'source' ? 'active' : ''} type="button" onClick={() => setViewMode('source')}>
                  Source
                </button>
                <button className={viewMode === 'preview' ? 'active' : ''} type="button" onClick={() => setViewMode('preview')}>
                  Preview
                </button>
              </div>
            )}
            {readOnly && isMarkdown && !markdownPreviewAllowed && <span className="file-editor-note">Preview disabled for large Markdown files.</span>}
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
          {readOnly && isMarkdown && markdownPreviewAllowed && viewMode === 'preview' ? (
            <Suspense fallback={<div className="detail-loading">Loading preview...</div>}>
              <div className="file-markdown-preview">
                <MarkdownView content={content} />
              </div>
            </Suspense>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
