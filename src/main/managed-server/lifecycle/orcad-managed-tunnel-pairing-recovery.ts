/**
 * The one place a managed tunnel build turns "our own server refused our token" into a re-pair.
 * The refusal is proven before this runs: it arrived sealed under the pinned host key, so a
 * foreign server never reaches the repair; it fails the build as a foreign answer instead.
 */
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { ManagedOrcadPairingRepairs } from './orcad-managed-pairing-repair'
import { OrcadManagedPairingRejectedError } from './orcad-managed-tunnel-identity'

export type ManagedOrcadPairingRecovery = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  repairs: ManagedOrcadPairingRepairs
  /** Retires every transport still authenticating with the refused token. */
  repaired: (environmentId: string) => void | Promise<void>
}

/** Builds once; a refused pairing re-pairs over SSH and builds once more on the new one. */
export async function buildWithPairingRepair(
  recovery: ManagedOrcadPairingRecovery,
  environmentId: string,
  build: (environment: KnownRuntimeEnvironment) => Promise<void>
): Promise<'built' | 'repaired'> {
  try {
    await build(recovery.resolve(environmentId))
    return 'built'
  } catch (error) {
    if (!(error instanceof OrcadManagedPairingRejectedError)) {
      throw error
    }
    console.warn('[ssh] The managed Orca server refused this desktop; pairing again:', error)
  }
  const repaired = await recovery.repairs.repair(environmentId)
  // Why before the rebuild: a failed rebuild still leaves no transport on the refused token.
  await recovery.repaired(environmentId)
  try {
    await build(repaired)
    return 'repaired'
  } catch (error) {
    throw error instanceof OrcadManagedPairingRejectedError
      ? recovery.repairs.recordRefusedAfterRepair(environmentId)
      : error
  }
}
