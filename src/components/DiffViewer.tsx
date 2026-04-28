export default function DiffViewer({ before, after, language }: { before: string; after: string; language?: string }) {
  return (
    <div className="diff-viewer" data-language={language ?? 'plaintext'}>
      <section className="diff-pane" aria-label="Before">
        <div className="diff-title">Before</div>
        <pre>{before}</pre>
      </section>
      <section className="diff-pane" aria-label="After">
        <div className="diff-title">After</div>
        <pre>{after}</pre>
      </section>
    </div>
  );
}
