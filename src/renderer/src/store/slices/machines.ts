import type { StateCreator } from 'zustand'
import type {
  MachineExpiryWarning,
  MachineProviderSnapshot,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { machineTargetKey } from '@/lib/machines/machine-host-match'
import type { MachineChoice } from '@/lib/machines/machine-group-options'
import type { MachineCreateDraft } from '@/lib/machines/machine-create-draft'
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
  /** The new-machine draft a composer had when sign-in closed it; read once when it reopens. */
  composerDraftRestore: MachineCreateDraft | null
  setComposerDraftRestore: (draft: MachineCreateDraft | null) => void
  /** The machine whose Delete dialog is open; one dialog host serves every menu. */
  machineDeleteTarget: MachineTarget | null
  /** Whether the sidebar's "Archived machines (n)" row is open; closed by default. */
  archivedMachinesExpanded: boolean
  setArchivedMachinesExpanded: (expanded: boolean) => void
  setMachineDeleteTarget: (target: MachineTarget | null) => void
  applyMachineSnapshot: (snapshot: MachineProviderSnapshot) => void
  /** Main's 15-minute warnings, keyed by `machineTargetKey`; the latest per machine wins. */
  machineExpiryWarnings: Readonly<Record<string, MachineExpiryWarning>>
  applyMachineExpiryWarning: (warning: MachineExpiryWarning) => void
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
  composerDraftRestore: null,
  setComposerDraftRestore: (composerDraftRestore) => set({ composerDraftRestore }),
  setComposerMachineRestore: (composerMachineRestore) => set({ composerMachineRestore }),
  machineDeleteTarget: null,
  archivedMachinesExpanded: false,
  setArchivedMachinesExpanded: (archivedMachinesExpanded) => set({ archivedMachinesExpanded }),
  setMachineDeleteTarget: (machineDeleteTarget) => set({ machineDeleteTarget }),
  applyMachineSnapshot: (snapshot) =>
    set((state) =>
      isNewer(snapshot, state.machineProviders[snapshot.providerKey]) &&
      !changesNothing(snapshot, state.machineProviders[snapshot.providerKey])
        ? { machineProviders: { ...state.machineProviders, [snapshot.providerKey]: snapshot } }
        : {}
    ),
  machineExpiryWarnings: {},
  applyMachineExpiryWarning: (warning) =>
    set((state) => ({
      machineExpiryWarnings: {
        ...state.machineExpiryWarnings,
        [machineTargetKey(warning)]: warning
      }
    })),
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
