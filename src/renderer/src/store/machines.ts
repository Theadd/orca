import { useEffect, useMemo } from 'react'
import type {
  MachineActionResult,
  MachineProviderSnapshot
} from '../../../shared/machine-inventory'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  findMachineForHost,
  type MachineMatch,
  type MachineSources
} from '@/lib/machines/machine-host-match'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

// Freshness while machines are on screen: states and expiry stay within a minute.
const VISIBLE_LIST_MAX_AGE_MS = 60_000

let subscribed = false
let loadState: 'idle' | 'loading' | 'ready' = 'idle'

const NO_MACHINE_STATE: Pick<AppState, 'machineProviders' | 'machineEnvironmentProviders'> = {
  machineProviders: {},
  machineEnvironmentProviders: {}
}

/** The machines slice; sidebar and card surfaces also render against partial stores. */
function machineSlice(
  state: AppState
): Pick<AppState, 'machineProviders' | 'machineEnvironmentProviders'> {
  // Why: the slice is optional to every surface that only decorates hosts with machines.
  return 'machineProviders' in state ? state : NO_MACHINE_STATE
}

/** Loads the cached inventories and follows main's pushes; retries a failed load on the next call. */
export function ensureMachinesLoaded(): void {
  const machinesApi = window.api?.machines
  if (!machinesApi) {
    return
  }
  if (!subscribed) {
    subscribed = true
    machinesApi.onChanged((snapshot) => useAppStore.getState().applyMachineSnapshot(snapshot))
  }
  if (loadState !== 'idle') {
    return
  }
  loadState = 'loading'
  machinesApi.snapshots().then(
    (result) => {
      if (!result.ok) {
        loadState = 'idle'
        return
      }
      loadState = 'ready'
      // Why: a push that landed while this was in flight is newer, and the slice keeps it.
      for (const snapshot of result.value) {
        useAppStore.getState().applyMachineSnapshot(snapshot)
      }
    },
    () => {
      loadState = 'idle'
    }
  )
}

/** Re-lists this app's providers older than `maxAgeMs`; results arrive through the change push. */
export function refreshMachineProviders(maxAgeMs: number): void {
  const machinesApi = window.api?.machines
  if (!machinesApi) {
    return
  }
  for (const { providerKey } of Object.values(useAppStore.getState().machineProviders)) {
    void machinesApi.list({ providerKey, maxAgeMs })
  }
}

/**
 * Reads a paired server's machines. Only a server without machine methods reads as having none;
 * losing contact keeps what was last seen, since it says nothing about the machines.
 */
export async function loadEnvironmentMachines(environmentId: string): Promise<void> {
  const store = useAppStore.getState()
  try {
    const result = await callRuntimeRpc<MachineActionResult<MachineProviderSnapshot[]>>(
      { kind: 'environment', environmentId },
      'machines.list',
      {},
      { suppressFeatureInteraction: true }
    )
    if (result.ok) {
      store.setMachineEnvironmentSnapshots(environmentId, result.value)
    } else if (result.code === 'unsupported') {
      // The server has machines turned off.
      store.setMachineEnvironmentSnapshots(environmentId, [])
    }
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      store.setMachineEnvironmentSnapshots(environmentId, [])
    }
  }
}

/** Paired servers that answer right now; an unreachable one keeps its last inventory. */
function reachableEnvironmentIds(state: AppState): string[] {
  return state.runtimeEnvironments
    .filter((environment) => state.runtimeStatusByEnvironmentId.get(environment.id)?.status)
    .map((environment) => environment.id)
}

function refreshAllMachines(): void {
  refreshMachineProviders(VISIBLE_LIST_MAX_AGE_MS)
  for (const environmentId of reachableEnvironmentIds(useAppStore.getState())) {
    void loadEnvironmentMachines(environmentId)
  }
}

export function hasMachineProviders(): boolean {
  const state = useAppStore.getState()
  return (
    Object.keys(machineSlice(state).machineProviders).length > 0 ||
    Object.values(machineSlice(state).machineEnvironmentProviders).some(
      (snapshots) => snapshots.length > 0
    )
  )
}

function hasAnyMachine(state: AppState): boolean {
  const hasMachines = (snapshots: Iterable<MachineProviderSnapshot>): boolean =>
    [...snapshots].some((snapshot) => snapshot.machines.length > 0)
  return (
    hasMachines(Object.values(machineSlice(state).machineProviders)) ||
    Object.values(machineSlice(state).machineEnvironmentProviders).some((snapshots) =>
      hasMachines(snapshots)
    )
  )
}

/**
 * Follows machine inventories while machines are enabled; mounted once near the app root. Paired
 * servers are read once; while any machine exists, everything re-lists each minute the window is
 * visible, so a provider without machines is never polled.
 */
export function useMachineInventory(enabled: boolean): void {
  const machinesExist = useAppStore((state) => enabled && hasAnyMachine(state))
  // Why: a string keeps the selector stable; a server that becomes reachable is read then.
  const reachable = useAppStore((state) =>
    enabled ? reachableEnvironmentIds(state).join('\n') : ''
  )
  useEffect(() => {
    if (enabled) {
      ensureMachinesLoaded()
    }
  }, [enabled])
  useEffect(() => {
    if (!enabled || !reachable) {
      return
    }
    for (const environmentId of reachable.split('\n')) {
      void loadEnvironmentMachines(environmentId)
    }
  }, [enabled, reachable])
  useEffect(() => {
    if (!enabled || !machinesExist) {
      return
    }
    return installWindowVisibilityInterval({
      run: refreshAllMachines,
      intervalMs: VISIBLE_LIST_MAX_AGE_MS
    })
  }, [enabled, machinesExist])
}

let sourcesCache: {
  providers: AppState['machineProviders']
  environments: AppState['machineEnvironmentProviders']
  sources: MachineSources
} | null = null

// Why: many rows ask at once; one shared value keeps them from each re-sorting.
function selectMachineSources(
  providers: AppState['machineProviders'],
  environments: AppState['machineEnvironmentProviders']
): MachineSources {
  if (
    !sourcesCache ||
    sourcesCache.providers !== providers ||
    sourcesCache.environments !== environments
  ) {
    sourcesCache = {
      providers,
      environments,
      sources: {
        self: Object.values(providers).sort((a, b) => a.name.localeCompare(b.name)),
        environments
      }
    }
  }
  return sourcesCache.sources
}

export function useMachineSources(): MachineSources {
  const providers = useAppStore((state) => machineSlice(state).machineProviders)
  const environments = useAppStore((state) => machineSlice(state).machineEnvironmentProviders)
  return selectMachineSources(providers, environments)
}

export function getMachineSources(): MachineSources {
  const state = useAppStore.getState()
  return selectMachineSources(
    machineSlice(state).machineProviders,
    machineSlice(state).machineEnvironmentProviders
  )
}

/** The machine a host runs on, or null for every other host. */
export function useMachineForHost(hostKey: string | null | undefined): MachineMatch | null {
  const sources = useMachineSources()
  return useMemo(() => findMachineForHost(hostKey, sources), [hostKey, sources])
}
