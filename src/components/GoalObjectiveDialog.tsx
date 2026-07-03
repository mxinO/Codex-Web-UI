import { useEffect, useRef, useState, type RefObject } from 'react';

type SharedProps = {
  currentObjective: string;
  busy: boolean;
  error?: string | null;
  submitDisabled?: boolean;
  onCancel: () => void;
};

type EditProps = SharedProps & {
  mode: 'edit';
  onSave: (objective: string) => void;
};

type ReplaceProps = SharedProps & {
  mode: 'replace';
  proposedObjective: string;
  onReplace: () => void;
};

type GoalObjectiveDialogProps = EditProps | ReplaceProps;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  );
}

export default function GoalObjectiveDialog(props: GoalObjectiveDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLTextAreaElement | HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [objective, setObjective] = useState(props.currentObjective);

  useEffect(() => {
    if (props.mode === 'edit') setObjective(props.currentObjective);
  }, [props.currentObjective, props.mode]);

  useEffect(() => {
    initialFocusRef.current?.focus();
    const previousFocus = previousFocusRef.current;
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.busy) dialog.focus();
    else if (document.activeElement === dialog) initialFocusRef.current?.focus();
  }, [props.busy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) {
        event.preventDefault();
        props.onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [props.busy, props.onCancel]);

  const title = props.mode === 'edit' ? 'Edit goal' : 'Replace goal?';
  const trimmedObjective = objective.trim();

  return (
    <div className="modal-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="detail-modal goal-objective-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={props.busy}
        aria-labelledby="goal-objective-dialog-title"
        aria-describedby={props.error ? 'goal-objective-dialog-error' : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span id="goal-objective-dialog-title">{title}</span>
        </div>
        <div className="modal-body goal-objective-dialog__body">
          {props.mode === 'edit' ? (
            <label className="goal-objective-dialog__field">
              <span>Objective</span>
              <textarea
                ref={initialFocusRef as RefObject<HTMLTextAreaElement>}
                value={objective}
                disabled={props.busy}
                onChange={(event) => setObjective(event.target.value)}
                rows={6}
              />
            </label>
          ) : (
            <div className="goal-objective-dialog__comparison">
              <div>
                <span>Current goal</span>
                <p>{props.currentObjective}</p>
              </div>
              <div>
                <span>New goal</span>
                <p>{props.proposedObjective}</p>
              </div>
            </div>
          )}
          {props.error && (
            <div id="goal-objective-dialog-error" className="goal-objective-dialog__error" role="alert">
              {props.error}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            ref={props.mode === 'replace' ? (initialFocusRef as RefObject<HTMLButtonElement>) : undefined}
            className="text-button"
            type="button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          {props.mode === 'edit' ? (
            <button className="text-button primary" type="button" disabled={props.busy || props.submitDisabled || !trimmedObjective} onClick={() => props.onSave(trimmedObjective)}>
              {props.busy ? 'Saving...' : 'Save'}
            </button>
          ) : (
            <button className="text-button primary" type="button" disabled={props.busy || props.submitDisabled} onClick={props.onReplace}>
              {props.busy ? 'Replacing...' : 'Replace'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
