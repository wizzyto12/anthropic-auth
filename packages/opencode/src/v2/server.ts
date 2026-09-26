/**
 * OpenCode 2 host entry.
 *
 * OpenCode 2 does not run V1 plugin hooks: it validates a default export of
 * `{ id, setup }` and hands `setup` a domain context (integration, session,
 * model, command, ...). Rather than re-implementing the V1 plugin, this entry
 * builds the V1 hooks object with a small client shim and bridges each hook
 * onto its V2 equivalent:
 *
 * | V1 hook                               | V2 bridge                                  |
 * | ------------------------------------- | ------------------------------------------ |
 * | `auth.methods` (Claude Pro/Max OAuth) | `integration` OAuth method `anthropic/oauth` |
 * | `auth.loader` custom `fetch`          | `http.request` -> loopback -> V1 `fetch`   |
 * | `provider.models` cost zeroing        | `model.transform`                          |
 * | `experimental.chat.system.transform`  | `session.hook("context")`                  |
 * | `config.command` + `command.execute.before` | `command.transform`                  |
 *
 * The V1 `fetch` owns account routing, fallbacks, quota, refresh (with the
 * cross-process shared-store lock) and every request/response transform. V2's
 * `http.request` hook can rewrite a request but not answer it, so Anthropic
 * requests are redirected to a loopback listener in this process that runs the
 * V1 `fetch` unchanged and streams its response back. The bearer token V2 attaches
 * from its own credential store is discarded there; the V1 pipeline sets its own.
 *
 * V1 `event` (desktop notices) and `chat.headers`/`chat.message` (lane-start
 * marking) have no bridge yet. The TUI is a separate entry.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { AnthropicAuthPlugin } from '../index.ts'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start.ts'
import { drainNotifications } from '../rpc/notifications.ts'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol.ts'
import { createRpcClient } from '../rpc/rpc-client.ts'
import { getRpcDir } from '../rpc/rpc-dir.ts'
import { ANTHROPIC_AUTH_RPC } from '../rpc/v2-contract.mjs'
import type { OpenCodeAnthropicAuth } from '../shared-auth.ts'

const PLUGIN_ID = '@cortexkit/opencode-anthropic-auth'
const INTEGRATION_ID = 'anthropic'
// The V2 migration imports a legacy auth.json `anthropic` oauth entry with
// methodID "oauth"; registering the same id takes over those logins.
const OAUTH_METHOD_ID = 'oauth'
// V1 `event` consumers read only these session lifecycle events.
const V1_SESSION_EVENTS = new Set([
  'session.status',
  'session.idle',
  'session.deleted',
])
const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'
const UPSTREAM_HEADER = 'x-cortexkit-v2-upstream'
const SECRET_HEADER = 'x-cortexkit-v2-secret'
const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  UPSTREAM_HEADER,
  SECRET_HEADER,
])

// ---------------------------------------------------------------------------
// Minimal structural view of the V2 context. Only what this entry touches is
// typed, so the package takes no dependency on `@opencode/plugin`.

type Registration = { dispose: () => Promise<void> }

type OAuthCredential = {
  type: 'oauth'
  methodID: string
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}
type KeyCredential = { type: 'key'; key: string }
type Credential = OAuthCredential | KeyCredential | { type: string }

type SessionScope = {
  sessionID: string
  model: { providerID: string; id?: string; modelID?: string }
}

export type V2Context = {
  location: { directory: string }
  options?: Record<string, unknown>
  integration: {
    transform: (
      cb: (editor: {
        method: { update: (registration: unknown) => void }
      }) => void,
    ) => Promise<Registration>
    connection: {
      active: (integrationID: string) => Promise<unknown | undefined>
      resolve: (connection: unknown) => Promise<Credential | undefined>
    }
  }
  model: {
    transform: (
      cb: (editor: {
        list: (providerID?: string) => ReadonlyArray<{
          id: string
          providerID: string
          cost?: unknown
        }>
        update: (
          providerID: string,
          modelID: string,
          update: (model: { cost?: unknown }) => void,
        ) => void
      }) => void,
    ) => Promise<Registration>
  }
  command: {
    transform: (
      cb: (editor: {
        add: (definition: {
          name: string
          description?: string
          execute: (input: {
            sessionID: string
            prompt: { text: string }
          }) => Promise<void>
        }) => void
      }) => void,
    ) => Promise<Registration>
  }
  session: {
    hook: (
      name: string,
      callback: (event: never) => Promise<void> | void,
      options?: { providerID?: string },
    ) => Promise<Registration>
    synthetic: (input: {
      sessionID: string
      text: string
      description?: string
      resume?: boolean
    }) => Promise<unknown>
    get?: (input: { sessionID: string }) => Promise<unknown>
  }
  rpc?: {
    register: (
      definition: typeof ANTHROPIC_AUTH_RPC,
      handlers: Record<string, (input: never) => Promise<unknown>>,
    ) => Promise<Registration>
  }
  event?: {
    subscribe: (options?: {
      signal?: AbortSignal
    }) => AsyncIterable<{ type: string; data?: Record<string, unknown> }>
  }
}

/**
 * A V1 host (1.18.x) may also call `setup` through its core external-plugin
 * layer with an older context that has no `session.hook`. That host already
 * runs the V1 entry, so this lane must stay inert there.
 */
