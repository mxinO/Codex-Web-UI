import { sanitizeStoredEffort } from './runOptions';
import type { CodexModelOption, CodexReasoningEffortOption } from '../types/ui';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function effortOptions(value: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: CodexReasoningEffortOption[] = [];

  for (const candidate of value) {
    const record = recordValue(candidate);
    const reasoningEffort = sanitizeStoredEffort(nonEmptyString(record?.reasoningEffort));
    if (!reasoningEffort || seen.has(reasoningEffort)) continue;
    seen.add(reasoningEffort);
    options.push({
      reasoningEffort,
      description: typeof record?.description === 'string' ? record.description : '',
    });
  }

  return options;
}

export function modelOptionsFromResult(result: unknown): CodexModelOption[] {
  const data = recordValue(result)?.data;
  if (!Array.isArray(data)) return [];

  const models: CodexModelOption[] = [];
  for (const candidate of data) {
    const record = recordValue(candidate);
    if (!record || record.hidden === true) continue;

    const id = nonEmptyString(record.id);
    const model = nonEmptyString(record.model);
    if (!id || !model) continue;

    const supportedReasoningEfforts = effortOptions(record.supportedReasoningEfforts);
    const supported = new Set(supportedReasoningEfforts.map((option) => option.reasoningEffort));
    const declaredDefault = sanitizeStoredEffort(nonEmptyString(record.defaultReasoningEffort));

    models.push({
      id,
      model,
      displayName: nonEmptyString(record.displayName) ?? model,
      description: typeof record.description === 'string' ? record.description : '',
      supportedReasoningEfforts,
      defaultReasoningEffort: declaredDefault && supported.has(declaredDefault) ? declaredDefault : null,
      isDefault: record.isDefault === true,
    });
  }

  return models;
}

function selectedModel(models: CodexModelOption[], model: string | null): CodexModelOption | null {
  if (!model) return null;
  return models.find((candidate) => candidate.model === model || candidate.id === model) ?? null;
}

export function effortOptionsForModel(
  models: CodexModelOption[],
  model: string | null,
): CodexReasoningEffortOption[] {
  return selectedModel(models, model)?.supportedReasoningEfforts ?? [];
}

export function reconcileEffortForModel(
  models: CodexModelOption[],
  model: string | null,
  effort: string | null,
): string | null {
  const selected = selectedModel(models, model);
  if (!selected) return sanitizeStoredEffort(effort);

  const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  const current = sanitizeStoredEffort(effort);
  if (current && supported.includes(current)) return current;
  return selected.defaultReasoningEffort ?? supported[0] ?? null;
}
