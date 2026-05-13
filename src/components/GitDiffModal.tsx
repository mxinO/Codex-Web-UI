import { useEffect, useState } from 'react';
import type { GitDiffResult } from '../../server/types';
import type DiffViewerType from './DiffViewer';

type DiffViewerComponent = typeof DiffViewerType;

interface GitDiffModalProps {
  diff: GitDiffResult;
  onClose: () => void;
}

function languageFromPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx') return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'css') return 'css';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'py') return 'python';
  if (extension === 'sh' || extension === 'bash') return 'shell';
  return 'plaintext';
}

function hunkOnlyPatch(patch: string): string {
  const rows: string[] = [];
  let inHunk = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      rows.push(line);
      continue;
    }

    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }

    if (inHunk) rows.push(line);
  }

  while (rows.at(-1) === '') rows.pop();
  return rows.length > 0 ? rows.join('\n') : 'No textual changes to display.';
}

export default function GitDiffModal({ diff, onClose }: GitDiffModalProps) {
  const [DiffViewer, setDiffViewer] = useState<DiffViewerComponent | null>(null);
  const showCompactState = diff.binary === true || diff.truncated === true;
  const showTwoWayDiff = !showCompactState && typeof diff.before === 'string' && typeof diff.after === 'string';
  const language = languageFromPath(diff.path);

  useEffect(() => {
    if (showCompactState) return;
    let canceled = false;
    void import('./DiffViewer').then((module) => {
      if (!canceled) setDiffViewer(() => module.default);
    });
    return () => {
      canceled = true;
    };
  }, [showCompactState]);

  return (
    <div className="modal-overlay" role="presentation">
      <div className="detail-modal git-diff-modal" role="dialog" aria-modal="true" aria-label={`Git diff ${diff.path}`}>
        <div className="modal-header">
          <span className="git-diff-modal__title" title={diff.path}>
            {diff.path}
          </span>
          <button className="file-action" type="button" onClick={onClose} aria-label="Close git diff" title="Close">
            x
          </button>
        </div>
        <div className="modal-body git-diff-modal__body">
          {(showCompactState || diff.truncated) && (
            <div className="git-diff-modal__state">
              {diff.binary && <span>Binary diff is not available.</span>}
              {diff.truncated && <span>Diff output was truncated.</span>}
            </div>
          )}
          {!showCompactState &&
            (DiffViewer ? (
              showTwoWayDiff ? (
                <DiffViewer before={diff.before} after={diff.after} language={language} />
              ) : (
                <DiffViewer patch={hunkOnlyPatch(diff.patch)} language={language} />
              )
            ) : (
              <div className="detail-loading">Loading diff...</div>
            ))}
        </div>
      </div>
    </div>
  );
}
