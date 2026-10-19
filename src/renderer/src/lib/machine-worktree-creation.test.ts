import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../../shared/machine-inventory'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const PROVIDER = 'plugin:omarchy/omarchy' as const

type StoreFixture = {
  repos: { id: string; path: string }[]
  projects: { id: string; displayName: string }[]
  projectHostSetups: {
    id: string
    projectId: string
    hostId: string
    repoId: string
    setupState: string
  }[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  activePendingCreationId: string
  updatePendingWorktreeCreation: ReturnType<typeof vi.fn>
  setRuntimeEnvironments: ReturnType<typeof vi.fn>
  setupProjectClone: ReturnType<typeof vi.fn>
}

const store: StoreFixture = {
  repos: [],
  projects: [{ id: 'project-1', displayName: 'acme-web' }],
  projectHostSetups: [],
  pendingWorktreeCreations: {},
  activePendingCreationId: 'creation-1',
  updatePendingWorktreeCreation: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  setupProjectClone: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/project-clone-url-prefill', () => ({
  resolveProjectCloneUrlPrefill: () => 'git@github.com:acme/web.git'
}))

import { prepareMachineRequest } from './machine-worktree-creation'

const machines = {
  get: vi.fn(),
  wake: vi.fn(),
  connect: vi.fn()
}

function record(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'box-1',
    name: 'omarchy-dev',
    lifetime: 'persistent',
    state: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    providerKey: PROVIDER,
    lastSeenAt: 0,
    access: {
      kind: 'ssh',
      host: 'omarchy',
      port: 2201,
      user: 'dev',
      projectRoot: '/home/dev/src'
    },
    ...overrides
  }
}

const MACHINE = {
  sourceRepoId: 'repo-local',
  projectId: 'project-1',
  providerKey: PROVIDER,
  machineId: 'box-1'
}

const REQUEST = {
  repoId: 'repo-local',
  name: 'feature',
  baseBranch: 'main',
  setupDecision: 'inherit',
  agent: null,
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null,
  machine: MACHINE
} satisfies WorktreeCreationRequest

beforeEach(() => {
  vi.clearAllMocks()
  store.repos = []
  store.projectHostSetups = []
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'preparing',
      status: 'creating',
      startedAt: 1,
      indeterminate: true,
      loaderVisible: true,
      request: REQUEST
    }
  }
  machines.connect.mockResolvedValue({
    ok: true,
    value: { kind: 'ssh', sshTargetId: 'machine-abc', environmentId: 'env-1' }
  })
  vi.stubGlobal('window', {
    api: { machines, runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) } }
  })
})

describe('prepareMachineRequest', () => {
  it('wakes a sleeping machine before connecting and clones the project into its root', async () => {
    machines.get
      .mockResolvedValueOnce({ ok: true, value: record({ state: 'sleeping', access: undefined }) })
      .mockResolvedValueOnce({ ok: true, value: record() })
    machines.wake.mockResolvedValue({ ok: true, value: record() })
    store.setupProjectClone.mockResolvedValue({
      project: { id: 'project-1' },
      setup: { id: 'setup-1', projectId: 'project-1', hostId: 'runtime:env-1' },
      repo: { id: 'repo-machine', path: '/home/dev/src/web' }
    })

    const prepared = await prepareMachineRequest('creation-1', REQUEST, MACHINE)

    expect(machines.wake.mock.invocationCallOrder[0]).toBeLessThan(
      machines.connect.mock.invocationCallOrder[0]
    )
    expect(store.setupProjectClone).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      url: 'git@github.com:acme/web.git',
      destination: '/home/dev/src',
      displayName: 'acme-web'
    })
    expect(prepared).toMatchObject({
      repoId: 'repo-machine',
      baseBranch: undefined,
      workspaceRunContext: {
        hostId: 'runtime:env-1',
        projectHostSetupId: 'setup-1',
        path: '/home/dev/src/web'
      }
    })
  })

  it('uses a running machine as is and reuses the project already set up there', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    store.projectHostSetups = [
      {
        id: 'setup-1',
        projectId: 'project-1',
        hostId: 'runtime:env-1',
        repoId: 'repo-machine',
        setupState: 'ready'
      }
    ]
    store.repos = [{ id: 'repo-machine', path: '/home/dev/src/web' }]

    const prepared = await prepareMachineRequest('creation-1', REQUEST, MACHINE)

    expect(machines.wake).not.toHaveBeenCalled()
    expect(store.setupProjectClone).not.toHaveBeenCalled()
    expect(prepared?.repoId).toBe('repo-machine')
  })

  it('fails the create on a Gone machine without connecting', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record({ state: 'gone' }) })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(machines.connect).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'This machine is gone.'
    })
  })

  it('stops quietly when the pending create was dismissed mid-start', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    machines.connect.mockImplementation(async () => {
      store.pendingWorktreeCreations = {}
      return { ok: true, value: { kind: 'ssh', sshTargetId: 'machine-abc' } }
    })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(store.setupProjectClone).not.toHaveBeenCalled()
  })
})
