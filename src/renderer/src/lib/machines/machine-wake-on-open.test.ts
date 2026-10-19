import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineProviderSnapshot, MachineRecord } from '../../../../shared/machine-inventory'
import type { MachineSources } from './machine-host-match'

const PROVIDER = 'plugin:omarchy/omarchy' as const

const mocks = vi.hoisted(() => {
  const state: { sources: MachineSources | null } = { sources: null }
  return { state, callRuntimeRpc: vi.fn(), toastError: vi.fn() }
})

vi.mock('@/store/machines', () => ({ getMachineSources: () => mocks.state.sources }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { wakeMachineForHost } from './machine-wake-on-open'

function snapshot(machine: Partial<MachineRecord>): MachineProviderSnapshot {
  return {
    providerKey: PROVIDER,
    name: 'Omarchy',
    pendingCreates: [],
    machines: [
      {
        id: 'box-1',
        name: 'omarchy-dev',
        lifetime: 'persistent',
        state: 'sleeping',
        createdAt: '2026-10-01T00:00:00.000Z',
        providerKey: PROVIDER,
        lastSeenAt: 0,
        sshTargetId: 'machine-a',
        ...machine
      }
    ]
  }
}

const machines = { wake: vi.fn(), connect: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  machines.wake.mockResolvedValue({ ok: true, value: {} })
  machines.connect.mockResolvedValue({ ok: true, value: { kind: 'ssh', sshTargetId: 'machine-a' } })
  vi.stubGlobal('window', { api: { machines } })
})

describe('wakeMachineForHost', () => {
  it('wakes and reconnects a sleeping machine, joining repeat opens', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {}, sshTargetIdByEnvironmentId: {} }

    await Promise.all([wakeMachineForHost('ssh:machine-a'), wakeMachineForHost('ssh:machine-a')])

    expect(machines.wake).toHaveBeenCalledTimes(1)
    expect(machines.wake).toHaveBeenCalledWith({ providerKey: PROVIDER, machineId: 'box-1' })
    expect(machines.connect).toHaveBeenCalledTimes(1)
  })

  it('leaves running machines and plain hosts alone', async () => {
    mocks.state.sources = {
      self: [snapshot({ state: 'running' })],
      environments: {},
      sshTargetIdByEnvironmentId: {}
    }

    await wakeMachineForHost('ssh:machine-a')
    await wakeMachineForHost('ssh:dev-box')

    expect(machines.wake).not.toHaveBeenCalled()
  })

  it('asks a paired server to wake a machine its provider owns', async () => {
    mocks.state.sources = {
      self: [],
      environments: { 'env-2': [snapshot({})] },
      sshTargetIdByEnvironmentId: {}
    }
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: {} })

    await wakeMachineForHost('nested:env-2/machine-a')

    expect(machines.wake).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-2' },
      'machines.wake',
      { providerKey: PROVIDER, machineId: 'box-1' }
    )
  })

  it('reports a failed wake without throwing into navigation', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {}, sshTargetIdByEnvironmentId: {} }
    machines.wake.mockResolvedValue({ ok: false, code: 'unavailable', message: 'host is down' })

    await wakeMachineForHost('ssh:machine-a')

    expect(mocks.toastError).toHaveBeenCalledWith('Couldn’t wake omarchy-dev', {
      description: 'host is down'
    })
    expect(machines.connect).not.toHaveBeenCalled()
  })
})
