import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type {
  MachineActionResult,
  MachineProviderSnapshot
} from '../../../shared/machine-inventory'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { MachineSources } from '@/lib/machines/machine-host-match'
import { useAppStore } from '@/store'
import {
  getRuntimeSshAccess,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'

type MachinesState = {
  /** Providers this app runs, as last pushed by main. */
  providers: Readonly<Record<string, MachineProviderSnapshot>>
  /** Paired servers' inventories; an empty list also stands for a server without machines. */
  environmentProviders: Readonly<Record<string, readonly MachineProviderSnapshot[]>>
  applySnapshot: (snapshot: MachineProviderSnapshot) => void
  setSnapshots: (snapshots: readonly MachineProviderSnapshot[]) => void
  setEnvironmentSnapshots: (
    environmentId: string,
    snapshots: readonly MachineProviderSnapshot[]
  ) => void
}

export const useMachinesStore = create<MachinesState>()((set) => ({
  providers: {},
  environmentProviders: {},
  applySnapshot: (snapshot) =>
    set((state) => ({ providers: { ...state.providers, [snapshot.providerKey]: snapshot } })),
  setSnapshots: (snapshots) =>
    set({
      providers: Object.fromEntries(snapshots.map((snapshot) => [snapshot.providerKey, snapshot]))
    }),
  setEnvironmentSnapshots: (environmentId, snapshots) =>
    set((state) => ({
      environmentProviders: { ...state.environmentProviders, [environmentId]: snapshots }
    }))
}))

export function hasMachineProviders(): boolean {
  return Object.keys(useMachinesStore.getState().providers).length > 0
}

let changeSubscriptionStarted = false

/** Loads the cached inventories and follows main's pushes; safe to call repeatedly. */
export function ensureMachinesLoaded(): void {
  const machinesApi = window.api?.machines
  if (changeSubscriptionStarted || !machinesApi) {
    return
  }
  changeSubscriptionStarted = true
  machinesApi.onChanged((snapshot) => useMachinesStore.getState().applySnapshot(snapshot))
  void machinesApi.snapshots().then((result) => {
    if (result.ok) {
      useMachinesStore.getState().setSnapshots(result.value)
    }
  })
}

/** Follows machine inventories while machines are enabled; mounted once near the app root. */
export function useMachineInventory(enabled: boolean): void {
  useEffect(() => {
    if (enabled) {
      ensureMachinesLoaded()
    }
  }, [enabled])
}

/** Re-lists every provider older than `maxAgeMs`; results arrive through the change push. */
export function refreshMachineProviders(maxAgeMs: number): void {
  const machinesApi = window.api?.machines
  if (!machinesApi) {
    return
  }
  for (const { providerKey } of Object.values(useMachinesStore.getState().providers)) {
    void machinesApi.list({ providerKey, maxAgeMs })
  }
}

/** Reads a paired server's inventory; an older server without machines reads as empty. */
export async function loadEnvironmentMachines(environmentId: string): Promise<void> {
  let snapshots: readonly MachineProviderSnapshot[] = []
  try {
    const result = await callRuntimeRpc<MachineActionResult<MachineProviderSnapshot[]>>(
      { kind: 'environment', environmentId },
      'machines.list',
      {},
      { suppressFeatureInteraction: true }
    )
    snapshots = result.ok ? result.value : []
  } catch {
    // Why: `method_not_found` from an older server means it has no machine UI to show.
    snapshots = []
  }
  useMachinesStore.getState().setEnvironmentSnapshots(environmentId, snapshots)
}

function sortProviders(
  providers: Readonly<Record<string, MachineProviderSnapshot>>
): MachineProviderSnapshot[] {
  return Object.values(providers).sort((a, b) => a.name.localeCompare(b.name))
}

export function useMachineProviders(): MachineProviderSnapshot[] {
  const providers = useMachinesStore((state) => state.providers)
  return useMemo(() => sortProviders(providers), [providers])
}

function indexSshTunnels(
  environments: readonly PublicKnownRuntimeEnvironment[]
): Record<string, string> {
  const index: Record<string, string> = {}
  for (const environment of environments) {
    const access = getRuntimeSshAccess(environment)
    if (access) {
      index[environment.id] = access.sshTargetId
    }
  }
  return index
}

export function useMachineSources(): MachineSources {
  const providers = useMachinesStore((state) => state.providers)
  const environments = useMachinesStore((state) => state.environmentProviders)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  return useMemo(
    () => ({
      self: sortProviders(providers),
      environments,
      sshTargetIdByEnvironmentId: indexSshTunnels(runtimeEnvironments)
    }),
    [environments, providers, runtimeEnvironments]
  )
}

export function getMachineSources(): MachineSources {
  const state = useMachinesStore.getState()
  return {
    self: sortProviders(state.providers),
    environments: state.environmentProviders,
    sshTargetIdByEnvironmentId: indexSshTunnels(useAppStore.getState().runtimeEnvironments)
  }
}
