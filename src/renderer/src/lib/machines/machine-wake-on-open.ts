import { toast } from 'sonner'
import type { MachineActionResult, MachineRecord } from '../../../../shared/machine-inventory'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getMachineSources } from '@/store/machines'
import { translate } from '@/i18n/i18n'
import { machineNeedsWake } from './machine-display-state'
import { findMachineForHost, machineTargetKey, type MachineMatch } from './machine-host-match'

const wakesInFlight = new Map<string, Promise<void>>()

async function wake(match: MachineMatch): Promise<MachineActionResult<MachineRecord>> {
  const target = { providerKey: match.snapshot.providerKey, machineId: match.machine.id }
  if (match.environmentId === null) {
    const woken = await window.api.machines.wake(target)
    // Why: reconnecting now spares the terminal its first reconnect attempt against a cold host.
    return woken.ok ? window.api.machines.connect(target).then(() => woken) : woken
  }
  // Why: a paired server's provider wakes its own machine; this app only asks.
  return callRuntimeRpc<MachineActionResult<MachineRecord>>(
    { kind: 'environment', environmentId: match.environmentId },
    'machines.wake',
    target
  )
}

/**
 * Opening a worktree whose machine sleeps (or is archived) wakes it once; repeat opens while the
 * wake runs join it. Navigation never waits on this.
 */
export function wakeMachineForHost(hostId: string | null | undefined): Promise<void> {
  const match = findMachineForHost(hostId, getMachineSources())
  if (!match || !machineNeedsWake(match.machine.state)) {
    return Promise.resolve()
  }
  const key = machineTargetKey({
    providerKey: match.snapshot.providerKey,
    machineId: match.machine.id
  })
  const existing = wakesInFlight.get(key)
  if (existing) {
    return existing
  }
  const reportFailure = (description: string): void => {
    toast.error(
      translate('auto.lib.machines.machineWakeOnOpen.wakeFailed', 'Couldn’t wake {{name}}', {
        name: match.machine.name
      }),
      { description }
    )
  }
  const run = wake(match)
    .then((result) => {
      if (!result.ok) {
        reportFailure(result.message)
      }
    })
    .catch((error: unknown) =>
      reportFailure(error instanceof Error ? error.message : String(error))
    )
    .finally(() => wakesInFlight.delete(key))
  wakesInFlight.set(key, run)
  return run
}
