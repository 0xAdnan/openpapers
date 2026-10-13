export type ProviderId = 'openalex' | 'semantic-scholar';

export const PAPER_ID_PATTERN = /^(?:W[1-9]\d{0,14}|S2:[a-f0-9]{40})$/;
export const S2_ID_PATTERN = /^S2:[a-f0-9]{40}$/;

export function paperProvider(id: string): ProviderId {
  return id.startsWith('S2:') ? 'semantic-scholar' : 'openalex';
}

export function providerName(provider: ProviderId): string {
  return provider === 'semantic-scholar' ? 'Semantic Scholar' : 'OpenAlex';
}

export function providerRecordUrl(id: string): string {
  return paperProvider(id) === 'semantic-scholar'
    ? `https://www.semanticscholar.org/paper/${id.slice(3)}`
    : `https://openalex.org/${id}`;
}
