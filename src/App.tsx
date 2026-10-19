import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Filter, FlaskConical, GitBranch, Github, Globe, GraduationCap, Info, Library, List, Menu, Network, Plus, Search, Share2, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { DataMeta, Example, GraphPaper, GraphResponse, Paper, SearchResponse } from '../shared/types';
import { ExamplesSchema, GraphResponseSchema, PaperSchema, ProvidersSchema, SearchResponseSchema } from '../shared/schemas';
import { paperProvider, providerRecordUrl, type ProviderId } from '../shared/providers';
import { paperMatchScore, rankPapers } from '../shared/fuzzy';
import { doiIdentifier } from '../shared/identifiers';
import GraphCanvas from './components/GraphCanvas';
import GraphPreview, { type FeaturedPreview } from './components/GraphPreview';
import featuredPreviews from './featured-previews.json';
import GraphShare from './components/GraphShare';
import { graphShareLink } from '../shared/share-link';
import useGraphJob from './hooks/useGraphJob';

const number = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat('en');
const graphUrl = (ids: string[], view = 'graph') => `/graph/${ids.join(',')}/${view}`;
const searchUrl = (query: string, provider: string, page = 1) => `/search?q=${encodeURIComponent(query)}&page=${page}&provider=${encodeURIComponent(provider)}`;
const repoUrl = 'https://github.com/0xAdnan/openpapers';
const s2Attribution = 'Data source: Semantic Scholar; API/data terms apply';
const authors = (paper: Paper) => `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}` || 'Authors unavailable';

function safeUrl(value: string | null | undefined) {
  try { const url = new URL(value ?? ''); return /^https?:$/.test(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

function useApi<T>(url: string | null) {
  const [state, setState] = useState<{ url?: string | null; data?: T; error?: string; loading: boolean }>({ loading: Boolean(url) });
  useEffect(() => {
    if (!url) { setState({ url, loading: false }); return; }
    const controller = new AbortController();
    setState({ url, loading: true });
    fetch(url, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed. Please try again.');
      const schema = url === '/api/providers' ? ProvidersSchema : url.startsWith('/api/graph?') ? GraphResponseSchema : url.startsWith('/api/search?') ? SearchResponseSchema : ExamplesSchema;
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error('The server returned incomplete or invalid paper data. Please try again.');
      return parsed.data as T;
    }).then(data => { if (!controller.signal.aborted) setState({ url, data, loading: false }); }).catch(error => {
      if (!controller.signal.aborted) setState({ url, error: error.message, loading: false });
    });
    return () => controller.abort();
  }, [url]);
  // Never expose the previous request's data during a URL/provider change.
  return state.url === url ? state : { loading: Boolean(url) };
}

interface ProviderState {
  provider?: ProviderId; searchProvider?: string; config?: typeof ProvidersSchema._output;
  error?: string;
}
const ProviderContext = createContext<ProviderState>({});

interface LibraryState { papers: Paper[]; toggle: (paper: Paper) => void; notify: (message: string) => void }
const LibraryContext = createContext<LibraryState>({ papers: [], toggle: () => {}, notify: () => {} });

function loadLibrary(): Paper[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('open-papers-library') ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 300).flatMap(paper => { const result = PaperSchema.safeParse(paper); return result.success ? [result.data] : []; });
  } catch { return []; }
}

export default function App() {
  const { data: config, error: providerError } = useApi<typeof ProvidersSchema._output>('/api/providers');
  const [chosen, setChosen] = useState<ProviderId>();
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const rawProvider = pathname === '/' || pathname === '/search' ? params.get('provider') : null;
  const knownProvider = rawProvider === 'openalex' || rawProvider === 'semantic-scholar' ? rawProvider : undefined;
  const preferred = knownProvider ?? chosen;
  const provider = config?.providers.find(item => item.id === preferred)?.id ?? config?.providers.find(item => item.id === config.defaultProvider)?.id;
  // Wait for configuration, but let unknown URL providers reach the API's validation.
  const searchProvider = !config || (knownProvider && knownProvider !== provider) ? undefined : rawProvider !== null && !knownProvider ? rawProvider : provider;
  useEffect(() => {
    if (!config || !provider) return;
    setChosen(provider);
    if (knownProvider && knownProvider !== provider) {
      const next = new URLSearchParams(params); next.set('provider', provider); next.delete('page');
      setParams(next, { replace: true });
    }
  }, [config, provider, knownProvider, params, setParams]);
  const [papers, setPapers] = useState(loadLibrary);
  const [message, setMessage] = useState('');
  useEffect(() => { if (message) { const timer = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(timer); } }, [message]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'open-papers-library') setPapers(loadLibrary()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  async function toggle(paper: Paper) {
    const update = () => {
      const current = loadLibrary();
      const exists = current.some(p => p.id === paper.id);
      if (!exists && current.length >= 300) { setMessage('Your local library is full (300 papers). Remove a paper first.'); return; }
      const next = exists ? current.filter(p => p.id !== paper.id) : [paper, ...current];
      localStorage.setItem('open-papers-library', JSON.stringify(next));
      setPapers(next); setMessage(exists ? 'Paper removed from your library.' : 'Paper saved on this device.');
    };
    try {
      if (navigator.locks) await navigator.locks.request('open-papers-library', update);
      else update();
    } catch { setMessage('Could not save: browser storage is unavailable or full.'); }
  }
  return <ProviderContext value={{ provider, searchProvider, config, error: providerError }}><LibraryContext value={{ papers, toggle, notify: setMessage }}>
    <a className="skip-link" href="#main">Skip to content</a>
    <Header />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/graph/:ids/:view?" element={<Workspace />} />
      <Route path="/library" element={<LibraryPage />} />
      <Route path="/about" element={<About />} />
      <Route path="*" element={<main id="main" className="reading-page"><h1>Page not found</h1><Link to="/">Return to search</Link></main>} />
    </Routes>
    <div className={`toast ${message ? 'visible' : ''}`} role="status" aria-live="polite">{message && <><Check size={18} />{message}<button aria-label="Dismiss notification" onClick={() => setMessage('')}><X size={16} /></button></>}</div>
  </LibraryContext></ProviderContext>;
}

function Brand() {
  return <Link className="brand" to="/" aria-label="Open Papers home"><svg viewBox="0 0 36 38" aria-hidden="true"><path d="M7 29L22 8L29 25L7 29" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="7" cy="29" r="5.5" fill="#339b9e" /><circle cx="22" cy="8" r="4.5" fill="#73babc" /><circle cx="29" cy="25" r="4" fill="#267f83" /></svg><span>OPEN PAPERS</span></Link>;
}

function GithubStar() {
  return <a className="github-star" href={repoUrl} target="_blank" rel="noreferrer" aria-label="Star Open Papers on GitHub"><Github size={16} />Star on GitHub</a>;
}

function Header() {
  const [open, setOpen] = useState(false);
  const { papers } = useContext(LibraryContext);
  return <header className="site-header">
    <Brand />
    <div className="header-search"><SearchBox compact /></div>
    <nav className={open ? 'header-nav is-open' : 'header-nav'} aria-label="Main navigation">
      <NavLink to="/about" onClick={() => setOpen(false)}>About</NavLink>
      <NavLink to="/library" onClick={() => setOpen(false)}><Library size={17} />Library{papers.length > 0 && <span className="count">{papers.length}</span>}</NavLink>
      <GithubStar />
    </nav>
    <button className="icon-button mobile-menu" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} onClick={() => setOpen(!open)}><Menu size={22} /></button>
  </header>;
}

