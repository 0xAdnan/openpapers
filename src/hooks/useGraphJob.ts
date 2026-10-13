import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { GraphJobSchema, type GraphJob } from '../../shared/graph-jobs';

const ConfigSchema = z.object({
  available: z.boolean(), candidateBudget: z.number().int().min(40).max(50000),
  maxCandidateBudget: z.literal(50000), requestBudget: z.number().int().min(1).max(1500),
  persistence: z.enum(['postgres', 'none']),
}).refine(config => !config.available || config.persistence === 'postgres');
const MAX_BYTES = 4 * 1024 * 1024;

class JobRequestError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function requestJson(url: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new JobRequestError('The graph job service returned an empty response.');
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new JobRequestError('The graph job response exceeded the 4 MiB limit. Try a smaller target.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new JobRequestError(`Graph job service returned a non-JSON response (HTTP ${response.status}). Check the deployment or try again later.`, response.status); }
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error.slice(0, 500) : 'Graph job request failed. Try again later.';
    throw new JobRequestError(`${message} (HTTP ${response.status})`, response.status);
  }
  return data;
}

function parseJob(body: unknown, key: string, id?: string): GraphJob {
  const parsed = GraphJobSchema.safeParse(body);
  if (!parsed.success) throw new JobRequestError('The server returned invalid graph job data. The quick graph is unchanged.');
  const job = parsed.data;
  if ((id && job.id !== id) || new Set(job.origins).size !== job.origins.length || job.requestsUsed > 1500 ||
    [job.createdAt, job.updatedAt, ...(job.nextRunAt ? [job.nextRunAt] : [])].some(date => !Number.isFinite(Date.parse(date)))) {
    throw new JobRequestError('The server returned inconsistent graph job data. The quick graph is unchanged.');
  }
  if ([...job.origins].sort().join(',') !== key || (job.result && [...job.result.origins].sort().join(',') !== key)) {
    throw new JobRequestError('This research job belongs to different origin papers. Its result was not applied.', 409);
  }
  if (job.state === 'completed' && !job.result) throw new JobRequestError('The completed research job has no result. The quick graph is unchanged.');
  return job;
}

type JobState = { key: string; id: string | null; job?: GraphJob; error?: string; creating?: boolean };

export default function useGraphJob(origins: string[]) {
  const key = [...origins].sort().join(',');
  const [params, setParams] = useSearchParams();
  const id = params.get('job');
  const [config, setConfig] = useState<z.infer<typeof ConfigSchema>>();
  const configRequest = useRef<Promise<z.infer<typeof ConfigSchema>> | null>(null);
  const [state, setState] = useState<JobState>({ key, id });
  const accepted = useRef<JobState>({ key, id });
  const submission = useRef<AbortController | null>(null);
  const previousRoute = useRef({ key, id });
  const [watching, setWatching] = useState(true);
  const [retry, setRetry] = useState(0);
  const current = state.key === key && state.id === id ? state : { key, id };
  const available = Boolean(config?.available && origins.length >= 1 && origins.length <= 3 && new Set(origins).size === origins.length && origins.every(origin => /^W[1-9]\d{0,14}$/.test(origin)));

  const updateId = useEffectEvent((nextId: string | null) => {
    const next = new URLSearchParams(window.location.search);
    if (nextId) next.set('job', nextId); else next.delete('job');
    setParams(next, { replace: true });
  });

  useEffect(() => {
    let active = true;
    configRequest.current ??= requestJson('/api/graph-jobs/config', new AbortController().signal).then(body => ConfigSchema.parse(body));
    configRequest.current.then(value => { if (active) setConfig(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setWatching(true);
    return () => { submission.current?.abort(); submission.current = null; };
  }, [key, id]);

  useEffect(() => {
    const carriedJob = previousRoute.current.key !== key && previousRoute.current.id === id;
    previousRoute.current = { key, id };
    if (carriedJob && id) { accepted.current = { key, id: null }; updateId(null); return; }
    if (!id || !watching) return;
    if (!GraphJobSchema.shape.id.safeParse(id).success) {
      setState({ key, id, error: 'Invalid research job link. Remove the job from this view and try again.' });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const seed = accepted.current.key === key && accepted.current.id === id ? accepted.current.job : undefined;
    const delay = (job?: GraphJob) => job?.state === 'paused' && job.nextRunAt ? Math.min(30000, Math.max(4000, Date.parse(job.nextRunAt) - Date.now())) : 4000;
    async function poll() {
      try {
        const job = parseJob(await requestJson(`/api/graph-jobs/${id}`, controller.signal), key, id!);
        if (controller.signal.aborted) return;
        accepted.current = { key, id, job };
        setState(accepted.current);
        failures = 0;
        if (job.state !== 'completed' && job.state !== 'failed') timer = setTimeout(poll, delay(job));
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof JobRequestError ? error.message : 'Could not reach the graph job service. Updates will retry; the server job is unaffected.';
        const mismatch = error instanceof JobRequestError && error.status === 409;
        setState(previous => ({ key, id: mismatch ? null : id, job: !mismatch && previous.key === key && previous.id === id ? previous.job : undefined, error: message }));
        if (mismatch) { accepted.current = { key, id: null }; updateId(null); }
        else if (!(error instanceof JobRequestError) || error.status >= 500 || error.status === 429) timer = setTimeout(poll, Math.min(30000, 4000 * 2 ** failures++));
      }
    }
    if (seed && retry === 0) {
      setState({ key, id, job: seed });
      if (seed.state !== 'completed' && seed.state !== 'failed') timer = setTimeout(poll, delay(seed));
    } else void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, id, watching, retry]);

  async function start(candidateBudget: number) {
    if (!available || !config || id || submission.current) return false;
    if (!Number.isInteger(candidateBudget) || candidateBudget < 40 || candidateBudget > config.candidateBudget) return false;
    const controller = new AbortController();
    submission.current = controller;
    setState({ key, id: null, creating: true });
    try {
      const job = parseJob(await requestJson('/api/graph-jobs', controller.signal, { origins: key.split(','), candidateBudget }), key);
      if (controller.signal.aborted) return false;
      accepted.current = { key, id: job.id, job };
      setState(accepted.current);
      const next = new URLSearchParams(window.location.search);
      next.set('job', job.id);
      setParams(next, { replace: true });
      setRetry(0);
      setWatching(true);
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setState({ key, id: null, error: error instanceof JobRequestError ? error.message : 'Could not confirm creation of the research job. Check your connection before trying again.' });
      return false;
    } finally { if (submission.current === controller) submission.current = null; }
  }

  function forget() {
    submission.current?.abort();
    accepted.current = { key, id: null };
    setState({ key, id: null });
    const next = new URLSearchParams(window.location.search); next.delete('job');
    setParams(next, { replace: true });
  }

  return {
    config, available, id, job: current.job, error: current.error, creating: Boolean(current.creating), watching,
    result: current.job?.state === 'completed' ? current.job.result : null,
    start, forget, stopWatching: () => setWatching(false),
    resume: () => { setWatching(true); setRetry(value => value + 1); },
  };
}
