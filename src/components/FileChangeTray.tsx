import { useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';

export interface ActiveFileSummary {
  turnId: string;
  files: Array<{ path: string; editCount: number; hasDiff: boolean; updatedAtMs: number }>;
}

interface FileChangeTrayProps {
  summary: ActiveFileSummary;
  onOpenDiff: (turnId: string, path: string, changeCount: number) => void;
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export default function FileChangeTray({ summary, onOpenDiff }: FileChangeTrayProps) {
  const [expanded, setExpanded] = useState(true);
  const totalEdits = summary.files.reduce((sum, file) => sum + file.editCount, 0);

  if (summary.files.length === 0) return null;

  return (
    <aside className="file-change-tray" aria-label="Files changed in this turn">
      <button className="file-change-tray__header" type="button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        <span>Files changed</span>
        <small>{summary.files.length} files - {totalEdits} edits</small>
      </button>
      {expanded && (
        <div className="file-change-tray__list">
          {summary.files.map((file) => (
            <div className="file-change-tray__row" key={file.path} title={file.path}>
              <span>{basename(file.path)}</span>
              <small>{file.editCount > 1 ? `${file.editCount} edits` : '1 edit'}</small>
              <button
                className="file-change-tray__diff"
                type="button"
                title="See diff"
                aria-label={`See diff for ${file.path}`}
                onClick={() => onOpenDiff(summary.turnId, file.path, file.editCount)}
              >
                <FileDiff size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
