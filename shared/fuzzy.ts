// Fuzzy matching helpers shared by the offline search ranker and the search UI.
// Matching is subsequence-based with bonuses for consecutive characters and
// word starts, so typos and partial titles still rank well.

export const normalizeText = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const words = (value: string) => value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Subsequence fuzzy score of `query` against `candidate`; 0 means no match.
export function fuzzyScore(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  let qi = 0, score = 0, streak = 0, last = -2;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] !== query[qi]) { streak = 0; continue; }
    streak = last === ci - 1 ? streak + 1 : 1;
    score += 2 * streak;
    if (ci === 0 || /[^\p{L}\p{N}]/u.test(candidate[ci - 1])) score += 4;
    last = ci; qi++;
  }
  return qi === query.length ? score / query.length : 0;
}

export interface MatchablePaper { title: string; authors: string[]; topics: string[]; abstract?: string | null }

export function paperMatchScore(rawQuery: string, paper: MatchablePaper): number {
  const query = normalizeText(rawQuery).trim();
  if (!query) return 0;
  const title = normalizeText(paper.title);
  if (title === query) return 1000;
  const tokens = words(query);
  const titleWords = words(title);
  const authorWords = words(normalizeText(paper.authors.join(' ')));
  const topicWords = words(normalizeText(paper.topics.join(' ')));
  const text = normalizeText([paper.title, ...paper.authors, ...paper.topics].join(' '));
  let score = 0;
  if (title.includes(query)) score += 300;
  if (tokens.length && tokens.every(token => text.includes(token))) score += 60;
  if (paper.abstract && tokens.length && tokens.every(token => normalizeText(paper.abstract!).includes(token))) score += 10;
  let fuzzy = 0;
  for (const token of tokens) {
    if (titleWords.some(word => word.startsWith(token))) { fuzzy += 40; continue; }
    if (authorWords.some(word => word === token)) { fuzzy += 25; continue; }
    let best = 0;
    for (const word of [...titleWords, ...authorWords, ...topicWords]) best = Math.max(best, fuzzyScore(token, word));
    if (best < 3) { fuzzy = 0; break; }
    fuzzy += best * 8;
  }
  return score + fuzzy;
}

// Stable sort: papers with equal fuzzy scores keep their original (API relevance) order.
export function rankPapers<T extends MatchablePaper>(query: string, papers: T[]): T[] {
  return [...papers].sort((a, b) => paperMatchScore(query, b) - paperMatchScore(query, a));
}
