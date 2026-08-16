// Routing for the HOME tab's sub-views.
//
// Every view state — which sub-view, which sector, which registry filters, and
// whether the uplink palette is open — is expressed as a hash route:
//
//   #/home/overview
//   #/home/sectors/living-room
//   #/home/registry?domain=sensor&q=temp
//   #/home/overview?uplink=open
//
// This is the first of the machine-interface conventions, and it earns its keep
// twice. An agent navigates the tab by *setting a route* rather than by
// synthesizing clicks on controls whose positions it has to infer, and the
// operator gets a shareable deep link to any state the UI can be in.
//
// Parsing is deliberately total: any string produces a HomeRoute, falling back to
// the overview. A malformed hash — from a stale bookmark, a typo, or an agent
// that guessed — must land somewhere sane rather than render nothing.

/** The HOME tab's sub-views, in rail order. */
export const HOME_VIEWS = ['overview', 'sectors', 'devices', 'registry', 'automata'] as const

export type HomeView = (typeof HOME_VIEWS)[number]

export interface HomeRoute {
  view: HomeView
  /** Selected sector slug — only meaningful on the sectors view. */
  sector?: string
  /** Registry domain filter, e.g. 'light'. */
  domain?: string
  /** Registry free-text query. */
  q?: string
  /** True when the uplink palette is open over the view. */
  uplink?: boolean
}

export function isHomeView(value: string): value is HomeView {
  return (HOME_VIEWS as readonly string[]).includes(value)
}

/**
 * A URL-safe slug for an area name: 'Living Room' → 'living-room'.
 *
 * Sector ids come from HA area *names*, which are free text an operator typed —
 * they carry spaces, apostrophes and punctuation that have no business in a
 * route. Slugs are also what an agent addresses a sector by, so they must be
 * stable and derivable from the name alone.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['‘’]/g, '')   // possessives collapse rather than split
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Parses any hash into a route. Never throws; unknown input yields the overview. */
export function parseHomeRoute(hash: string): HomeRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const [path = '', query = ''] = raw.split('?')
  const segments = path.split('/').filter(Boolean)

  if (segments[0] !== 'home') return { view: 'overview' }

  const view = segments[1] ?? ''
  if (!isHomeView(view)) return { view: 'overview' }

  const route: HomeRoute = { view }

  if (view === 'sectors' && segments[2]) {
    const sector = slugify(safeDecode(segments[2]))
    if (sector) route.sector = sector
  }

  const params = new URLSearchParams(query)
  const domain = params.get('domain')
  const q = params.get('q')
  if (domain) route.domain = domain
  if (q) route.q = q
  if (params.get('uplink') === 'open') route.uplink = true

  return route
}

/** The canonical route string for a state. Inverse of parseHomeRoute. */
export function formatHomeRoute(route: HomeRoute): string {
  let path = `#/home/${route.view}`
  if (route.view === 'sectors' && route.sector) path += `/${route.sector}`

  // Fixed key order so the same state always produces the same string — routes
  // are compared, cached and diffed, and key order must not make two identical
  // states look different.
  const parts: string[] = []
  if (route.domain) parts.push(`domain=${encodeURIComponent(route.domain)}`)
  if (route.q) parts.push(`q=${encodeURIComponent(route.q)}`)
  if (route.uplink) parts.push('uplink=open')

  return parts.length ? `${path}?${parts.join('&')}` : path
}

/** decodeURIComponent that returns its input rather than throwing on bad escapes. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
