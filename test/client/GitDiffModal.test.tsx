// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitDiffModal from '../../src/components/GitDiffModal';

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
type Diff = React.ComponentProps<typeof GitDiffModal>['diff'];

function renderModal(diff: Diff) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<GitDiffModal diff={diff} onClose={vi.fn()} />);
  });
}

async function waitForElement(selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const element = document.querySelector(selector);
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  throw new Error(`missing ${selector}`);
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('GitDiffModal', () => {
  it('shows the raw path in the title and renders normal patches without git headers', async () => {
    renderModal({
      repoId: 'repo:1',
      path: 'src/mixedCase.TS',
      scope: 'unstaged',
      patch: 'diff --git a/src/mixedCase.TS b/src/mixedCase.TS\nindex abc..def 100644\n--- a/src/mixedCase.TS\n+++ b/src/mixedCase.TS\n@@ -1 +1 @@\n-old\n+new',
      truncated: false,
    });
    await waitForElement('.diff-viewer--patch');

    expect(document.querySelector('.git-diff-modal__title')?.textContent).toBe('src/mixedCase.TS');
    expect(document.querySelector('.diff-viewer--patch')).toBeInstanceOf(HTMLElement);
    const patchText = document.querySelector('[aria-label="Patch lines"]')?.textContent ?? '';
    expect(patchText).not.toContain('diff --git');
    expect(patchText).not.toContain('index abc');
    expect(patchText).toContain('+new');
  });

  it('uses the two-way message-flow diff viewer when snapshots are available', async () => {
    renderModal({
      repoId: 'repo:1',
      path: 'src/mixedCase.TS',
      scope: 'unstaged',
      patch: 'diff --git a/src/mixedCase.TS b/src/mixedCase.TS\n@@ -1 +1 @@\n-old\n+new',
      truncated: false,
      before: 'old\n',
      after: 'new\n',
    });
    await waitForElement('.monaco-diff-mock');

    expect(document.querySelector('.diff-viewer--patch')).toBeNull();
    expect(document.querySelector('.monaco-diff-mock')?.getAttribute('data-language')).toBe('typescript');
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toBe('old\n');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toBe('new\n');
  });

  it('uses the two-way viewer for equal snapshots such as pure renames', async () => {
    renderModal({
      repoId: 'repo:1',
      path: 'src/renamed.ts',
      scope: 'staged',
      patch: 'diff --git a/src/original.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/original.ts\nrename to src/renamed.ts',
      truncated: false,
      before: 'same\n',
      after: 'same\n',
    });
    await waitForElement('.monaco-diff-mock');

    expect(document.querySelector('.diff-viewer--patch')).toBeNull();
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toBe('same\n');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toBe('same\n');
  });

  it('does not expose raw git headers for metadata-only patch fallbacks', async () => {
    renderModal({
      repoId: 'repo:1',
      path: 'src/renamed.ts',
      scope: 'staged',
      patch: 'diff --git a/src/original.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/original.ts\nrename to src/renamed.ts',
      truncated: false,
    });
    await waitForElement('.diff-viewer--patch');

    const patchText = document.querySelector('[aria-label="Patch lines"]')?.textContent ?? '';
    expect(patchText).toContain('No textual changes to display.');
    expect(patchText).not.toContain('diff --git');
    expect(patchText).not.toContain('rename from');
  });

  it('uses compact states for binary and truncated diffs', () => {
    renderModal({ repoId: 'repo:1', path: 'asset.bin', scope: 'unstaged', patch: '', truncated: true, binary: true });

    expect(document.querySelector('.git-diff-modal__state')?.textContent).toContain('Binary diff is not available.');
    expect(document.querySelector('.git-diff-modal__state')?.textContent).toContain('Diff output was truncated.');
    expect(document.querySelector('.diff-viewer--patch')).toBeNull();
  });

  it('uses a compact state for truncated-only diffs without rendering the patch viewer', () => {
    renderModal({ repoId: 'repo:1', path: 'src/rawName.ts', scope: 'staged', patch: 'partial patch', truncated: true });

    expect(document.querySelector('.git-diff-modal__title')?.textContent).toBe('src/rawName.ts');
    expect(document.querySelector('.git-diff-modal__state')?.textContent).toContain('Diff output was truncated.');
    expect(document.querySelector('.diff-viewer--patch')).toBeNull();
  });
});
