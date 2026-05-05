import { describe, expect, it } from 'vitest';
import { fileDownloadUrl, filePreviewUrl, isImagePath, normalizeMentionedFilePath } from '../../src/lib/filePreview';
import { markdownFileHrefPath, splitFileMentions } from '../../src/lib/fileMentions';

describe('file preview helpers', () => {
  it('detects common image paths without treating raw line-like suffixes as extensions', () => {
    expect(isImagePath('plots/output.PNG')).toBe(true);
    expect(isImagePath('/repo/screenshots/view.webp:12')).toBe(false);
    expect(isImagePath(normalizeMentionedFilePath('/repo/screenshots/view.webp:12'))).toBe(true);
    expect(isImagePath('src/App.tsx')).toBe(false);
  });

  it('normalizes mentioned paths without keeping line and column suffixes', () => {
    expect(normalizeMentionedFilePath('src/App.tsx:49')).toBe('src/App.tsx');
    expect(normalizeMentionedFilePath('/repo/src/App.tsx:49:2')).toBe('/repo/src/App.tsx');
  });

  it('builds inline preview urls without base64 encoding file contents', () => {
    expect(filePreviewUrl('/repo/plots/output image.png')).toBe('/api/file?path=%2Frepo%2Fplots%2Foutput%20image.png');
    expect(filePreviewUrl('/repo/plots/output.png:12')).toBe('/api/file?path=%2Frepo%2Fplots%2Foutput.png%3A12');
    expect(fileDownloadUrl('/repo/data/report.txt:12')).toBe('/api/download?path=%2Frepo%2Fdata%2Freport.txt%3A12');
  });
});

describe('splitFileMentions', () => {
  it('splits path-like text into clickable file tokens', () => {
    expect(splitFileMentions('Open src/App.tsx:49 and /repo/plots/output.png.')).toEqual([
      { type: 'text', value: 'Open ' },
      { type: 'file', value: 'src/App.tsx:49', path: 'src/App.tsx' },
      { type: 'text', value: ' and ' },
      { type: 'file', value: '/repo/plots/output.png', path: '/repo/plots/output.png' },
      { type: 'text', value: '.' },
    ]);
  });

  it('does not turn common dotted prose into file mentions', () => {
    expect(splitFileMentions('Node.js, dev@example.com, 1.2.3, React.memo, and example.com/path are not files.')).toEqual([
      { type: 'text', value: 'Node.js, dev@example.com, 1.2.3, React.memo, and example.com/path are not files.' },
    ]);
  });
});

describe('markdownFileHrefPath', () => {
  it('recognizes local markdown hrefs as file paths', () => {
    expect(markdownFileHrefPath('docs/guide.md')).toBe('docs/guide.md');
    expect(markdownFileHrefPath('/repo/src/App.tsx#L42')).toBe('/repo/src/App.tsx');
    expect(markdownFileHrefPath('plots/output%20image.png?raw=1')).toBe('plots/output image.png');
  });

  it('leaves external and in-page markdown hrefs alone', () => {
    expect(markdownFileHrefPath('https://example.com/docs/guide.md')).toBeNull();
    expect(markdownFileHrefPath('//example.com/docs/guide.md')).toBeNull();
    expect(markdownFileHrefPath('#section')).toBeNull();
  });
});
