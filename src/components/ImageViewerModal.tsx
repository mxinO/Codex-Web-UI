import { Download, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fileDownloadUrl, filePreviewUrl } from '../lib/filePreview';

interface ImageViewerModalProps {
  path: string;
  onClose: () => void;
  onPreviewError?: (message: string) => void;
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export default function ImageViewerModal({ path, onClose, onPreviewError }: ImageViewerModalProps) {
  const [failed, setFailed] = useState(false);
  const previewUrl = useMemo(() => filePreviewUrl(path), [path]);
  const downloadUrl = useMemo(() => fileDownloadUrl(path), [path]);
  const name = basename(path);

  useEffect(() => {
    setFailed(false);
  }, [path]);

  const handleError = () => {
    const message = 'Image preview failed to load.';
    setFailed(true);
    onPreviewError?.(message);
  };

  return (
    <div className="modal-overlay" role="presentation">
      <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image viewer">
        <div className="modal-header image-viewer__header">
          <span className="image-viewer__title" title={path}>
            {path}
          </span>
          <div className="image-viewer__actions">
            <a className="image-viewer__download" href={downloadUrl} download title="Download image" aria-label={`Download ${path}`}>
              <Download size={16} aria-hidden="true" />
            </a>
            <button className="image-viewer__close" type="button" onClick={onClose} title="Close image viewer" aria-label="Close image viewer">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="image-viewer__body">
          {failed ? (
            <div className="image-viewer__error">Image preview failed to load.</div>
          ) : (
            <img className="image-viewer__image" src={previewUrl} alt={name} onError={handleError} />
          )}
        </div>
      </div>
    </div>
  );
}
