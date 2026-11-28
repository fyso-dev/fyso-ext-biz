import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';

let routes;
let unexpected;

export function route(method, url, body, status = 200) {
  routes.set(`${method} ${url}`, () => new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  ));
}

export const fakeFetch = vi.fn(async (url, init) => {
  const key = `${init?.method ?? 'GET'} ${url}`;
  const respond = routes.get(key);
  if (respond) return respond();
  unexpected.push(key);
  throw new Error(`Unexpected fetch: ${key}`);
});

beforeEach(() => {
  routes = new Map();
  unexpected = [];
  sessionStorage.clear();
  fakeFetch.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});
