// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileEditorModal, { languageForPath, resolveMarkdownLinkPath } from '../../src/components/FileEditorModal';

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    options,
    language,
  }: {
    value?: string;
    onChange?: (value?: string) => void;
    options?: { readOnly?: boolean };
    language?: string;
  }) => (
    <textarea
      className="monaco-editor-mock"
      data-language={language}
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
  it('maps common source paths to Monaco language ids', () => {
    expect(languageForPath('/repo/script.sh')).toBe('shell');
    expect(languageForPath('/repo/.bashrc')).toBe('shell');
    expect(languageForPath('/repo/Makefile')).toBe('shell');
    expect(languageForPath('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/repo/Dockerfile.dev')).toBe('dockerfile');
    expect(languageForPath('/repo/view.jsx')).toBe('javascript');
    expect(languageForPath('/repo/package.mts')).toBe('typescript');
    expect(languageForPath('/repo/package.cts')).toBe('typescript');
    expect(languageForPath('/repo/src/main.rs')).toBe('rust');
    expect(languageForPath('/repo/query.sql')).toBe('sql');
    expect(languageForPath('/repo/README.md')).toBe('markdown');
    expect(languageForPath('/repo/config.toml')).toBe('ini');
  });

  it('resolves markdown preview links relative to the open file', () => {
    expect(resolveMarkdownLinkPath('/repo/docs/README.md', 'guide.md')).toBe('/repo/docs/guide.md');
    expect(resolveMarkdownLinkPath('/repo/docs/README.md', '../src/App.tsx')).toBe('/repo/src/App.tsx');
    expect(resolveMarkdownLinkPath('/repo/docs/README.md', '/repo/LICENSE')).toBe('/repo/LICENSE');
  });

  it('uses the lazy Monaco editor surface for editable files', async () => {
    render(<FileEditorModal path="/repo/a.ts" initialContent="const value = 1;" readOnly={false} onClose={vi.fn()} onSave={vi.fn()} />);

    await act(async () => {
      await import('@monaco-editor/react');
      await Promise.resolve();
    });

    const editor = document.querySelector<HTMLTextAreaElement>('.monaco-editor-mock');
    expect(editor?.value).toBe('const value = 1;');
    expect(editor?.readOnly).toBe(false);
    expect(editor?.dataset.language).toBe('typescript');
  });

  it('renders markdown preview controls for read-only markdown files', async () => {
    render(
      <FileEditorModal
        path="/repo/README.md"
        initialContent="# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n"
        sizeBytes={42}
        readOnly
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const previewButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Preview');
    expect(previewButton).toBeTruthy();

    act(() => {
      previewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await import('../../src/components/MarkdownView');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('.file-markdown-preview')?.textContent).toContain('Title');
  });

  it('opens local markdown preview links through the file viewer callback', async () => {
    const onOpenFile = vi.fn();
    render(
      <FileEditorModal
        path="/repo/docs/README.md"
        initialContent="[Guide](./guide.md) and [App](../src/App.tsx:42)"
        sizeBytes={42}
        readOnly
        onClose={vi.fn()}
        onSave={vi.fn()}
        onOpenFile={onOpenFile}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const previewButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Preview');
    act(() => {
      previewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await import('../../src/components/MarkdownView');
      await Promise.resolve();
      await Promise.resolve();
    });

    const fileLinks = Array.from(document.querySelectorAll<HTMLButtonElement>('.markdown-file-link'));
    expect(fileLinks.map((link) => link.textContent)).toEqual(['Guide', 'App']);

    act(() => {
      fileLinks[0].click();
      fileLinks[1].click();
    });

    expect(onOpenFile).toHaveBeenNthCalledWith(1, '/repo/docs/guide.md');
    expect(onOpenFile).toHaveBeenNthCalledWith(2, '/repo/src/App.tsx');
  });

  it('disables markdown preview for large markdown files', async () => {
    render(
      <FileEditorModal
        path="/repo/LARGE.md"
        initialContent="# Large\n"
        sizeBytes={2 * 1024 * 1024}
        readOnly
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Preview')).toBe(false);
    expect(document.body.textContent).toContain('Preview disabled for large Markdown files.');
  });
});
