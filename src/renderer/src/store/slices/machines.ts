import type { StateCreator } from 'zustand'
import type { MachineProviderSnapshot } from '../../../../shared/machine-inventory'
import type { MachineChoice } from '@/lib/machines/machine-group-options'
import type { AppState } from '../types'

export type MachinesSlice = {
  /** This app's machine providers, keyed by provider, as last pushed by main. */
  machineProviders: Readonly<Record<string, MachineProviderSnapshot>>
  /** Paired servers' machine providers, keyed by environment id. */
  machineEnvironmentProviders: Readonly<Record<string, readonly MachineProviderSnapshot[]>>
  /** Worktrees whose machine is waking, by worktree id, with the machine's name. */
  wakingMachineByWorktreeId: Readonly<Record<string, string>>
  setWorktreeMachineWaking: (worktreeId: string, machineName: string | null) => void
  /** The machine a composer had chosen when sign-in closed it; read once when it reopens. */
  composerMachineRestore: MachineChoice | null
  setComposerMachineRestore: (choice: MachineChoice | null) => void
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

/** A healthy re-list that changed nothing keeps the held object, so nothing re-renders. */
function changesNothing(
  next: MachineProviderSnapshot,
  held: MachineProviderSnapshot | undefined
): boolean {
  return (
    held !== undefined &&
    !next.lastFailure &&
    JSON.stringify({ ...next, listedAt: 0 }) === JSON.stringify({ ...held, listedAt: 0 })
  )
}

export const createMachinesSlice: StateCreator<AppState, [], [], MachinesSlice> = (set) => ({
  machineProviders: {},
  machineEnvironmentProviders: {},
  wakingMachineByWorktreeId: {},
  setWorktreeMachineWaking: (worktreeId, machineName) =>
    set((state) => {
      const next = { ...state.wakingMachineByWorktreeId }
      if (machineName) {
        next[worktreeId] = machineName
      } else {
        delete next[worktreeId]
      }
      return { wakingMachineByWorktreeId: next }
    }),
  composerMachineRestore: null,
  setComposerMachineRestore: (composerMachineRestore) => set({ composerMachineRestore }),
  applyMachineSnapshot: (snapshot) =>
    set((state) =>
      isNewer(snapshot, state.machineProviders[snapshot.providerKey]) &&
      !changesNothing(snapshot, state.machineProviders[snapshot.providerKey])
        ? { machineProviders: { ...state.machineProviders, [snapshot.providerKey]: snapshot } }
        : {}
    ),
  setMachineEnvironmentSnapshots: (environmentId, snapshots) =>
    set((state) => {
      const held = state.machineEnvironmentProviders[environmentId]
      const unchanged =
        held?.length === snapshots.length &&
        snapshots.every((snapshot, index) => changesNothing(snapshot, held[index]))
      return unchanged
        ? {}
        : {
            machineEnvironmentProviders: {
              ...state.machineEnvironmentProviders,
              [environmentId]: snapshots
            }
          }
    })
})