function SearchBox({ compact = false, initial = '' }: { compact?: boolean; initial?: string }) {
  const { searchProvider } = useContext(ProviderContext);
  const [query, setQuery] = useState(initial);
  const [debounced, setDebounced] = useState('');
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ key: '', index: -1 });
  const wrapper = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => { setQuery(initial); }, [initial]);
  useEffect(() => { setSelection({ key: '', index: -1 }); }, [searchProvider]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 400); return () => clearTimeout(timer); }, [query]);
  const request = searchProvider !== undefined && debounced === query.trim() && debounced.length >= 3 ? `/api/search?q=${encodeURIComponent(debounced)}&page=1&provider=${encodeURIComponent(searchProvider)}` : null;
  const { data, loading, error } = useApi<SearchResponse>(focused ? request : null);
  const suggestions = rankPapers(debounced, data?.results ?? []).slice(0, 5);
  const active = selection.key === request ? selection.index : -1;
  const setActive = (index: number) => setSelection({ key: request ?? '', index });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || searchProvider === undefined) { wrapper.current?.querySelector('input')?.focus(); return; }
    setFocused(false); setActive(-1);
    if (active >= 0 && suggestions[active]) navigate(graphUrl([suggestions[active].id]));
    else navigate(searchUrl(query.trim(), searchProvider));
  }
  return <div ref={wrapper} className={`search-box-wrap ${compact ? 'compact' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <form className="search-box" onSubmit={submit} role="search">
      <Search size={compact ? 19 : 21} aria-hidden="true" />
      <input aria-label="Search academic papers" aria-autocomplete="list" aria-controls={focused && suggestions.length ? (compact ? 'header-suggestions' : 'main-suggestions') : undefined} autoComplete="off" spellCheck={false} maxLength={200} value={query} onFocus={() => setFocused(true)} onChange={event => { setQuery(event.target.value); setActive(-1); }} placeholder={compact ? 'Search for a paper...' : 'Search by title, keywords or DOI'} onKeyDown={event => {
        if (event.key === 'Escape') { setFocused(false); setActive(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(active + 1, suggestions.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(-1, active - 1)); }
      }} />
      {query && <button type="button" className="clear-search" aria-label="Clear search" onClick={() => { setQuery(''); setActive(-1); }}><X size={16} /></button>}
      {!compact ? <button type="submit" className="primary search-submit" disabled={searchProvider === undefined}>Build a graph<ArrowRight size={17} /></button> : <button type="submit" className="compact-submit" aria-label="Submit search" disabled={searchProvider === undefined}><ArrowRight size={17} /></button>}
    </form>
    {focused && request && <div id={compact ? 'header-suggestions' : 'main-suggestions'} className="suggestions">
      {loading && <div className="suggestion-status" role="status">Searching...</div>}
      {error && <div className="suggestion-status" role="status">{error}</div>}
      {suggestions.map((paper, index) => <Link key={paper.id} className={active === index ? 'suggestion active' : 'suggestion'} to={graphUrl([paper.id])} onClick={() => setFocused(false)}><Network size={17} /><span><strong>{paper.title}</strong><small>{paper.authors[0] || 'Unknown author'} · {paper.year ?? 'Year unavailable'}</small></span><ArrowRight size={16} /></Link>)}
      <button className="all-suggestions" type="button" onClick={() => { setFocused(false); setActive(-1); navigate(searchUrl(query.trim(), searchProvider!)); }}>See all paper suggestions <ArrowRight size={16} /></button>
    </div>}
  </div>;
}

function DecorativeGraph({ side }: { side: 'left' | 'right' }) {
  const points = [[36, 40, 22], [136, 111, 15], [75, 179, 25], [211, 204, 12], [122, 256, 20], [267, 310, 30], [58, 337, 20], [220, 391, 25], [102, 433, 15], [271, 445, 29], [17, 250, 8], [159, 349, 9]];
  return <svg className={`decorative-graph ${side}`} viewBox="0 0 320 500" aria-hidden="true"><g stroke="#638083" strokeWidth=".6" opacity=".55">{points.flatMap((point, i) => points.slice(i + 1).filter((_, j) => (i + j) % 3 !== 0).map((other, j) => <line key={`${i}-${j}`} x1={point[0]} y1={point[1]} x2={other[0]} y2={other[1]} />))}</g>{points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={p[2]} fill={['#16585d', '#6c9699', '#c1d3d3', '#43888b'][i % 4]} opacity=".8" />)}</svg>;
}

const FEATURED = featuredPreviews as FeaturedPreview[];
// Each hint runs a real sample search, so readers see which inputs work.
const SEARCH_HINTS = [
  { icon: <span className="try-doi" aria-hidden="true">doi</span>, label: 'Paper DOI', query: '10.1002/asi.21525' },
  { icon: <FileText size={22} aria-hidden="true" />, label: 'arXiv', detail: 'Paper URL', query: 'https://arxiv.org/abs/1706.03762' },
  { icon: <Search size={22} aria-hidden="true" />, label: 'Paper title', query: 'DeepFruits: A Fruit Detection System Using Deep Neural Networks' },
  { icon: <Library size={22} aria-hidden="true" />, label: 'PubMed', detail: 'Paper URL', query: 'https://pubmed.ncbi.nlm.nih.gov/23287718/' },
  { icon: <Network size={22} aria-hidden="true" />, label: 'Keywords', query: 'science mapping' },
];

function Home() {
  const { searchProvider } = useContext(ProviderContext);
  return <main id="main">
    <section className="hero">
      <div className="hero-decor"><DecorativeGraph side="left" /><DecorativeGraph side="right" /></div>
      <div className="hero-content"><div className="eyebrow"><span className="status-dot" />LITERATURE DISCOVERY, OPEN TO EVERYONE</div>
        <h1>Explore academic papers<br />in a visual graph</h1>
        <p className="hero-subtitle">Start with one paper. Discover the research around it.</p>
        <SearchBox />
        <p className="search-hint">Free to use. No account or subscription.</p>
      </div>
    </section>
    <section className="try-section content-width" aria-labelledby="try-heading">
      <h2 id="try-heading">You can try:</h2>
      <ul className="try-list">{SEARCH_HINTS.map(hint => <li key={hint.label}><Link to={searchUrl(hint.query, searchProvider ?? 'openalex')} title={`Example: ${hint.query}`}>{hint.icon}<strong>{hint.label}</strong>{hint.detail && <span>{hint.detail}</span>}</Link></li>)}</ul>
    </section>
    <section className="examples-section content-width" aria-labelledby="examples-heading">
      <div className="section-top"><h2 id="examples-heading">Or start with one of our example graphs</h2></div>
      <div className="example-grid">{FEATURED.map(example => <Link className="example-card" key={example.id} to={graphUrl([example.id])}><GraphPreview preview={example} /><h3>{example.title} <span className="example-meta">({example.author}, {example.year})</span></h3></Link>)}</div>
    </section>
    <section className="use-cases content-width"><h2>A new perspective on your research</h2><div className="use-case-grid">
      <article><Network size={25} /><h3>Get a visual overview of a field</h3><p>Build a neighborhood around a paper. Similar papers cluster together, helping you see the foundations and directions of a research area.</p></article>
      <article><GitBranch size={25} /><h3>Find the work before and after</h3><p>Explore the references shared by your graph, then discover papers that build on many of those works.</p></article>
      <article><Bookmark size={25} /><h3>Build your bibliography</h3><p>Save interesting papers on your device and export their citations. Your library stays yours, without an account.</p></article>
    </div></section>
    <section className="open-strip content-width"><div><FlaskConical size={27} /><h2>Free, open source, and open to inspection.</h2></div><GithubStar /></section>
    <Footer />
  </main>;
}

function DataBadge({ meta }: { meta: DataMeta }) {
  const date = new Date(meta.fetchedAt);
  return <span className="data-badge" title={meta.warning ?? `Data fetched ${meta.fetchedAt}`}><span className="status-dot" />{meta.provider && `${meta.provider === 'semantic-scholar' ? 'Semantic Scholar' : 'OpenAlex'} · `}{meta.source === 'live' ? 'Live data' : meta.source === 'snapshot' ? 'Snapshot' : 'Cached data'}<span>· {Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</span></span>;
}

function ErrorState({ error }: { error: string }) {
  return <div className="error-state" role="alert"><Info size={26} /><h2>We couldn’t load this research</h2><p>{error}</p><Link className="primary" to="/">Try an example graph <ArrowRight size={17} /></Link></div>;
}

function Loading({ graph = false }: { graph?: boolean }) {
  return <div className={`loading-state ${graph ? 'graph-loading' : ''}`} role="status"><div className="loading-nodes"><i /><i /><i /></div><h2>{graph ? 'Finding connections...' : 'Searching the literature...'}</h2><p>{graph ? 'Collecting references and comparing papers. A new graph may take up to a minute.' : 'Looking for papers.'}</p></div>;
}

function SaveButton({ paper, small = false }: { paper: Paper; small?: boolean }) {
  const { papers, toggle } = useContext(LibraryContext);
  const saved = papers.some(p => p.id === paper.id);
  return <button className={`save-button ${saved ? 'saved' : ''}`} onClick={() => toggle(paper)} aria-label={`${saved ? 'Unsave' : 'Save'} ${paper.title}`} aria-pressed={saved}><Bookmark size={small ? 17 : 19} fill={saved ? 'currentColor' : 'none'} />{!small && (saved ? 'Saved' : 'Save')}</button>;
}

function PaperLinks({ paper, bare = false }: { paper: Paper; bare?: boolean }) {
  const pdf = safeUrl(paper.pdfUrl), doi = safeUrl(paper.doi?.startsWith('http') ? paper.doi : paper.doi ? `https://doi.org/${paper.doi}` : null);
  return <div className="paper-links">{!bare && <span className="open-in">Open in:</span>}{pdf && <a className="open-icon" href={pdf} target="_blank" rel="noreferrer" aria-label={`PDF for ${paper.title}`} title="PDF"><FileText size={15} /></a>}{doi && <a className="open-icon" href={doi} target="_blank" rel="noreferrer" aria-label={`DOI ${doiIdentifier(paper.doi!)}`} title="DOI"><span className="doi-badge">doi</span></a>}<a className="open-icon" href={providerRecordUrl(paper.id)} target="_blank" rel="noreferrer" aria-label={`Source record for ${paper.title}`} title="Source record"><Globe size={15} /></a><a className="open-icon" href={`https://scholar.google.com/scholar?q=${encodeURIComponent(paper.title)}`} target="_blank" rel="noreferrer" aria-label={`Google Scholar for ${paper.title}`} title="Google Scholar"><GraduationCap size={16} /></a></div>;
}

