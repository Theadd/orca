import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'

const clockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** "Deletes 4:12 PM": the absolute local time, which a person can plan around. */
export function formatMachineExpiry(expiresAt: number): string {
  return translate('auto.lib.machines.machineCopy.deletesAt', 'Deletes {{time}}', {
    time: clockTime.format(expiresAt)
  })
}

export function formatProviderUnreachable(lastSeenAt: number | null, now: number): string {
  return lastSeenAt === null
    ? translate('auto.lib.machines.machineCopy.cantReach', 'Can’t reach')
    : translate('auto.lib.machines.machineCopy.cantReachSeen', 'Can’t reach · seen {{ago}} ago', {
        ago: formatShortTimeAgo(lastSeenAt, now)
      })
}
