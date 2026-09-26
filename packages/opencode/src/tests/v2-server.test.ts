import { describe, expect, test } from 'bun:test'
import {
  isOpenCode2HostContext,
  setup,
  startLoopbackBridge,
  type V2Context,
} from '../v2/server'

const FAR_FUTURE = Date.now() + 24 * 60 * 60 * 1000

function createContext(credential?: unknown) {
  const methods: any[] = []
  const hooks: Array<{ name: string; callback: any; options?: any }> = []
  const commands: any[] = []
  const synthetic: any[] = []
  const registration = () => ({ dispose: async () => {} })
  const context: V2Context = {
    location: { directory: process.cwd() },
    integration: {
      transform: async (cb) => {
        cb({ method: { update: (reg) => methods.push(reg) } })
        return registration()
      },
      connection: {
        active: async () => (credential ? { id: 'conn' } : undefined),
        resolve: async () => credential as never,
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
        cb({ add: (definition) => commands.push(definition) })
        return registration()
      },
    },
    session: {
      hook: async (name, callback, options) => {
        hooks.push({ name, callback, options })
        return registration()
      },
      synthetic: async (input) => {
        synthetic.push(input)
      },
    },
  }
  return { context, methods, hooks, commands, synthetic }
}

describe('OpenCode 2 host detection', () => {
  test('requires session.hook', () => {
    expect(isOpenCode2HostContext({ session: { hook: () => {} } })).toBe(true)
    expect(isOpenCode2HostContext({ agent: {} })).toBe(false)
    expect(isOpenCode2HostContext(null)).toBe(false)
  })

  test('setup is inert on a V1 host context', async () => {
    const cleanup = await setup({ agent: {} } as never)
    expect(typeof cleanup).toBe('function')
  })
})

describe('OpenCode 2 setup', () => {
  test('registers the anthropic oauth method, request bridge and commands', async () => {
    const { context, methods, hooks, commands } = createContext()
    const cleanup = await setup(context)
    try {
      const oauth = methods.find((m) => m.method?.type === 'oauth')
      expect(oauth.integrationID).toBe('anthropic')
      // Matches the methodID the V2 migration gives legacy auth.json logins.
      expect(oauth.method.id).toBe('oauth')
      expect(typeof oauth.authorize).toBe('function')
      expect(typeof oauth.refresh).toBe('function')

      const credential = {
        type: 'oauth',
        methodID: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: 1,
      }
      const refreshed = await oauth.refresh(credential)
      // Never exchanges the refresh token (that would race the V1 pipeline).
      expect(refreshed.refresh).toBe('r')
      expect(refreshed.access).toBe('a')
      expect(refreshed.expires).toBeGreaterThan(Date.now())

      const http = hooks.find((h) => h.name === 'http.request')
      expect(http?.options).toEqual({ providerID: 'anthropic' })
      expect(hooks.some((h) => h.name === 'context')).toBe(true)
      expect(commands.map((c) => c.name)).toContain('claude-quota')
    } finally {
      await cleanup()
    }
  })

  test('routes anthropic requests to the loopback bridge under oauth', async () => {
    const { context, hooks } = createContext({
      type: 'oauth',
      methodID: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: FAR_FUTURE,
    })
    const cleanup = await setup(context)
    try {
      const http = hooks.find((h) => h.name === 'http.request')!
      const event = {
        request: new Request(
          'https://api.anthropic.com/v1/messages?beta=true',
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer stale',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
          },
        ),
      }
      await http.callback(event)
      const url = new URL(event.request.url)
      expect(url.hostname).toBe('127.0.0.1')
      expect(url.pathname).toBe('/v1/messages')
      expect(url.search).toBe('?beta=true')
      expect(event.request.headers.get('x-cortexkit-v2-upstream')).toBe(
        'https://api.anthropic.com/v1/messages?beta=true',
      )
      expect(event.request.headers.get('x-cortexkit-v2-secret')).toBeTruthy()
      expect(JSON.parse(await event.request.text()).model).toBe(
        'claude-opus-4-8',
      )
    } finally {
      await cleanup()
    }
  })
})

