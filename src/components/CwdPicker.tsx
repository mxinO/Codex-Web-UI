import { ArrowUp, Folder, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

interface Props {
  initialCwd: string;
  rpc?: Rpc;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (cwd: string) => void;
}

interface RawDirectoryEntry {
  name?: unknown;
  path?: unknown;
  isDirectory?: unknown;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface LoadDirectoryOptions {
  filterPrefix?: string;
  syncInput?: boolean;
}

interface TypedBrowseRequest {
  path: string;
  filterPrefix: string;
}

interface BrowseResult {
  path?: unknown;
  parent?: unknown;
  entries?: unknown;
  data?: unknown;
  truncated?: unknown;
}

const TYPED_BROWSE_DEBOUNCE_MS = 250;

function parentPath(filePath: string): string {
  const trimmed = filePath.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '/';
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

function stripTrailingSlashes(filePath: string): string {
  const stripped = filePath.trim().replace(/\/+$/, '');
  return stripped || '/';
}

function typedBrowseRequest(filePath: string): TypedBrowseRequest | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('/')) return { path: stripTrailingSlashes(trimmed), filterPrefix: '' };

  const slashIndex = trimmed.lastIndexOf('/');
  if (slashIndex < 0) return { path: '.', filterPrefix: trimmed };
  if (slashIndex === 0) return { path: '/', filterPrefix: trimmed.slice(1) };
  return { path: trimmed.slice(0, slashIndex), filterPrefix: trimmed.slice(slashIndex + 1) };
}

function rawEntries(result: BrowseResult): RawDirectoryEntry[] {
  if (Array.isArray(result.entries)) return result.entries as RawDirectoryEntry[];
  if (typeof result.data === 'object' && result.data !== null && Array.isArray((result.data as BrowseResult).entries)) {
    return (result.data as BrowseResult).entries as RawDirectoryEntry[];
  }
  return [];
}

function normalizeEntries(result: BrowseResult): DirectoryEntry[] {
  return rawEntries(result)
    .map((entry) => {
      const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null;
      const path = typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : null;
      if (!name || !path || entry.isDirectory === false) return null;
      return { name, path };
    })
    .filter((entry): entry is DirectoryEntry => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterEntries(entries: DirectoryEntry[], filterPrefix: string): DirectoryEntry[] {
  const normalizedPrefix = filterPrefix.trim().toLowerCase();
  if (!normalizedPrefix) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(normalizedPrefix));
}

export default function CwdPicker({ initialCwd, rpc, busy = false, onCancel, onConfirm }: Props) {
  const [cwd, setCwd] = useState(initialCwd);
  const [typedCwd, setTypedCwd] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState(initialCwd.trim() || '/');
  const [parent, setParent] = useState(parentPath(initialCwd.trim() || '/'));
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseTruncated, setBrowseTruncated] = useState(false);
  const titleId = useId();
  const browseSeqRef = useRef(0);
  const skipBrowsePathEffectForRef = useRef<string | null>(null);
  const trimmedCwd = cwd.trim();

  const loadDirectory = useCallback(
    async (path: string, options: LoadDirectoryOptions = {}) => {
      if (!rpc || !path.trim()) return;
      const { filterPrefix = '', syncInput = true } = options;
      const sequence = (browseSeqRef.current += 1);
      setBrowseLoading(true);
      setBrowseError(null);
      try {
        const result = await rpc<BrowseResult>('webui/fs/browseDirectory', { path });
        if (sequence !== browseSeqRef.current) return;
        const resolvedPath = typeof result.path === 'string' && result.path.length > 0 ? result.path : path;
        const resolvedParent = typeof result.parent === 'string' && result.parent.length > 0 ? result.parent : parentPath(resolvedPath);
        if (!syncInput) skipBrowsePathEffectForRef.current = resolvedPath;
        setBrowsePath(resolvedPath);
        if (syncInput) setCwd(resolvedPath);
        setParent(resolvedParent);
        setEntries(filterEntries(normalizeEntries(result), filterPrefix));
        setBrowseTruncated(result.truncated === true);
      } catch (caught) {
        if (sequence !== browseSeqRef.current) return;
        setBrowseError(caught instanceof Error ? caught.message : String(caught));
        setEntries([]);
        setBrowseTruncated(false);
      } finally {
        if (sequence === browseSeqRef.current) setBrowseLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!rpc) return;
    if (skipBrowsePathEffectForRef.current !== null) {
      const skippedPath = skipBrowsePathEffectForRef.current;
      skipBrowsePathEffectForRef.current = null;
      if (skippedPath === browsePath) return;
    }
    void loadDirectory(browsePath);
  }, [browsePath, loadDirectory, rpc]);

  useEffect(() => {
    if (!rpc || typedCwd === null) return;
    const request = typedBrowseRequest(typedCwd);
    if (!request) return;

    const timer = window.setTimeout(() => {
      void loadDirectory(request.path, { filterPrefix: request.filterPrefix, syncInput: false });
    }, TYPED_BROWSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [loadDirectory, rpc, typedCwd]);

  const chooseFolder = (path: string) => {
    setTypedCwd(null);
    setCwd(path);
    setBrowsePath(path);
  };

  const browseTypedPath = () => {
    if (trimmedCwd) {
      setTypedCwd(null);
      setBrowsePath(trimmedCwd);
    }
  };

  const handleInputChange = (value: string) => {
    setCwd(value);
    setTypedCwd(value);
  };

  return (
    <div className="modal-overlay">
      <form
        className="auth-box cwd-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedCwd && !busy) onConfirm(trimmedCwd);
        }}
      >
        <h2 id={titleId}>New Session</h2>
        <label className="field-label">
          Working directory
          <input className="text-input" value={cwd} onChange={(event) => handleInputChange(event.target.value)} autoFocus />
        </label>
        {rpc && (
          <div className="cwd-browser" aria-label="Folder picker">
            <div className="cwd-browser-toolbar">
              <button className="icon-button icon-button--square" type="button" onClick={() => chooseFolder(parent)} title="Parent folder" aria-label="Parent folder">
                <ArrowUp size={15} aria-hidden="true" />
              </button>
              <button className="text-button" type="button" onClick={browseTypedPath} disabled={!trimmedCwd || browseLoading}>
                Browse
              </button>
              <button
                className="icon-button icon-button--square"
                type="button"
                onClick={() => void loadDirectory(trimmedCwd || browsePath)}
                disabled={browseLoading}
                title="Refresh folders"
                aria-label="Refresh folders"
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
              <span className="cwd-browser-path" title={browsePath}>
                {browsePath}
              </span>
            </div>
            {browseError && <div className="file-error">{browseError}</div>}
            <div className="cwd-browser-list" aria-busy={browseLoading}>
              {browseLoading && <div className="file-empty">Loading folders...</div>}
              {!browseLoading && entries.length === 0 && !browseError && <div className="file-empty">No folders</div>}
              {!browseLoading && browseTruncated && <div className="file-empty">Showing first 500 folders</div>}
              {!browseLoading &&
                entries.map((entry) => (
                  <button key={entry.path} className="cwd-folder-row" type="button" onClick={() => chooseFolder(entry.path)} title={entry.path} aria-label={`Open folder ${entry.name}`}>
                    <Folder size={14} aria-hidden="true" />
                    <span>{entry.name}</span>
                  </button>
                ))}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="text-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="text-button primary" type="submit" disabled={!trimmedCwd || busy}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
