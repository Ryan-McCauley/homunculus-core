// The library: where employees file work that outlives a run.
//
// A journal note is private and short — "what I concluded today". A board thread is a
// conversation. An artifact is neither: it is a *document*, written to be read later by
// someone who was not there. Research, a forecast, a post-mortem, a table of base rates.
//
// The distinction that matters: journals and minds are capped and roll off (see
// server/office.ts). The library does not. If an employee wants something to survive,
// this is where it goes.

export type ArtifactKind =
  | 'research'   // a study: question, method, numbers, conclusion
  | 'report'     // a periodic write-up (desk review, weekly conditions)
  | 'forecast'   // a falsifiable call with a resolution date
  | 'plan'       // a proposed course of action
  | 'postmortem' // what went wrong and why
  | 'dataset'    // extracted numbers, kept so nobody re-derives them
  | 'note'       // anything else worth keeping

export const ARTIFACT_KINDS: ArtifactKind[] = ['research', 'report', 'forecast', 'plan', 'postmortem', 'dataset', 'note']

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  research: 'RESEARCH',
  report: 'REPORT',
  forecast: 'FORECAST',
  plan: 'PLAN',
  postmortem: 'POST-MORTEM',
  dataset: 'DATASET',
  note: 'NOTE'
}

/** How the body should be rendered. Nothing is executed — this is display only. */
export type ArtifactFormat = 'markdown' | 'text' | 'json' | 'csv'

export const ARTIFACT_FORMATS: ArtifactFormat[] = ['markdown', 'text', 'json', 'csv']

/** A forecast is only worth filing if it can be graded. Artifacts carrying a resolution
 *  date get one of these; everything else stays 'none'. */
export type ArtifactOutcome = 'none' | 'pending' | 'correct' | 'wrong' | 'void'

export const ARTIFACT_OUTCOME_LABELS: Record<ArtifactOutcome, string> = {
  none: '',
  pending: 'PENDING',
  correct: 'CORRECT',
  wrong: 'WRONG',
  void: 'VOID'
}

export interface Artifact {
  id: string
  title: string
  kind: ArtifactKind
  format: ArtifactFormat
  /** agentId of the author, or 'operator'. */
  authorId: string
  createdAt: number
  updatedAt: number
  /** Bumped on every edit. A document that has been revised eleven times is telling you
   *  something about how settled its conclusion is. */
  revision: number
  /** One or two sentences — what this says, for someone deciding whether to open it. */
  summary: string
  tags: string[]
  /** Trading pairs this document is about, e.g. ['WIFUSD']. Lets a colleague working a
   *  symbol find prior work on it without reading every title. */
  symbols: string[]
  /** The document. Never interpreted, only stored and displayed. */
  body: string
  /** Set when the artifact makes a call that can later be graded. */
  resolvesAt: number | null
  outcome: ArtifactOutcome
  /** Filled in when the call resolves — how it actually turned out. */
  resolution: string
  /** Artifact id this one replaces. Superseded documents stay in the library, marked. */
  supersedes: string | null
  pinned: boolean
}

/** Metadata without the body — what the shelf renders. */
export type ArtifactSummary = Omit<Artifact, 'body'> & { bytes: number; supersededBy: string | null }

export interface NewArtifactInput {
  title: string
  body: string
  kind?: ArtifactKind
  format?: ArtifactFormat
  authorId?: string
  summary?: string
  tags?: string[]
  symbols?: string[]
  resolvesAt?: number | null
  supersedes?: string | null
}

export interface ArtifactPatch {
  title?: string
  body?: string
  kind?: ArtifactKind
  format?: ArtifactFormat
  summary?: string
  tags?: string[]
  symbols?: string[]
  resolvesAt?: number | null
  outcome?: ArtifactOutcome
  resolution?: string
  pinned?: boolean
}

/** Bodies are documents, not logs, but a runaway agent could still paste a snapshot dump
 *  into one. 256 KB is far more than any real write-up and small enough to render. */
export const MAX_ARTIFACT_BYTES = 256 * 1024

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === 'string' && (ARTIFACT_KINDS as string[]).includes(v)
}

export function isArtifactFormat(v: unknown): v is ArtifactFormat {
  return typeof v === 'string' && (ARTIFACT_FORMATS as string[]).includes(v)
}

export function isArtifactOutcome(v: unknown): v is ArtifactOutcome {
  return v === 'none' || v === 'pending' || v === 'correct' || v === 'wrong' || v === 'void'
}