function PaperCard({ paper, children }: { paper: Paper; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <article className="paper-card"><div className="paper-card-top"><Link to={graphUrl([paper.id])}><h2>{paper.title}</h2></Link></div><p className="paper-authors">{authors(paper)}</p><p className="paper-publication">{paper.venue && `${paper.venue} `}{paper.year ?? 'Year unavailable'}{paper.venue ? '.' : ''}</p><p className="paper-stats">{exactNumber.format(paper.citations)} Citations, {paper.references.length} References{paper.openAccess && <span className="oa-label">Open access</span>}</p><div className="paper-card-bottom"><div className="paper-actions"><Link className="open-icon build-icon" to={graphUrl([paper.id])} aria-label="Build graph" title="Build graph"><Network size={16} /></Link><PaperLinks paper={paper} bare /></div><div className="paper-card-actions">{children}<SaveButton paper={paper} /></div></div>{paper.abstract && <div className="abstract-row"><p className={`paper-abstract ${expanded ? 'expanded' : ''}`}>{paper.abstract}</p><button className="show-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button></div>}</article>;
}

function SearchPage() {
  const [params] = useSearchParams();
  const { provider, searchProvider, error: providerError } = useContext(ProviderContext);
  const query = params.get('q') ?? '';
  const page = Math.max(1, Math.min(100, Number(params.get('page')) || 1));
  const { data, loading, error } = useApi<SearchResponse>(query && searchProvider !== undefined ? `/api/search?q=${encodeURIComponent(query)}&page=${page}&provider=${encodeURIComponent(searchProvider)}` : null);
  const source = data?.meta.provider ?? provider;
  const lastPage = Math.min(source === 'semantic-scholar' ? 50 : 100, Math.ceil((data?.total ?? 0) / 20));
  const results = rankPapers(query, data?.results ?? []);
  return <main id="main" className="search-page content-width"><Link className="back-link" to="/"><ArrowLeft size={16} />Back to discovery</Link><SearchBox initial={query} />{query && <p className="suggestions-note">Showing paper suggestions for “{query}”.</p>}<div className="search-result-heading"><h1>{query ? 'Choose a paper to build a graph:' : 'Search by title, keyword, or DOI'}</h1>{data && <DataBadge meta={data.meta} />}</div>{loading || (query && searchProvider === undefined && !providerError) ? <Loading /> : error || providerError ? <ErrorState error={error ?? providerError!} /> : data && <>
    <p className="result-count">{exactNumber.format(data.total)} results</p>{data.meta.warning && <div className="notice"><Info size={17} /><p>{data.meta.warning}</p></div>}
    {results.length ? results.map(paper => <PaperCard key={paper.id} paper={paper} />) : <div className="empty-state"><Search size={32} /><h2>No matching papers</h2><p>Try a shorter title, a DOI, or an example graph on the homepage. Offline search only includes bundled and previously cached papers.</p></div>}
    {data.total > data.perPage && <nav className="pagination" aria-label="Search result pages">{page > 1 ? <Link to={searchUrl(query, searchProvider!, page - 1)}><ChevronLeft size={16} />Previous</Link> : <span /> }<span>Page {page} of {lastPage}</span>{page * data.perPage < data.total && page < lastPage ? <Link to={searchUrl(query, searchProvider!, page + 1)}>Next<ChevronRight size={16} /></Link> : <span />}</nav>}
  </>}<Footer /></main>;
}

function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPapers(papers: Paper[], format: 'bib' | 'csv') {
  if (format === 'csv') {
    // Quoted CSV fields can still execute spreadsheet formulas; neutralize their prefixes.
    const cell = (value: string | number | null) => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    downloadFile([['Title', 'Authors', 'Year', 'Citations', 'DOI', 'Paper ID', 'Source'].map(cell).join(','), ...papers.map(p => [p.title, p.authors.join('; '), p.year, p.citations, p.doi, p.id, paperProvider(p.id) === 'semantic-scholar' ? s2Attribution : providerRecordUrl(p.id)].map(cell).join(','))].join('\r\n'), 'open-papers.csv', 'text/csv;charset=utf-8');
  } else {
    const escape = (value: string) => value.replace(/[\\{}]/g, ' ').replace(/[\r\n]+/g, ' ');
    downloadFile(papers.map(p => `@article{${p.id.replace(':', '')},\n  title = {${escape(p.title)}},\n  author = {${p.authors.map(escape).join(' and ')}},${p.year ? `\n  year = {${p.year}},` : ''}${p.venue ? `\n  journal = {${p.venue}},` : ''}${p.doi ? `\n  doi = {${escape(doiIdentifier(p.doi))}},` : ''}${paperProvider(p.id) === 'semantic-scholar' ? `\n  note = {${s2Attribution}},` : ''}\n  url = {${providerRecordUrl(p.id)}}\n}`).join('\n\n'), 'open-papers.bib', 'application/x-bibtex');
  }
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  return <dialog ref={ref} className="dialog" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={21} /></button></div>{children}</dialog>;
}

function Workspace() {
  const { ids = '', view = 'graph' } = useParams();
  const requestedOrigins = ids.split(',');
  const currentView = ['graph', 'list', 'prior', 'derivative'].includes(view) ? view : 'graph';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: quickData, loading, error } = useApi<GraphResponse>(`/api/graph?ids=${encodeURIComponent(ids)}${params.has('provider') ? `&provider=${encodeURIComponent(params.get('provider')!)}` : ''}`);
  const expansionEnabled = !quickData?.meta.fallback && requestedOrigins.every(id => paperProvider(id) === 'openalex');
  const expansion = useGraphJob(requestedOrigins, expansionEnabled);
  const data = quickData?.meta.fallback ? quickData : expansion.result ?? quickData;
  const graphOrigins = data?.origins ?? requestedOrigins;
  const fallback = data?.meta.fallback;
  const job = expansion.job;
  const [mobilePane, setMobilePane] = useState<'graph' | 'papers' | 'details'>('graph');
  const [dialog, setDialog] = useState<'filters' | 'export' | 'data' | 'expand' | 'share' | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { notify } = useContext(LibraryContext);
  useEffect(() => { setMobilePane('graph'); setHoveredId(null); }, [ids, view]);
  useEffect(() => { setDialog(null); }, [ids]);
  const all = data ? [...data.nodes, ...data.prior, ...data.derivative] : [];
  const requestedSelected = params.get('selected');
  const originIndex = fallback?.requestedOrigins.indexOf(requestedSelected ?? '') ?? -1;
  const selectedId = originIndex >= 0 ? fallback?.resolvedOrigins[originIndex] : requestedSelected;
  const selected = all.find(p => p.id === selectedId) ?? data?.nodes[0];
  const detailPaper = all.find(p => p.id === hoveredId) ?? selected;
  const keyword = params.get('keyword')?.toLowerCase() ?? '';
  const min = Number(params.get('from')) || 0, max = Number(params.get('to')) || 9999;
  const filter = (p: Paper) => (!keyword || paperMatchScore(keyword, p) > 0 || `${p.title} ${authors(p)}`.toLowerCase().includes(keyword)) && (!params.has('oa') || p.openAccess) && (!params.has('pdf') || Boolean(p.pdfUrl)) && (p.year === null ? min === 0 && max === 9999 : p.year >= min && p.year <= max);
  const filtered = data?.nodes.filter(p => p.isOrigin || filter(p)) ?? [];
  const filteredIds = new Set(filtered.map(p => p.id));
  const edges = data?.edges.filter(edge => filteredIds.has(edge.source) && filteredIds.has(edge.target)) ?? [];
  const filterCount = ['keyword', 'from', 'to', 'oa', 'pdf'].filter(key => params.has(key)).length;
  function select(id: string, detail = false) {
    const next = new URLSearchParams(params); next.set('selected', id); setParams(next, { replace: true });
    if (detail) setMobilePane('details');
  }
  function open(id: string) { navigate(graphUrl([id])); }
  const shareParams = new URLSearchParams(params);
  if (selected && requestedSelected) shareParams.set('selected', selected.id);
  if (graphOrigins.some(id => paperProvider(id) === 'semantic-scholar')) shareParams.delete('job');
  const shareUrl = data ? graphShareLink(window.location.origin, graphOrigins, currentView, shareParams) : '';
  return <main id="main" className="workspace">
    <div className="workspace-toolbar"><Link to="/" className="workspace-back" aria-label="Back to search"><ArrowLeft size={18} /></Link><h1 title={data?.nodes.filter(p => p.isOrigin).map(p => p.title).join(' + ')}>{data?.nodes.filter(p => p.isOrigin).map(p => p.title).join(' + ') || 'Research graph'}</h1><nav className="view-tabs" aria-label="Graph views">
      <Link className={currentView === 'graph' ? 'active' : ''} to={`${graphUrl(requestedOrigins)}?${params}`}><Network size={17} /><span>Graph</span></Link>
      <Link className={currentView === 'prior' ? 'active' : ''} to={`${graphUrl(requestedOrigins, 'prior')}?${params}`}><GitBranch size={17} /><span>Prior<span className="desktop-word"> works</span></span></Link>
      <Link className={currentView === 'derivative' ? 'active' : ''} to={`${graphUrl(requestedOrigins, 'derivative')}?${params}`}><Plus size={17} /><span>Derivative<span className="desktop-word"> works</span></span></Link>
      <Link className={currentView === 'list' ? 'active' : ''} to={`${graphUrl(requestedOrigins, 'list')}?${params}`}><List size={17} /><span>List<span className="desktop-word"> view</span></span></Link>
    </nav><div className="workspace-actions"><button className={filterCount ? 'active' : ''} onClick={() => setDialog('filters')} aria-label="Filter papers"><SlidersHorizontal size={18} /><span>Filters{filterCount ? ` (${filterCount})` : ''}</span></button><button className="graph-share-trigger" onClick={() => setDialog('share')} disabled={!data} aria-label="Share graph"><Share2 size={18} /><span>Share</span></button><button onClick={() => setDialog('export')} aria-label="Export graph"><Download size={18} /></button></div></div>
    {expansionEnabled && (expansion.available || expansion.id || expansion.creating || expansion.error) && <section className={`jobs-banner ${expansion.error || job?.state === 'failed' ? 'jobs-error' : ''}`} aria-label="Research expansion">
      <div className="jobs-content" role="status" aria-live="polite">
        <strong>{expansion.creating ? 'Starting research expansion...' : !expansion.watching ? 'Research updates hidden' : job ? ({ queued: 'Research expansion queued', running: job.phase === 'acquire' ? 'Acquiring research candidates' : job.phase === 'score' ? 'Scoring acquired candidates' : 'Publishing research graph', paused: 'Research expansion paused', completed: 'Research expansion complete', failed: 'Research expansion failed' }[job.state]) : expansion.id ? 'Resuming research expansion...' : 'Quick graph coverage'}</strong>
        {job ? <>
          <div className="jobs-counts"><span>{exactNumber.format(job.acquiredCount)} / {exactNumber.format(job.candidateBudget)} candidates acquired</span><span>{exactNumber.format(job.requestsUsed)} / {exactNumber.format(job.requestBudget)} request attempts reserved</span><span>{exactNumber.format(job.referenceCount)} / {exactNumber.format(job.referenceBudget)} reference entries</span></div>
          {!expansion.watching && <p>The durable job continues on the server. Reload this URL to resume updates.</p>}
          {job.state === 'paused' && <p>{job.nextRunAt ? <>Next server run no earlier than <time dateTime={job.nextRunAt}>{new Date(job.nextRunAt).toLocaleString()}</time>.</> : 'Waiting for the server to resume.'}</p>}
          {job.stopReason && <p>Acquisition stopped: {({ candidate_budget: 'candidate target reached', request_budget: 'request attempt limit reached', reference_budget: 'reference entry limit reached', frontier_exhausted: 'available acquisition tasks exhausted', invalid_origins: 'invalid origin papers', unknown_origin: 'origin paper not found', provider_rejected: 'data provider rejected the request', provider_unavailable: 'data provider unavailable', missing_origin_metadata: 'origin metadata missing', response_too_large: 'result exceeded the response size limit' } as Record<string, string>)[job.stopReason] ?? job.stopReason.replaceAll('_', ' ').slice(0, 200)}.</p>}
          {job.error && <p>{job.error.slice(0, 500)}</p>}
          {job.state === 'completed' && <p>Showing up to 40 papers from the acquired candidates, not an exhaustive literature survey.</p>}
          <progress aria-label="Candidates acquired" value={Math.min(job.acquiredCount, job.candidateBudget)} max={job.candidateBudget} />
        </> : !expansion.id && !expansion.creating && <p>Expand only when needed. The graph stays small while the server acquires more candidates.</p>}
        {expansion.error && <p>{expansion.error}</p>}
      </div>
      <div className="jobs-actions">
        {expansion.available && !expansion.id && <button className="secondary small" disabled={!quickData || expansion.creating} onClick={() => setDialog('expand')}>Expand research</button>}
        {expansion.id && (expansion.error || !expansion.watching) && <button className="secondary small" onClick={expansion.resume}>Resume updates</button>}
        {expansion.id && expansion.watching && job?.state !== 'completed' && job?.state !== 'failed' && <button className="text-button" title="Stops polling on this page only. The server job continues; keep this URL to resume." onClick={expansion.stopWatching}>Hide updates</button>}
        {(expansion.error || job?.state === 'failed') && <button className="text-button" onClick={expansion.forget}>Remove job from view</button>}
      </div>
    </section>}
    {loading && !data ? <Loading graph /> : error && !data ? <ErrorState error={error} /> : data && selected && detailPaper && <>
      {fallback && <section className="jobs-banner" aria-label="Graph data fallback">
        <div className="jobs-content" role="status" aria-live="polite"><strong>{fallback.reason === 'openalex_unavailable' ? 'Showing Semantic Scholar: OpenAlex was unavailable.' : 'Showing Semantic Scholar: OpenAlex had limited connection data.'}</strong><p>{fallback.comparison.openalex ? `OpenAlex: ${exactNumber.format(fallback.comparison.openalex.nodes)} ${fallback.comparison.openalex.nodes === 1 ? 'paper' : 'papers'}, ${exactNumber.format(fallback.comparison.openalex.edges)} ${fallback.comparison.openalex.edges === 1 ? 'edge' : 'edges'}.` : 'OpenAlex: unavailable.'} {`Semantic Scholar: ${exactNumber.format(fallback.comparison.semanticScholar.nodes)} ${fallback.comparison.semanticScholar.nodes === 1 ? 'paper' : 'papers'}, ${exactNumber.format(fallback.comparison.semanticScholar.edges)} ${fallback.comparison.semanticScholar.edges === 1 ? 'edge' : 'edges'}.`}</p></div>
        <div className="jobs-actions"><Link className="secondary small" to={shareUrl}>Open canonical graph <ArrowRight size={15} /></Link></div>
      </section>}
      {data.meta.warning?.includes('Data integrity warning:') && <button className="integrity-notice" onClick={() => setDialog('data')}><Info size={16} /><span>Source metadata conflicts with the seed publication. Review before citing.</span><span className="integrity-more">Details <ChevronRight size={14} /></span></button>}
      <div className="mobile-pane-tabs" role="group" aria-label="Workspace panels"><button className={mobilePane === 'graph' ? 'active' : ''} onClick={() => setMobilePane('graph')}>{currentView === 'graph' ? <Network size={17} /> : <List size={17} />}{currentView === 'graph' ? 'Graph' : 'Results'}</button><button className={mobilePane === 'papers' ? 'active' : ''} onClick={() => setMobilePane('papers')}><Library size={17} />Papers ({filtered.length})</button><button className={mobilePane === 'details' ? 'active' : ''} onClick={() => setMobilePane('details')}><Info size={17} />Details</button></div>
      <div className={`workspace-panels pane-${mobilePane} view-${currentView}`}>
        <aside className="paper-sidebar" aria-label="Graph papers"><div className="panel-heading"><h2>Graph papers</h2><span>{filtered.length}</span></div><div className="paper-sidebar-list">{filtered.map(paper => <button key={paper.id} className={`sidebar-paper ${selected.id === paper.id ? 'selected' : ''} ${paper.isOrigin ? 'origin-paper' : ''}`} onClick={() => select(paper.id, mobilePane === 'papers')}>
          {paper.isOrigin && <span className="origin-label"><span />Origin paper</span>}<strong>{paper.title}</strong><span className="sidebar-meta"><span>{paper.authors[0] || 'Unknown author'}{paper.authors.length > 1 ? ' et al.' : ''}</span><span>{paper.year ?? 'n.d.'}</span></span>{!paper.isOrigin && <span className="sidebar-score">{paper.similarity > 0 ? `${(paper.similarity * 100).toFixed(1)}% similarity` : data.nodes.some(origin => graphOrigins.includes(origin.id) && (paper.references.includes(origin.id) || origin.references.includes(paper.id))) ? 'Direct citation' : 'No measured origin similarity'}</span>}
        </button>)}</div></aside>
        <section className="graph-main" aria-label={currentView === 'graph' ? 'Similarity graph' : 'Related papers'}>
          {currentView === 'graph' ? <><div className="graph-summary"><span><strong>{filtered.length}</strong> papers <span className="summary-divider">/</span> {edges.length} connections</span><button onClick={() => setDialog('data')}><DataBadge meta={data.meta} /><Info size={14} /></button></div><GraphCanvas nodes={filtered} edges={edges} selectedId={selected.id} onHover={setHoveredId} onSelect={id => select(id)} onOpen={open} /><button className="mobile-selection" onClick={() => setMobilePane('details')}><span><small>Selected paper</small><strong>{selected.title}</strong></span><ChevronRight size={20} /></button></> : <PaperTable papers={(currentView === 'prior' ? data.prior : currentView === 'derivative' ? data.derivative : data.nodes).filter(p => p.isOrigin || filter(p))} selected={selected.id} onSelect={id => select(id, true)} kind={currentView} />}
        </section>
        <aside className="detail-sidebar" aria-label="Selected paper details"><PaperDetails paper={detailPaper} origins={graphOrigins} onAdd={() => { if (graphOrigins.some(id => paperProvider(id) !== paperProvider(detailPaper.id))) notify('Combined graph origins must use the same data source. Your origins are unchanged.'); else if (graphOrigins.length >= 3) notify('A graph can have up to 3 origin papers.'); else if (!graphOrigins.includes(detailPaper.id)) { const next = new URLSearchParams(shareParams); next.set('selected', detailPaper.id); next.delete('job'); const url = new URL(graphShareLink(window.location.origin, [...graphOrigins, detailPaper.id], 'graph', next)); navigate(url.pathname + url.search); } }} /></aside>
      </div>
      <div className="workspace-status"><span><span className="status-dot" />{data.meta.candidateCount} papers compared</span><button onClick={() => setDialog('data')}>Data & coverage <Info size={13} /></button></div>
    </>}
    {dialog === 'share' && data && <Dialog title="Share graph" onClose={() => setDialog(null)}><GraphShare key={shareUrl} url={shareUrl} title={data.nodes.filter(paper => paper.isOrigin).map(paper => paper.title).join(' + ')} expanded={shareParams.has('job')} /></Dialog>}
    {dialog === 'expand' && expansion.config && <Dialog title="Expand research" onClose={() => setDialog(null)}><form onSubmit={async event => { event.preventDefault(); const target = Number(new FormData(event.currentTarget).get('candidateBudget')); if (await expansion.start(target)) setDialog(null); }}>
      <p className="dialog-copy">Start a durable acquisition job for these origin papers. Your quick graph remains usable until a completed result is ready. The display stays at up to 40 papers.</p>
      <label className="field-label jobs-target">Candidate target<select name="candidateBudget" defaultValue={Math.min(5000, expansion.config.candidateBudget)} disabled={expansion.creating}>{[...new Set([1000, 5000, 10000, 50000, expansion.config.candidateBudget])].sort((a, b) => a - b).filter(target => target <= expansion.config!.candidateBudget).map(target => <option key={target} value={target}>{exactNumber.format(target)} candidates</option>)}</select></label>
      <p className="dialog-copy">Current server limit: {exactNumber.format(expansion.config.candidateBudget)} candidates and {exactNumber.format(expansion.config.requestBudget)} request attempts. Targets are limits, not promises of acquired or analyzed papers. Failed requests can use the request budget.</p>
      <p className="dialog-copy">Leaving this page or hiding updates stops polling, not the server job. Its ID is saved in this URL so you can reload or share it to resume.</p>
      {expansion.error && <p className="jobs-dialog-error" role="alert">{expansion.error}</p>}
      <div className="dialog-footer"><button className="secondary" type="button" onClick={() => setDialog(null)}>Not now</button><button className="primary" type="submit" disabled={expansion.creating || !expansion.available || Boolean(expansion.id)}>{expansion.creating ? 'Starting...' : 'Start expansion'}</button></div>
    </form></Dialog>}
    {dialog === 'filters' && <Dialog title="Filter graph papers" onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); const next = new URLSearchParams(params); for (const key of ['keyword', 'from', 'to', 'oa', 'pdf']) { next.delete(key); const value = form.get(key); if (typeof value === 'string' && value.trim()) next.set(key, value.trim()); } const from = Number(next.get('from')) || 0, to = Number(next.get('to')) || 9999; if (from > to) { notify('The start year must be before the end year.'); return; } setParams(next); setDialog(null); }}><p className="dialog-copy">Origins always stay visible. Filters change this view, not the underlying graph.</p><label className="field-label">Title or author<input name="keyword" defaultValue={params.get('keyword') ?? ''} placeholder="Filter by keyword..." maxLength={200} /></label><div className="year-fields"><label className="field-label">From year<input name="from" type="number" min="1000" max="2100" placeholder="Any" defaultValue={params.get('from') ?? ''} /></label><label className="field-label">To year<input name="to" type="number" min="1000" max="2100" placeholder="Any" defaultValue={params.get('to') ?? ''} /></label></div><label className="checkbox-label"><input name="oa" type="checkbox" value="1" defaultChecked={params.has('oa')} />Open access only</label><label className="checkbox-label"><input name="pdf" type="checkbox" value="1" defaultChecked={params.has('pdf')} />PDF available</label><div className="dialog-footer"><button type="button" className="secondary" onClick={() => { const next = new URLSearchParams(params); ['keyword', 'from', 'to', 'oa', 'pdf'].forEach(key => next.delete(key)); setParams(next); setDialog(null); }}>Clear filters</button><button className="primary" type="submit"><Filter size={16} />Apply filters</button></div></form></Dialog>}
    {dialog === 'export' && data && <Dialog title="Export your research" onClose={() => setDialog(null)}><p className="dialog-copy">Export all {data.nodes.length} graph papers. JSON includes the full graph, edge evidence, and data provenance. Current display filters do not affect exports. Source attribution is retained in exports where required.</p><div className="export-options"><button onClick={() => exportPapers(data.nodes, 'bib')}><Download size={20} /><span><strong>BibTeX bibliography</strong><small>For Zotero, LaTeX, and reference managers</small></span><ArrowRight size={17} /></button><button onClick={() => exportPapers(data.nodes, 'csv')}><Download size={20} /><span><strong>CSV paper list</strong><small>Titles, authors, years, citations, identifiers, and sources</small></span><ArrowRight size={17} /></button><button onClick={() => downloadFile(JSON.stringify(data, null, 2), 'open-papers-graph.json', 'application/json')}><Download size={20} /><span><strong>Full graph JSON</strong><small>Reusable nodes, edges, and scores</small></span><ArrowRight size={17} /></button></div></Dialog>}
    {dialog === 'data' && data && <Dialog title="Data & coverage" onClose={() => setDialog(null)}><DataBadge meta={data.meta} />{data.meta.warning && <p className="dialog-copy">{data.meta.warning}</p>}<h3>What this graph covers</h3><p className="dialog-copy">{data.meta.coverage}</p><p className="dialog-copy">{data.meta.candidateCount} papers were compared for this graph. A missing connection is not evidence that two papers are unrelated. Counts are a snapshot, not real-time measurements.</p></Dialog>}
  </main>;
}