describe('loopback bridge', () => {
  test('runs the plugin fetch against the upstream URL and streams back', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const bridge = await startLoopbackBridge(
      async () =>
        (async (url: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(url), init: init ?? {} })
          return new Response('event: ping\n\n', {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'content-encoding': 'gzip',
            },
          })
        }) as typeof fetch,
    )
    try {
      const response = await fetch(`${bridge.origin}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-cortexkit-v2-upstream': 'https://api.anthropic.com/v1/messages',
          'x-cortexkit-v2-secret': bridge.secret,
          authorization: 'Bearer stale',
        },
        body: '{"model":"m"}',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(await response.text()).toBe('event: ping\n\n')

      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages')
      expect(seen[0]!.init.body).toBe('{"model":"m"}')
      const headers = seen[0]!.init.headers as Headers
      expect(headers.get('x-cortexkit-v2-secret')).toBeNull()
      expect(headers.get('x-cortexkit-v2-upstream')).toBeNull()
      expect(headers.get('host')).toBeNull()
    } finally {
      await bridge.close()
    }
  })

  test('rejects requests without the bridge secret', async () => {
    const bridge = await startLoopbackBridge(async () => undefined)
    try {
      const response = await fetch(`${bridge.origin}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-cortexkit-v2-upstream': 'https://example.com/',
          'x-cortexkit-v2-secret': 'wrong',
        },
        body: '{}',
      })
      expect(response.status).toBe(403)
    } finally {
      await bridge.close()
    }
  })
})

describe('OpenCode 2 session bridges', () => {
  test('model.request tags only a pending lane-start turn', async () => {
    const { context, hooks } = createContext()
    const cleanup = await setup(context)
    try {
      const modelRequest = hooks.find((h) => h.name === 'model.request')!
      expect(modelRequest.options).toEqual({ providerID: 'anthropic' })
      const event = {
        sessionID: 'ses_1',
        model: { providerID: 'anthropic' },
        kind: 'primary',
        headers: {} as Record<string, string>,
      }
      await modelRequest.callback(event)
      expect(event.headers['x-cortexkit-lane-start']).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test('consumes host session events and stops on cleanup', async () => {
    const { context } = createContext()
    let aborted = false
    const events = [
      {
        type: 'session.status',
        data: { sessionID: 'ses_1', status: { type: 'busy' } },
      },
      { type: 'session.idle', data: { sessionID: 'ses_1' } },
      { type: 'session.deleted', data: { sessionID: 'ses_1' } },
      { type: 'message.updated', data: {} },
    ]
    let consumed = 0
    ;(context as any).event = {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        return (async function* () {
          for (const event of events) {
            consumed++
            yield event
          }
        })()
      },
    }
    const cleanup = await setup(context)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(consumed).toBe(events.length)
    await cleanup()
    expect(aborted).toBe(true)
  })
})

describe('OpenCode 2 model costs', () => {
  test('zeroes anthropic model costs under subscription oauth', async () => {
    const { context } = createContext({
      type: 'oauth',
      methodID: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: FAR_FUTURE,
    })
    const model = {
      id: 'claude-opus-4-8',
      providerID: 'anthropic',
      cost: [{ input: 5, output: 25, cache: { read: 0.5 } }],
    }
    context.model.transform = async (cb) => {
      cb({
        list: () => [model],
        update: (_provider, _id, update) => update(model),
      })
      return { dispose: async () => {} }
    }
    const cleanup = await setup(context)
    try {
      expect(model.cost).toEqual([{ input: 0, output: 0, cache: { read: 0 } }])
    } finally {
      await cleanup()
    }
  })
})

describe('OpenCode 2 TUI channel', () => {
  test('registers the host RPC contract with pending and apply', async () => {
    const { context } = createContext()
    const registered: Array<{ id: string; handlers: Record<string, unknown> }> =
      []
    ;(context as any).rpc = {
      register: async (
        definition: { id: string },
        handlers: Record<string, unknown>,
      ) => {
        registered.push({ id: definition.id, handlers })
        return { dispose: async () => {} }
      },
    }
    const cleanup = await setup(context)
    try {
      expect(registered).toHaveLength(1)
      expect(registered[0]!.id).toBe('cortexkit.anthropic-auth')
      expect(Object.keys(registered[0]!.handlers).sort()).toEqual([
        'apply',
        'pending',
      ])
      const pending = registered[0]!.handlers.pending as (
        input: unknown,
      ) => Promise<{ messages: unknown[] }>
      expect(
        Array.isArray((await pending({ lastReceivedId: 0 })).messages),
      ).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
