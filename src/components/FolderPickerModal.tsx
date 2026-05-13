import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, Folder, RefreshCw } from 'lucide-react';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

interface FolderEntry {
  name: string;
  path: string;
  isDirectory: true;
}

interface BrowseResult {
  path: string;
  parent: string;
  truncated: boolean;
  entries: FolderEntry[];
}

interface FolderPickerModalProps {
  open: boolean;
  root: string;
  rpc: Rpc;
  selectDisabled?: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

function normalizeBrowseResult(result: unknown, fallbackPath: string): BrowseResult {
  const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const path = typeof record.path === 'string' ? record.path : fallbackPath;
  const parent = typeof record.parent === 'string' ? record.parent : path;
  const truncated = record.truncated === true;
  const entries = Array.isArray(record.entries)
    ? record.entries
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({
          name: typeof entry.name === 'string' ? entry.name : typeof entry.path === 'string' ? entry.path.split('/').pop() || entry.path : '',
          path: typeof entry.path === 'string' ? entry.path : '',
          isDirectory: true as const,
        }))
        .filter((entry) => entry.name && entry.path)
    : [];
  return { path, parent, truncated, entries };
}

export default function FolderPickerModal({ open, root, rpc, selectDisabled = false, onClose, onSelect }: FolderPickerModalProps) {
  const [typedPath, setTypedPath] = useState(root);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [validatedPath, setValidatedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const browsePath = useCallback(
    async (path: string) => {
      const generation = (generationRef.current += 1);
      setLoading(true);
      setError(null);
      setBrowse(null);
      setValidatedPath(null);
      try {
        const result = await rpc<unknown>('webui/fs/browseWorkspaceDirectory', { path });
        if (generation !== generationRef.current) return;
        const nextBrowse = normalizeBrowseResult(result, path);
        setBrowse(nextBrowse);
        setValidatedPath(nextBrowse.path);
        setTypedPath(nextBrowse.path);
      } catch (caught) {
        if (generation !== generationRef.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!open) return;
    setTypedPath(root);
    setBrowse(null);
    setValidatedPath(null);
    setError(null);
    void browsePath(root);
  }, [browsePath, open, root]);

  if (!open) return null;

  const submitTypedPath = (event: FormEvent) => {
    event.preventDefault();
    void browsePath(typedPath);
  };

  const currentPath = validatedPath ?? typedPath;
  const parentPath = browse?.parent ?? currentPath;
  const cannotSelect = selectDisabled || loading || Boolean(error) || !validatedPath;

  return (
    <div className="modal-overlay" role="presentation">
      <div className="detail-modal folder-picker-modal" role="dialog" aria-modal="true" aria-label="Choose Git repository folder">
        <div className="modal-header">
          <span>Choose folder</span>
          <button className="file-action" type="button" onClick={onClose} aria-label="Close folder picker" title="Close">
            x
          </button>
        </div>
        <form className="folder-picker-path" onSubmit={submitTypedPath}>
          <input value={typedPath} onChange={(event) => setTypedPath(event.target.value)} aria-label="Folder path" spellCheck={false} />
          <button className="file-action" type="submit" disabled={loading} aria-label="Browse typed folder" title="Go">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button className="file-action" type="button" onClick={() => void browsePath(parentPath)} disabled={loading || parentPath === currentPath} aria-label="Browse parent folder" title="Up">
            <ChevronUp size={14} aria-hidden="true" />
          </button>
        </form>
        <div className="modal-body folder-picker-body">
          {error && <div className="file-error">{error}</div>}
          {loading && <div className="file-empty">Loading...</div>}
          {browse?.truncated && <div className="file-empty">Directory list truncated</div>}
          <div className="folder-picker-list" aria-label="Folders">
            {browse?.entries.map((entry) => (
              <div className="folder-picker-row" key={entry.path}>
                <button className="folder-picker-row__open" type="button" onClick={() => void browsePath(entry.path)} title={entry.path}>
                  <Folder size={14} aria-hidden="true" />
                  <span>{entry.name}</span>
                </button>
                <button className="file-compact" type="button" onClick={() => onSelect(entry.path)} disabled={selectDisabled || loading} aria-label={`Select ${entry.name}`} title="Select folder">
                  +
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-actions folder-picker-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => validatedPath && onSelect(validatedPath)} disabled={cannotSelect} aria-label="Select folder">
            Select folder
          </button>
        </div>
      </div>
    </div>
  );
}
