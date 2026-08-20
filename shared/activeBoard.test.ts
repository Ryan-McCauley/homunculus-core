import { describe, it, expect } from 'vitest'
import {
  BOARD_MAX_AGE_MS,
  BOARD_MAX_MESSAGES,
  ACTIVE_BOARD_TAG,
  shouldRollBoard,
  activeBoardTitle,
  runAnnouncement,
  agentMayOpenThread
} from './activeBoard'

const HOUR = 3_600_000

describe('shouldRollBoard', () => {
  it('opens the first board when the desk has none', () => {
    expect(shouldRollBoard(null, 0)).toBe(true)
  })

  it('keeps posting to a fresh board rather than opening one per run', () => {
    // The bug this replaces: 61 Scout threads in four days, most of them empty.
    expect(shouldRollBoard({ createdAt: 0, messageCount: 3 }, 1 * HOUR)).toBe(false)
  })

  it('rolls to a new board once the current one is a day old', () => {
    expect(shouldRollBoard({ createdAt: 0, messageCount: 3 }, BOARD_MAX_AGE_MS + 1)).toBe(true)
  })

  it('rolls once the board gets too long to be worth reading', () => {
    expect(shouldRollBoard({ createdAt: 0, messageCount: BOARD_MAX_MESSAGES }, 1 * HOUR)).toBe(true)
  })

  it('does not roll one message short of the limit', () => {
    expect(shouldRollBoard({ createdAt: 0, messageCount: BOARD_MAX_MESSAGES - 1 }, 1 * HOUR)).toBe(false)
  })
})

describe('activeBoardTitle', () => {
  it('names the board for its UTC day, so the operator can find a given day', () => {
    expect(activeBoardTitle(Date.UTC(2026, 7, 19, 22, 4))).toContain('2026-08-19')
  })

  it('uses UTC, not the server\'s local day — the desk speaks UTC', () => {
    // 2026-08-19T23:30Z is still the 19th in UTC wherever the server happens to sit.
    expect(activeBoardTitle(Date.UTC(2026, 7, 19, 23, 30))).toContain('2026-08-19')
  })
})

describe('runAnnouncement', () => {
  const at = Date.UTC(2026, 7, 19, 22, 4)

  it('says who woke, and what woke them', () => {
    const msg = runAnnouncement({ agentId: 'trap-scout', agentName: 'Trap Scout', trigger: 'interval', runId: 'r1', at })
    expect(msg).toContain('Trap Scout')
    expect(msg).toContain('interval')
  })

  it('stamps the server clock in UTC — the timestamp agents kept hallucinating', () => {
    const msg = runAnnouncement({ agentId: 'trap-scout', agentName: 'Trap Scout', trigger: 'interval', runId: 'r1', at })
    expect(msg).toContain('2026-08-19T22:04')
  })

  it('does not @mention the agent — an @ films a triage item and burns desk attention', () => {
    const msg = runAnnouncement({ agentId: 'trap-scout', agentName: 'Trap Scout', trigger: 'interval', runId: 'r1', at })
    expect(msg).not.toContain('@')
  })
})

describe('agentMayOpenThread', () => {
  it('lets the desk manager open the board — that is who owns it', () => {
    expect(agentMayOpenThread('manager', 'manager').ok).toBe(true)
  })

  it('refuses a colleague opening its own thread, and says where to post instead', () => {
    const v = agentMayOpenThread('trap-scout', 'manager')
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/active board/i)
  })

  it('always lets the operator open a thread — the human is not an employee', () => {
    expect(agentMayOpenThread('operator', 'manager').ok).toBe(true)
  })

  it('falls back to allowing everyone when no manager has been appointed yet', () => {
    // Otherwise appointing nobody would silence the whole desk.
    expect(agentMayOpenThread('trap-scout', null).ok).toBe(true)
  })

  it('tags the board so it can be found without guessing at titles', () => {
    expect(ACTIVE_BOARD_TAG).toBeTruthy()
  })
})
