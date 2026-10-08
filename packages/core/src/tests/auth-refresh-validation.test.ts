import { expect, test } from 'bun:test'
import {
  ClaudeOAuthMalformedResponseError,
  refreshClaudeOAuthToken,
} from '../auth.ts'

const respond = (body: unknown, status = 200) =>
  Object.assign(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
    { preconnect: fetch.preconnect },
  )

test('a complete token response is returned and a missing refresh_token keeps the input', async () => {
  const result = await refreshClaudeOAuthToken({
    refreshToken: 'old-refresh',
    fetchImpl: respond({ access_token: 'a', expires_in: 60 }),
    now: () => 1_000,
    maxRetries: 0,
  })
  expect(result.access).toBe('a')
  expect(result.refresh).toBe('old-refresh')
  expect(result.expires).toBe(61_000)
})

test.each([
  ['empty access', { access_token: '', expires_in: 60 }],
  ['non-string access', { access_token: 5, expires_in: 60 }],
  ['missing access', { expires_in: 60 }],
  ['missing expires_in', { access_token: 'a' }],
  ['string expires_in', { access_token: 'a', expires_in: '60' }],
  ['zero expires_in', { access_token: 'a', expires_in: 0 }],
  ['negative expires_in', { access_token: 'a', expires_in: -1 }],
  [
    'null expires_in (non-finite serializes to null)',
    { access_token: 'a', expires_in: Number.POSITIVE_INFINITY },
  ],
  [
    'empty refresh_token',
    { access_token: 'a', expires_in: 60, refresh_token: '' },
  ],
  [
    'non-string refresh_token',
    { access_token: 'a', expires_in: 60, refresh_token: 7 },
  ],
  ['null body', null],
])('malformed 2xx (%s) is rejected and never retried', async (_name, body) => {
  let calls = 0
  const fetchImpl = Object.assign(
    async () => {
      calls++
      return new Response(JSON.stringify(body), { status: 200 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(
    refreshClaudeOAuthToken({
      refreshToken: 'r',
      fetchImpl,
      maxRetries: 2,
      baseDelayMs: 0,
    }),
  ).rejects.toBeInstanceOf(ClaudeOAuthMalformedResponseError)
  expect(calls).toBe(1)
})

test('an aborted signal is passed to fetch and not retried', async () => {
  let calls = 0
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      calls++
      init?.signal?.throwIfAborted()
      return new Response('{}')
    },
    { preconnect: fetch.preconnect },
  )
  await expect(
    refreshClaudeOAuthToken({
      refreshToken: 'r',
      fetchImpl,
      maxRetries: 2,
      baseDelayMs: 0,
      signal: AbortSignal.abort(new Error('timeout')),
    }),
  ).rejects.toThrow()
  expect(calls).toBe(1)
})