export function isOpenCode2HostContext(context: unknown): context is V2Context {
  if (typeof context !== 'object' || context === null) return false
  const session = (context as { session?: { hook?: unknown } }).session
  return typeof session?.hook === 'function'
}

// ---------------------------------------------------------------------------

type V1Hooks = {
  auth: {
    loader: (
      getAuth: () => Promise<OpenCodeAnthropicAuth>,
      provider: { models: Record<string, { cost: unknown }> },
    ) => Promise<{ apiKey?: string; fetch?: typeof fetch }>
    methods: Array<{
      label: string
      type: 'oauth' | 'api'
      authorize?: () => Promise<{
        url: string
        instructions: string
        method: 'code' | 'auto'
        callback: (code: string) => Promise<
          | {
              type: 'success'
              refresh?: string
              access?: string
              expires?: number
              key?: string
            }
          | { type: 'failed' }
        >
      }>
    }>
  }
  'experimental.chat.system.transform'?: (
    input: {
      sessionID?: string
      model?: { providerID?: string; api?: { npm?: string } }
    },
    output: { system: string[] },
  ) => Promise<void>
  'command.execute.before'?: (input: {
    command: string
    arguments: string
    sessionID: string
  }) => Promise<void>
  config?: (config: {
    command?: Record<string, { description?: string }>
  }) => Promise<void>
  provider?: {
    models: (
      provider: { models: Record<string, unknown> },
      context: { auth?: { type?: string } },
    ) => Promise<Record<string, { cost?: unknown }>>
  }
}

function toV1Auth(credential: Credential | undefined): OpenCodeAnthropicAuth {
  if (credential?.type === 'oauth') {
    const oauth = credential as OAuthCredential
    return {
      type: 'oauth',
      refresh: oauth.refresh,
      access: oauth.access,
      expires: oauth.expires,
    }
  }
  if (credential?.type === 'key') {
    return { type: 'api', key: (credential as KeyCredential).key }
  }
  // No stored V2 credential. The V1 reconciler still consults the shared
  // account store and sidecar, which are the authoritative sources.
  return { type: 'oauth' }
}

/** V1 `ctx.client` surface the plugin calls, backed by the V2 context. */
type HostState = {
  /** Last V2 `session.status` per session; V1 omits idle sessions. */
  busy: Map<string, { type: string }>
  /** Sessions whose next primary model request is a lane-start warm. */
  laneStarts: Set<string>
}

type ShimPart = { type?: string; text?: string; synthetic?: boolean }

