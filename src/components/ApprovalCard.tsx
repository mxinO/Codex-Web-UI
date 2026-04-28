import { useState } from 'react';

interface ApprovalCardProps {
  requestId: number | string;
  method: string;
  params: unknown;
  onDecision: (decision: unknown) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readableJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null, null, 2);
  } catch {
    text = String(value);
  }

  return text.length > 6000 ? `${text.slice(0, 6000)}\n... truncated` : text;
}

function decisionsFor(method: string, params: unknown): string[] {
  if (isRecord(params) && Array.isArray(params.availableDecisions)) {
    const decisions = params.availableDecisions.filter((item): item is string => typeof item === 'string');
    if (decisions.length > 0) return decisions;
  }

  if (method === 'item/commandExecution/requestApproval') {
    return ['accept', 'decline'];
  }

  if (method === 'item/fileChange/requestApproval') return ['accept', 'decline'];
  if (method === 'mcpServer/elicitation/request') return ['decline', 'cancel'];
  if (method === 'item/permissions/requestApproval') return ['accept', 'decline'];
  if (method === 'item/tool/requestUserInput') return ['submit', 'cancel'];
  if (method === 'item/tool/call') return ['accept', 'decline'];
  return [];
}

export default function ApprovalCard({ requestId, method, params, onDecision }: ApprovalCardProps) {
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const decisions = decisionsFor(method, params);

  const submit = async (decision: string) => {
    if (pendingDecision) return;
    setPendingDecision(decision);
    try {
      await onDecision(decision);
    } catch {
      setPendingDecision(null);
    }
  };

  return (
    <section className="approval-card" aria-label="Approval request">
      <div className="approval-card__header">
        <span>Approval</span>
        <code>{method}</code>
      </div>
      <div className="approval-card__meta">Request {String(requestId)}</div>
      <pre className="approval-card__params">{readableJson(params)}</pre>
      {decisions.length > 0 ? (
        <div className="approval-card__actions">
          {decisions.map((decision) => (
            <button
              className="text-button approval-card__button"
              type="button"
              key={decision}
              disabled={pendingDecision !== null}
              onClick={() => void submit(decision)}
            >
              {pendingDecision === decision ? 'Sending...' : decision}
            </button>
          ))}
        </div>
      ) : (
        <div className="approval-card__empty">No supported response is available.</div>
      )}
    </section>
  );
}
