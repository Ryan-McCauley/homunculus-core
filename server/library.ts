// The library — durable storage for documents employees write.
//
//   data/crypto/office/library/
//     <slug>-<id8>.json    the artifact, authoritative
//     <slug>-<id8>.md      human-readable mirror (markdown/text bodies only)
//
// Same discipline as the cubicle: the .json is what the app reads, the .md is a
// write-only mirror so a research doc can be opened in any editor with the app down.
// Nothing parses the mirror back, so it cannot drift into being wrong.
//
// Unlike journals and minds, nothing here rolls off. That is the point of the room: an
// employee files something here when it needs to outlive the run that produced it. The
// only bound is MAX_ARTIFACT_BYTES per body, so one confused agent pasting a snapshot
// dump cannot fill the disk.
//
// This module holds no trading authority. It stores text.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { stateStore } from './stateStore'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactPatch, ArtifactSummary, NewArtifactInput } from '../shared/library'
import { MAX_ARTIFACT_BYTES } from '../shared/library'

const LIBRARY_DIR = join(process.cwd(), 'data', 'crypto', 'office', 'library')

/** Filesystem-safe stem from a title, so the directory reads like a shelf. */
function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || 'untitled').slice(0, 60)
}

function ts(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16)
}

class Library {
  private items = new Map<string, Artifact>()
  /** id → file basename. Fixed at creation so retitling never orphans a file. */
  private basenames = new Map<string, string>()

  constructor() {
    this.load()
  }

  private load(): void {
    if (!existsSync(LIBRARY_DIR)) return
    for (const name of readdirSync(LIBRARY_DIR)) {
      if (!name.endsWith('.json')) continue
      try {
        const rec = stateStore.readJson<Artifact>(join(LIBRARY_DIR, name), undefined as unknown as Artifact)
        if (!rec?.id) continue
        this.items.set(rec.id, rec)
        this.basenames.set(rec.id, name.slice(0, -'.json'.length))
      } catch (e) {
        console.warn(`[library] skipping unreadable ${name}: ${(e as Error).message}`)
      }
    }
    if (this.items.size) console.log(`[library] loaded ${this.items.size} artifact(s)`)
  }

  private persist(rec: Artifact): void {
    mkdirSync(LIBRARY_DIR, { recursive: true })
    const base = this.basenames.get(rec.id) ?? `${slugify(rec.title)}-${rec.id.slice(0, 8)}`
    this.basenames.set(rec.id, base)
    stateStore.writeJson(join(LIBRARY_DIR, `${base}.json`), rec)
    if (rec.format === 'markdown' || rec.format === 'text') {
      const header = [
        `# ${rec.title}`,
        '',
        `_${rec.kind} · by ${rec.authorId} · filed ${ts(rec.createdAt)}` +
          `${rec.revision > 1 ? ` · rev ${rec.revision}, updated ${ts(rec.updatedAt)}` : ''}_`,
        rec.summary ? `\n> ${rec.summary}` : '',
        rec.symbols.length ? `\n**Symbols:** ${rec.symbols.join(', ')}` : '',
        rec.tags.length ? `**Tags:** ${rec.tags.join(', ')}` : '',
        '',
        '---',
        ''
      ].filter((l) => l !== '').join('\n')
      writeFileSync(join(LIBRARY_DIR, `${base}.md`), `${header}\n${rec.body}\n`)
    }
  }

