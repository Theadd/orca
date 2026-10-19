import { describe, expect, it, vi } from 'vitest'

vi.mock('../theme/mobile-theme', () => ({
  colors: { statusGreen: 'green', statusAmber: 'amber', statusRed: 'red', textMuted: 'muted' }
}))

import { machineRowModel } from './machine-row-model'

const base = { id: 'm', name: 'dev', lastSeenAt: 0 }

describe('machineRowModel', () => {
  it('offers Sleep on a running machine and Wake on a sleeping or archived one', () => {
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'running' }, 0, 0)
    ).toMatchObject({ stateLabel: 'Running', action: 'sleep', subtitle: 'Persistent' })
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'sleeping' }, 0, 0).action
    ).toBe('wake')
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'archived' }, 0, 0).action
    ).toBe('wake')
    expect(machineRowModel({ ...base, lifetime: 'persistent', state: 'gone' }, 0, 0)).toMatchObject(
      {
        stateLabel: 'Gone',
        stateColor: 'red',
        action: null
      }
    )
  })

  it('reads expiry on the provider clock', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    const machine = {
      ...base,
      lifetime: 'temporary' as const,
      state: 'running',
      expiresAt: '2026-10-18T12:00:30Z'
    }
    // The provider runs a minute ahead, so its 12:00:30 has already passed here.
    expect(machineRowModel(machine, 60_000, now).subtitle).toBe('Temporary · expired')
    expect(machineRowModel(machine, 0, now).subtitle).toMatch(/^Temporary · deletes at /)
  })
})
