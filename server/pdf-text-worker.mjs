import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Parsing is isolated from the API event loop and can be terminated on timeout/cancellation.
const loading = getDocument({ data: workerData.data, isEvalSupported: false, useWorkerFetch: false,
  useSystemFonts: false, disableFontFace: true, stopAtErrors: true, maxImageSize: 0, verbosity: 0 });
try {
  const document = await loading.promise;
  if (document.numPages > 40) throw new Error('PDF page limit');
  let text = '';
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    let y;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (y !== undefined && Math.abs(y - item.transform[5]) > 2) text += '\n';
      text += item.str + (item.hasEOL ? '\n' : ' ');
      y = item.transform[5];
      if (text.length > 500000) throw new Error('PDF text limit');
    }
    text += '\n\f\n';
    page.cleanup();
  }
  parentPort.postMessage({ text });
} catch {
  parentPort.postMessage({ error: 'PDF text unavailable' });
} finally {
  await loading.destroy();
}
