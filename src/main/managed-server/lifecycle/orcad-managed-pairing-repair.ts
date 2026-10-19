/**
 * Pairing again with a managed orcad that refused this desktop's token. SSH access is what paired
 * it in the first place, so the repair reads the offer the server publishes now over SSH, the same
 * way a deploy or update does, and keeps it only when it names the host key this desktop pinned.
 */
import { parsePairingCode } from '../../../shared/pairing'
import { errorMessage } from '../../../shared/error-message'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { refreshManagedOrcadPairing } from '../../../shared/runtime-environment-managed-orcad-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../../shared/runtime-environment-reconciliation-record'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { tunneledOrcadPairingCode } from '../../ssh/orcad-tunneled-pairing'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { readActiveManagedOrcadReadiness } from './orcad-managed-bound-port'
import { OrcadManagedIdentityError } from './orcad-managed-tunnel-identity'
import { OrcadManagedPairingRepairFailedError } from './orcad-managed-pairing-repair-failure'
import { notifyManagedOrcadPairingRepaired } from './orcad-managed-pairing-repaired-listener'

// Why a cap on attempts: a server that refuses every fresh offer would otherwise re-pair forever.
export const MAX_PAIRING_REPAIRS_PER_WINDOW = 3
export const PAIRING_REPAIR_WINDOW_MS = 10 * 60_000
// Why remembered briefly: every reconnecting pane would otherwise re-read the host over SSH.
export const PAIRING_REPAIR_FAILURE_HOLD_MS = 15_000

export type ManagedOrcadPairingRepairDeps = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  connect: (environment: KnownRuntimeEnvironment) => Promise<{
    target: SshTarget
    connection: OrcadHostTransport
  }>
  readReadiness: (input: {
    target: SshTarget
    connection: OrcadHostTransport
  }) => Promise<ServeReadiness | null>
  refresh: (environmentId: string, pairingCode: string) => KnownRuntimeEnvironment
  /** Retires every transport still authenticating with the refused token, once per repair. */
  repaired: (environmentId: string) => void | Promise<void>
  now: () => number
}

export function liveManagedOrcadPairingRepairDeps(
  userDataPath: string
): ManagedOrcadPairingRepairDeps {
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    connect: connectManagedOrcadHost,
    readReadiness: readActiveManagedOrcadReadiness,
    refresh: (environmentId, pairingCode) =>
      refreshManagedOrcadPairing(userDataPath, environmentId, pairingCode),
    repaired: notifyManagedOrcadPairingRepaired,
    now: Date.now
  }
}

async function connectManagedOrcadHost(environment: KnownRuntimeEnvironment) {
  const deployment = getOrcadSshDeployment(environment)
  const store = getSshTargetRegistryStore()
  const connections = getSshConnectionManager()
  if (!deployment || !store || !connections) {
    throw new Error('SSH is unavailable on this client')
  }
  const target = store.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedOrcadFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('the SSH registration for this server was removed or re-created')
  }
  return { target, connection: await connections.connect(target) }
}