function PaperDetails({ paper, origins, onAdd }: { paper: GraphPaper; origins: string[]; onAdd: () => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [paper.id]);
  return <div className="paper-details">{paper.isOrigin ? <span className="origin-label"><span />Origin paper</span> : <span className="detail-eyebrow">SELECTED PAPER</span>}<h2>{paper.title}</h2><p className="detail-authors">{expanded ? paper.authors.join(', ') : authors(paper)}{paper.authors.length > 3 && <button onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer authors' : `All ${paper.authors.length} authors`}</button>}</p><p className="paper-publication">{paper.year ?? 'Year unavailable'}{paper.venue && ` · ${paper.venue}`}</p><div className="detail-stats"><span><strong>{number.format(paper.citations)}</strong> citations</span><SaveButton paper={paper} /></div><PaperLinks paper={paper} />{!paper.isOrigin && <div className="detail-actions"><Link className="primary small" to={graphUrl([paper.id])}><Network size={16} />Open graph</Link><button className="secondary small" disabled={origins.length >= 3 || origins.includes(paper.id)} onClick={onAdd}><Plus size={16} />Add origin</button></div>}<div className="detail-divider" />{paper.openAccess && <div className="access-status"><span className="status-dot" />Open access</div>}<h3>Abstract</h3><p className="detail-abstract">{paper.abstract || 'An abstract is not available for this paper. Follow the links above to read more.'}</p><div className="evidence-card"><h3>Connection evidence</h3><dl><div><dt>Similarity to origin</dt><dd>{(paper.similarity * 100).toFixed(1)}%</dd></div><div><dt>Shared references</dt><dd>{paper.sharedReferences}</dd></div><div><dt>Sampled co-citations</dt><dd>{paper.coCitations}</dd></div><div><dt>References</dt><dd>{paper.references.length}</dd></div></dl><p>{paper.isOrigin ? 'The origin is the starting point, so its similarity is 100%.' : 'Scores use the strongest origin connection in multi-origin graphs.'}</p></div>{paper.topics.length > 0 && <div className="topic-tags">{paper.topics.slice(0, 4).map(topic => <span key={topic}>{topic}</span>)}</div>}<p className="paper-id">ID: {paper.id}</p></div>;
}

function PaperTable({ papers, selected, onSelect, kind }: { papers: GraphPaper[]; selected: string; onSelect: (id: string) => void; kind: string }) {
  const [sort, setSort] = useState({ key: kind === 'list' ? 'similarity' : 'graphConnections', desc: true });
  useEffect(() => { setSort({ key: kind === 'list' ? 'similarity' : 'graphConnections', desc: true }); }, [kind]);
  const sorted = [...papers].sort((a, b) => { const key = sort.key as keyof GraphPaper; const av = a[key], bv = b[key]; const comparison = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av ?? -1) - Number(bv ?? -1); return (sort.desc ? -comparison : comparison) || a.id.localeCompare(b.id); });
  const isList = kind === 'list';
  const headings = [{ key: 'title', label: 'Title' }, { key: 'year', label: 'Year' }, { key: 'citations', label: 'Citations' }, { key: isList ? 'similarity' : 'graphConnections', label: isList ? 'Similarity' : kind === 'prior' ? 'Graph citations' : 'Graph references' }];
  return <div className="related-view"><div className="related-heading"><span className="detail-eyebrow">{isList ? 'YOUR RESEARCH NEIGHBORHOOD' : kind === 'prior' ? 'THE FOUNDATIONS' : 'WHAT CAME NEXT'}</span><h2>{isList ? 'All graph papers' : kind === 'prior' ? 'Prior works' : 'Derivative works'}</h2><p>{isList ? 'Compare the papers in this similarity graph. Select a paper to read its details.' : kind === 'prior' ? 'Papers most commonly referenced by the works in your graph. A useful place to find foundational research.' : 'Papers that cite multiple works in your graph. Find follow-up studies, surveys, and research building on this neighborhood.'}</p><span className="result-count">{papers.length} papers · Rankings reflect this sampled graph</span></div><div className="table-scroll"><table className="paper-table"><thead><tr>{headings.map(h => <th key={h.key} aria-sort={sort.key === h.key ? sort.desc ? 'descending' : 'ascending' : 'none'}><button onClick={() => setSort({ key: h.key, desc: sort.key === h.key ? !sort.desc : true })}>{h.label}{sort.key === h.key && <ChevronDown size={13} className={!sort.desc ? 'ascending' : ''} />}</button></th>)}</tr></thead><tbody>{sorted.map(paper => <tr key={paper.id} className={paper.id === selected ? 'selected' : ''}><td><button className="table-title" onClick={() => onSelect(paper.id)}>{paper.isOrigin && <span className="origin-dot" />}{paper.title}</button><span className="table-authors">{authors(paper)}</span></td><td>{paper.year ?? 'n.d.'}</td><td>{number.format(paper.citations)}</td><td>{isList ? <span className="similarity-cell"><span style={{ width: `${paper.similarity * 100}%` }} />{(paper.similarity * 100).toFixed(1)}%</span> : paper.graphConnections}</td></tr>)}</tbody></table></div>{!papers.length && <div className="empty-state"><GitBranch size={30} /><h3>No papers meet these filters</h3><p>Clear the filters or explore a different origin. Sparse reference data can also limit this view.</p></div>}</div>;
}

