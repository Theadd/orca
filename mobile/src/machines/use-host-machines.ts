import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { MachineProviderKey } from '../../../src/shared/machine-inventory'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  machinesListRead,
  machineSleep,
  machineWake,
  type MobileMachineProvider
} from './machine-operations'
import { readMachineAction, readMachinesList } from './machine-replies'

// While the screen is focused and the app is active; the desktop caches lists for 30 s anyway.
const MACHINES_REFRESH_MS = 60_000

export type HostMachinesState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; providers: MobileMachineProvider[]; error: string | null }
  | { status: 'failed'; error: string }

export type HostMachinesNotice = { title: string; message: string }

export function useHostMachines(args: {
  client: RpcClient | null
  connState: ConnectionState
  focused: boolean
}): {
  state: HostMachinesState
  refreshing: boolean
  busyMachineId: string | null
  notice: HostMachinesNotice | null
  dismissNotice: () => void
  refresh: () => Promise<void>
  act: (providerKey: MachineProviderKey, machineId: string, verb: 'wake' | 'sleep') => Promise<void>
} {
  const { client, connState, focused } = args
  const [state, setState] = useState<HostMachinesState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [busyMachineId, setBusyMachineId] = useState<string | null>(null)
  const [notice, setNotice] = useState<HostMachinesNotice | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const current = ++generation.current
    setRefreshing(true)
    try {
      const outcome = readMachinesList(await machinesListRead.request(client, { refresh: true }))
      if (current !== generation.current) {
        return
      }
      setState((previous) =>
        outcome.kind === 'providers'
          ? { status: 'ready', providers: outcome.providers, error: null }
          : outcome.kind === 'unavailable'
            ? { status: 'unavailable' }
            : // A failed refresh keeps the rows the phone already shows.
              previous.status === 'ready'
              ? { ...previous, error: outcome.message }
              : { status: 'failed', error: outcome.message }
      )
    } finally {
      if (current === generation.current) {
        setRefreshing(false)
      }
    }
  }, [client, connState])

  useEffect(() => {
    if (!focused) {
      return
    }
    void refresh()
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') {
        void refresh()
      }
    }, MACHINES_REFRESH_MS)
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refresh()
      }
    })
    return () => {
      clearInterval(interval)
      appState.remove()
    }
  }, [focused, refresh])

  const act = useCallback(
    async (providerKey: MachineProviderKey, machineId: string, verb: 'wake' | 'sleep') => {
      if (!client) {
        return
      }
      setBusyMachineId(machineId)
      try {
        const operation = verb === 'wake' ? machineWake : machineSleep
        const outcome = readMachineAction(
          await operation.request(client, { providerKey, machineId }),
          verb
        )
        if (outcome.kind === 'failed') {
          setNotice({
            title: verb === 'wake' ? 'Could not wake machine' : 'Could not sleep machine',
            message: outcome.message
          })
        }
        await refresh()
      } finally {
        setBusyMachineId(null)
      }
    },
    [client, refresh]
  )

  return {
    state,
    refreshing,
    busyMachineId,
    notice,
    dismissNotice: () => setNotice(null),
    refresh,
    act
  }
}

/**
 * Whether the host screen should offer Machines: the desktop answers machines.list with at least
 * one provider. Read once per connection; an older desktop or one with Machines off hides it.
 */
export function useHostMachinesAvailable(
  client: RpcClient | null,
  connState: ConnectionState
): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    void machinesListRead
      .request(client)
      .then((reply) => {
        if (!stale) {
          const outcome = readMachinesList(reply)
          setAvailable(outcome.kind === 'providers' && outcome.providers.length > 0)
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, connState])
  return available
}
