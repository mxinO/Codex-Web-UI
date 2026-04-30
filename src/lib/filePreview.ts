const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

export function normalizeMentionedFilePath(path: string): string {
  return path.trim().replace(/:\d+(?::\d+)?$/, '');
}

export function isImagePath(path: string): boolean {
  const normalized = normalizeMentionedFilePath(path).toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return IMAGE_EXTENSIONS.has(normalized.slice(dotIndex));
}

export function filePreviewUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(normalizeMentionedFilePath(path))}`;
}

export function fileDownloadUrl(path: string): string {
  return `/api/download?path=${encodeURIComponent(normalizeMentionedFilePath(path))}`;
}
