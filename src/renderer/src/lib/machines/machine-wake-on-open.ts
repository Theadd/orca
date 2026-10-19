import { toast } from 'sonner'
import type { MachineProviderErrorCode } from '../../../../shared/machine-provider-protocol'
import { getMachineSources } from '@/store/machines'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { machineNeedsWake } from './machine-display-state'
import { describeMachineFailure } from './machine-copy'
import { findMachineForHost, machineTargetKey, type MachineMatch } from './machine-host-match'
import { wakeMachine } from './machine-wake'

const opensInFlight = new Map<string, Promise<void>>()

type WakeOutcome = { ok: true } | { ok: false; code: MachineProviderErrorCode | null }

async function wakeAndConnect(match: MachineMatch): Promise<WakeOutcome> {
  const target = { providerKey: match.snapshot.providerKey, machineId: match.machine.id }
  const woken = await wakeMachine(target, { environmentId: match.environmentId })
  if (!woken.ok) {
    return { ok: false, code: woken.code }
  }
  if (match.environmentId !== null) {
    return { ok: true }
  }
  // Why: reconnecting now spares the terminal its first reconnect attempt against a cold host.
  const connected = await window.api.machines.connect(target)
  return connected.ok ? { ok: true } : { ok: false, code: connected.code }
}

/**
 * Opening a worktree whose machine sleeps (or is archived) wakes it once; repeat opens while the
 * wake runs join it. Navigation never waits on this. A worktree with terminals names the wake in
 * their reconnect banner; one without gets a toast, so the wake is announced in one place.
 */
export function wakeMachineForHost(
  hostId: string | null | undefined,
  worktreeId?: string
): Promise<void> {
  const match = findMachineForHost(hostId, getMachineSources())
  if (!match || !machineNeedsWake(match.machine.state)) {
    return Promise.resolve()
  }
  const key = machineTargetKey({
    providerKey: match.snapshot.providerKey,
    machineId: match.machine.id
  })
  const existing = opensInFlight.get(key)
  if (existing) {
    return existing
  }
  const name = match.machine.name
  const store = useAppStore.getState()
  const hasTerminals = worktreeId ? (store.tabsByWorktree[worktreeId]?.length ?? 0) > 0 : false
  const toastId = hasTerminals
    ? undefined
    : toast.loading(
        translate('auto.lib.machines.machineWakeOnOpen.waking', 'Waking {{name}}…', { name })
      )
  if (worktreeId) {
    store.setWorktreeMachineWaking(worktreeId, name)
  }
  const reportFailure = (code: MachineProviderErrorCode | null): void => {
    toast.error(
      translate('auto.lib.machines.machineWakeOnOpen.wakeFailed', 'Couldn’t wake {{name}}', {
        name
      }),
      {
        ...(toastId !== undefined ? { id: toastId } : {}),
        description: code
          ? describeMachineFailure(code)
          : translate(
              'auto.lib.machines.machineWakeOnOpen.wakeFailedUnknown',
              'Orca couldn’t reach the machine’s provider.'
            )
      }
    )
  }
  const run = wakeAndConnect(match)
    .then((outcome) => {
      if (outcome.ok) {
        if (toastId !== undefined) {
          toast.dismiss(toastId)
        }
      } else {
        reportFailure(outcome.code)
      }
    })
    .catch(() => reportFailure(null))
    .finally(() => {
      opensInFlight.delete(key)
      if (worktreeId) {
        useAppStore.getState().setWorktreeMachineWaking(worktreeId, null)
      }
    })
  opensInFlight.set(key, run)
  return run
}
