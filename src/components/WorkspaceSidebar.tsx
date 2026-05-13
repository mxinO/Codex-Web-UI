import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, useState } from 'react';
import { Files, GitBranch } from 'lucide-react';
import FileExplorerPanel from './FileExplorerPanel';
import GitTrackerPanel from './GitTrackerPanel';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
type WorkspacePanel = 'files' | 'git';

interface WorkspaceSidebarProps {
  root: string;
  rpc: Rpc;
  onOpenFile: (path: string, readOnly: boolean) => void;
  initialPanel?: WorkspacePanel;
}

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const WIDTH_STORAGE_KEY = 'codex-web-ui:file-explorer-width';
const PANEL_STORAGE_KEY = 'codex-web-ui:workspace-sidebar-panel';
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 48;

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

function storedPanel(): WorkspacePanel {
  try {
    return window.localStorage.getItem(PANEL_STORAGE_KEY) === 'git' ? 'git' : 'files';
  } catch {
    return 'files';
  }
}

function persistWidth(nextWidth: number) {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(nextWidth));
  } catch {
    // Width persistence is client-only convenience.
  }
}

function persistPanel(panel: WorkspacePanel) {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, panel);
  } catch {
    // Panel persistence is client-only convenience.
  }
}

export default function WorkspaceSidebar({ root, rpc, onOpenFile, initialPanel }: WorkspaceSidebarProps) {
  const [width, setWidth] = useState(initialExplorerWidth);
  const [panel, setPanel] = useState<WorkspacePanel>(() => initialPanel ?? storedPanel());

  const selectPanel = (nextPanel: WorkspacePanel) => {
    setPanel(nextPanel);
    persistPanel(nextPanel);
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

  const explorerStyle = { '--file-explorer-width': `${width}px` } as CSSProperties;

  return (
    <aside className="file-explorer" aria-label="Workspace sidebar" style={explorerStyle}>
      <div className="workspace-sidebar-tabs" aria-label="Workspace panels">
        <button
          className={`workspace-sidebar-tab ${panel === 'files' ? 'workspace-sidebar-tab--active' : ''}`}
          type="button"
          aria-pressed={panel === 'files'}
          aria-label="Show Files panel"
          onClick={() => selectPanel('files')}
        >
          <Files size={14} aria-hidden="true" />
          <span>Files</span>
        </button>
        <button
          className={`workspace-sidebar-tab ${panel === 'git' ? 'workspace-sidebar-tab--active' : ''}`}
          type="button"
          aria-pressed={panel === 'git'}
          aria-label="Show Git panel"
          onClick={() => selectPanel('git')}
        >
          <GitBranch size={14} aria-hidden="true" />
          <span>Git</span>
        </button>
      </div>
      {panel === 'files' ? <FileExplorerPanel root={root} rpc={rpc} onOpenFile={onOpenFile} /> : <GitTrackerPanel root={root} rpc={rpc} />}
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
