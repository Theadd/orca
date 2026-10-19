import { describe, expect, it, vi } from 'vitest'
import {
  encodePairingOffer,
  PAIRING_OFFER_VERSION,
  type PairingOffer
} from '../../../shared/pairing'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  ManagedOrcadPairingRepairs,
  MAX_PAIRING_REPAIRS_PER_WINDOW,
  PAIRING_REPAIR_FAILURE_HOLD_MS,
  PAIRING_REPAIR_WINDOW_MS
} from './orcad-managed-pairing-repair'
import { OrcadManagedPairingRepairFailedError } from './orcad-managed-pairing-repair-failure'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError
} from './orcad-managed-tunnel-identity'
import { buildWithPairingRepair } from './orcad-managed-tunnel-pairing-recovery'

const KEY = 'pinned-host-key'

function offer(deviceToken: string, publicKeyB64 = KEY): PairingOffer {
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://127.0.0.1:46768',
    deviceToken,
    publicKeyB64,
    pairedDeviceId: `device-${deviceToken}`
  }
}

function environment(deviceToken: string): KnownRuntimeEnvironment {
  return {
    ...createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'Box server',
      now: 1,
      offer: offer(deviceToken),
      connectionDependency: 'ssh-tunnel'
    }),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function readiness(published: PairingOffer | null): ServeReadiness {
  return {
    runtimeId: 'runtime-now',
    boundEndpoint: 'ws://127.0.0.1:6768',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: published
      ? {
          available: true,
          url: encodePairingOffer({ ...published, endpoint: 'ws://127.0.0.1:6768' }),
          endpoint: 'ws://127.0.0.1:6768',
          deviceId: published.pairedDeviceId!,
          webClientUrl: null,
          scope: 'runtime',
          qr: null
        }
      : { available: false, reason: 'disabled_by_operator', guidance: 'Restart with pairing.' }
  }
}

function setup(published: () => ServeReadiness | null) {
  let current = environment('refused-token')
  let now = 0
  const deps = {
    resolve: vi.fn(() => current),
    connect: vi.fn(async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only handed to readReadiness, a double here.
      target: {} as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only handed to readReadiness, a double here.
      connection: {} as OrcadHostTransport
    })),
    readReadiness: vi.fn(async () => published()),
    refresh: vi.fn((_id: string, _code: string) => {
      current = environment(`fresh-${deps.refresh.mock.calls.length}`)
      return current
    }),
    now: () => now
  }
  return {
    deps,
    repairs: new ManagedOrcadPairingRepairs(deps),
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('ManagedOrcadPairingRepairs', () => {
  it('keeps the offer the server publishes now, with the pinned key, at the tunnel port', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    await state.repairs.repair('env-1')
    const code = state.deps.refresh.mock.calls[0]?.[1] ?? ''
    expect(code).toContain('orca://')
    expect(state.deps.refresh).toHaveBeenCalledOnce()
  })

  it('runs one repair at a time for concurrent refusals', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    await Promise.all([state.repairs.repair('env-1'), state.repairs.repair('env-1')])
    expect(state.deps.readReadiness).toHaveBeenCalledOnce()
  })

  it('refuses an offer under another host key, so a foreign server stays foreign', async () => {
    const state = setup(() => readiness(offer('fresh-token', 'other-key')))
    await expect(state.repairs.repair('env-1')).rejects.toBeInstanceOf(OrcadManagedIdentityError)
    expect(state.deps.refresh).not.toHaveBeenCalled()
  })

  it('says why when the server still offers the token it refused', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    await expect(state.repairs.repair('env-1')).rejects.toThrow(
      /still offers the pairing it refused/
    )
    expect(state.deps.refresh).not.toHaveBeenCalled()
  })

  it.each([
    ['publishes no readiness', () => null, /hasn't published a pairing/],
    ['offers no pairing', () => readiness(null), /isn't offering a pairing/]
  ])('fails clearly when the server %s', async (_name, published, message) => {
    const state = setup(published)
    const failure = state.repairs.repair('env-1')
    await expect(failure).rejects.toBeInstanceOf(OrcadManagedPairingRepairFailedError)
    await expect(failure).rejects.toThrow(message)
  })

  it('holds a failure briefly instead of re-reading the host for every reconnect', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    await expect(state.repairs.repair('env-1')).rejects.toThrow()
    await expect(state.repairs.repair('env-1')).rejects.toThrow()
    expect(state.deps.readReadiness).toHaveBeenCalledOnce()
    state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    await expect(state.repairs.repair('env-1')).rejects.toThrow()
    expect(state.deps.readReadiness).toHaveBeenCalledTimes(2)
  })

  it('lets an explicit connect retry past a held failure', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    await expect(state.repairs.repair('env-1')).rejects.toThrow()
    state.repairs.forgetHeldFailure('env-1')
    await expect(state.repairs.repair('env-1')).rejects.toThrow()
    expect(state.deps.readReadiness).toHaveBeenCalledTimes(2)
  })

  it('does not hold a lost SSH connection, which says nothing about the pairing', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    state.deps.connect.mockRejectedValueOnce(new Error('ssh: connection reset'))
    await expect(state.repairs.repair('env-1')).rejects.toThrow('connection reset')
    await expect(state.repairs.repair('env-1')).resolves.toBeDefined()
  })

  it('caps repairs per window', async () => {
    let token = 0
    const state = setup(() => readiness(offer(`issued-${++token}`)))
    for (let i = 0; i < MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      await state.repairs.repair('env-1')
    }
    await expect(state.repairs.repair('env-1')).rejects.toThrow(/kept refusing/)
    expect(state.deps.refresh).toHaveBeenCalledTimes(MAX_PAIRING_REPAIRS_PER_WINDOW)
    state.advance(PAIRING_REPAIR_WINDOW_MS)
    await expect(state.repairs.repair('env-1')).resolves.toBeDefined()
  })
})

