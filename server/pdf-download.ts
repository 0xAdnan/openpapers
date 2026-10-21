import { lookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export const MAX_PDF_BYTES = 8 * 1024 * 1024;

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function pdfUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2000) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash) return;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostname.includes('.') || hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname) ||
        isIP(hostname) && !publicAddress(hostname)) return;
    return url;
  } catch { return; }
}

/** Resolve once and pin the checked address to the socket, closing DNS-rebinding and redirect SSRF paths. */
export async function downloadPdf(url: URL, signal: AbortSignal, options: { lookup?: typeof lookup; request?: typeof request } = {}): Promise<Uint8Array> {
  const body = await downloadDocument(url, signal, { ...options, maxBytes: MAX_PDF_BYTES, types: ['application/pdf', 'application/octet-stream'] });
  if (!Buffer.from(body).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Not a PDF');
  return body;
}

/** Same public-address pinning for bounded metadata and artifact documents; no redirect following. */
export async function downloadDocument(url: URL, signal: AbortSignal, options: {
  lookup?: typeof lookup; request?: typeof request; maxBytes?: number; types?: string[];
} = {}): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!pdfUrl(url.href)) throw new Error('Unsafe PDF URL');
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    (options.lookup ?? lookup)(url.hostname, { all: true, verbatim: true }, (error, records) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(records);
    });
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw new Error('Non-public PDF host');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason); req.destroy(); };
    const finish = (error?: Error, body?: Uint8Array) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(body!);
    };
    const req = (options.request ?? request)(url, {
      signal, agent: false, family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: (options.types ?? ['application/json', 'text/html', 'text/plain']).join(', '), 'Accept-Encoding': 'identity', 'User-Agent': 'OpenPapers/0.1 (source discovery)' },
    }, response => {
      const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const limit = options.maxBytes ?? 1024 * 1024;
      if (response.statusCode !== 200 || !(options.types ?? ['application/json', 'text/html', 'text/plain']).includes(type ?? '') ||
          response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' ||
          Number(response.headers['content-length']) > limit) {
        finish(new Error('PDF download rejected')); req.destroy(); response.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) { finish(new Error('Document too large')); req.destroy(); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('PDF download interrupted')));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        finish(undefined, new Uint8Array(body));
      });
    });
    req.on('error', error => finish(error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end();
  });
}
