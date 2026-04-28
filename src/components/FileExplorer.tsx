import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

interface FileExplorerProps {
  root: string;
  rpc: Rpc;
  onOpenFile: (path: string, readOnly: boolean) => void;
}

interface RawEntry {
  fileName?: unknown;
  name?: unknown;
  path?: unknown;
  isDirectory?: unknown;
  isFile?: unknown;
  type?: unknown;
  kind?: unknown;
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}

function joinPath(parent: string, child: string): string {
  return `${trimTrailingSlash(parent)}/${child}`.replace(/\/+/g, '/');
}

function basename(filePath: string): string {
  return trimTrailingSlash(filePath).split('/').pop() || filePath;
}

function parentPath(root: string, currentDir: string): string {
  const normalizedRoot = trimTrailingSlash(root);
  const normalizedCurrent = trimTrailingSlash(currentDir);
  if (normalizedCurrent === normalizedRoot) return normalizedRoot;
  const parent = normalizedCurrent.slice(0, normalizedCurrent.lastIndexOf('/')) || '/';
  return parent.startsWith(normalizedRoot) ? parent : normalizedRoot;
}

function extractEntries(result: unknown): RawEntry[] {
  if (Array.isArray(result)) return result as RawEntry[];
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.entries)) return record.entries as RawEntry[];
  if (Array.isArray(record.data)) return record.data as RawEntry[];
  const data = record.data;
  if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).entries)) {
    return (data as Record<string, unknown>).entries as RawEntry[];
  }
  return [];
}

function normalizeEntry(entry: RawEntry, currentDir: string): FileEntry | null {
  const explicitPath = typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : null;
  const explicitName =
    typeof entry.fileName === 'string' && entry.fileName.trim()
      ? entry.fileName.trim()
      : typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : null;
  const name = explicitName ?? (explicitPath ? basename(explicitPath) : null);
  if (!name) return null;

  const entryPath = explicitPath ?? joinPath(currentDir, name);
  const type = typeof entry.type === 'string' ? entry.type : typeof entry.kind === 'string' ? entry.kind : '';
  const isDirectory = entry.isDirectory === true || type === 'directory' || type === 'dir' || type === 'folder';
  const isFile = entry.isFile === true || type === 'file' || !isDirectory;
  return { name, path: entryPath, isDirectory, isFile };
}

function dispatchInsertPath(path: string): void {
  window.dispatchEvent(new CustomEvent('insert-input-text', { detail: { text: path } }));
}

export default function FileExplorer({ root, rpc, onOpenFile }: FileExplorerProps) {
  const [currentDir, setCurrentDir] = useState(root);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const currentDirRef = useRef(root);
  const normalizedRoot = useMemo(() => trimTrailingSlash(root), [root]);

  const setDisplayedDirectory = (dir: string) => {
    currentDirRef.current = dir;
    loadSeqRef.current += 1;
    setCurrentDir(dir);
  };

  const loadDirectory = async (dir: string) => {
    const loadSeq = (loadSeqRef.current += 1);
    const isLatestLoad = () => loadSeq === loadSeqRef.current && currentDirRef.current === dir;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc<unknown>('webui/fs/readDirectory', { path: dir });
      if (!isLatestLoad()) return;
      const normalized = extractEntries(result)
        .map((entry) => normalizeEntry(entry, dir))
        .filter((entry): entry is FileEntry => Boolean(entry))
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      setEntries(normalized);
    } catch (caught) {
      if (!isLatestLoad()) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setEntries([]);
    } finally {
      if (isLatestLoad()) setLoading(false);
    }
  };

  useEffect(() => {
    setDisplayedDirectory(root);
  }, [root]);

  useEffect(() => {
    currentDirRef.current = currentDir;
  }, [currentDir]);

  useEffect(() => {
    void loadDirectory(currentDir);
  }, [currentDir]);

  const createEntry = async (kind: 'file' | 'directory') => {
    const label = kind === 'file' ? 'file name' : 'directory name';
    const name = window.prompt(`New ${label}`);
    if (!name?.trim()) return;

    setError(null);
    try {
      const startedInDir = currentDir;
      const path = joinPath(currentDir, name.trim());
      await rpc(kind === 'file' ? 'webui/fs/createFile' : 'webui/fs/createDirectory', { path });
      if (currentDirRef.current === startedInDir) await loadDirectory(startedInDir);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const uploadFile = async (targetDir: string, file: File | null) => {
    if (!file) return;
    setError(null);
    try {
      const startedInDir = currentDir;
      const path = joinPath(targetDir, file.name);
      const response = await fetch(`/api/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `upload failed with HTTP ${response.status}`);
      }
      if (currentDirRef.current === startedInDir) await loadDirectory(startedInDir);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleUpload = (targetDir: string) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    void uploadFile(targetDir, file);
  };

  const canGoUp = trimTrailingSlash(currentDir) !== normalizedRoot;

  return (
    <aside className="file-explorer" aria-label="File explorer">
      <div className="file-explorer-header">
        <div className="file-root" title={root}>
          {basename(root)}
        </div>
        <button className="file-action" type="button" onClick={() => void loadDirectory(currentDir)} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="file-toolbar">
        <button className="file-action" type="button" onClick={() => setDisplayedDirectory(parentPath(root, currentDir))} disabled={!canGoUp || loading}>
          Up
        </button>
        <button className="file-action" type="button" onClick={() => void createEntry('file')}>
          New File
        </button>
        <button className="file-action" type="button" onClick={() => void createEntry('directory')}>
          New Dir
        </button>
        <label className="file-action file-upload">
          Upload Root
          <input type="file" onChange={handleUpload(root)} />
        </label>
        {canGoUp && (
          <label className="file-action file-upload">
            Upload Here
            <input type="file" onChange={handleUpload(currentDir)} />
          </label>
        )}
      </div>
      <div className="file-current" title={currentDir}>
        {currentDir}
      </div>
      {error && <div className="file-error">{error}</div>}
      <div className="file-list" aria-busy={loading}>
        {loading && <div className="file-empty">Loading...</div>}
        {!loading && entries.length === 0 && <div className="file-empty">No files</div>}
        {!loading &&
          entries.map((entry) => (
            <div className="file-row" key={`${entry.path}-${entry.isDirectory ? 'dir' : 'file'}`}>
              <button
                className={`file-name ${entry.isDirectory ? 'file-name--directory' : ''}`}
                type="button"
                title={entry.path}
                onClick={() => (entry.isDirectory ? setDisplayedDirectory(entry.path) : onOpenFile(entry.path, true))}
              >
                <span className="file-kind">{entry.isDirectory ? 'dir' : 'file'}</span>
                <span className="file-label">{entry.name}</span>
              </button>
              <div className="file-row-actions">
                {entry.isDirectory ? (
                  <label className="file-compact file-upload" title="Upload into directory">
                    Up
                    <input type="file" onChange={handleUpload(entry.path)} />
                  </label>
                ) : (
                  <>
                    <button className="file-compact" type="button" onClick={() => onOpenFile(entry.path, false)} title="Edit file">
                      Edit
                    </button>
                    <a className="file-compact" href={`/api/download?path=${encodeURIComponent(entry.path)}`} title="Download file">
                      Dl
                    </a>
                  </>
                )}
                <button className="file-compact" type="button" onClick={() => dispatchInsertPath(entry.path)} title="Insert path">
                  Ins
                </button>
              </div>
            </div>
          ))}
      </div>
    </aside>
  );
}
