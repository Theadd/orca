import { translate } from '@/i18n/i18n'
import { getMachineLocalExpiry } from './machine-group-options'
import type { MachineExpiryWarning } from '../../../../shared/machine-inventory'
import type { MachineMatch } from './machine-host-match'

/** Work a machine's deletion would lose: uncommitted files and commits not on a remote. */
type MachineWorkAtRisk = { uncommitted: number; unpushed: number }

/** How long before a Temporary machine is deleted that Orca warns about unsaved work on it. */
export const MACHINE_EXPIRY_WARNING_MS = 15 * 60_000

const clockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Local expiry inside the warning window, or null when there is nothing to warn about yet. */
export function getWarnableExpiry(match: MachineMatch, now: number): number | null {
  if (match.machine.lifetime !== 'temporary' || match.machine.state === 'gone') {
    return null
  }
  const expiry = getMachineLocalExpiry(match.machine, match.snapshot.clockOffsetMs)
  return expiry !== null && expiry > now && expiry - now <= MACHINE_EXPIRY_WARNING_MS
    ? expiry
    : null
}

/** "3 uncommitted changes, 2 unpushed commits": what a delete would lose, empty parts left out. */
export function formatWorkAtRisk(work: MachineWorkAtRisk): string {
  const parts: string[] = []
  if (work.uncommitted === 1) {
    parts.push(
      translate('auto.lib.machines.machineExpiryWarning.uncommittedOne', '1 uncommitted change')
    )
  } else if (work.uncommitted > 1) {
    parts.push(
      translate(
        'auto.lib.machines.machineExpiryWarning.uncommitted',
        '{{count}} uncommitted changes',
        { count: work.uncommitted }
      )
    )
  }
  if (work.unpushed === 1) {
    parts.push(translate('auto.lib.machines.machineExpiryWarning.unpushedOne', '1 unpushed commit'))
  } else if (work.unpushed > 1) {
    parts.push(
      translate('auto.lib.machines.machineExpiryWarning.unpushed', '{{count}} unpushed commits', {
        count: work.unpushed
      })
    )
  }
  return parts.join(', ')
}

/**
 * "Deletes 4:12 PM · 3 unpushed commits" from main's warning, while the machine is still in its
 * last 15 minutes and the work is at risk or couldn't be read.
 */
export function getMachineExpiryWarning(
  match: MachineMatch,
  warning: MachineExpiryWarning | undefined,
  now: number
): string | null {
  // Why: a provider that extended the expiry leaves the old warning behind.
  if (!warning || getWarnableExpiry(match, now) === null) {
    return null
  }
  const work = warning.workAtRisk
  if (work !== null && work.uncommitted === 0 && work.unpushed === 0) {
    return null
  }
  return translate(
    'auto.lib.machines.machineExpiryWarning.warningAt',
    'Deletes {{time}} · {{work}}',
    {
      time: clockTime.format(warning.expiresAt),
      work:
        work === null
          ? translate(
              'auto.lib.machines.machineExpiryWarning.unknown',
              'Couldn’t check unsaved work'
            )
          : formatWorkAtRisk(work)
    }
  )
}