describe('buildWithPairingRepair', () => {
  function recovery() {
    const state = setup(() => readiness(offer('fresh-token')))
    return {
      state,
      recovery: {
        resolve: state.deps.resolve,
        repairs: state.repairs,
        repaired: vi.fn()
      }
    }
  }
  const refusal = () => new OrcadManagedPairingRejectedError('rejected the pairing token')

  it('re-pairs once on a refusal from our own server, then builds on the new pairing', async () => {
    const { state, recovery: deps } = recovery()
    const build = vi
      .fn<(environment: KnownRuntimeEnvironment) => Promise<void>>()
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(buildWithPairingRepair(deps, 'env-1', build)).resolves.toBe('repaired')
    warn.mockRestore()
    expect(state.deps.refresh).toHaveBeenCalledOnce()
    expect(deps.repaired).toHaveBeenCalledWith('env-1')
    expect(build.mock.calls[1]?.[0].endpoints[0]).toMatchObject({ deviceToken: 'fresh-1' })
  })

  it('never re-pairs on a foreign answer or lost contact', async () => {
    const { state, recovery: deps } = recovery()
    const foreign = new OrcadManagedIdentityError(6_768, '4001: Unauthorized')
    await expect(
      buildWithPairingRepair(deps, 'env-1', vi.fn().mockRejectedValue(foreign))
    ).rejects.toBe(foreign)
    expect(state.deps.readReadiness).not.toHaveBeenCalled()
  })

  it('fails clearly, without looping, when the new pairing is refused too', async () => {
    const { state, recovery: deps } = recovery()
    const build = vi.fn().mockRejectedValue(refusal())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = buildWithPairingRepair(deps, 'env-1', build)
    await expect(failure).rejects.toBeInstanceOf(OrcadManagedPairingRepairFailedError)
    await expect(failure).rejects.toThrow(/refused the new pairing too/)
    warn.mockRestore()
    expect(build).toHaveBeenCalledTimes(2)
    expect(state.deps.refresh).toHaveBeenCalledOnce()
  })
})
