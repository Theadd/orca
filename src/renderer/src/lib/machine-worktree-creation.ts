import { toast } from 'sonner'
import type { MachineRecord, MachineTarget } from '../../../shared/machine-inventory'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ProjectHostSetupResult } from '../../../shared/project-types'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { machineNeedsWake } from '@/lib/machines/machine-display-state'
import { resolveProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import { getPortableBaseSelection } from '@/lib/portable-base-selection'
import { translate } from '@/i18n/i18n'

type MachineRequest = NonNullable<WorktreeCreationRequest['machine']>

type StartedMachine = { hostId: ExecutionHostId; projectRoot: string; environmentId?: string }

type Step<T> = { ok: true; value: T } | { ok: false; error: string }

function stillPending(creationId: string): boolean {
  return Boolean(useAppStore.getState().pendingWorktreeCreations[creationId])
}

function fail(creationId: string, error: string): null {
  const store = useAppStore.getState()
  if (!store.pendingWorktreeCreations[creationId]) {
    return null
  }
  store.updatePendingWorktreeCreation(creationId, { status: 'error', error })
  if (store.activePendingCreationId !== creationId) {
    toast.error(error)
  }
  return null
}

/**
 * Wakes a stopped machine, connects to it and reads where projects live. A sleeping or archived
 * machine is woken here, on submit, so choosing it in the composer never waits.
 */
async function startMachine(target: MachineTarget): Promise<Step<StartedMachine>> {
  const machines = window.api.machines
  const current = await machines.get(target)
  if (!current.ok) {
    return { ok: false, error: current.message }
  }
  if (current.value.state === 'gone') {
    return {
      ok: false,
      error: translate('auto.lib.machineWorktreeCreation.machineGone', 'This machine is gone.')
    }
  }
  if (machineNeedsWake(current.value.state)) {
    const woken = await machines.wake(target)
    if (!woken.ok) {
      return { ok: false, error: woken.message }
    }
  }
  const connection = await machines.connect(target)
  if (!connection.ok) {
    return { ok: false, error: connection.message }
  }
  // Why: access is only reported while running, so read it after the wake settled.
  const running = await machines.get(target)
  const projectRoot = running.ok ? machineProjectRoot(running.value) : null
  if (!projectRoot) {
    return {
      ok: false,
      error: translate(
        'auto.lib.machineWorktreeCreation.noProjectRoot',
        'The provider did not say where projects live on this machine.'
      )
    }
  }
  const { value } = connection
  if (value.kind === 'orca-server') {
    return {
      ok: true,
      value: {
        hostId: toRuntimeExecutionHostId(value.runtimeEnvironmentId),
        projectRoot,
        environmentId: value.runtimeEnvironmentId
      }
    }
  }
  // Why: worktrees live on the server Orca runs over SSH when it has one, as for any SSH host.
  return {
    ok: true,
    value: value.environmentId
      ? {
          hostId: toRuntimeExecutionHostId(value.environmentId),
          projectRoot,
          environmentId: value.environmentId
        }
      : { hostId: toSshExecutionHostId(value.sshTargetId), projectRoot }
  }
}

function machineProjectRoot(machine: MachineRecord): string | null {
  return machine.access?.projectRoot ?? null
}

/** Reuses the project's location on the machine, or clones it into the provider's project root. */
async function ensureProjectOnMachine(args: {
  projectId: string
  hostId: ExecutionHostId
  projectRoot: string
}): Promise<Step<ProjectHostSetupResult>> {
  const store = useAppStore.getState()
  const existing = store.projectHostSetups.find(
    (setup) =>
      setup.projectId === args.projectId &&
      setup.hostId === args.hostId &&
      setup.setupState === 'ready'
  )
  const project = store.projects.find((candidate) => candidate.id === args.projectId)
  const existingRepo = existing
    ? store.repos.find((repo) => repo.id === existing.repoId)
    : undefined
  if (existing && existingRepo && project) {
    return { ok: true, value: { project, setup: existing, repo: existingRepo } }
  }
  const url = resolveProjectCloneUrlPrefill(store.projects, store.repos, args.projectId)
  if (!url) {
    return {
      ok: false,
      error: translate(
        'auto.lib.machineWorktreeCreation.noCloneUrl',
        'This project has no remote to clone onto the machine.'
      )
    }
  }
  const cloned = await store.setupProjectClone({
    projectId: args.projectId,
    hostId: args.hostId,
    url,
    destination: args.projectRoot,
    ...(project ? { displayName: project.displayName } : {})
  })
  return cloned
    ? { ok: true, value: cloned }
    : {
        ok: false,
        error: translate(
          'auto.lib.machineWorktreeCreation.cloneFailed',
          'Couldn’t set up the project on the machine.'
        )
      }
}

/** Starts the chosen machine and sets the project up on it before the worktree is created. */
export async function prepareMachineRequest(
  creationId: string,
  request: WorktreeCreationRequest,
  machine: MachineRequest
): Promise<WorktreeCreationRequest | null> {
  useAppStore
    .getState()
    .updatePendingWorktreeCreation(creationId, { phase: 'starting-machine', provisioningLog: '' })
  const started = await startMachine({
    providerKey: machine.providerKey,
    machineId: machine.machineId
  })
  if (!started.ok) {
    return fail(creationId, started.error)
  }
  if (started.value.environmentId) {
    try {
      // Why: the first connect may have just deployed this server; host badges and setup read it.
      useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    } catch {
      // A stale catalog only delays host badges; setup re-reads the route.
    }
  }
  if (!stillPending(creationId)) {
    return null
  }
  const setup = await ensureProjectOnMachine({
    projectId: machine.projectId,
    hostId: started.value.hostId,
    projectRoot: started.value.projectRoot
  })
  if (!setup.ok) {
    return fail(creationId, setup.error)
  }
  if (!stillPending(creationId)) {
    return null
  }
  const prepared: WorktreeCreationRequest = {
    ...request,
    repoId: setup.value.repo.id,
    ...getPortableBaseSelection(request),
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: setup.value.setup.projectId,
      hostId: started.value.hostId,
      projectHostSetupId: setup.value.setup.id,
      repoId: setup.value.repo.id,
      path: setup.value.repo.path
    }
  }
  useAppStore
    .getState()
    .updatePendingWorktreeCreation(creationId, { phase: 'fetching', request: prepared })
  return prepared
}
