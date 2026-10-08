import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { saveAccounts, tokenFingerprint } from '@cortexkit/anthropic-auth-core'
import { getRpcDir } from '../rpc/rpc-dir'
import type { V2Context } from '../v2/server'

// Host-like refresh evidence. Every scenario runs against both the TypeScript
// source and the built entry (`packages/opencode/server.js` -> dist/v2) so the
// shipped artifact is held to the same contract. All network traffic is a fake
// fetch; credentials are synthetic and live only in an in-memory store.

type Server = {
  setup: (context: V2Context) => Promise<() => Promise<void>>
}
type Plugin = (input: unknown) => Promise<any>
const plugins: Record<string, () => Promise<Plugin>> = {
  src: async () => (await import('../index')).AnthropicAuthPlugin as Plugin,
  'built server.js': async () =>
    (await import(resolve(import.meta.dir, '../../dist/index.js')))
      .AnthropicAuthPlugin as Plugin,
}
const rpcFiles = () => {
  const dir = getRpcDir(process.cwd())
  return existsSync(dir) ? readdirSync(dir) : []
}

const targets: Array<[string, () => Promise<Server>]> = [
  ['src', () => import('../v2/server') as Promise<Server>],
  [
    'built server.js',
    () =>
      import(resolve(import.meta.dir, '../../server.js')) as Promise<Server>,
  ],
]

const HOST_WINDOW_MS = 5 * 60_000
const OWNERS = Symbol.for('cortexkit.anthropic-auth.host-refresh-owners')
const OWNED = Symbol.for('cortexkit.anthropic-auth.host-owned')
const owners = () => (globalThis as any)[OWNERS]

type Cred = {
  type: 'oauth'
  methodID: string
  access: string
  refresh: string
  expires: number
}

/** In-memory host: stores one credential, refreshes through the registered method. */
function createHost(initial: Cred) {
  let stored = initial
  const methods: any[] = []
  const hooks: Array<{ name: string; callback: any }> = []
  const registration = () => ({ dispose: async () => {} })
  const context: V2Context = {
    location: { directory: process.cwd() },
    integration: {
      transform: async (cb) => {
        cb({ method: { update: (reg) => methods.push(reg) } })
        return registration()
      },
      connection: {
        active: async () => ({ id: 'conn' }),
        resolve: async () => ({ ...stored }) as never,
      },
    },
    model: {
      transform: async (cb) => {
        cb({ list: () => [], update: () => {} })
        return registration()
      },
    },
    command: {
      transform: async (cb) => {
        cb({ add: () => {} })
        return registration()
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.push({ name, callback })
        return registration()
      },
      synthetic: async () => {},
    },
  }
  return {
    context,
    methods,
    hooks,
    stored: () => stored,
    persist: (next: Cred) => {
      stored = next
    },
    /** What the host does when the resolved credential is expired. */
    async resolveRefreshing(methodID = stored.methodID) {
      if (stored.expires - Date.now() > HOST_WINDOW_MS) return stored
      const method = methods.find((m) => m.method.id === methodID)
      const next = (await method.refresh(stored)) as Cred
      stored = next
      return stored
    },
  }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  const leakedOwners = owners()
  delete (globalThis as any)[OWNERS]
  delete (globalThis as any)[OWNED]
  expect(leakedOwners).toBeUndefined()
  delete process.env.OPENCODE_ANTHROPIC_AUTH_HOST_REFRESH
})

function fakeFetch(opts: {
  token?: (body: string, n: number) => Response | Promise<Response>
  upstream?: (url: string, init?: RequestInit) => Response
}) {
  const tokenBodies: string[] = []
  const upstreamAuth: string[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/oauth/token')) {
      tokenBodies.push(String(init?.body))
      return opts.token
        ? opts.token(String(init?.body), tokenBodies.length)
        : new Response('{}', { status: 500 })
    }
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
    if (url.includes('api.anthropic.com/v1/messages')) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      upstreamAuth.push(headers.get('authorization') ?? '')
    }
    return (
      opts.upstream?.(url, init) ??
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  }) as typeof fetch
  return { tokenBodies, upstreamAuth }
}

const seedStickyStorage = async (access: string) => {
  const checkedAt = Date.now()
  const window = { usedPercent: 10, remainingPercent: 90, checkedAt }
  await saveAccounts({
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    },
    accounts: [],
    routing: { mode: 'sticky-balanced' },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 1, seven_day: 1 },
      failClosedOnUnknownQuota: true,
      mainQuota: { checkedAt, five_hour: window, seven_day: window },
      mainQuotaCheckedAt: checkedAt,
      mainQuotaToken: tokenFingerprint(access),
    },
  } as never)
}

