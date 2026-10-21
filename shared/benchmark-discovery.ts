import type { PaperBenchmarksResponse } from './benchmarks';

export interface BenchmarkText {
  kind: 'title' | 'abstract' | 'fulltext' | 'artifact';
  text: string;
  url: string;
  availabilityUrl?: string;
}
const identity = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const resource = /\b(?:benchmarks?|datasets?|data sets?|corpora|corpus|test suites?|evaluation suites?|repositories|projects|subjects)\b/i;
const namedResource = /\b(?:benchmarks?|datasets?|data sets?|corpora|corpus|test suites?|evaluation suites?)\b/i;
const usage = /\b(?:we (?:use|used|evaluate|evaluated|test|tested|assess|compare|select|collect|construct|build|create)|(?:evaluat\w*|experiment\w*|test\w*) (?:on|using|with)|our (?:evaluation|experiments|dataset)|(?:benchmark|dataset) repositor|(?:artifact|package) (?:includes|contains))\b/i;
const token = '[\\p{L}][\\p{L}\\p{N}_+/-]*';
const nameToken = (value: string) => /^[\p{Lu}][\p{L}\p{N}_+./-]*$/u.test(value) || /[\p{L}][\p{Lu}\p{N}]/u.test(value);
const generic = /^(?:the|our|this|existing|public|standard|new|a|an|all|both|real|world|open|source|synthetic)$/i;