function createClientShim(context: V2Context, state: HostState) {
  const synthetic = async (
    sessionID: string,
    body: { noReply?: boolean; parts?: ShimPart[] },
  ) => {
    const parts = body.parts ?? []
    const text = parts
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n')
    if (!text) return
    // V1 marks the lane-start turn through chat.message + chat.headers; V2
    // has neither, so remember it here and tag the next model request.
    if (
      body.noReply === false &&
      parts.some(
        (part) => part.synthetic === true && part.text === LANE_START_TEXT,
      )
    ) {
      state.laneStarts.add(sessionID)
    }
    await context.session.synthetic({
      sessionID,
      text,
      description: 'anthropic-auth',
      // V1 `noReply: false` (e.g. /claude-start) asks for a model turn.
      resume: body.noReply === false,
    })
  }
  return {
    session: {
      promptAsync: (request: {
        path: { id: string }
        body: { noReply?: boolean; parts?: ShimPart[] }
      }) => synthetic(request.path.id, request.body),
      // V1 status map: only non-idle sessions appear.
      status: async () => ({ data: Object.fromEntries(state.busy) }),
      // Prompt-context lookups degrade to "unknown"; callers handle absence.
      messages: async () => ({ data: [] }),
      get: async () => ({ data: undefined }),
    },
    tui: {
      showToast: async () => ({ data: true }),
    },
    auth: {
      // V2 persists refreshed credentials through the integration `refresh`
      // callback; the shared account store stays authoritative for V1 routing.
      set: async () => ({ data: true }),
    },
  }
}

function zeroCost(cost: unknown): unknown {
  if (Array.isArray(cost)) return cost.map(zeroCost)
  if (typeof cost === 'number') return 0
  if (cost && typeof cost === 'object') {
    return Object.fromEntries(
      Object.entries(cost).map(([key, value]) => [key, zeroCost(value)]),
    )
  }
  return cost
}

// ---------------------------------------------------------------------------
// Loopback bridge: V2 request -> V1 fetch.

type LoopbackBridge = {
  origin: string
  secret: string
  close: () => Promise<void>
}

