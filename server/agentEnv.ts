// The environment handed to a Claude Agent SDK child process.
//
// WHY THIS IS AN ALLOWLIST AND NOT A DENYLIST
//
// Every SDK session this server starts — fleet agents, the strategy runner, the
// Computer Core chat, the proactive monitor — runs with `permissionMode:
// 'bypassPermissions'`. Fleet agents additionally get unrestricted Bash and a
// prompt assembled partly from text OTHER agents wrote (library documents, board
// threads, journals, manager-file instructions) plus live market and home-state
// strings. That is a prompt-injection surface pointed at a shell.
//
// The three call sites used to build their env as `{...process.env}` minus two
// Anthropic keys. That denylist forwarded, to that shell: GEMINI_API_KEY and
// GEMINI_API_SECRET (spend the portfolio directly, no propose() gate involved),
// HA_TOKEN (unlock the house), HOMUNCULUS_ADMIN_TOKEN (amend the audit record
// that exists to catch exactly this), DATABASE_URL (credentials to the system of
// record), and every OSINT_* feed key. The trade-authority gate in
// agents.ts::propose is meaningless if the caller can just sign its own Gemini
// request, and a denylist silently re-opens the hole the day someone adds a new
// credential — which is precisely how these six got there.
//
// So: nothing reaches a child unless it is named here. New credentials are safe
// by default. If a child genuinely needs something new, adding it is a one-line,
// reviewable decision rather than an invisible inheritance.

/** Env a child process needs to run at all — interpreter discovery, temp dirs,
 *  the user profile the Claude CLI reads its own config and session from. */
const SYSTEM_KEYS = [
  // POSIX
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMPDIR', 'TERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  // Windows — a child that loses SystemRoot/PATHEXT/COMSPEC cannot spawn anything
  'SystemRoot', 'SystemDrive', 'windir', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  // Node/npm toolchain the CLI may be installed under (nvm, volta, custom prefix)
  'NODE_PATH', 'NODE_OPTIONS', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'NPM_CONFIG_PREFIX',
] as const

/** Non-secret app config a child is allowed to see. Deliberately short. */
const APP_KEYS = [
  // Which model the session should use — not a credential.
  'HOMUNCULUS_MODEL',
  // Lets a skill's helper scripts find the API on a non-default port. The port
  // is not a secret and the routes behind it have their own gates.
  'HOMUNCULUS_PORT',
] as const

/**
 * Credentials a child MUST NOT receive, listed explicitly.
 *
 * Redundant with the allowlist — nothing here would pass it anyway — and that is
 * the point: it states the intent in a form a future reader (or a future edit
 * that loosens the allowlist) runs straight into. Keep in step with SECRET_SPECS
 * in shared/secrets.ts.
 */
export const NEVER_FORWARDED = [
  'GEMINI_API_KEY', 'GEMINI_API_SECRET',
  'HA_TOKEN', 'HA_URL',
  'CMC_API_KEY',
  'DATABASE_URL',
  'HOMUNCULUS_TOKEN', 'HOMUNCULUS_ADMIN_TOKEN',
  'OSINT_AISSTREAM_KEY', 'OSINT_PIZZA_KEY',
  // Forcing the local-subscription path rather than a billed API key is a
  // deliberate product decision, not only a security one — see the SDK call sites.
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
] as const

const ALLOWED = new Set<string>([...SYSTEM_KEYS, ...APP_KEYS, 'CLAUDE_CODE_OAUTH_TOKEN'])
const DENIED = new Set<string>(NEVER_FORWARDED)

/**
 * Builds the env for an Agent SDK child.
 *
 * @param extra Additional non-secret pairs this particular session needs — e.g.
 *              the strategy runner stamping HOMUNCULUS_SKILL so audit entries
 *              written by helper scripts are attributed to the skill. Applied
 *              after the allowlist, so a caller can add its own values, but
 *              still filtered through the deny list so no call site can
 *              reintroduce a credential by accident.
 */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (!ALLOWED.has(k)) continue
    if (DENIED.has(k)) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (DENIED.has(k)) continue
    env[k] = v
  }
  return env
}
