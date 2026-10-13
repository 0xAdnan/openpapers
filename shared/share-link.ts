import { PAPER_ID_PATTERN } from './providers';

export function graphShareLink(origin: string, ids: string[], view: string, params: URLSearchParams): string {
  if (!ids.length || ids.length > 3 || ids.some(id => !PAPER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Cannot share an invalid graph');
  }
  const url = new URL(`/graph/${ids.join(',')}/${['graph', 'list', 'prior', 'derivative'].includes(view) ? view : 'graph'}`, origin);
  for (const key of ['selected', 'keyword', 'from', 'to', 'oa', 'pdf', 'job']) {
    const value = params.get(key);
    if (!value || value.length > 200) continue;
    if (key === 'selected' && !PAPER_ID_PATTERN.test(value)) continue;
    if (key === 'job' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) continue;
    url.searchParams.set(key, value);
  }
  return url.href;
}
