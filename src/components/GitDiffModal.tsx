import { useEffect, useState } from 'react';
import type { GitDiffResult } from '../../server/types';
import type DiffViewerType from './DiffViewer';

type DiffViewerComponent = typeof DiffViewerType;

interface GitDiffModalProps {
  diff: GitDiffResult;
  onClose: () => void;
}

export default function GitDiffModal({ diff, onClose }: GitDiffModalProps) {
  const [DiffViewer, setDiffViewer] = useState<DiffViewerComponent | null>(null);
  const showCompactState = diff.binary === true || diff.truncated === true;

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
          {!showCompactState && (DiffViewer ? <DiffViewer patch={diff.patch} /> : <div className="detail-loading">Loading diff...</div>)}
        </div>
      </div>
    </div>
  );
}
