// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiffViewer from '../../src/components/DiffViewer';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified, language }: { original?: string; modified?: string; language?: string }) => (
    <div className="monaco-diff-mock" data-language={language}>
      <pre aria-label="Before">{original}</pre>
      <pre aria-label="After">{modified}</pre>
    </div>
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

describe('DiffViewer', () => {
  it('uses Monaco DiffEditor for two-way diffs', () => {
    render(<DiffViewer before="old" after="new" language="typescript" />);

    expect(document.querySelector('.monaco-diff-mock')?.getAttribute('data-language')).toBe('typescript');
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toBe('old');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toBe('new');
  });
});
