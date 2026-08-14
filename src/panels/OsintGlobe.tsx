// OsintGlobe — the focal point of the OSINT tab. A globe.gl/three.js globe
// styled to the Homunculus phosphor aesthetic, with each OSINT dataset wired as
// a toggleable overlay layer:
//   • Seismic  → pulsing rings + clickable core points (USGS quakes)
//   • Aircraft → points (military ADS-B; emergency squawks in crimson)
//   • Vessels  → points (AIS, blue)
//   • Cyber    → points (C2 servers by country, crimson)
//   • Geomag   → heatmap (NOAA OVATION aurora oval)
//
// Part A interactivity: click-to-focus (fly + HUD), auto-track of priority
// events, a home marker, and a live view-center readout. The whole heavy
// three.js chunk is code-split via React.lazy in the dashboard.

import { useCallback, useEffect, useRef, useState } from 'react'
import Globe, { type GlobeInstance } from 'globe.gl'
import { Color } from 'three'
import { feature } from 'topojson-client'
import countries110m from 'world-atlas/countries-110m.json'
import { tokens } from '../lib/tokens'
import type { OsintSnapshot } from '../../shared/osint'

export interface GlobeLayers {
  seismic: boolean
  aircraft: boolean
  geomag: boolean
  vessels: boolean
  cyber: boolean
}

export interface LatLng { lat: number; lng: number }

type Kind = 'aircraft' | 'vessel' | 'cyber' | 'quake' | 'home'

// All point-style overlays share globe.gl's single pointsData layer, tagged by
// kind so aircraft, vessels, C2 servers, quake cores and home coexist.
interface GlobePoint {
  lat: number; lng: number; color: string; radius: number; label: string
  kind: Kind; title: string; sub: string
}
interface RingDatum { lat: number; lng: number; r: number; period: number; speed: number; rgb: string; maxAlpha: number }
interface FocusTarget { kind: Kind; color: string; title: string; sub: string; lat: number; lng: number; auto: boolean }

type Ring = [number, number][]
type LandFeature = { geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] } }

/** A ring with fewer than three distinct points encloses no area. h3 rejects one
 *  outright (E_FAILED), and the throw lands inside the globe's init effect — with
 *  no error boundary above it that unmounts the whole app, not just this panel.
 *  world-atlas ships exactly one: North Korea's first part is a single point
 *  repeated four times. Drop the degenerate parts, keep the real ones. */
function ringHasArea(ring: Ring): boolean {
  const distinct = new Set(ring.map((p) => `${p[0]},${p[1]}`))
  return distinct.size >= 3
}

function sanitizeLand(features: LandFeature[]): object[] {
  const kept: object[] = []
  for (const f of features) {
    const g = f.geometry
    if (g.type === 'Polygon') {
      if (ringHasArea((g.coordinates as Ring[])[0])) kept.push(f)
      continue
    }
    const parts = (g.coordinates as Ring[][]).filter((poly) => ringHasArea(poly[0]))
    if (parts.length === 0) continue
    kept.push(parts.length === g.coordinates.length ? f : { ...f, geometry: { ...g, coordinates: parts } })
  }
  return kept
}

const LAND = sanitizeLand(
  (feature(countries110m as never, (countries110m as never as { objects: { countries: never } }).objects.countries) as never as { features: LandFeature[] }).features
)

const KIND_ICON: Record<Kind, string> = {
  aircraft: 'ti-plane', vessel: 'ti-anchor', cyber: 'ti-shield-bolt', quake: 'ti-activity', home: 'ti-home'
}

function fmtLat(v: number): string { return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}` }
function fmtLng(v: number): string { return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}` }

