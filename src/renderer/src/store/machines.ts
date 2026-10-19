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
    Object.keys(state.machineProviders).length > 0 ||
    Object.values(state.machineEnvironmentProviders).some((snapshots) => snapshots.length > 0)
  )
}

/**
 * Follows machine inventories while machines are enabled; mounted once near the app root. It
 * re-lists each minute the window is visible, and nothing polls while the window is hidden.
 */
export function useMachineInventory(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    ensureMachinesLoaded()
    return installWindowVisibilityInterval({
      run: refreshAllMachines,
      intervalMs: VISIBLE_LIST_MAX_AGE_MS
    })
  }, [enabled])
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
  const providers = useAppStore((state) => state.machineProviders)
  const environments = useAppStore((state) => state.machineEnvironmentProviders)
  return selectMachineSources(providers, environments)
}

export function getMachineSources(): MachineSources {
  const state = useAppStore.getState()
  return selectMachineSources(state.machineProviders, state.machineEnvironmentProviders)
}

/** The machine a host runs on, or null for every other host. */
export function useMachineForHost(hostKey: string | null | undefined): MachineMatch | null {
  const sources = useMachineSources()
  return useMemo(() => findMachineForHost(hostKey, sources), [hostKey, sources])
}
