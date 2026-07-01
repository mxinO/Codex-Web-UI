const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const RAW_BROWSER_EXTENSIONS = new Set(['.htm', '.html', '.pdf']);
const TRUSTED_HTML_EXTENSIONS = new Set(['.htm', '.html']);

export function normalizeMentionedFilePath(path: string): string {
  return path.trim().replace(/:\d+(?::\d+)?$/, '');
}

export function isImagePath(path: string): boolean {
  const normalized = path.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return IMAGE_EXTENSIONS.has(normalized.slice(dotIndex));
}

export function isRawBrowserOpenablePath(path: string): boolean {
  const normalized = path.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return RAW_BROWSER_EXTENSIONS.has(normalized.slice(dotIndex));
}

export function isTrustedHtmlPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return TRUSTED_HTML_EXTENSIONS.has(normalized.slice(dotIndex));
}

export function filePreviewUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

export function fileRawUrl(path: string, options: { trustedHtml?: boolean } = {}): string {
  const trusted = options.trustedHtml && isTrustedHtmlPath(path) ? '&trusted=1' : '';
  return `/api/file/raw?path=${encodeURIComponent(path)}${trusted}`;
}

export function fileTrustedHtmlUrl(path: string): string {
  return fileRawUrl(path, { trustedHtml: true });
}

export function fileBrowserUrl(path: string): string {
  return isTrustedHtmlPath(path) ? fileTrustedHtmlUrl(path) : fileRawUrl(path);
}

export function fileDownloadUrl(path: string): string {
  return `/api/download?path=${encodeURIComponent(path)}`;
}