export function OsintGlobe({ snap, layers, autoTrack, homeMode, home, radiusKm, geofence, onSetHome }: {
  snap: OsintSnapshot | null
  layers: GlobeLayers
  autoTrack: boolean
  homeMode: boolean
  home: LatLng | null
  radiusKm: number
  /** Whether the home perimeter is armed (draws the sweep ring). */
  geofence: boolean
  onSetHome: (c: LatLng) => void
}): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<GlobeInstance | null>(null)
  const controlsRef = useRef<{ autoRotate: boolean } | null>(null)
  const povRef = useRef<HTMLSpanElement>(null)

  const [focus, setFocus] = useState<FocusTarget | null>(null)

  // Mutable bits the once-installed globe handlers need to read live.
  const manualFocusRef = useRef(false)
  const homeModeRef = useRef(homeMode)
  const onSetHomeRef = useRef(onSetHome)
  const autoTrackRef = useRef(autoTrack)
  useEffect(() => { homeModeRef.current = homeMode }, [homeMode])
  useEffect(() => { onSetHomeRef.current = onSetHome }, [onSetHome])
  useEffect(() => { autoTrackRef.current = autoTrack }, [autoTrack])

  // Auto-track dedupe.
  const seenRef = useRef<Set<string>>(new Set())
  const lastAutoRef = useRef(0)
  const primedRef = useRef(false)

  const flyTo = useCallback((lat: number, lng: number): void => {
    const g = globeRef.current
    if (!g) return
    if (controlsRef.current) controlsRef.current.autoRotate = false
    g.pointOfView({ lat, lng, altitude: 1.35 }, 900)
  }, [])

  const focusOn = useCallback((t: FocusTarget): void => {
    setFocus(t)
    manualFocusRef.current = !t.auto
    flyTo(t.lat, t.lng)
  }, [flyTo])

  const clearFocus = useCallback((): void => {
    setFocus(null)
    manualFocusRef.current = false
    if (controlsRef.current && !homeModeRef.current) controlsRef.current.autoRotate = true
  }, [])

  // ── Init once ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const C = tokens()

    const g = new Globe(el)
      .backgroundColor('rgba(0,0,0,0)')
      .width(el.clientWidth)
      .height(el.clientHeight)
      .showGlobe(true)
      .showAtmosphere(true)
      .atmosphereColor(C.green)
      .atmosphereAltitude(0.16)
      .hexPolygonsData(LAND)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.34)
      .hexPolygonUseDots(true)
      .hexPolygonAltitude(0.003)
      .hexPolygonColor(() => C.green + 'cc')
      .ringColor((d: object) => { const r = d as RingDatum; return (t: number) => `rgba(${r.rgb},${(r.maxAlpha * (1 - t)).toFixed(3)})` })
      .ringMaxRadius((d: object) => (d as RingDatum).r)
      .ringPropagationSpeed((d: object) => (d as RingDatum).speed)
      .ringRepeatPeriod((d: object) => (d as RingDatum).period)
      .ringAltitude(0.006)
      .pointLat('lat')
      .pointLng('lng')
      .pointColor((d: object) => (d as GlobePoint).color)
      .pointAltitude(0.008)
      .pointRadius((d: object) => (d as GlobePoint).radius)
      .pointResolution(6)
      .pointLabel((d: object) => (d as GlobePoint).label)
      .onPointClick((d: object) => {
        const p = d as GlobePoint
        focusOn({ kind: p.kind, color: p.color, title: p.title, sub: p.sub, lat: p.lat, lng: p.lng, auto: false })
      })
      .onGlobeClick((coords: { lat: number; lng: number }) => {
        if (homeModeRef.current) onSetHomeRef.current({ lat: coords.lat, lng: coords.lng })
        else clearFocus()
      })
      .heatmapPointLat('lat')
      .heatmapPointLng('lng')
      .heatmapPointWeight((d: object) => (d as { prob: number }).prob / 100)
      .heatmapBandwidth(2.6)
      .heatmapBaseAltitude(0.004)
      .heatmapTopAltitude(0.05)
      // Per-heatmap accessor, not the interpolator itself: globe.gl calls this with
      // the heatmap datum and expects the (t) => colour function back. Passing the
      // interpolator directly makes it the accessor, and the string it returns is
      // then called as a function ("colorFn is not a function") on every redraw.
      .heatmapColorFn(() => (t: number) => `rgba(70,240,190,${Math.min(0.8, t * 0.9)})`)
      .heatmapsTransitionDuration(0)

    const mat = g.globeMaterial() as unknown as { color: Color; emissive: Color; emissiveIntensity: number; shininess: number }
    mat.color = new Color('#07140f')
    mat.emissive = new Color('#04130d')
    mat.emissiveIntensity = 0.45
    mat.shininess = 0.3

    const controls = g.controls() as unknown as { autoRotate: boolean; autoRotateSpeed: number; enableZoom: boolean }
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.42
    controls.enableZoom = true
    controlsRef.current = controls
    g.pointOfView({ lat: 22, lng: -40, altitude: 2.4 })
    globeRef.current = g

    // Live view-center readout (direct DOM write — no React re-render).
    const povTimer = setInterval(() => {
      const span = povRef.current
      if (!span) return
      const v = g.pointOfView()
      span.textContent = `${fmtLat(v.lat)}  ${fmtLng(v.lng)}  ·  ALT ${v.altitude.toFixed(1)}`
    }, 250)

    const ro = new ResizeObserver(() => {
      if (!mountRef.current) return
      g.width(mountRef.current.clientWidth).height(mountRef.current.clientHeight)
    })
    ro.observe(el)

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !document.hidden) g.resumeAnimation()
      else g.pauseAnimation()
    })
    io.observe(el)
    const onVis = (): void => { if (document.hidden) g.pauseAnimation(); else g.resumeAnimation() }
    document.addEventListener('visibilitychange', onVis)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') clearFocus() }
    document.addEventListener('keydown', onKey)

    return () => {
      clearInterval(povTimer)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      document.removeEventListener('keydown', onKey)
      ;(g as unknown as { _destructor?: () => void })._destructor?.()
      el.replaceChildren()
      globeRef.current = null
      controlsRef.current = null
    }
  }, [focusOn, clearFocus])

  // ── Push overlay data on snapshot / layer / home changes ───────────────────
  useEffect(() => {
    const g = globeRef.current
    if (!g) return
    const C = tokens()

    const rings: RingDatum[] = layers.seismic && snap?.seismic
      ? snap.seismic.quakes.map((q) => ({
          lat: q.lat, lng: q.lng, r: Math.max(1.5, q.mag * 1.3),
          period: Math.max(700, 1600 - q.mag * 120), speed: 2.2, rgb: '255,80,80', maxAlpha: 1
        }))
      : []
    // Armed home perimeter — a slow green sweep whose max radius IS the fence.
    if (home && geofence) {
      const r = Math.max(0.4, radiusKm / 111.32)
      rings.push({ lat: home.lat, lng: home.lng, r, period: 2600, speed: 1.1, rgb: '90,240,150', maxAlpha: 0.5 })
    }
    g.ringsData(rings)

    const points: GlobePoint[] = []
    if (layers.seismic && snap?.seismic) {
      for (const q of snap.seismic.quakes) {
        points.push({ lat: q.lat, lng: q.lng, color: C.crimson, radius: 0.22, kind: 'quake',
          title: `M${q.mag.toFixed(1)}`, sub: q.place, label: `◉ M${q.mag.toFixed(1)} · ${q.place}` })
      }
    }
    if (layers.aircraft && snap?.aircraft) {
      for (const a of snap.aircraft.aircraft) {
        points.push({ lat: a.lat, lng: a.lng, color: a.emergency ? C.crimson : C.amber, radius: 0.16, kind: 'aircraft',
          title: a.callsign, sub: `${a.type}${a.altFt != null ? ` · ${a.altFt.toLocaleString()} ft` : ''}${a.emergency ? ' · EMERGENCY' : ''}`,
          label: `✈ ${a.callsign} · ${a.type}${a.altFt != null ? ` · ${a.altFt.toLocaleString()} ft` : ''}` })
      }
    }
    if (layers.vessels && snap?.vessels) {
      for (const v of snap.vessels.vessels) {
        points.push({ lat: v.lat, lng: v.lng, color: C.blue, radius: 0.12, kind: 'vessel',
          title: v.name, sub: `${v.sog != null ? `${v.sog} kn` : '—'}${v.cog != null ? ` · ${v.cog}°` : ''}`,
          label: `⚓ ${v.name}${v.sog != null ? ` · ${v.sog} kn` : ''}` })
      }
    }
    if (layers.cyber && snap?.cyber) {
      for (const c of snap.cyber.c2) {
        if (c.lat == null || c.lng == null) continue
        points.push({ lat: c.lat, lng: c.lng, color: C.crimson, radius: 0.28, kind: 'cyber',
          title: `C2 · ${c.malware}`, sub: `${c.country} · ${c.ip}:${c.port}`,
          label: `⚠ C2 ${c.malware} · ${c.country} · ${c.ip}` })
      }
    }
    if (home) {
      points.push({ lat: home.lat, lng: home.lng, color: C.green, radius: 0.4, kind: 'home',
        title: 'HOME', sub: `${fmtLat(home.lat)} ${fmtLng(home.lng)}`, label: `⌂ HOME` })
    }
    g.pointsData(points)

    g.heatmapsData(layers.geomag && snap?.geomag && snap.geomag.aurora.length ? [snap.geomag.aurora] : [])
  }, [snap, layers, home, radiusKm, geofence])

  // ── Auto-track priority events (A2) ────────────────────────────────────────
  useEffect(() => {
    if (!globeRef.current) return
    const C = tokens()
    const candidates: FocusTarget[] = []
    const seen = seenRef.current

    if (snap?.seismic) {
      for (const q of snap.seismic.quakes) {
        if (q.mag >= 5.5) candidates.push({ kind: 'quake', color: C.crimson, title: `M${q.mag.toFixed(1)}`, sub: q.place, lat: q.lat, lng: q.lng, auto: true })
      }
    }
    if (snap?.aircraft) {
      for (const a of snap.aircraft.aircraft) {
        if (a.emergency) candidates.push({ kind: 'aircraft', color: C.crimson, title: a.callsign, sub: `${a.type} · EMERGENCY`, lat: a.lat, lng: a.lng, auto: true })
      }
    }
    const keyOf = (t: FocusTarget): string => `${t.kind}:${t.title}:${t.sub}`

    // Prime on first snapshot so we don't fly to pre-existing events on load.
    if (!primedRef.current) {
      for (const c of candidates) seen.add(keyOf(c))
      primedRef.current = true
      return
    }

    const fresh = candidates.filter((c) => !seen.has(keyOf(c)))
    for (const c of fresh) seen.add(keyOf(c))
    if (seen.size > 2000) seenRef.current = new Set(candidates.map(keyOf))

    if (fresh.length && autoTrackRef.current && !manualFocusRef.current && Date.now() - lastAutoRef.current > 12_000) {
      lastAutoRef.current = Date.now()
      focusOn(fresh[0])
    }
  }, [snap, focusOn])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%', cursor: homeMode ? 'crosshair' : 'grab' }} />

      {/* Focus HUD callout */}
      {focus && <FocusHud focus={focus} onClose={clearFocus} />}

      {/* Live view-center readout */}
      <div style={{ position: 'absolute', bottom: 10, right: 14, fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)', fontFamily: 'var(--font-mono)', pointerEvents: 'none' }}>
        <span style={{ color: 'var(--green-dim)' }}>VIEW </span><span ref={povRef} style={{ color: 'var(--green)' }} />
      </div>

      {/* Home-pick hint */}
      {homeMode && (
        <div style={{ position: 'absolute', top: 56, left: 12, fontSize: 13, letterSpacing: 1, color: 'var(--amber)', border: '0.5px solid var(--amber)', background: 'rgba(0,0,0,0.6)', padding: '4px 8px' }}>
          <i className="ti ti-crosshair" style={{ marginRight: 4 }} />CLICK THE GLOBE TO SET HOME
        </div>
      )}
    </div>
  )
}