const authFailure = () =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid bearer token' },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )

const tokenOk = (access: string, refresh: string) =>
  new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      expires_in: 28800,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const expired = (methodID: string, refresh: string): Cred => ({
  type: 'oauth',
  methodID,
  access: 'old-access',
  refresh,
  expires: 1,
})

describe.each(targets)('V2 host refresh (%s)', (_name, load) => {
  test('registers both claude-max and oauth methods with refresh', async () => {
    const host = createHost(expired('claude-max', 'reg-refresh'))
    const cleanup = await (await load()).setup(host.context)
    try {
      const ids = host.methods
        .filter((m) => m.method.type === 'oauth')
        .map((m) => m.method.id)
        .sort()
      expect(ids).toEqual(['claude-max', 'oauth'])
      for (const m of host.methods) {
        expect(m.integrationID).toBe('anthropic')
        expect(typeof m.authorize).toBe('function')
        expect(typeof m.refresh).toBe('function')
      }
    } finally {
      await cleanup()
    }
  })

  for (const methodID of ['claude-max', 'oauth']) {
    test(`expired ${methodID} credential: refresh once, persist pair, second resolve reuses`, async () => {
      const refresh = `host-${_name}-${methodID}-r0`
      const host = createHost(expired(methodID, refresh))
      const cleanup = await (await load()).setup(host.context)
      const fake = fakeFetch({
        token: () => tokenOk(`${methodID}-a1`, `${methodID}-r1`),
      })
      try {
        const first = await host.resolveRefreshing()
        expect(first.access).toBe(`${methodID}-a1`)
        expect(first.refresh).toBe(`${methodID}-r1`)
        expect(first.methodID).toBe(methodID)
        expect(first.expires).toBeGreaterThan(Date.now())
        const second = await host.resolveRefreshing()
        expect(second).toEqual(first)
        expect(fake.tokenBodies).toHaveLength(1)
        expect(fake.tokenBodies[0]).toContain(refresh)
      } finally {
        await cleanup()
      }
    })
  }

  test('concurrent refresh across separate setup contexts exchanges once', async () => {
    const refresh = `shared-${_name}-r0`
    const a = createHost(expired('claude-max', refresh))
    const b = createHost(expired('claude-max', refresh))
    const { setup } = await load()
    const cleanupA = await setup(a.context)
    const cleanupB = await setup(b.context)
    const fake = fakeFetch({
      token: async () => {
        await new Promise((r) => setTimeout(r, 25))
        return tokenOk('shared-a1', 'shared-r1')
      },
    })
    try {
      const [x, y] = await Promise.all([
        a.resolveRefreshing(),
        b.resolveRefreshing(),
      ])
      expect(fake.tokenBodies).toHaveLength(1)
      expect(x).toEqual(y)
      expect(x.refresh).toBe('shared-r1')
    } finally {
      await cleanupA()
      await cleanupB()
    }
  })

  test('failed exchange is not presented again, even from a new context', async () => {
    const refresh = `fail-${_name}-r0`
    const a = createHost(expired('claude-max', refresh))
    const b = createHost(expired('oauth', refresh))
    const { setup } = await load()
    const cleanupA = await setup(a.context)
    const cleanupB = await setup(b.context)
    const fake = fakeFetch({ token: () => new Response('no', { status: 500 }) })
    try {
      await expect(a.resolveRefreshing()).rejects.toThrow()
      await expect(a.resolveRefreshing()).rejects.toThrow()
      await expect(b.resolveRefreshing()).rejects.toThrow()
      expect(fake.tokenBodies).toHaveLength(1)
    } finally {
      await cleanupA()
      await cleanupB()
    }
  })

  test('V1 request path waits for host refresh instead of exchanging; rotated token reaches the next bridge request', async () => {
    const refresh = `v1-${_name}-r0`
    const host = createHost(expired('claude-max', refresh))
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({ token: () => tokenOk('v1-a1', 'v1-r1') })
    try {
      expect(owners()).toBe(1)
      expect(process.env.OPENCODE_ANTHROPIC_AUTH_HOST_REFRESH).toBeUndefined()
      const http = host.hooks.find((h) => h.name === 'http.request')!
      const send = async () => {
        const event = {
          request: new Request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer stale',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          }),
        }
        await http.callback(event)
        return fetch(event.request)
      }
      // Request arrives while the credential is expired; only the host rotates.
      const inflight = send()
      await new Promise((r) => setTimeout(r, 400))
      expect(fake.tokenBodies).toHaveLength(0) // V1 path did not exchange
      await host.resolveRefreshing() // host performs the single exchange
      const response = await inflight
      expect(response.status).toBe(200)
      expect(fake.tokenBodies).toHaveLength(1)
      expect(fake.upstreamAuth.at(-1)).toBe('Bearer v1-a1')
      // Next request uses the rotated pair without any further exchange.
      const next = await send()
      expect(next.status).toBe(200)
      expect(fake.tokenBodies).toHaveLength(1)
      expect(fake.upstreamAuth.at(-1)).toBe('Bearer v1-a1')
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('host-like resolve refreshes a credential expiring within 5 minutes', async () => {
    const refresh = `window-${_name}-r0`
    const host = createHost({
      ...expired('claude-max', refresh),
      access: 'near',
      expires: Date.now() + 4 * 60_000,
    })
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({ token: () => tokenOk('window-a1', 'window-r1') })
    try {
      expect((await host.resolveRefreshing()).access).toBe('window-a1')
      expect(fake.tokenBodies).toHaveLength(1)
      const far = createHost({
        ...expired('claude-max', refresh),
        expires: Date.now() + 6 * 60_000,
      })
      expect((await far.resolveRefreshing()).access).toBe('old-access')
      expect(fake.tokenBodies).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  test('multiple setup locations share ownership and release it in any order', async () => {
    const { setup } = await load()
    const a = createHost(expired('claude-max', `own-${_name}-a`))
    const b = createHost(expired('claude-max', `own-${_name}-b`))
    const cleanupA = await setup(a.context)
    const cleanupB = await setup(b.context)
    expect(owners()).toBe(2)
    await cleanupA()
    await cleanupA()
    expect(owners()).toBe(1)
    await cleanupB()
    expect(owners()).toBeUndefined()
  })

  test('a consumed refresh token stays blocked after the grace window; unchanged refresh tokens do not', async () => {
    const refresh = `grace-${_name}-r0`
    const same = `grace-${_name}-same`
    const host = createHost(expired('claude-max', refresh))
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({
      token: (body) =>
        body.includes(same)
          ? tokenOk('same-a', same)
          : tokenOk('grace-a1', 'grace-r1'),
    })
    const realNow = Date.now()
    const now = spyOn(Date, 'now')
    try {
      now.mockReturnValue(realNow)
      await host.resolveRefreshing()
      const sameMethod = host.methods.find((m) => m.method.id === 'claude-max')
      await sameMethod.refresh(expired('claude-max', same))
      expect(fake.tokenBodies).toHaveLength(2)
      now.mockReturnValue(realNow + 61_000)
      const stale = host.methods.find((m) => m.method.id === 'claude-max')
      await expect(
        stale.refresh(expired('claude-max', refresh)),
      ).rejects.toThrow(/already exchanged/)
      expect(fake.tokenBodies).toHaveLength(2)
      await sameMethod.refresh(expired('claude-max', same))
      expect(fake.tokenBodies).toHaveLength(3)
    } finally {
      now.mockRestore()
      await cleanup()
    }
  })

  test('exchange timeout aborts via signal, is not retried, and blocks re-presentation', async () => {
    const refresh = `timeout-${_name}-r0`
    const host = createHost(expired('claude-max', refresh))
    const cleanup = await (await load()).setup(host.context)
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new Error('exchange timed out')),
    )
    let calls = 0
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls += 1
      if (!init?.signal) throw new Error('missing signal')
      init.signal.throwIfAborted()
      return tokenOk('never', 'never')
    }) as typeof fetch
    try {
      await expect(host.resolveRefreshing()).rejects.toThrow()
      await expect(host.resolveRefreshing()).rejects.toThrow()
      expect(calls).toBe(1)
      expect(timeout).toHaveBeenCalledWith(30_000)
    } finally {
      timeout.mockRestore()
      await cleanup()
    }
  })

  test('cleanup disposes V1 resources first, keeps the host-owned marker, and an orphan V1 never exchanges', async () => {
    const refresh = `zombie-${_name}-r0`
    const host = createHost({
      ...expired('claude-max', refresh),
      access: 'near',
      expires: Date.now() + 60_000,
    })
    const { setup } = await load()
    const fake = fakeFetch({ token: () => tokenOk('z-a1', 'z-r1') })
    const cleanup = await setup(host.context)
    expect(rpcFiles().length).toBeGreaterThan(0)
    expect(owners()).toBe(1)
    await cleanup()
    await cleanup()
    expect(rpcFiles()).toEqual([])
    expect(owners()).toBeUndefined()
    expect((globalThis as any)[OWNED]).toBe(true)

    const createPlugin = await plugins[_name]?.()
    const orphan = await createPlugin?.({
      client: { auth: { set: async () => {} } },
      directory: process.cwd(),
    })
    const loaded = await orphan.auth.loader(
      async () => ({
        type: 'oauth',
        access: 'near',
        refresh,
        expires: Date.now() - 1_000,
      }),
      { models: {} },
    )
    const pending = loaded.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    pending.catch(() => {})
    const outcome = await Promise.race([
      pending.then((r: Response) => `settled:${r.status}`),
      pending.catch((e: Error) => `rejected:${e.message}`),
      new Promise((r) => setTimeout(() => r('waiting'), 1_000)),
    ])
    expect(outcome).toBe('waiting')
    expect(fake.tokenBodies).toHaveLength(0)
    await orphan.dispose?.()
  }, 20_000)

  test('a late caller within the grace window gets the cached pair without a second exchange', async () => {
    const refresh = `late-${_name}-r0`
    const host = createHost(expired('claude-max', refresh))
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({ token: () => tokenOk('late-a1', 'late-r1') })
    const realNow = Date.now()
    const now = spyOn(Date, 'now')
    try {
      now.mockReturnValue(realNow)
      const method = host.methods.find((m) => m.method.id === 'claude-max')
      const first = await method.refresh(expired('claude-max', refresh))
      now.mockReturnValue(realNow + 59_000)
      const late = await method.refresh(expired('claude-max', refresh))
      expect(late).toEqual(first)
      expect(fake.tokenBodies).toHaveLength(1)
    } finally {
      now.mockRestore()
      await cleanup()
    }
  })

  describe('failure classification', () => {
    const run = async (
      tag: string,
      token: (n: number) => Response | Promise<Response>,
      steps: Array<{ advanceMs: number; expect: 'throws' | 'ok' | 'blocked' }>,
    ) => {
      const refresh = `cls-${_name}-${tag}`
      const host = createHost(expired('claude-max', refresh))
      const cleanup = await (await load()).setup(host.context)
      const fake = fakeFetch({ token: (_b, n) => token(n) })
      const realNow = Date.now()
      const now = spyOn(Date, 'now')
      const exchanges: number[] = []
      try {
        const method = host.methods.find((m) => m.method.id === 'claude-max')
        for (const step of steps) {
          now.mockReturnValue(realNow + step.advanceMs)
          const before = fake.tokenBodies.length
          const attempt = method.refresh(expired('claude-max', refresh))
          if (step.expect === 'ok') await attempt
          else await expect(attempt).rejects.toThrow()
          exchanges.push(fake.tokenBodies.length - before)
        }
      } finally {
        now.mockRestore()
        await cleanup()
      }
      return exchanges
    }
    const status = (
      code: number,
      headers: Record<string, string> = {},
      body = 'x',
    ) => new Response(body, { status: code, headers })

    test('429 honors Retry-After, then retries after the cooldown', async () => {
      const exchanges = await run(
        '429a',
        (n) =>
          n === 1 ? status(429, { 'retry-after': '120' }) : tokenOk('a', 'r'),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 119_000, expect: 'throws' },
          { advanceMs: 121_000, expect: 'ok' },
        ],
      )
      expect(exchanges).toEqual([1, 0, 1])
    })

    test('429 without Retry-After uses a 60s fallback and is not permanent', async () => {
      const exchanges = await run(
        '429b',
        (n) => (n === 1 ? status(429) : tokenOk('a', 'r')),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 59_000, expect: 'throws' },
          { advanceMs: 61_000, expect: 'ok' },
        ],
      )
      expect(exchanges).toEqual([1, 0, 1])
    })

    test('an absurd Retry-After is capped at 10 minutes', async () => {
      const exchanges = await run(
        '429c',
        (n) =>
          n === 1 ? status(429, { 'retry-after': '86400' }) : tokenOk('a', 'r'),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 601_000, expect: 'ok' },
        ],
      )
      expect(exchanges).toEqual([1, 1])
    })

    test('a definite non-grant 4xx only cools down', async () => {
      const exchanges = await run(
        '400',
        (n) =>
          n === 1
            ? status(400, {}, '{"error":"invalid_request"}')
            : tokenOk('a', 'r'),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 61_000, expect: 'ok' },
        ],
      )
      expect(exchanges).toEqual([1, 1])
    })

    test('invalid_grant blocks permanently', async () => {
      const exchanges = await run(
        'grant',
        () => status(400, {}, '{"error":"invalid_grant"}'),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 3_600_000, expect: 'blocked' },
        ],
      )
      expect(exchanges).toEqual([1, 0])
    })

    test('5xx is ambiguous and blocks', async () => {
      const exchanges = await run('5xx', () => status(503), [
        { advanceMs: 0, expect: 'throws' },
        { advanceMs: 3_600_000, expect: 'blocked' },
      ])
      expect(exchanges).toEqual([1, 0])
    })

    test('a network failure is ambiguous and blocks', async () => {
      const exchanges = await run('net', () => {
        throw new TypeError('fetch failed')
      }, [
        { advanceMs: 0, expect: 'throws' },
        { advanceMs: 3_600_000, expect: 'blocked' },
      ])
      expect(exchanges).toEqual([1, 0])
    })

    test.each([
      [
        'empty access',
        { access_token: '', refresh_token: 'r', expires_in: 60 },
      ],
      ['no expires_in', { access_token: 'a', refresh_token: 'r' }],
    ])('malformed 2xx (%s) is ambiguous and blocks', async (name, body) => {
      const exchanges = await run(
        `bad-${name}`,
        () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        [
          { advanceMs: 0, expect: 'throws' },
          { advanceMs: 3_600_000, expect: 'blocked' },
        ],
      )
      expect(exchanges).toEqual([1, 0])
    })
  })

  test('a setup failure after the V1 plugin exists rolls everything back and rethrows the original error', async () => {
    const host = createHost(expired('claude-max', `rollback-${_name}-r0`))
    const failure = new Error('rpc registration failed')
    const disposed: string[] = []
    host.context.rpc = {
      register: async () => {
        throw failure
      },
    }
    const base = host.context.session.hook
    host.context.session.hook = async (name, callback, options) => {
      const registration = await base(name, callback, options)
      return {
        dispose: async () => {
          disposed.push(name)
          await registration.dispose()
        },
      }
    }
    const { setup } = await load()
    const before = owners()
    await expect(setup(host.context)).rejects.toBe(failure)
    expect(rpcFiles()).toEqual([])
    expect(owners()).toBe(before)
    expect((globalThis as any)[OWNED]).toBe(true)
    expect(disposed).toContain('http.request')
  })

  const v1Request = (host: ReturnType<typeof createHost>) => {
    const http = host.hooks.find((h) => h.name === 'http.request')!
    return async () => {
      const event = {
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses-host-refresh',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
      }
      await http.callback(event)
      return fetch(event.request)
    }
  }

  test('V1 401 with a different valid host access retries immediately without exchange', async () => {
    const host = createHost({
      ...expired('claude-max', `rej-${_name}-r0`),
      access: 'acc-1',
      expires: Date.now() + 60 * 60_000,
    })
    await seedStickyStorage('acc-1')
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({
      upstream: (url, init) => {
        const auth = new Headers(init?.headers).get('authorization')
        if (auth === 'Bearer acc-1') {
          host.persist({
            ...host.stored(),
            access: 'acc-2',
            refresh: `rej-${_name}-r1`,
          })
          return authFailure()
        }
        return new Response('{}', { status: 200 })
      },
    })
    try {
      const started = Date.now()
      const response = await v1Request(host)()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(fake.upstreamAuth).toEqual(['Bearer acc-1', 'Bearer acc-2'])
      expect(response.status).toBe(200)
      expect(fake.tokenBodies).toHaveLength(0)
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('V1 401 on an unchanged non-expiring access fails fast instead of waiting', async () => {
    const host = createHost({
      ...expired('claude-max', `rej2-${_name}-r0`),
      access: 'acc-1',
      expires: Date.now() + 60 * 60_000,
    })
    await seedStickyStorage('acc-1')
    const cleanup = await (await load()).setup(host.context)
    const fake = fakeFetch({
      upstream: () => authFailure(),
    })
    try {
      const started = Date.now()
      const response = await v1Request(host)()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(await response.text()).toContain('re-login required')
      expect(fake.upstreamAuth).toHaveLength(1)
      expect(fake.tokenBodies).toHaveLength(0)
      expect(fake.upstreamAuth).toEqual(['Bearer acc-1'])
    } finally {
      await cleanup()
    }
  }, 20_000)
})
