import test from 'node:test';
import assert from 'node:assert/strict';
import { graphShareLink } from '../shared/share-link.ts';

test('share links preserve graph state and omit tracking, credentials and unrelated parameters', () => {
  const params = new URLSearchParams('selected=W2&keyword=neural+networks&from=2017&to=2025&oa=1&pdf=1&job=123e4567-e89b-12d3-a456-426614174000&utm_source=share_popup&token=private&provider=unknown');
  const url = new URL(graphShareLink('https://openpapers.si', ['W1', 'W2'], 'prior', params));
  assert.equal(url.pathname, '/graph/W1,W2/prior');
  assert.equal(url.searchParams.get('keyword'), 'neural networks');
  for (const key of ['selected', 'from', 'to', 'oa', 'pdf', 'job']) assert.equal(url.searchParams.get(key), params.get(key));
  for (const key of ['utm_source', 'token', 'provider']) assert.equal(url.searchParams.has(key), false);
});

test('links validate graph IDs, preserve source IDs and reject invalid optional IDs', () => {
  const s2 = `S2:${'a'.repeat(40)}`;
  const url = new URL(graphShareLink('http://localhost:5173', [s2], 'invalid', new URLSearchParams('selected=bad&job=bad&keyword=')));
  assert.equal(url.pathname, `/graph/${s2}/graph`);
  assert.equal(url.search, '');
  for (const ids of [[], ['W1', 'W1'], ['bad'], ['W1', 'W2', 'W3', 'W4']]) assert.throws(() => graphShareLink('https://openpapers.si', ids, 'graph', new URLSearchParams()));
});
