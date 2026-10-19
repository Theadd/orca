import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { probeManagedOrcadTunnel } from './orcad-managed-tunnel-resume'
import { ensureManagedOrcadServing } from './orcad-managed-serving'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import { getRemoteRuntimeSharedControlAnsweredAt } from '../../ipc/runtime-environments/runtime-environment-shared-control-answers'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  MANAGED_ORCAD_TUNNEL_TARGETING,
  type OrcadTunnelStartChecks
} from './orcad-managed-tunnel-target'
import {
  liveManagedOrcadPairingRepairDeps,
  ManagedOrcadPairingRepairs
} from './orcad-managed-pairing-repair'
import {
  buildWithPairingRepair,
  type ManagedOrcadPairingRecovery
} from './orcad-managed-tunnel-pairing-recovery'

const managedTunnels = new OrcadManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore,
  targeting: MANAGED_ORCAD_TUNNEL_TARGETING,
  ensureServing: (input) =>
    ensureManagedOrcadServing({
      ...input,
      probe: probeManagedOrcadTunnel,
      answeredAt: getRemoteRuntimeSharedControlAnsweredAt
    })
})

const pairingRepairs = new Map<string, ManagedOrcadPairingRepairs>()

function pairingRecovery(userDataPath: string): ManagedOrcadPairingRecovery {
  let repairs = pairingRepairs.get(userDataPath)
  if (!repairs) {
    repairs = new ManagedOrcadPairingRepairs(liveManagedOrcadPairingRepairDeps(userDataPath))
    pairingRepairs.set(userDataPath, repairs)
  }
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    repairs,
    ensure: (environment) =>
      managedTunnels.ensure(environment, () =>
        resolveEnvironmentOrNull(userDataPath, environment.id)
      )
  }
}

export async function ensureOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<void> {
  const { id } = resolveEnvironment(userDataPath, selector)
  await buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
    managedTunnels.ensure(environment, () => resolveEnvironmentOrNull(userDataPath, id))
  )
}

/** After a redeploy: the reused forward may target the port the previous server bound. */
export async function rebuildOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<'built' | 'repaired'> {
  const { id } = resolveEnvironment(userDataPath, selector)
  return buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
    managedTunnels.rebuild(environment, () => resolveEnvironmentOrNull(userDataPath, id))
  )
}

/**
 * A socket through a standing tunnel had its token refused. Forwarding anew re-proves which
 * server answers, so only our own server's refusal re-pairs; a foreign one fails as foreign.
 */
export function recoverRefusedManagedOrcadPairing(
  userDataPath: string,
  environmentId: string
): Promise<'built' | 'repaired'> {
  return rebuildOrcadManagedTunnel(userDataPath, environmentId)
}

/** An explicit connect is the user asking again, so recent failed re-pairs must not answer it. */
export function forgetFailedManagedOrcadPairingRepair(
  userDataPath: string,
  environmentId: string
): void {
  pairingRepairs.get(userDataPath)?.forgetFailures(environmentId)
}

function resolveEnvironmentOrNull(userDataPath: string, id: string) {
  try {
    return resolveEnvironment(userDataPath, id)
  } catch {
    return null
  }
}

export function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return managedTunnels.verifyServing(environment)
}

export function disposeOrcadManagedTunnels(): void {
  managedTunnels.dispose()
}

/** Why on quit: a system-ssh tunnel is its own `ssh -L` process and would outlive Orca. */
export function shutdownOrcadManagedTunnels(): Promise<void> {
  return managedTunnels.shutdown()
}

export function recoverOrcadManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => resolveEnvironmentOrNull(userDataPath, environmentId)
  })
}

export function startOrcadManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: OrcadTunnelStartChecks
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort, checks)
}

export function closeOrcadManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}
