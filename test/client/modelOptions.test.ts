import { describe, expect, it } from 'vitest';
import {
  effortOptionsForModel,
  modelOptionsFromResult,
  reconcileEffortForModel,
} from '../../src/lib/modelOptions';

const catalogResult = {
  data: [
    {
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'General coding model',
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Faster' },
        { reasoningEffort: 'high', description: 'Deeper' },
      ],
      defaultReasoningEffort: 'high',
    },
    {
      id: 'gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 mini',
      description: '',
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'max', description: 'Maximum reasoning' },
      ],
      defaultReasoningEffort: 'medium',
    },
    { id: '', model: '', displayName: 'Invalid model' },
    null,
  ],
  nextCursor: null,
};

describe('model option helpers', () => {
  it('normalizes valid model entries and supported effort values', () => {
    expect(modelOptionsFromResult(catalogResult)).toEqual([
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'General coding model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Faster' },
          { reasoningEffort: 'high', description: 'Deeper' },
        ],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        description: '',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'max', description: 'Maximum reasoning' },
        ],
        defaultReasoningEffort: 'medium',
        isDefault: false,
      },
    ]);
  });

  it('returns only efforts supported by the selected model', () => {
    const models = modelOptionsFromResult(catalogResult);
    expect(effortOptionsForModel(models, 'gpt-5.4')).toEqual([
      { reasoningEffort: 'low', description: 'Faster' },
      { reasoningEffort: 'high', description: 'Deeper' },
    ]);
    expect(effortOptionsForModel(models, 'missing')).toEqual([]);
  });

  it('keeps a supported effort and otherwise selects the model default', () => {
    const models = modelOptionsFromResult(catalogResult);
    expect(reconcileEffortForModel(models, 'gpt-5.4', 'low')).toBe('low');
    expect(reconcileEffortForModel(models, 'gpt-5.4-mini', 'high')).toBe('medium');
  });

  it('falls back to the first supported effort and then null', () => {
    const models = modelOptionsFromResult({
      data: [
        {
          id: 'no-default',
          model: 'no-default',
          displayName: 'No default',
          supportedReasoningEfforts: [{ reasoningEffort: 'minimal', description: '' }],
          defaultReasoningEffort: 'unsupported',
        },
        {
          id: 'no-effort',
          model: 'no-effort',
          displayName: 'No effort',
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(reconcileEffortForModel(models, 'no-default', 'high')).toBe('minimal');
    expect(reconcileEffortForModel(models, 'no-effort', 'high')).toBeNull();
    expect(reconcileEffortForModel(models, 'missing', 'high')).toBe('high');
  });
});
