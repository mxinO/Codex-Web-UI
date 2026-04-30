// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageViewerModal from '../../src/components/ImageViewerModal';

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

function rerender(node: React.ReactNode) {
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

describe('ImageViewerModal', () => {
  it('renders an inline authenticated image preview with a download action', () => {
    const onClose = vi.fn();

    render(<ImageViewerModal path="/repo/plots/output image.png" onClose={onClose} />);

    const image = document.querySelector<HTMLImageElement>('.image-viewer__image');
    const download = document.querySelector<HTMLAnchorElement>('.image-viewer__download');
    expect(image?.getAttribute('src')).toBe('/api/file?path=%2Frepo%2Fplots%2Foutput%20image.png');
    expect(image?.getAttribute('alt')).toBe('output image.png');
    expect(download?.getAttribute('href')).toBe('/api/download?path=%2Frepo%2Fplots%2Foutput%20image.png');

    act(() => {
      document.querySelector<HTMLButtonElement>('.image-viewer__close')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('retries image loading when the path changes after a preview error', () => {
    render(<ImageViewerModal path="/repo/plots/broken.png" onClose={vi.fn()} />);

    act(() => {
      document.querySelector<HTMLImageElement>('.image-viewer__image')?.dispatchEvent(new Event('error'));
    });
    expect(document.querySelector('.image-viewer__error')?.textContent).toContain('failed');

    rerender(<ImageViewerModal path="/repo/plots/fixed.png" onClose={vi.fn()} />);

    const image = document.querySelector<HTMLImageElement>('.image-viewer__image');
    expect(image?.getAttribute('src')).toBe('/api/file?path=%2Frepo%2Fplots%2Ffixed.png');
    expect(document.querySelector('.image-viewer__error')).toBeNull();
  });
});
