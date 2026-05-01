import { ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Clipboard, Download, Eye, File, FilePlus, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Upload } from 'lucide-react';

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

interface DirectoryState {
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
}

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const WIDTH_STORAGE_KEY = 'codex-web-ui:file-explorer-width';
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 48;

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function initialExplorerWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function joinPath(parent: string, child: string): string {
  return `${trimTrailingSlash(parent)}/${child}`.replace(/\/+/g, '/');
}

function basename(filePath: string): string {
  return trimTrailingSlash(filePath).split('/').pop() || filePath;
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

function sortedEntries(result: unknown, currentDir: string): FileEntry[] {
  return extractEntries(result)
    .map((entry) => normalizeEntry(entry, currentDir))
    .filter((entry): entry is FileEntry => Boolean(entry))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

export default function FileExplorer({ root, rpc, onOpenFile }: FileExplorerProps) {
  const [width, setWidth] = useState(initialExplorerWidth);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set([trimTrailingSlash(root)]));
  const normalizedRoot = useMemo(() => trimTrailingSlash(root), [root]);
  const rootGenerationRef = useRef(0);
  const nextLoadIdRef = useRef(0);
  const loadIdsRef = useRef(new Map<string, number>());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef(normalizedRoot);

  const persistWidth = (nextWidth: number) => {
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(nextWidth));
    } catch {
      // Width persistence is client-only convenience.
    }
  };

  const loadDirectory = useCallback(
    async (dir: string) => {
      const generation = rootGenerationRef.current;
      const loadId = (nextLoadIdRef.current += 1);
      loadIdsRef.current.set(dir, loadId);
      setDirectories((current) => ({
        ...current,
        [dir]: { entries: current[dir]?.entries ?? [], loading: true, error: null, loaded: current[dir]?.loaded ?? false },
      }));

      try {
        const result = await rpc<unknown>('webui/fs/readDirectory', { path: dir });
        if (generation !== rootGenerationRef.current || loadIdsRef.current.get(dir) !== loadId) return;
        setDirectories((current) => ({
          ...current,
          [dir]: { entries: sortedEntries(result, dir), loading: false, error: null, loaded: true },
        }));
      } catch (caught) {
        if (generation !== rootGenerationRef.current || loadIdsRef.current.get(dir) !== loadId) return;
        setDirectories((current) => ({
          ...current,
          [dir]: {
            entries: current[dir]?.entries ?? [],
            loading: false,
            error: caught instanceof Error ? caught.message : String(caught),
            loaded: true,
          },
        }));
      }
    },
    [rpc],
  );

  useEffect(() => {
    rootGenerationRef.current += 1;
    loadIdsRef.current.clear();
    uploadTargetRef.current = normalizedRoot;
    setDirectories({});
    setExpandedDirectories(new Set([normalizedRoot]));
    void loadDirectory(normalizedRoot);
  }, [loadDirectory, normalizedRoot]);

  const toggleDirectory = async (dir: string) => {
    const wasExpanded = expandedDirectories.has(dir);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (wasExpanded) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!wasExpanded && !directories[dir]?.loaded) await loadDirectory(dir);
  };

  const refreshTree = async () => {
    const generation = rootGenerationRef.current;
    const dirs = new Set<string>([normalizedRoot]);
    for (const dir of expandedDirectories) dirs.add(dir);
    for (const dir of Object.keys(directories)) {
      if (directories[dir]?.loaded) dirs.add(dir);
    }

    const orderedDirs = Array.from(dirs).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const dir of orderedDirs) {
      if (generation !== rootGenerationRef.current) return;
      await loadDirectory(dir);
    }
  };

  const createEntry = async (kind: 'file' | 'directory', parentDir: string) => {
    const label = kind === 'file' ? 'file name' : 'directory name';
    const name = window.prompt(`New ${label}`);
    if (!name?.trim()) return;

    const generation = rootGenerationRef.current;
    try {
      const path = joinPath(parentDir, name.trim());
      await rpc(kind === 'file' ? 'webui/fs/createFile' : 'webui/fs/createDirectory', { path });
      if (generation === rootGenerationRef.current) await loadDirectory(parentDir);
    } catch (caught) {
      setDirectories((current) => ({
        ...current,
        [parentDir]: {
          entries: current[parentDir]?.entries ?? [],
          loading: false,
          loaded: current[parentDir]?.loaded ?? true,
          error: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    }
  };

  const uploadFile = async (targetDir: string, file: File | null) => {
    if (!file) return;
    const generation = rootGenerationRef.current;
    try {
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
      if (generation === rootGenerationRef.current) await loadDirectory(targetDir);
    } catch (caught) {
      setDirectories((current) => ({
        ...current,
        [targetDir]: {
          entries: current[targetDir]?.entries ?? [],
          loading: false,
          loaded: current[targetDir]?.loaded ?? true,
          error: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    }
  };

  const triggerUpload = (targetDir: string) => {
    uploadTargetRef.current = targetDir;
    uploadInputRef.current?.click();
  };

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    void uploadFile(uploadTargetRef.current, file);
  };

  const beginResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = startWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      nextWidth = clampWidth(startWidth + moveEvent.clientX - startX);
      setWidth(nextWidth);
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      persistWidth(nextWidth);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;

    if (event.key === 'ArrowLeft') nextWidth = clampWidth(width - step);
    else if (event.key === 'ArrowRight') nextWidth = clampWidth(width + step);
    else if (event.key === 'Home') nextWidth = MIN_WIDTH;
    else if (event.key === 'End') nextWidth = MAX_WIDTH;

    if (nextWidth === null) return;
    event.preventDefault();
    setWidth(nextWidth);
    persistWidth(nextWidth);
  };

  const renderEntry = (entry: FileEntry, depth: number): JSX.Element => {
    const isExpanded = expandedDirectories.has(entry.path);
    const directoryState = directories[entry.path];
    const indent = 6 + depth * 16;

    return (
      <div className="file-tree-node" key={`${entry.path}-${entry.isDirectory ? 'dir' : 'file'}`}>
        <div className="file-row" role="treeitem" aria-expanded={entry.isDirectory ? isExpanded : undefined} style={{ paddingLeft: indent }}>
          {entry.isDirectory ? (
            <button
              className="file-disclosure"
              type="button"
              onClick={() => void toggleDirectory(entry.path)}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.name}`}
              title={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.path}`}
            >
              {isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            </button>
          ) : (
            <span className="file-disclosure-placeholder" aria-hidden="true" />
          )}
          <button
            className={`file-name ${entry.isDirectory ? 'file-name--directory' : ''}`}
            type="button"
            title={entry.path}
            onClick={() => (entry.isDirectory ? void toggleDirectory(entry.path) : onOpenFile(entry.path, true))}
          >
            <span className="file-kind" aria-hidden="true">
              {entry.isDirectory ? isExpanded ? <FolderOpen size={14} /> : <Folder size={14} /> : <File size={14} />}
            </span>
            <span className="file-label">{entry.name}</span>
          </button>
          <div className="file-row-actions">
            {entry.isDirectory ? (
              <>
                <button className="file-compact" type="button" onClick={() => void createEntry('file', entry.path)} title="New file" aria-label={`New file in ${entry.name}`}>
                  <FilePlus size={13} aria-hidden="true" />
                </button>
                <button className="file-compact" type="button" onClick={() => void createEntry('directory', entry.path)} title="New folder" aria-label={`New folder in ${entry.name}`}>
                  <FolderPlus size={13} aria-hidden="true" />
                </button>
                <button className="file-compact" type="button" onClick={() => triggerUpload(entry.path)} title="Upload into folder" aria-label={`Upload into ${entry.name}`}>
                  <Upload size={13} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button className="file-compact" type="button" onClick={() => onOpenFile(entry.path, false)} title="Edit file" aria-label={`Edit ${entry.name}`}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button className="file-compact" type="button" onClick={() => onOpenFile(entry.path, true)} title="View file" aria-label={`View ${entry.name}`}>
                  <Eye size={13} aria-hidden="true" />
                </button>
                <a className="file-compact" href={`/api/download?path=${encodeURIComponent(entry.path)}`} title="Download file" aria-label={`Download ${entry.name}`}>
                  <Download size={13} aria-hidden="true" />
                </a>
              </>
            )}
            <button className="file-compact" type="button" onClick={() => dispatchInsertPath(entry.path)} title="Insert path" aria-label={`Insert ${entry.name} path`}>
              <Clipboard size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
        {entry.isDirectory && isExpanded && (
          <div role="group">
            {directoryState?.error && <div className="file-error file-child-state">{directoryState.error}</div>}
            {directoryState?.loading && <div className="file-empty file-child-state">Loading...</div>}
            {directoryState?.loaded && !directoryState.loading && !directoryState.error && directoryState.entries.length === 0 && (
              <div className="file-empty file-child-state">No files</div>
            )}
            {directoryState?.entries.map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootState = directories[normalizedRoot];
  const explorerStyle = { '--file-explorer-width': `${width}px` } as CSSProperties;

  return (
    <aside className="file-explorer" aria-label="File explorer" style={explorerStyle}>
      <div className="file-explorer-header">
        <div className="file-root" title={root}>
          <span>Explorer</span>
          <small>{basename(root)}</small>
        </div>
        <button className="file-action" type="button" onClick={() => void createEntry('file', normalizedRoot)} title="New file" aria-label="New file in root">
          <FilePlus size={14} aria-hidden="true" />
        </button>
        <button className="file-action" type="button" onClick={() => void createEntry('directory', normalizedRoot)} title="New folder" aria-label="New folder in root">
          <FolderPlus size={14} aria-hidden="true" />
        </button>
        <button className="file-action" type="button" onClick={() => triggerUpload(normalizedRoot)} title="Upload to root" aria-label="Upload to root">
          <Upload size={14} aria-hidden="true" />
        </button>
        <button className="file-action" type="button" onClick={() => void refreshTree()} disabled={rootState?.loading} title="Refresh" aria-label="Refresh file explorer">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <input ref={uploadInputRef} className="file-hidden-upload" type="file" onChange={handleUpload} />
      {rootState?.error && <div className="file-error">{rootState.error}</div>}
      <div className="file-list" role="tree" aria-busy={rootState?.loading ? 'true' : 'false'}>
        {rootState?.loading && !rootState.loaded && <div className="file-empty">Loading...</div>}
        {rootState?.loaded && !rootState.loading && !rootState.error && rootState.entries.length === 0 && <div className="file-empty">No files</div>}
        {rootState?.entries.map((entry) => renderEntry(entry, 0))}
      </div>
      <div
        className="file-resize-handle"
        role="separator"
        aria-label="Resize file explorer"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={handleResizeKeyDown}
        onMouseDown={beginResize}
      />
    </aside>
  );
}
