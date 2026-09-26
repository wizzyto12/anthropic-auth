// Prefer the host OpenTUI runtime registry when it exists. OpenTUI 0.4.x
// registers these virtual modules process-wide, allowing the precompiled TUI to
// share the host's single Solid/OpenTUI runtime when loaded from node_modules.
const runtimeProbe = `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`

function isMissingRuntimeRegistry(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(
      message,
    ) && message.includes('opentui:runtime-module:')
  )
}

let mod
try {
  await import(runtimeProbe)
} catch (error) {
  if (!isMissingRuntimeRegistry(error)) {
    console.error('Anthropic Auth TUI runtime registry probe failed', error)
    throw error
  }
  // Older hosts and bare Bun do not provide the virtual registry. Their source
  // loader still applies the Solid transform, so retain the raw TSX fallback.
  mod = await import('../tui.tsx')
}

if (!mod) {
  try {
    mod = await import('../tui-compiled/tui.tsx')
  } catch (error) {
    console.error('Anthropic Auth compiled TUI failed to load', error)
    throw error
  }
}

const v1 = mod.default

// OpenCode 1 reads `tui`; OpenCode 2 validates `{ id, setup }` and ignores
// `tui`, so one object serves both hosts. The V2 lane runs the same V1
// components through an adapter built from the V2 context.
async function setup(context) {
  const { createV1Api, isV2TuiContext } = await import('./v2-host.mjs')
  if (!isV2TuiContext(context)) return
  const host = createV1Api(context)
  await v1.tui(host.api)
  return () => host.dispose()
}

export default { id: v1.id, tui: v1.tui, setup }
