// The Manager's File — the desk's single queue of outstanding questions.
//
// shared/managerFile.ts holds the rules; this holds the state. One JSON file at
// data/crypto/office/managers-file.json, readable without the app running, same as
// everything else in the office.
//
// The file is a VIEW that persists its own triage. `refresh()` re-scans the board and the
// blocker board on every watch tick; anything new lands as 'new', anything the manager has
// already touched keeps its triage, and anything whose source resolved itself closes. The
// scan is the input, the triage is the state, and the two never fight — see mergeIntoFile.
//
// Nothing here grants authority. It routes questions; server/agents.ts decides who runs
// and shared/agents.ts decides what they may do once awake.

import { join } from 'node:path'
import type { ManagerFileItem } from '../shared/managerFile'
import {
  answerItem, assignItem, closeItem, collectBlockerItems, collectMentionItems, deskManagerId,
  managerDigest, markAssignmentsDelivered, mentionWakeDue, mergeIntoFile, openItems,
  pendingAssignments
} from '../shared/managerFile'
import { office } from './office'
import { blockerBoard } from './blockers'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'

const FILE = join(process.cwd(), 'data', 'crypto', 'office', 'managers-file.json')

// Closed rows are kept so the manager can see what the desk sorted out on its own, but the
// open set is the working list and the only thing that reaches a prompt.
const MAX_CLOSED_KEPT = 200

interface PersistShape {
  items: ManagerFileItem[]
}

/** How long the resolved manager id is trusted before the roster is read again. */
const MANAGER_CACHE_MS = 60_000

class ManagerFileStore {
  private items: ManagerFileItem[] = []
  /** Refreshing rewrites the file, so a tick that changed nothing should not touch disk. */
  private lastWritten = ''
  private managerCache: { id: string | null; at: number } | null = null

  constructor() {
    this.items = stateStore.readJson<PersistShape>(FILE, { items: [] }).items ?? []
    if (this.items.length) {
      console.log(`[manager-file] loaded ${openItems(this.items).length} open of ${this.items.length}`)
    }
  }

  private save(): void {
    const open = this.items.filter((i) => i.status !== 'closed')
    const closed = this.items.filter((i) => i.status === 'closed')
      .sort((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at))
      .slice(0, MAX_CLOSED_KEPT)
    this.items = [...open, ...closed]
    const payload = JSON.stringify({ items: this.items } satisfies PersistShape)
    if (payload === this.lastWritten) return
    this.lastWritten = payload
    stateStore.writeJson(FILE, { items: this.items } satisfies PersistShape)
  }

  /** Who the file belongs to. Null when the roster cannot name a manager — the caller
   *  then leaves mention waking off entirely rather than picking someone arbitrary.
   *
   *  Cached: listPersonnel() opens one file per employee, and this is asked on every watch
   *  tick and once per agent per prompt build. The roster changes on a hire, not on a tick. */
  managerId(): string | null {
    const now = Date.now()
    if (this.managerCache && now - this.managerCache.at < MANAGER_CACHE_MS) return this.managerCache.id
    const id = deskManagerId(office.listPersonnel())
    this.managerCache = { id, at: now }
    return id
  }

  /** Dropped on a hire or an HR edit, so a new manager takes effect at once. */
  invalidateManager(): void {
    this.managerCache = null
  }

  /**
   * Folds the current board and blocker board onto the file. Idempotent: item ids are
   * derived from their source, so re-scanning the same desk adds nothing.
   */
  refresh(now = Date.now()): ManagerFileItem[] {
    const opts = { managerId: this.managerId() ?? '', now }
    const incoming = [
      ...collectMentionItems(office.listThreads(), opts),
      ...collectBlockerItems(blockerBoard.open(), opts)
    ]
    const before = this.items.length
    const beforeOpen = openItems(this.items).length
    this.items = mergeIntoFile(this.items, incoming, now)
    const added = this.items.length - before
    if (added > 0) console.log(`[manager-file] +${added} item(s) — ${openItems(this.items).length} open`)
    else if (openItems(this.items).length !== beforeOpen) {
      console.log(`[manager-file] ${openItems(this.items).length} open (${beforeOpen - openItems(this.items).length} closed at source)`)
    }
    this.save()
    return this.items
  }

  list(): ManagerFileItem[] {
    return [...this.items]
  }

  open(): ManagerFileItem[] {
    return openItems(this.items)
  }

  get(id: string): ManagerFileItem | null {
    return this.items.find((i) => i.id === id) ?? null
  }

  assign(id: string, to: string, instruction: string, by: string): { ok: true; item: ManagerFileItem } | { ok: false; error: string } {
    const r = assignItem(this.items, { id, to, instruction, now: Date.now() })
    if (!r.ok) return r
    this.items = r.items
    this.save()
    auditLog.note({
      action: 'manager-file.assign',
      resource: `agent:${to}`,
      summary: `${by} assigned ${r.item.kind} ${id} to ${to}: ${instruction.slice(0, 120)}`,
      after: r.item
    })
    console.log(`[manager-file] ${by} → @${to}: ${instruction.slice(0, 80)}`)
    return { ok: true, item: r.item }
  }

  answer(id: string, answer: string, by: string): { ok: true; item: ManagerFileItem } | { ok: false; error: string } {
    const r = answerItem(this.items, { id, answer, by, now: Date.now() })
    if (!r.ok) return r
    this.items = r.items
    this.save()
    auditLog.note({
      action: 'manager-file.answer',
      resource: `agent:${r.item.fromId}`,
      summary: `${by} answered ${id}: ${answer.slice(0, 120)}`,
      after: r.item
    })
    console.log(`[manager-file] ${by} answered ${id}`)
    return { ok: true, item: r.item }
  }

  close(id: string, by: string): { ok: true; item: ManagerFileItem } | { ok: false; error: string } {
    const r = closeItem(this.items, { id, by, now: Date.now() })
    if (!r.ok) return r
    this.items = r.items
    this.save()
    auditLog.note({
      action: 'manager-file.close',
      resource: `agent:${r.item.fromId}`,
      summary: `${by} closed ${id}`,
      after: r.item
    })
    return { ok: true, item: r.item }
  }

  /** The manager's working note on an item. Never changes its status. */
  note(id: string, text: string): { ok: true; item: ManagerFileItem } | { ok: false; error: string } {
    const found = this.get(id)
    if (!found) return { ok: false, error: `no item ${id} on the file` }
    const next = { ...found, note: text.trim() }
    this.items = this.items.map((i) => (i.id === id ? next : i))
    this.save()
    return { ok: true, item: next }
  }

  /** Assigned work this agent has not been handed yet — the reason to wake it. */
  pendingFor(agentId: string): ManagerFileItem[] {
    return pendingAssignments(this.items, agentId)
  }

  markDelivered(ids: string[]): void {
    if (!ids.length) return
    this.items = markAssignmentsDelivered(this.items, ids, Date.now())
    this.save()
  }

  /** True when something untriaged has landed since the manager's last automatic wake. */
  wakeDue(since: number): boolean {
    return mentionWakeDue(this.items, since)
  }

  /** The file rendered for the manager's system prompt. */
  digest(now = Date.now()): string {
    return managerDigest(this.items, { now })
  }

  stats(): { open: number; needsTriage: number; assigned: number; answered: number; closed: number } {
    const by = (s: ManagerFileItem['status']): number => this.items.filter((i) => i.status === s).length
    return {
      open: openItems(this.items).length,
      needsTriage: by('new'),
      assigned: by('assigned'),
      answered: by('answered'),
      closed: by('closed')
    }
  }
}

export const managerFile = new ManagerFileStore()
