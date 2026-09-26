// OpenCode 2 TUI host adapter.
//
// OpenCode 2 hands a TUI plugin's `setup` a domain context (`ui.slot`,
// `ui.dialog.*` promise helpers, a token-tree `theme`, `data` events, the
// router) instead of OpenCode 1's `TuiPluginApi`. The sidebar and command
// dialogs in `../tui.tsx` are written against the V1 API and already talk to
// the server half through the sidebar state file and the private RPC server,
// both of which the V2 server entry keeps running. So rather than rewriting
// the components, this module builds the slice of the V1 API they use on top
// of the V2 context and runs the same compiled `tui()` through it.
//
// Plain .mjs on purpose (like entry.mjs): it is loaded by the host directly,
// and a TypeScript importer of the compiled .tsx would drag it into the
// declaration build.

import { ANTHROPIC_AUTH_RPC } from '../rpc/v2-contract.mjs'

/**
 * OpenCode 1 gave components a flat colour table; OpenCode 2 resolves a token
 * tree (`text.base`, `text.feedback.error.base`, `hue.accent[200]`, ...). The
 * accent is read at hue step 200, where the host draws its own accent UI;
 * missing tokens fall back to colours readable in the host's theme mode.
 */
export function flattenTheme(theme, mode = 'dark') {
  const light = mode === 'light'
  const feedback = theme?.text?.feedback
  return {
    text: theme?.text?.base ?? (light ? '#1a1a1a' : '#ffffff'),
    textMuted: theme?.text?.muted ?? (light ? '#6b6b6b' : '#9a9a9a'),
    accent: theme?.hue?.accent?.[200] ?? '#5f87ff',
    background: theme?.background?.base ?? (light ? '#ffffff' : '#000000'),
    borderActive: theme?.border?.base ?? '#9a9a9a',
    error: feedback?.error?.base ?? '#d13b3b',
    warning: feedback?.warning?.base ?? '#c77d1a',
    success: feedback?.success?.base ?? '#2e9a4e',
  }
}

/** A V1 dialog component prop may be a string or a render function. */
function textOf(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * V1 dialog components are rendered inside `dialog.replace`. V2 offers the
 * same dialogs as promise helpers that open their own dialog, so each
 * component starts the helper once it is mounted and routes the result to the
 * V1 callbacks. It renders nothing itself: the helper replaces the dialog.
 */
function createDialogComponents(ui) {
  const defer = (fn) => queueMicrotask(() => void fn().catch(() => {}))

  function DialogSelect(props) {
    const options = props.options ?? []
    defer(async () => {
      const value = await ui.dialog.select({
        title: props.title,
        placeholder: props.placeholder,
        current: props.current,
        options: options.map((option) => ({
          title: option.title,
          value: option.value,
          description: textOf(option.description),
          footer: textOf(option.footer),
          category: option.category,
          disabled: option.disabled,
        })),
      })
      if (value === undefined) {
        props.onCancel?.()
        return
      }
      const option = options.find((candidate) => candidate.value === value)
      if (option) props.onSelect?.(option)
    })
    return null
  }

  function DialogPrompt(props) {
    defer(async () => {
      const value = await ui.dialog.prompt({
        title: props.title,
        description: textOf(props.description) ?? props.descriptionText,
        placeholder: props.placeholder,
        value: props.value,
      })
      if (value === undefined) props.onCancel?.()
      else props.onConfirm?.(value)
    })
    return null
  }

  function DialogConfirm(props) {
    defer(async () => {
      const confirmed = await ui.dialog.confirm({
        title: props.title,
        message: textOf(props.message) ?? '',
      })
      if (confirmed) props.onConfirm?.()
      else props.onCancel?.()
    })
    return null
  }

  return { DialogSelect, DialogPrompt, DialogConfirm }
}

/**
 * V1 `RpcClient` over the host RPC channel. The host routes the call to the
 * server this TUI is attached to; failures read as "nothing pending", like
 * the V1 client when no port file is found.
 */
function createHostRpcClient(context, directory) {
  const rpc = context.client?.rpc?.(ANTHROPIC_AUTH_RPC)
  if (!rpc) return undefined
  // One OpenCode 2 server hosts a plugin instance per location; route to the
  // instance serving this TUI's directory.
  const options = { location: { directory } }
  return {
    pending: (lastReceivedId, sessionId) =>
      rpc
        .pending({ lastReceivedId, sessionId }, options)
        .then((result) => result?.messages ?? [])
        .catch(() => []),
    apply: (request) =>
      rpc
        .apply({ ...request }, options)
        .then((result) => result ?? { text: 'apply failed', knobs: {} })
        .catch(() => ({ text: 'apply failed', knobs: {} })),
  }
}

function sessionIDOf(route) {
  return route?.type === 'session' ? route.sessionID : undefined
}

/**
 * Builds the V1 `TuiPluginApi` subset used by `../tui.tsx` and
 * `./command-dialogs.tsx`. Returns the api and a disposer for everything it
 * registered with the host.
 */
export function createV1Api(context) {
  const disposers = []
  const track = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const { ui } = context
  const directory =
    context.location?.directory ??
    context.data?.location?.default?.()?.directory ??
    process.cwd()

  const api = {
    slots: {
      register(registration) {
        const render = registration?.slots?.sidebar_content
        if (typeof render !== 'function') return
        track(
          ui.slot({
            append: 'sidebar.content',
            render: (input) =>
              render(undefined, { session_id: input.sessionID }),
          }),
        )
      },
    },
    theme: {
      get current() {
        return flattenTheme(context.theme, context.themeMode)
      },
    },
    event: {
      // V1 listened for session.updated / message.updated only to refresh
      // sooner than the poll; any host event serves the same purpose.
      on(_type, handler) {
        const unsubscribe = context.data?.listen?.(() => handler())
        return track(unsubscribe) ?? (() => {})
      },
    },
    state: { path: { directory } },
    route: {
      get current() {
        const sessionID = sessionIDOf(ui.router.current())
        return { name: sessionID ? 'session' : 'home', params: { sessionID } }
      },
    },
    renderer: context.renderer,
    rpcClient: createHostRpcClient(context, directory),
    /** Runs when the host disposes this plugin generation. */
    onDispose(dispose) {
      track(dispose)
    },
    ui: {
      ...createDialogComponents(ui),
      dialog: {
        setSize(size) {
          ui.dialog.set({ size })
        },
        replace(render) {
          ui.dialog.show(render)
        },
        clear() {
          ui.dialog.clear()
        },
      },
      toast(options) {
        ui.toast.show({
          title: options?.title,
          message: options?.message ?? '',
          variant: options?.variant,
          duration: options?.duration,
        })
      },
    },
  }

  return {
    api,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // Host already tore the registration down.
        }
      }
    },
  }
}

/** True for an OpenCode 2 TUI context (V1 hosts never call `setup`). */
export function isV2TuiContext(context) {
  return (
    typeof context === 'object' &&
    context !== null &&
    typeof context.ui?.slot === 'function' &&
    typeof context.ui?.dialog?.show === 'function'
  )
}