function LibraryPage() {
  const { papers, toggle, notify } = useContext(LibraryContext);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const filtered = query.trim() ? papers.filter(p => paperMatchScore(query, p) > 0 || `${p.title} ${authors(p)}`.toLowerCase().includes(query.toLowerCase())) : papers;
  const current = selected.filter(id => papers.some(p => p.id === id));
  function select(paper: Paper) {
    if (current.includes(paper.id)) setSelected(current.filter(id => id !== paper.id));
    else if (current.some(id => paperProvider(id) !== paperProvider(paper.id))) notify('Combined graphs must use the same data source. Your selection is unchanged.');
    else if (current.length < 3) setSelected([...current, paper.id]);
    else notify('Select at most 3 origin papers.');
  }
  return <main id="main" className="library-page content-width"><div className="library-heading"><div className="library-title"><span className="eyebrow">YOUR RESEARCH, YOUR DEVICE</span><h1>Saved papers <span>{papers.length}</span></h1><p>A reading list without an account. Stored only in this browser.</p></div>{papers.length > 0 && <div className="library-export"><button className="secondary" onClick={() => exportPapers(papers, 'bib')}><Download size={16} />BibTeX</button><button className="secondary" onClick={() => exportPapers(papers, 'csv')}><Download size={16} />CSV</button></div>}</div>{papers.length > 0 ? <><div className="library-tools"><div className="library-filter"><Search size={18} /><input aria-label="Filter saved papers" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a saved paper..." /></div><span>Select up to 3 papers from the same data source for a combined graph</span>{current.length > 0 && <Link className="primary small" to={graphUrl(current)}><Network size={16} />Build combined graph ({current.length})</Link>}</div>{filtered.map(paper => <div className="library-row" key={paper.id}><label className="library-checkbox"><input aria-label={`Select ${paper.title} for combined graph`} type="checkbox" checked={current.includes(paper.id)} onChange={() => select(paper)} /></label><PaperCard paper={paper}><Link className="primary small" to={graphUrl([paper.id])}><Network size={16} />Open graph</Link><button className="icon-button" aria-label={`Remove ${paper.title}`} onClick={() => toggle(paper)}><Trash2 size={17} /></button></PaperCard></div>)}{!filtered.length && <div className="empty-state"><Search size={30} /><h2>No saved papers match</h2><button className="text-button" onClick={() => setQuery('')}>Clear search</button></div>}<div className="notice"><Info size={17} /><p>Combined graphs cannot mix papers from different data sources: cross-source identities have not been reconciled. Exports retain source attribution where required. This library does not sync between devices. Clearing browser data removes saved papers. Export your bibliography to keep a backup.</p></div></> : <div className="empty-state library-empty"><div className="empty-icon"><Bookmark size={35} /></div><h2>A home for your next discovery</h2><p>Save papers while exploring a graph or searching the literature. They’ll appear here, ready to read or export.</p><Link className="primary" to="/">Explore example graphs <ArrowRight size={17} /></Link></div>}<Footer /></main>;
}

function About() {
  return <main id="main" className="reading-page"><Link className="back-link" to="/"><ArrowLeft size={16} />Back to discovery</Link><span className="eyebrow">ABOUT OPEN PAPERS</span><h1>Research is connected.<br />Discovery should be open.</h1><p className="reading-lead">Open Papers is a free, open-source literature discovery tool. Start with a paper you know and explore the research around it as an interactive visual graph.</p>
    <section><h2>What can I do with it?</h2><p>Search for a paper by title, keyword, or DOI and build its graph: a neighborhood of related papers you can explore visually or as a sortable table. Combine up to three origin papers in one graph, filter by year, keyword, open access, or PDF availability, and save papers to a library on your device.</p></section>
    <section><h2>Read the work before and after</h2><p><strong>Prior works</strong> are papers referenced by multiple papers in your graph. <strong>Derivative works</strong> cite multiple graph papers. The tables show actual graph connection counts, not claims that a work is definitively foundational or a comprehensive survey.</p></section>
    <section><h2>Honest limitations</h2><p>Graphs are built from sampled data, not an exhaustive map of the literature, so they can miss recent or niche research. A missing connection does not mean two papers are unrelated.</p><p>Titles, abstracts, and reference lists can be incomplete, and a cached graph is not a live citation counter. Data comes from upstream sources and is not independently verified. Check the source publication before citing.</p></section>
    <section><h2>Where the data comes from</h2><p>Paper metadata comes from <a href="https://openalex.org" target="_blank" rel="noreferrer">OpenAlex</a>, an open catalog of scholarly works released under <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">CC0</a>. When Semantic Scholar search is enabled, its records are provided under the <a href="https://www.semanticscholar.org/product/api/license" target="_blank" rel="noreferrer">Semantic Scholar API License</a>. Use the Source record link on any paper to check its original entry.</p></section>
    <section><h2>Your library stays local</h2><p>No sign-in is required. Saved papers are stored in this browser's local storage, not on our server. Export as BibTeX or CSV to move your library elsewhere. There is no cross-device sync, user tracking, advertising, or paid tier.</p></section>
    <section><h2>Built to be inspected</h2><p>The application code is MIT licensed. Browse the <a href={repoUrl} target="_blank" rel="noreferrer">Open Papers source repository</a> to inspect the code, report issues, or self-host the application — and star the project if you find it useful.</p></section><Footer /></main>;
}

function Footer() {
  return <footer className="site-footer"><span>Open Papers · Independent & open source</span><div><Link to="/about">About</Link><a href={repoUrl} target="_blank" rel="noreferrer">GitHub <ExternalLink size={12} /></a><span>MIT licensed</span></div></footer>;
}
