// OpenCode 2 RPC contract between this plugin's server and TUI halves.
//
// OpenCode 2 runs one background server for every project, so the V1
// rendezvous (a port file keyed by project directory) cannot pair a TUI with
// its server there. The host's own RPC channel routes each call to the server
// the TUI is attached to. Plain .mjs so the TUI host adapter can import it.

const object = { type: 'object' }

export const ANTHROPIC_AUTH_RPC = {
  id: 'cortexkit.anthropic-auth',
  methods: {
    /** Drain dialog notifications; also marks the TUI connected for a session. */
    pending: { input: object, output: object },
    /** Apply a dialog's chosen command arguments. */
    apply: { input: object, output: object },
  },
  events: {},
}