  /** Shelf view: everything except the bodies, newest first with pinned on top. */
  list(): ArtifactSummary[] {
    const superseded = new Map<string, string>()
    for (const a of this.items.values()) {
      if (a.supersedes) superseded.set(a.supersedes, a.id)
    }
    return [...this.items.values()]
      .map(({ body, ...meta }) => ({
        ...meta,
        bytes: Buffer.byteLength(body, 'utf8'),
        supersededBy: superseded.get(meta.id) ?? null
      }))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt))
  }

  get(id: string): Artifact | null {
    return this.items.get(id) ?? null
  }

  create(input: NewArtifactInput): { ok: true; artifact: Artifact } | { ok: false; error: string } {
    const title = input.title.trim()
    if (!title) return { ok: false, error: 'title required' }
    const body = input.body ?? ''
    if (Buffer.byteLength(body, 'utf8') > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `body exceeds ${Math.floor(MAX_ARTIFACT_BYTES / 1024)}KB — file the analysis, not the raw data` }
    }
    if (input.supersedes && !this.items.has(input.supersedes)) {
      return { ok: false, error: `supersedes: no artifact ${input.supersedes}` }
    }
    const now = Date.now()
    const rec: Artifact = {
      id: randomUUID(),
      title,
      kind: input.kind ?? 'note',
      format: input.format ?? 'markdown',
      authorId: input.authorId ?? 'operator',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      summary: (input.summary ?? '').trim(),
      tags: input.tags ?? [],
      symbols: (input.symbols ?? []).map((s) => s.toUpperCase()),
      body,
      resolvesAt: input.resolvesAt ?? null,
      // A call with a resolution date starts life ungraded, by definition.
      outcome: input.resolvesAt ? 'pending' : 'none',
      resolution: '',
      supersedes: input.supersedes ?? null,
      pinned: false
    }
    this.items.set(rec.id, rec)
    this.persist(rec)
    console.log(`[library] ${rec.authorId} filed "${rec.title}" (${rec.kind}, ${rec.id.slice(0, 8)})`)
    return { ok: true, artifact: rec }
  }

  update(id: string, patch: ArtifactPatch): { ok: true; artifact: Artifact } | { ok: false; error: string } {
    const rec = this.items.get(id)
    if (!rec) return { ok: false, error: 'unknown artifact' }
    if (patch.body !== undefined && Buffer.byteLength(patch.body, 'utf8') > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `body exceeds ${Math.floor(MAX_ARTIFACT_BYTES / 1024)}KB` }
    }
    // Only a change to the document itself counts as a revision; pinning or grading a
    // forecast is filing work, not rewriting it.
    const rewrote = (patch.body !== undefined && patch.body !== rec.body) ||
      (patch.title !== undefined && patch.title.trim() !== rec.title)

    if (patch.title !== undefined && patch.title.trim()) rec.title = patch.title.trim()
    if (patch.body !== undefined) rec.body = patch.body
    if (patch.kind) rec.kind = patch.kind
    if (patch.format) rec.format = patch.format
    if (patch.summary !== undefined) rec.summary = patch.summary.trim()
    if (Array.isArray(patch.tags)) rec.tags = patch.tags
    if (Array.isArray(patch.symbols)) rec.symbols = patch.symbols.map((s) => s.toUpperCase())
    if (patch.resolvesAt !== undefined) {
      rec.resolvesAt = patch.resolvesAt
      if (patch.resolvesAt && rec.outcome === 'none') rec.outcome = 'pending'
    }
    if (patch.outcome) rec.outcome = patch.outcome
    if (patch.resolution !== undefined) rec.resolution = patch.resolution
    if (typeof patch.pinned === 'boolean') rec.pinned = patch.pinned
    if (rewrote) rec.revision += 1
    rec.updatedAt = Date.now()
    this.persist(rec)
    return { ok: true, artifact: rec }
  }

  remove(id: string): boolean {
    const rec = this.items.get(id)
    if (!rec) return false
    const base = this.basenames.get(id)
    this.items.delete(id)
    this.basenames.delete(id)
    if (base) {
      // The .json is stored state and must leave the database too; the .md is a
      // write-only human mirror that was never stored, so a plain rm is right.
      stateStore.deleteJson(join(LIBRARY_DIR, `${base}.json`))
      try { rmSync(join(LIBRARY_DIR, `${base}.md`), { force: true }) } catch { /* already gone */ }
    }
    console.log(`[library] removed "${rec.title}" (${id.slice(0, 8)})`)
    return true
  }

  /** Compact shelf listing for an agent's system prompt — enough to know what already
   *  exists and what to open, without pasting whole documents into the context. */
  promptDigest(limit = 12): string {
    const rows = this.list().filter((a) => !a.supersededBy).slice(0, limit)
    if (!rows.length) return '  (the library is empty — you would be the first to file something)'
    return rows.map((a) => {
      const bits = [`[${a.kind}]`, `"${a.title}"`, `by @${a.authorId}`, ts(a.updatedAt)]
      if (a.symbols.length) bits.push(a.symbols.join('/'))
      if (a.outcome === 'pending') bits.push('call pending')
      return `  ${a.id} — ${bits.join(' · ')}${a.summary ? `\n      ${a.summary.slice(0, 160)}` : ''}`
    }).join('\n')
  }
}

export const library = new Library()
