// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiffViewer from '../../src/components/DiffViewer';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    original,
    modified,
    language,
    options,
  }: {
    original?: string;
    modified?: string;
    language?: string;
    options?: { renderSideBySide?: boolean };
  }) => (
    <div className="monaco-diff-mock" data-language={language} data-side-by-side={String(options?.renderSideBySide)}>
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
    expect(document.querySelector('.monaco-diff-mock')?.getAttribute('data-side-by-side')).toBe('false');
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toBe('old');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toBe('new');
  });

  it('renders unified patch hunks with actual old and new line numbers', () => {
    render(<DiffViewer patch={'@@ -42,2 +99,3 @@\n context\n-old\n+new\n+extra\n'} language="typescript" />);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.diff-line'));
    expect(rows.map((row) => row.querySelector('.diff-line__old')?.textContent)).toEqual(['', '42', '43', '', '']);
    expect(rows.map((row) => row.querySelector('.diff-line__new')?.textContent)).toEqual(['', '99', '', '100', '101']);
    expect(rows.map((row) => row.querySelector('.diff-line__code')?.textContent)).toEqual([
      '@@ -42,2 +99,3 @@',
      ' context',
      '-old',
      '+new',
      '+extra',
    ]);
  });

  it('resets patch line numbers at each hunk header', () => {
    render(<DiffViewer patch={'@@ -5 +10 @@\n-old\n+new\n@@ -20 +30 @@\n-before\n+after\n'} language="typescript" />);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.diff-line'));
    expect(rows.map((row) => row.querySelector('.diff-line__old')?.textContent)).toEqual(['', '5', '', '', '20', '']);
    expect(rows.map((row) => row.querySelector('.diff-line__new')?.textContent)).toEqual(['', '', '10', '', '', '30']);
  });
});
