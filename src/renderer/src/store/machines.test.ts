import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ runtimeEnvironments: [] }) } }))

import { loadEnvironmentMachines, useMachinesStore } from './machines'

beforeEach(() => {
  vi.clearAllMocks()
  useMachinesStore.setState({ providers: {}, environmentProviders: {} })
})

describe('loadEnvironmentMachines', () => {
  it('stores a paired server’s inventory', async () => {
    const snapshot = {
      providerKey: 'plugin:p/omarchy',
      name: 'Omarchy',
      machines: [],
      pendingCreates: []
    }
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: [snapshot] })

    await loadEnvironmentMachines('env-1')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'machines.list',
      {},
      { suppressFeatureInteraction: true }
    )
    expect(useMachinesStore.getState().environmentProviders['env-1']).toEqual([snapshot])
  })

  it('reads an older server without machine methods as having none', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('method_not_found: machines.list'))

    await loadEnvironmentMachines('env-old')

    expect(useMachinesStore.getState().environmentProviders['env-old']).toEqual([])
  })
})
