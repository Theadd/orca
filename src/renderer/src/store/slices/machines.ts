import type { StateCreator } from 'zustand'
import type { MachineProviderSnapshot } from '../../../../shared/machine-inventory'
import type { AppState } from '../types'

export type MachinesSlice = {
  /** This app's machine providers, keyed by provider, as last pushed by main. */
  machineProviders: Readonly<Record<string, MachineProviderSnapshot>>
  /** Paired servers' machine providers, keyed by environment id. */
  machineEnvironmentProviders: Readonly<Record<string, readonly MachineProviderSnapshot[]>>
  applyMachineSnapshot: (snapshot: MachineProviderSnapshot) => void
  setMachineEnvironmentSnapshots: (
    environmentId: string,
    snapshots: readonly MachineProviderSnapshot[]
  ) => void
}

/** A snapshot replaces the held one only when it is at least as fresh. */
function isNewer(
  next: MachineProviderSnapshot,
  held: MachineProviderSnapshot | undefined
): boolean {
  return !held || (next.listedAt ?? 0) >= (held.listedAt ?? 0)
}

export const createMachinesSlice: StateCreator<AppState, [], [], MachinesSlice> = (set) => ({
  machineProviders: {},
  machineEnvironmentProviders: {},
  applyMachineSnapshot: (snapshot) =>
    set((state) =>
      isNewer(snapshot, state.machineProviders[snapshot.providerKey])
        ? { machineProviders: { ...state.machineProviders, [snapshot.providerKey]: snapshot } }
        : {}
    ),
  setMachineEnvironmentSnapshots: (environmentId, snapshots) =>
    set((state) => ({
      machineEnvironmentProviders: {
        ...state.machineEnvironmentProviders,
        [environmentId]: snapshots
      }
    }))
})