/** Extract source-backed candidates, without benchmark names, URLs, or paper-specific cases. */
export function discoverBenchmarks(source: BenchmarkText): PaperBenchmarksResponse['benchmarks'] {
  let text = source.text.replace(/```[\s\S]*?```/g, '').replace(/(\p{L})-\s*\n\s*(?=\p{Ll})/gu, '$1').replace(/\u00ad/g, '');
  // PDF line items can contain double newlines for every visual line; restore sentences before section splitting.
  if (source.kind === 'fulltext') text = text.replace(/\n[ \t]*\n/g, '\n').replace(/\f/g, '\n\n');
  // Bibliographies and related-work discussions do not establish evaluation use.
  const body = text.split(/^\s*(?:\d+[.\s]+)?(?:references|bibliography)\s*$/im)[0]
    .replace(/^(\s*(?:#{1,6}\s*|\d+(?:\.\d+)*\s+)?(?:evaluation(?: setup)?|experimental(?: setup| evaluation)?|experiments|datasets?|benchmarks?(?: repositories)?|results|related work|background|introduction|conclusion))\s*$/gim, '\n\n$1\n\n');
  const results: PaperBenchmarksResponse['benchmarks'] = [];
  let section = source.kind === 'abstract' ? 'Abstract' : source.kind === 'artifact' ? 'Artifact description' : '';
  let blocked = false;
  for (const paragraph of body.split(/\n\s*\n/)) {
    const clean = paragraph.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 12000) continue;
    const heading = /^(?:#{1,6}\s*|\d+(?:\.\d+)*\s+)?(evaluation(?: setup)?|experimental(?: setup| evaluation)?|experiments|datasets?|benchmarks?(?: repositories)?|results|related work|background|introduction|conclusion)\s*$/i.exec(clean);
    if (heading) { section = heading[1]; blocked = /related work|background|introduction|conclusion/i.test(section); continue; }
    if (/^#{1,6}\s/.test(clean)) continue;
    if (blocked) continue;
    const evaluation = /evaluat|experiment|dataset|benchmark/i.test(section) || source.kind === 'artifact';
    // Sentence boundaries avoid joining a resource in one sentence to an unrelated tool in another.
    const sentences = clean.split(/(?<=[.!?])\s+(?=[\p{Lu}])/u);
    for (const sentence of sentences) {
      if (!resource.test(sentence) && !usage.test(sentence)) continue;
      if (/\b(?:do not|does not|did not|no|without) (?:use |using )?(?:benchmarks?|datasets?)\b|\bfuture work\b/i.test(sentence)) continue;
      const active = usage.test(sentence) || evaluation && /\b(?:use|used|using|select|selected|collect|collected|evaluate|evaluated|contains|includes|dataset|benchmark)\b/i.test(sentence);
      if (!active) continue;
      const add = (name: string, category: 'named' | 'suite', availability?: string) => {
        name = name.trim().replace(/[,.;:]+$/, '');
        if (!name || name.length > 160) return;
        const position = Math.max(0, sentence.indexOf(name));
        const start = Math.max(0, position - 100);
        const excerpt = sentence.slice(start, start + 500).trim();
        const links = [...paragraph.matchAll(/https:\/\/[^\s<>"'\])]+/g)].map(match => match[0].replace(/[.,;]+$/, ''));
        // Only explicit nearby availability links or a verified artifact's own URL. Never guess a name's homepage.
        const url = availability ?? (links.length === 1 && /availab|download|releas|github|zenodo|huggingface/i.test(paragraph) ? links[0] : null);
        results.push({ name, url, category, evidence: { kind: source.kind, excerpt, sourceUrl: source.url, ...(section ? { section } : {}) } });
      };
      const count = /\b(\d{1,5})\s+(?:[\p{L}][\p{L}-]*\s+){0,5}(?:repositories|projects|subjects|programs|APIs|services|datasets|benchmarks)\b/giu;
      for (const match of sentence.matchAll(count)) {
        if (/\b(?:MB|GB|KB|bytes|remaining|out of)\b/i.test(match[0])) continue;
        add(match[0], 'suite', source.availabilityUrl);
        // "4 X, 8 Y and 7 Z repositories": use the explicit shared noun, no framework-name registry.
        const noun = match[0].match(/(?:repositories|projects|subjects|programs|APIs|services|datasets|benchmarks)$/i)?.[0];
        const prefix = sentence.slice(0, match.index);
        const enumeration = /((?:\d{1,5}\s+[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*)?\s*,\s*)*(?:\d{1,5}\s+[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*)?)\s*(?:,?\s*and\s*|,\s*))$/u.exec(prefix);
        if (noun && enumeration) for (const entry of enumeration[1].matchAll(/\b\d{1,5}\s+[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*)?/gu)) {
          if (resource.test(entry[0])) continue;
          add(`${entry[0].replace(/\s+and$/, '')} ${noun}`, 'suite', source.availabilityUrl);
        }
      }
      // Explicit "Foo dataset" and "dataset Foo" phrases.
      if (namedResource.test(sentence)) {
        const preceding = new RegExp(`(${token}(?:\\s+${token}){0,3})\\s+(?:benchmark|dataset|data set|corpus|test suite)\\b(?!\\s+(?:repositories|projects|subjects))`, 'gu');
        for (const match of sentence.matchAll(preceding)) {
          if (/\d\s+$/.test(sentence.slice(0, match.index))) continue;
          const words = match[1].split(/\s+/); const last = words.at(-1)!;
          if (!nameToken(last)) continue;
          let start = words.length - 1;
          while (start > 0 && nameToken(words[start - 1]) && !generic.test(words[start - 1])) start--;
          const names = words.slice(start).join(' ');
          if (names && !names.split(' ').every(word => generic.test(word))) add(names, 'named');
        }
      }
      for (const match of sentence.matchAll(/\b(?:datasets?|benchmarks?|corpus|test suite)\s+(?:named|called)?\s*["“']([^"”']{2,160})["”']/gi)) add(match[1], 'named');
      // Names appearing as objects of an evaluation/use clause; no fixed vocabulary of names.
      const list = /\b(?:on|using|use|used|with)\s+(?:the\s+)?(?:(?:datasets?|benchmarks?)\s*[:—-]?\s*)?([^;]{1,220})/gi;
      for (const match of sentence.matchAll(list)) {
        const candidate = match[1].replace(/\s*\[\d+(?:[,–-]\d+)*\]/g, '').replace(/\s+(?:with|for|to|across|spanning|which|that|where|as|from|and compare)\b.*$/i, '');
        for (const item of candidate.split(/,|\band\b|\bor\b/)) {
          const words = item.trim().replace(/^(?:the|both)\s+/i, '').replace(/[.!?]+$/, '').replace(/\s+(?:datasets?|benchmarks?)\b.*$/i, '').split(/\s+/);
          if (words.length > 5 || !words.every(nameToken)) continue;
          const name = words.join(' ');
          if (!name || words.every(word => generic.test(word))) continue;
          // Require a benchmark/data noun in the clause; a bare "with ToolName" isn't a dataset.
          if (namedResource.test(match[0]) || /^on\b/i.test(match[0]) && /\b(?:evaluate|evaluated|experiments|test|tested)\b/i.test(sentence)) add(name, 'named');
        }
      }
    }
  }
  return mergeBenchmarks(results);
}

export function mergeBenchmarks(results: PaperBenchmarksResponse['benchmarks']): PaperBenchmarksResponse['benchmarks'] {
  const unique = new Map<string, PaperBenchmarksResponse['benchmarks'][number]>();
  for (const result of results) {
    const suite = /^(\d+)\s+(.*?)\s*(repositories|projects|subjects|programs|apis|services|datasets|benchmarks)$/i.exec(result.name);
    // Only redundant resource labels are discarded; preserve meaningful training/testing/domain qualifiers.
    const qualifiers = suite?.[2].replace(/\b(?:benchmarks?|real[- ]world|web|REST API)\b/gi, '').replace(/\s+/g, ' ').trim() ?? '';
    const key = result.category === 'suite' && suite ? `suite:${suite[1]}:${identity(qualifiers)}:${suite[3].toLowerCase()}` : `${result.category}:${identity(result.name)}`;
    const previous = unique.get(key);
    if (!previous || result.url && !previous.url || previous.evidence.kind === 'abstract' && result.evidence.kind === 'fulltext') unique.set(key, result);
  }
  return [...unique.values()].slice(0, 50);
}
