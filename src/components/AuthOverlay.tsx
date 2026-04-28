export default function AuthOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="modal-overlay">
      <div className="auth-box" role="dialog" aria-modal="true" aria-labelledby="auth-overlay-title">
        <h2 id="auth-overlay-title">Authentication Required</h2>
        <p>Open the URL printed by the server, including its token query parameter.</p>
      </div>
    </div>
  );
}