/** The pairing revision a refusal was seen under, so a repair that already landed is not redone. */
export function pairingRevisionOf(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

/**
 * One repair per environment at a time and a capped number of attempts per window, with a failure
 * held briefly. Keyed by the refused revision: a refusal seen under an older pairing than the
 * stored one was already answered, so it gets the stored pairing without reaching the host.
 */
export class ManagedOrcadPairingRepairs {
  private readonly inFlight = new Map<string, Promise<KnownRuntimeEnvironment>>()
  private readonly attemptedAt = new Map<string, number[]>()
  private readonly heldFailures = new Map<string, { error: Error; at: number }>()

  constructor(private readonly deps: ManagedOrcadPairingRepairDeps) {}

  repair(environmentId: string, refusedRevision: number): Promise<KnownRuntimeEnvironment> {
    const pending = this.inFlight.get(environmentId)
    if (pending) {
      return pending
    }
    const operation = this.run(environmentId, refusedRevision).finally(() => {
      this.inFlight.delete(environmentId)
    })
    this.inFlight.set(environmentId, operation)
    return operation
  }

  /** The new pairing was refused too, so it counts as a failed repair. */
  recordRefusedAfterRepair(environmentId: string): Error {
    return this.hold(
      environmentId,
      new OrcadManagedPairingRepairFailedError('the server refused the new pairing too')
    )
  }

  /** An explicit connect is the user asking again: neither a held failure nor the cap answers it. */
  forgetFailures(environmentId: string): void {
    this.heldFailures.delete(environmentId)
    this.attemptedAt.delete(environmentId)
  }

  private async run(
    environmentId: string,
    refusedRevision: number
  ): Promise<KnownRuntimeEnvironment> {
    const environment = this.deps.resolve(environmentId)
    if (pairingRevisionOf(environment) !== refusedRevision) {
      return environment
    }
    const now = this.deps.now()
    const held = this.heldFailures.get(environmentId)
    if (held && now - held.at < PAIRING_REPAIR_FAILURE_HOLD_MS) {
      throw held.error
    }
    const recent = (this.attemptedAt.get(environmentId) ?? []).filter(
      (at) => now - at < PAIRING_REPAIR_WINDOW_MS
    )
    if (recent.length >= MAX_PAIRING_REPAIRS_PER_WINDOW) {
      throw this.hold(
        environmentId,
        new OrcadManagedPairingRepairFailedError(
          `it tried ${recent.length} times in ${PAIRING_REPAIR_WINDOW_MS / 60_000} minutes ` +
            'without the server accepting a pairing'
        )
      )
    }
    assertRuntimeEnvironmentNotReconciling(environment)
    const deployment = getOrcadSshDeployment(environment)
    if (!deployment) {
      throw new OrcadManagedPairingRepairFailedError('this server is not managed over SSH')
    }
    // Why counted after connecting: losing SSH proves nothing about the pairing.
    const host = await this.deps.connect(environment)
    this.attemptedAt.set(environmentId, [...recent, now])
    const readiness = await this.deps.readReadiness(host)
    const pairingCode = this.publishedPairingCode(environmentId, readiness, deployment.localPort)
    const offer = parsePairingCode(pairingCode)
    const pinned = getPreferredPairingOffer(environment)
    // Why refuse: a server with another key is not the one this desktop paired, whatever SSH says.
    if (!offer || offer.publicKeyB64 !== pinned.publicKeyB64) {
      throw this.hold(
        environmentId,
        new OrcadManagedIdentityError(
          deployment.remotePort,
          "the host's server now publishes a different host key than the one this desktop pinned"
        )
      )
    }
    if (offer.deviceToken === pinned.deviceToken) {
      throw this.hold(
        environmentId,
        new OrcadManagedPairingRepairFailedError(
          'the server still offers the pairing it refused; restarting it on the host issues a new one'
        )
      )
    }
    let repaired: KnownRuntimeEnvironment
    try {
      repaired = this.deps.refresh(environmentId, pairingCode)
    } catch (error) {
      throw this.hold(environmentId, new OrcadManagedPairingRepairFailedError(errorMessage(error)))
    }
    this.heldFailures.delete(environmentId)
    await this.deps.repaired(environmentId)
    return repaired
  }

  private publishedPairingCode(
    environmentId: string,
    readiness: ServeReadiness | null,
    localPort: number
  ): string {
    if (!readiness) {
      throw this.hold(
        environmentId,
        new OrcadManagedPairingRepairFailedError(
          "the server hasn't published a pairing Orca can read"
        )
      )
    }
    if (!readiness.pairing.available) {
      throw this.hold(
        environmentId,
        new OrcadManagedPairingRepairFailedError(
          `the server isn't offering a pairing (${readiness.pairing.guidance})`
        )
      )
    }
    try {
      return tunneledOrcadPairingCode(readiness, localPort)
    } catch (error) {
      throw this.hold(environmentId, new OrcadManagedPairingRepairFailedError(errorMessage(error)))
    }
  }

  private hold(environmentId: string, error: Error): Error {
    this.heldFailures.set(environmentId, { error, at: this.deps.now() })
    return error
  }
}
