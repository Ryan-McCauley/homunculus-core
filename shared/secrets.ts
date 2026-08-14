// ── Secret catalogue ───────────────────────────────────────────────────
// The credentials Homunculus knows how to use, described as data so the
// SETTINGS → KEYS panel and the first-run wizard can render themselves.
//
// SECURITY INVARIANT: a secret's VALUE only ever travels client → server.
// Nothing in this file, and no endpoint that uses it, sends a value back the
// other way. The UI shows presence + a last-4 fingerprint, never the plaintext.
// See server/secrets.ts for storage and electron/vault.ts for encryption.

export interface SecretSpec {
  /** Environment-variable name — the same name server/*.ts already reads. */
  key: string
  label: string
  /** Which tab this credential powers; '' for core/global settings. */
  module: string
  hint: string
  /** The module is unusable without it (vs. degraded-but-working). */
  required: boolean
  /** Render as a URL/token field rather than an opaque secret (still write-only). */
  kind?: 'secret' | 'url'
  /** true when the consuming module reads this at import time, so a new value
   *  only takes effect after a backend restart. The UI says so explicitly
   *  rather than letting a user think a dead key is live. */
  restartRequired?: boolean
  /** Where the user goes to mint this credential. Rendered as a link next to
   *  the hint. Omit for keys with no external issuer (self-generated secrets,
   *  connection strings you already own). */
  docsUrl?: string
  /** Short label for `docsUrl` — name the destination, not the action. */
  docsLabel?: string
}

export const SECRET_SPECS: SecretSpec[] = [
  {
    key: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude Code OAuth token', module: '', required: true,
    hint: 'Drives the Computer Core on your Claude subscription. Generate with `claude setup-token` on a machine where the Claude CLI is logged in.',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup', docsLabel: 'Claude Code setup docs',
  },
  {
    key: 'HOMUNCULUS_TOKEN', label: 'Remote access token', module: '', required: false, restartRequired: true,
    hint: 'Required once this machine is reachable beyond localhost. Gates the WebSocket and the finance/crypto REST routes. Use a long random string.',
  },
  {
    key: 'GEMINI_API_KEY', label: 'Gemini API key', module: 'CRYPTO', required: false,
    hint: 'Market data works without keys. Portfolio and trading need them.',
    docsUrl: 'https://exchange.gemini.com/settings/api', docsLabel: 'Gemini API settings',
  },
  {
    key: 'GEMINI_API_SECRET', label: 'Gemini API secret', module: 'CRYPTO', required: false,
    hint: 'Paired with the Gemini API key.',
    docsUrl: 'https://exchange.gemini.com/settings/api', docsLabel: 'Gemini API settings',
  },
  {
    key: 'CMC_API_KEY', label: 'CoinMarketCap key', module: 'CRYPTO', required: false,
    hint: 'Optional. Cross-checks the volume gate against aggregated cross-exchange volume; without it the gate falls back to Gemini-only.',
    docsUrl: 'https://coinmarketcap.com/api/', docsLabel: 'CoinMarketCap API plans',
  },
  {
    key: 'HA_URL', label: 'Home Assistant URL', module: 'HOME', required: true, restartRequired: true, kind: 'url',
    hint: 'Base URL of your Home Assistant instance, e.g. http://homeassistant.local:8123',
  },
  {
    key: 'HA_TOKEN', label: 'Home Assistant token', module: 'HOME', required: true, restartRequired: true,
    hint: 'Long-lived access token from your HA profile page.',
    docsUrl: 'https://www.home-assistant.io/docs/authentication/#your-account-profile', docsLabel: 'Home Assistant token docs',
  },
  {
    key: 'OSINT_AISSTREAM_KEY', label: 'AISStream key', module: 'OSINT', required: false, restartRequired: true,
    hint: 'Optional. Free key from aisstream.io for live vessel tracking.',
    docsUrl: 'https://aisstream.io/authenticate', docsLabel: 'aisstream.io',
  },
  {
    key: 'OSINT_PIZZA_KEY', label: 'Pizza-index key', module: 'OSINT', required: false, restartRequired: true,
    hint: 'Optional feed key. Has a working default.',
  },
  {
    key: 'DATABASE_URL', label: 'Postgres URL', module: 'ARCHIVE', required: false, restartRequired: true, kind: 'url',
    hint: 'Optional. Enables history capture for the DATA and ARCHIVE tabs. Blank runs live-only with no persistence.',
  },
]

export const secretsForModule = (module: string): SecretSpec[] =>
  SECRET_SPECS.filter((s) => s.module === module)

export const findSecretSpec = (key: string): SecretSpec | undefined =>
  SECRET_SPECS.find((s) => s.key === key)

/** What the server reports about a secret. Note the absence of a `value` field —
 *  that omission is the whole security model, so don't add one. */
export interface SecretStatus {
  key: string
  /** A value is present and usable right now. */
  set: boolean
  /** Where it came from: 'vault' = user-entered via the UI (keychain-encrypted),
   *  'env' = process environment / .env file, 'none' = unset. */
  source: 'vault' | 'env' | 'none'
  /** Last 4 characters, for "is this the key I think it is?". Empty when unset. */
  last4: string
}

/** Whether the running surface can accept key edits at all. Only an Electron
 *  shell talking to a LOCAL backend can — see server/secrets.ts. */
export interface SecretsCapability {
  writable: boolean
  /** Human-readable reason when `writable` is false. */
  reason: string
}

/** The preload bridge the Electron shell exposes as `window.homunculusVault`.
 *  Declared here (not in electron/preload.ts) so the renderer can type against
 *  it without pulling Electron's types into the web build. Note that no method
 *  returns a secret value — see the invariant at the top of this file. */
export interface VaultBridge {
  available: () => Promise<boolean>
  list: () => Promise<{ key: string; last4: string }[]>
  set: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
  remove: (key: string) => Promise<{ ok: boolean; error?: string }>
  clear: () => Promise<{ ok: boolean; error?: string }>
  /** Re-push the vault into the local backend (it holds keys in memory only, so
   *  this is how a restarted backend gets them back). */
  sync: () => Promise<{ ok: boolean; error?: string }>
}
