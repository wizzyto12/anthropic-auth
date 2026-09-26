import { describe, expect, test } from 'bun:test'
import { createV1Api, flattenTheme, isV2TuiContext } from '../tui/v2-host.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function createContext(
  answers: { select?: unknown; prompt?: unknown; confirm?: unknown } = {},
) {
  const calls: Record<string, unknown[]> = {
    slot: [],
    show: [],
    set: [],
    clear: [],
    toast: [],
    select: [],
    prompt: [],
    confirm: [],
  }
  let listener: (() => void) | undefined
  const context = {
    location: { directory: '/work/project' },
    theme: {
      text: { base: 'T', muted: 'M', feedback: { error: { base: 'E' } } },
      hue: { accent: { 200: 'A' } },
    },
    themeMode: 'dark',
    renderer: { copyToClipboardOSC52: () => true },
    data: {
      listen: (handler: () => void) => {
        listener = handler
        return () => {
          listener = undefined
        }
      },
    },
    ui: {
      slot: (claim: unknown) => {
        calls.slot!.push(claim)
        return () => calls.slot!.push('disposed')
      },
      router: { current: () => ({ type: 'session', sessionID: 'ses_1' }) },
      toast: { show: (options: unknown) => calls.toast!.push(options) },
      dialog: {
        show: (render: unknown) => calls.show!.push(render),
        set: (options: unknown) => calls.set!.push(options),
        clear: () => calls.clear!.push(true),
        select: async (options: unknown) => {
          calls.select!.push(options)
          return answers.select
        },
        prompt: async (options: unknown) => {
          calls.prompt!.push(options)
          return answers.prompt
        },
        confirm: async (options: unknown) => {
          calls.confirm!.push(options)
          return answers.confirm
        },
      },
    },
  }
  return { context, calls, fire: () => listener?.() }
}

describe('OpenCode 2 TUI host adapter', () => {
  test('detects a V2 TUI context', () => {
    expect(isV2TuiContext(createContext().context)).toBe(true)
    expect(isV2TuiContext({ slots: {} })).toBe(false)
  })

  test('flattens the V2 token tree to the V1 colour table', () => {
    const theme = flattenTheme(createContext().context.theme, 'dark')
    expect(theme.text).toBe('T')
    expect(theme.textMuted).toBe('M')
    expect(theme.accent).toBe('A')
    expect(theme.error).toBe('E')
    // Missing tokens fall back to readable colours.
    expect(flattenTheme(undefined, 'light').background).toBe('#ffffff')
  })

  test('maps sidebar_content onto the sidebar.content slot', () => {
    const { context, calls } = createContext()
    const host = createV1Api(context)
    const seen: unknown[] = []
    host.api.slots.register({
      slots: {
        sidebar_content: (_ctx: unknown, props: unknown) => {
          seen.push(props)
          return 'node'
        },
      },
    })
    const claim = calls.slot![0] as {
      append: string
      render: (input: unknown) => unknown
    }
    expect(claim.append).toBe('sidebar.content')
    expect(claim.render({ sessionID: 'ses_9' })).toBe('node')
    expect(seen).toEqual([{ session_id: 'ses_9' }])
    host.dispose()
    expect(calls.slot).toContain('disposed')
  })

  test('exposes directory, route and events the V1 TUI reads', () => {
    const { context, fire } = createContext()
    const host = createV1Api(context)
    expect(host.api.state.path.directory).toBe('/work/project')
    expect(host.api.route.current.params.sessionID).toBe('ses_1')
    let hits = 0
    const off = host.api.event.on('session.updated', () => hits++)
    fire()
    off()
    fire()
    expect(hits).toBe(1)
  })

  test('DialogSelect routes the chosen value to onSelect with its option', async () => {
    const { context, calls } = createContext({ select: 'b' })
    const { api } = createV1Api(context)
    const picked: unknown[] = []
    const options = [
      { title: 'A', value: 'a' },
      { title: 'B', value: 'b', description: 'bee' },
    ]
    expect(
      api.ui.DialogSelect({
        title: 'Pick',
        current: 'a',
        options,
        onSelect: (o: unknown) => picked.push(o),
      }),
    ).toBeNull()
    await tick()
    expect((calls.select![0] as { current: string }).current).toBe('a')
    expect(picked).toEqual([options[1]])
  })

  test('DialogPrompt uses descriptionText and reports cancel', async () => {
    const { context, calls } = createContext({ prompt: undefined })
    const { api } = createV1Api(context)
    let cancelled = false
    api.ui.DialogPrompt({
      title: 'Key',
      description: () => null,
      descriptionText: 'Paste your key',
      onConfirm: () => {},
      onCancel: () => {
        cancelled = true
      },
    })
    await tick()
    expect((calls.prompt![0] as { description: string }).description).toBe(
      'Paste your key',
    )
    expect(cancelled).toBe(true)
  })

  test('DialogConfirm, dialog size and toast map to the V2 helpers', async () => {
    const { context, calls } = createContext({ confirm: true })
    const { api } = createV1Api(context)
    let confirmed = false
    api.ui.DialogConfirm({
      title: 'Sure?',
      message: 'Really',
      onConfirm: () => (confirmed = true),
    })
    await tick()
    expect(confirmed).toBe(true)
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => 'content')
    api.ui.dialog.clear()
    api.ui.toast({ message: 'done', variant: 'success' })
    expect(calls.set).toEqual([{ size: 'xlarge' }])
    expect(calls.show).toHaveLength(1)
    expect(calls.clear).toHaveLength(1)
    expect((calls.toast![0] as { message: string }).message).toBe('done')
  })
})

describe('OpenCode 2 TUI RPC client', () => {
  test('pairs with the server through the host RPC channel', async () => {
    const { context } = createContext()
    const calls: unknown[] = []
    ;(context as any).client = {
      rpc: (definition: { id: string }) => ({
        pending: async (input: unknown) => {
          calls.push([definition.id, 'pending', input])
          return { messages: [{ id: 1 }] }
        },
        apply: async () => {
          throw new Error('offline')
        },
      }),
    }
    const { api } = createV1Api(context)
    expect(await api.rpcClient!.pending(3, 'ses_1')).toEqual([{ id: 1 }])
    expect(calls).toEqual([
      [
        'cortexkit.anthropic-auth',
        'pending',
        { lastReceivedId: 3, sessionId: 'ses_1' },
      ],
    ])
    expect((await api.rpcClient!.apply({ command: 'x' })).text).toBe(
      'apply failed',
    )
  })
})
