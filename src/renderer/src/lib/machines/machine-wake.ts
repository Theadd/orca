import type {
  MachineActionResult,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { machineTargetKey } from './machine-host-match'

const wakesInFlight = new Map<string, Promise<MachineActionResult<MachineRecord>>>()

function startWake(
  target: MachineTarget,
  environmentId: string | null,
  operationId: string | undefined
): Promise<MachineActionResult<MachineRecord>> {
  if (environmentId === null) {
    return window.api.machines.wake({ ...target, ...(operationId ? { operationId } : {}) })
  }
  // Why: a paired server's provider wakes its own machine; this app only asks.
  return callRuntimeRpc<MachineActionResult<MachineRecord>>(
    { kind: 'environment', environmentId },
    'machines.wake',
    target
  )
}

/**
 * The one way the UI wakes a machine. Submitting the composer and opening a worktree on the same
 * machine join a single wake; a joiner's `operationId` gets no log lines of its own.
 */
export function wakeMachine(
  target: MachineTarget,
  options: { environmentId?: string | null; operationId?: string } = {}
): Promise<MachineActionResult<MachineRecord>> {
  const environmentId = options.environmentId ?? null
  const key = `${environmentId ?? ''}\0${machineTargetKey(target)}`
  const existing = wakesInFlight.get(key)
  if (existing) {
    return existing
  }
  const run = startWake(target, environmentId, options.operationId).finally(() =>
    wakesInFlight.delete(key)
  )
  wakesInFlight.set(key, run)
  return run
}
