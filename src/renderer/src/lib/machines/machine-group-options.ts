import type {
  MachineProviderFailure,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord
} from '../../../../shared/machine-inventory'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { MachineLifetime } from '../../../../shared/machine-provider-protocol'
import { getMachineDisplayState, type MachineDisplayState } from './machine-display-state'

export type MachineOption = {
  providerKey: MachineProviderKey
  machineId: string
  name: string
  state: MachineDisplayState
  lifetime: MachineLifetime
  /** Local epoch ms the provider deletes it, already corrected for the provider's clock. */
  expiresAt: number | null
}

/** Why a provider can't list machines, if it can't; each has exactly one fix row. */
export type MachineGroupStatus =
  | { kind: 'ready' }
  | { kind: 'unreachable'; lastSeenAt: number | null }
  | { kind: 'sign-in' }
  | { kind: 'different-account' }
  | { kind: 'invalid-response' }

export type MachineGroupOption = {
  providerKey: MachineProviderKey
  name: string
  status: MachineGroupStatus
  /** Live machines, bound to this project first, then most recent. */
  machines: readonly MachineOption[]
  archived: readonly MachineOption[]
  canCreate: boolean
}

/** The host a connected machine runs worktrees on, if it has been connected. */
export function getMachineHostId(machine: MachineRecord): ExecutionHostId | null {
  if (machine.sshTargetId) {
    return toSshExecutionHostId(machine.sshTargetId)
  }
  return machine.runtimeEnvironmentId
    ? toRuntimeExecutionHostId(machine.runtimeEnvironmentId)
    : null
}

/** Local epoch ms of `expiresAt`, corrected for the provider's clock. */
export function getMachineLocalExpiry(
  machine: Pick<MachineRecord, 'expiresAt'>,
  clockOffsetMs: number | undefined
): number | null {
  const expiresAt = machine.expiresAt ? Date.parse(machine.expiresAt) : Number.NaN
  return Number.isNaN(expiresAt) ? null : expiresAt - (clockOffsetMs ?? 0)
}

function groupStatus(snapshot: MachineProviderSnapshot): MachineGroupStatus {
  const failure: MachineProviderFailure | undefined = snapshot.lastFailure
  if (!failure) {
    return { kind: 'ready' }
  }
  switch (failure.code) {
    case 'auth-required':
      return { kind: 'sign-in' }
    case 'context-mismatch':
      return { kind: 'different-account' }
    case 'invalid-response':
    case 'protocol-unsupported':
      return { kind: 'invalid-response' }
    case 'timeout':
    case 'unavailable':
    case 'not-found':
    case 'conflict':
    case 'quota':
    case 'unsupported':
    case 'cancelled':
      return { kind: 'unreachable', lastSeenAt: snapshot.listedAt ?? null }
  }
}

function toOption(snapshot: MachineProviderSnapshot, machine: MachineRecord): MachineOption {
  return {
    providerKey: snapshot.providerKey,
    machineId: machine.id,
    name: machine.name,
    state: getMachineDisplayState(machine.state),
    lifetime: machine.lifetime,
    expiresAt: getMachineLocalExpiry(machine, snapshot.clockOffsetMs)
  }
}

/**
 * Picker groups, one per provider. Machines this project already runs on lead, then the newest;
 * Gone machines can't run anything, so they are left out.
 */
export function buildMachineGroupOptions({
  snapshots,
  projectHostIds,
  allowCreate
}: {
  snapshots: readonly MachineProviderSnapshot[]
  /** Hosts where the selected project already has a location. */
  projectHostIds: ReadonlySet<string>
  allowCreate: boolean
}): MachineGroupOption[] {
  return snapshots.map((snapshot) => {
    const usable = snapshot.machines.filter((machine) => machine.state !== 'gone')
    const bound = (machine: MachineRecord): number => {
      const hostId = getMachineHostId(machine)
      return hostId && projectHostIds.has(hostId) ? 0 : 1
    }
    const ordered = [...usable].sort(
      (a, b) => bound(a) - bound(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    )
    return {
      providerKey: snapshot.providerKey,
      name: snapshot.name,
      status: groupStatus(snapshot),
      machines: ordered
        .filter((machine) => machine.state !== 'archived')
        .map((machine) => toOption(snapshot, machine)),
      archived: ordered
        .filter((machine) => machine.state === 'archived')
        .map((machine) => toOption(snapshot, machine)),
      canCreate: allowCreate && (snapshot.capabilities?.verbs.includes('create') ?? false)
    }
  })
}