function FocusHud({ focus, onClose }: { focus: FocusTarget; onClose: () => void }): JSX.Element {
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, minWidth: 190, maxWidth: 260,
      background: 'rgba(2,8,10,0.82)', border: `0.5px solid ${focus.color}88`,
      boxShadow: `0 0 14px ${focus.color}33`, padding: '9px 11px', fontFamily: 'var(--font-mono)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <i className={`ti ${KIND_ICON[focus.kind]}`} style={{ color: focus.color, fontSize: 19 }} />
        <span style={{ color: focus.color, fontSize: 17, letterSpacing: 1, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focus.title}</span>
        {focus.auto && <span style={{ fontSize: 11, letterSpacing: 1, color: 'var(--bg)', background: focus.color, padding: '1px 4px' }}>AUTO</span>}
        <i className="ti ti-x" onClick={onClose} style={{ color: 'var(--green-dim)', cursor: 'pointer', fontSize: 18 }} />
      </div>
      <div style={{ fontSize: 13, letterSpacing: 0.5, color: 'var(--green-soft)', lineHeight: 1.5, marginBottom: 5 }}>{focus.sub}</div>
      <div style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)' }}>{fmtLat(focus.lat)}  ·  {fmtLng(focus.lng)}</div>
    </div>
  )
}
