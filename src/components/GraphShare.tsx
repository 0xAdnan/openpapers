import { useRef, useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import './share.css';

export default function GraphShare({ url, title, expanded }: { url: string; title: string; expanded: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const nativeShare = typeof navigator.share === 'function';

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage('Graph link copied.');
    } catch {
      setCopied(false);
      input.current?.focus();
      input.current?.select();
      setMessage('Clipboard access is unavailable. The link is selected so you can copy it manually.');
    }
  }

  async function share() {
    setSharing(true);
    try {
      await navigator.share({ title: `Open Papers: ${title}`, text: 'Explore this research graph on Open Papers.', url });
      setMessage('Share sheet closed.');
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) setMessage('Sharing is unavailable. Use Copy link instead.');
    } finally { setSharing(false); }
  }

  return <div className="graph-share">
    <p className="dialog-copy">Anyone with this link can open the graph. It includes your origin papers, current view, filters, and selected paper, but not your private saved library.</p>
    <label className="field-label">Graph link<input ref={input} type="url" readOnly value={url} onFocus={event => event.currentTarget.select()} /></label>
    <div className="graph-share-actions">
      <button type="button" className="primary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy link'}</button>
      {nativeShare && <button type="button" className="secondary" disabled={sharing} onClick={share}><Share2 size={17} />{sharing ? 'Opening...' : 'Share via...'}</button>}
    </div>
    <p className="graph-share-status" role="status" aria-live="polite">{message}</p>
    <p className="dialog-copy">{expanded
      ? 'This link also includes the expanded research job. Saved job results are subject to server retention; export the graph JSON for a lasting copy.'
      : 'Quick graphs can change when their source data is refreshed. Export the graph JSON if you need to preserve this exact result.'}</p>
  </div>;
}
