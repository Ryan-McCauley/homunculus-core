// Hash-route state for the HOME tab.
//
// The route IS the view state — which sub-view, which sector, which registry
// filters, whether the uplink is open. Keeping it in the URL rather than in
// component state is what lets an agent navigate the tab by setting a route, and
// what gives the operator a deep link to any state the tab can be in.

import { useCallback, useEffect, useState } from 'react'
import { formatHomeRoute, parseHomeRoute, type HomeRoute } from '../../shared/homeRoute'

export function useHomeRoute(): [HomeRoute, (next: HomeRoute) => void] {
  const [route, setRoute] = useState<HomeRoute>(() => parseHomeRoute(window.location.hash))

  // Listen for external navigation — the back button, a pasted deep link, or an
  // agent assigning location.hash directly.
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHomeRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: HomeRoute) => {
    const formatted = formatHomeRoute(next)
    // State first, hash second: assigning the hash fires hashchange, but only
    // when the value actually differs, so a no-op navigation would otherwise
    // leave the component un-rerendered.
    setRoute(next)
    if (window.location.hash !== formatted) window.location.hash = formatted
  }, [])

  return [route, navigate]
}
