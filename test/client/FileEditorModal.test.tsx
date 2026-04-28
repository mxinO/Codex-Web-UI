// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileEditorModal from '../../src/components/FileEditorModal';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, options }: { value?: string; onChange?: (value?: string) => void; options?: { readOnly?: boolean } }) => (
    <textarea
      className="monaco-editor-mock"
      readOnly={options?.readOnly}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('FileEditorModal', () => {
  it('uses the lazy Monaco editor surface for editable files', async () => {
    render(<FileEditorModal path="/repo/a.ts" initialContent="const value = 1;" readOnly={false} onClose={vi.fn()} onSave={vi.fn()} />);

    await act(async () => {
      await import('@monaco-editor/react');
      await Promise.resolve();
    });

    const editor = document.querySelector<HTMLTextAreaElement>('.monaco-editor-mock');
    expect(editor?.value).toBe('const value = 1;');
    expect(editor?.readOnly).toBe(false);
  });
});