function secretMatches(expected: string, actual: string | undefined) {
  if (!actual) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function startLoopbackBridge(
  getFetch: () => Promise<typeof fetch | undefined>,
): Promise<LoopbackBridge> {
  const secret = randomBytes(32).toString('hex')

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const upstream = req.headers[UPSTREAM_HEADER]
    const presented = req.headers[SECRET_HEADER]
    if (
      typeof upstream !== 'string' ||
      !secretMatches(
        secret,
        typeof presented === 'string' ? presented : undefined,
      )
    ) {
      res.writeHead(403).end()
      return
    }

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const method = req.method ?? 'POST'
    const raw =
      method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    // The V1 pipeline parses and rewrites JSON bodies as strings.
    const body = raw && raw.length > 0 ? raw.toString('utf8') : undefined

    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })

    const pluginFetch = await getFetch()
    const response = await (pluginFetch ?? fetch)(upstream, {
      method,
      headers,
      body,
      signal: abort.signal,
    })

    const outHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      // fetch already decoded the body; forwarding these would corrupt it.
      if (lower === 'content-encoding' || lower === 'content-length') return
      if (HOP_BY_HOP.has(lower)) return
      outHeaders[name] = value
    })
    res.writeHead(response.status, response.statusText, outHeaders)
    if (!response.body) {
      res.end()
      return
    }
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      .on('error', () => res.destroy())
      .pipe(res)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `anthropic-auth bridge: ${error instanceof Error ? error.message : String(error)}`,
            },
          }),
        )
      } else {
        res.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  server.unref()
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    secret,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

// ---------------------------------------------------------------------------

export async function setup(context: V2Context) {
  if (!isOpenCode2HostContext(context)) return async () => {}

  const state: HostState = { busy: new Map(), laneStarts: new Set() }
  const hooks = (await AnthropicAuthPlugin({
    client: createClientShim(context, state),
    directory: context.location.directory,
  } as never)) as unknown as V1Hooks

  const getAuth = async (): Promise<OpenCodeAnthropicAuth> => {
    const connection = await context.integration.connection
      .active(INTEGRATION_ID)
      .catch(() => undefined)
    if (!connection) return toV1Auth(undefined)
    const credential = await context.integration.connection
      .resolve(connection)
      .catch(() => undefined)
    return toV1Auth(credential)
  }

  // The V1 loader is called once per provider load in V1; here once per
  // process, retried until it yields a fetch (e.g. after the first login).
  let loaded: Promise<typeof fetch | undefined> | undefined
  const getFetch = () => {
    loaded ??= hooks.auth
      .loader(getAuth, { models: {} })
      .then((result) => result.fetch)
      .catch(() => undefined)
    return loaded.then((fetchFn) => {
      if (!fetchFn) loaded = undefined
      return fetchFn
    })
  }

  const bridge = await startLoopbackBridge(getFetch)
  const registrations: Registration[] = []

  // -- Integration: Claude Pro/Max OAuth ------------------------------------
  const oauthMethod = hooks.auth.methods.find(
    (method) => method.type === 'oauth' && method.authorize,
  )
  registrations.push(
    await context.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: 'oauth',
          label: oauthMethod?.label ?? 'Claude Pro/Max',
        },
        authorize: async () => {
          if (!oauthMethod?.authorize) throw new Error('OAuth is unavailable')
          const flow = await oauthMethod.authorize()
          return {
            url: flow.url,
            instructions: flow.instructions,
            mode: 'code',
            callback: async (code: string): Promise<OAuthCredential> => {
              const result = await flow.callback(code)
              if (
                result.type !== 'success' ||
                !result.access ||
                !result.refresh
              ) {
                throw new Error('Anthropic authorization failed')
              }
              // A new login changes the account the V1 pipeline resolves.
              loaded = undefined
              return {
                type: 'oauth',
                methodID: OAUTH_METHOD_ID,
                access: result.access,
                refresh: result.refresh,
                expires: result.expires ?? Date.now() + 60 * 60 * 1000,
              }
            },
          }
        },
        // Never exchange the refresh token here: the V1 pipeline refreshes
        // under the shared-store lock, and presenting one refresh token from
        // two places revokes the whole token family. V2's stored bearer is
        // replaced on the bridge, so only its expiry needs to move forward.
        refresh: async (credential: OAuthCredential) => ({
          ...credential,
          expires: Date.now() + 60 * 60 * 1000,
        }),
      })
    }),
  )

  // -- Requests: route Anthropic HTTP through the V1 fetch ------------------
  registrations.push(
    await context.session.hook(
      'http.request',
      async (event: { request: Request }) => {
        if (!(await getFetch())) return // API-key auth: V2 handles it natively.
        const original = event.request
        const url = new URL(original.url)
        const headers = new Headers(original.headers)
        headers.set(UPSTREAM_HEADER, url.toString())
        headers.set(SECRET_HEADER, bridge.secret)
        event.request = new Request(
          `${bridge.origin}${url.pathname}${url.search}`,
          {
            method: original.method,
            headers,
            body:
              original.method === 'GET' || original.method === 'HEAD'
                ? undefined
                : await original.clone().arrayBuffer(),
            signal: original.signal,
          },
        )
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  // -- TUI channel: host RPC -> this process's V1 RPC server ----------------
  // The V1 TUI pairs with its server through a port file keyed by project
  // directory, but one OpenCode 2 server serves every project. The host RPC
  // routes the TUI to this server; forward to the V1 RPC server in-process so
  // its notification queue and TUI-connected tracking stay authoritative.
  if (context.rpc) {
    const local = createRpcClient(
      getRpcDir(context.location.directory),
      process.pid,
    )
    registrations.push(
      await context.rpc.register(ANTHROPIC_AUTH_RPC, {
        // The notification queue and TUI-connected tracking are process-wide,
        // so drain in-process whichever location instance answers.
        pending: async (input: {
          lastReceivedId?: number
          sessionId?: string
        }) => ({
          messages: drainNotifications(
            input.lastReceivedId ?? 0,
            input.sessionId,
          ),
        }),
        apply: async (input: Parameters<typeof local.apply>[0]) =>
          local.apply(input),
      }),
    )
  }

  // -- Lane start: tag the warm turn's request (V1 chat.message/chat.headers)
  registrations.push(
    await context.session.hook(
      'model.request',
      (
        event: SessionScope & { kind: string; headers: Record<string, string> },
      ) => {
        if (event.kind !== 'primary') return
        if (!state.laneStarts.delete(event.sessionID)) return
        event.headers[LANE_START_REQUEST_HEADER] = '1'
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  // -- Session events: desktop notices and per-session cleanup (V1 `event`)
  const events = new AbortController()
  const eventHook = (
    hooks as { event?: (input: { event: unknown }) => Promise<void> }
  ).event
  if (context.event && eventHook) {
    const stream = context.event.subscribe({ signal: events.signal })
    void (async () => {
      for await (const event of stream) {
        if (!V1_SESSION_EVENTS.has(event.type)) continue
        const data = event.data ?? {}
        const sessionID =
          typeof data.sessionID === 'string' ? data.sessionID : undefined
        if (event.type === 'session.status' && sessionID) {
          const status = data.status as { type?: string } | undefined
          if (status?.type && status.type !== 'idle') {
            state.busy.set(sessionID, { type: status.type })
          } else {
            state.busy.delete(sessionID)
          }
        }
        if (event.type === 'session.idle' && sessionID)
          state.busy.delete(sessionID)
        if (event.type === 'session.deleted' && sessionID) {
          state.busy.delete(sessionID)
          state.laneStarts.delete(sessionID)
        }
        await eventHook({
          event: { type: event.type, properties: data },
        }).catch(() => {})
      }
    })().catch(() => {})
  }

  // -- System prompt: parallel tool-use guidance ----------------------------
  const systemTransform = hooks['experimental.chat.system.transform']
  if (systemTransform) {
    registrations.push(
      await context.session.hook(
        'context',
        async (
          event: SessionScope & {
            system: Array<{ type: string; text: string }>
          },
        ) => {
          const system: string[] = []
          await systemTransform(
            {
              sessionID: event.sessionID,
              model: {
                providerID: event.model.providerID,
                api: { npm: '@ai-sdk/anthropic' },
              },
            },
            { system },
          )
          for (const text of system) event.system.push({ type: 'text', text })
        },
        { providerID: INTEGRATION_ID },
      ),
    )
  }

  // -- Models: zero per-token costs under subscription OAuth ----------------
  const auth = await getAuth().catch(() => undefined)
  if (hooks.provider) {
    // Ask the V1 hook whether it would zero a priced model under this auth
    // (subscription OAuth with cost zeroing enabled).
    const PROBE_ID = '__anthropic_auth_cost_probe__'
    const probe = await hooks.provider
      .models(
        { models: { [PROBE_ID]: { cost: { input: 1, output: 1 } } } },
        { auth: { type: auth?.type } },
      )
      .catch(() => undefined)
    const probeCost = probe?.[PROBE_ID]?.cost as { input?: number } | undefined
    const zeroing = probeCost?.input === 0
    if (zeroing) {
      registrations.push(
        await context.model.transform((editor) => {
          for (const model of editor.list(INTEGRATION_ID)) {
            editor.update(INTEGRATION_ID, model.id, (item) => {
              item.cost = zeroCost(item.cost)
            })
          }
        }),
      )
    }
  }

  // -- Slash commands --------------------------------------------------------
  const commandHook = hooks['command.execute.before']
  if (hooks.config && commandHook) {
    const config: { command?: Record<string, { description?: string }> } = {}
    await hooks.config(config)
    registrations.push(
      await context.command.transform((editor) => {
        for (const [name, definition] of Object.entries(config.command ?? {})) {
          if (!(COMMAND_MODAL_NAMES as readonly string[]).includes(name))
            continue
          editor.add({
            name,
            description: definition.description,
            execute: async ({ sessionID, prompt }) => {
              try {
                await commandHook({
                  command: name,
                  arguments: prompt?.text?.trim() ?? '',
                  sessionID,
                })
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message === HANDLED_SENTINEL
                ) {
                  return
                }
                throw error
              }
            },
          })
        }
      }),
    )
  }

  return async () => {
    events.abort()
    for (const registration of registrations.reverse()) {
      await registration.dispose().catch(() => {})
    }
    await bridge.close()
  }
}

export default {
  id: PLUGIN_ID,
  setup,
}
