import type { MachineProviderKey } from '../../../../shared/machine-inventory'
import { buildShellCommandFromArgv } from '../../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { getWorktreeExecutionHostId, isLocalExecutionHost } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'

/** Settings → Plugins, where machine providers are installed. */
export function openMachinePluginSettings(): void {
  const store = useAppStore.getState()
  store.closeModal()
  store.openSettingsTarget({ pane: 'plugins', repoId: null })
  store.openSettingsPage()
}

/** Settings → Experimental holds machine-provider consent, diagnostics and Doctor. */
export function openMachineProviderSettings(): void {
  const store = useAppStore.getState()
  store.closeModal()
  store.openSettingsTarget({ pane: 'experimental', repoId: null })
  store.openSettingsPage()
}

/** Re-lists a provider now, skipping its failure backoff; the result arrives as a change push. */
export function retryMachineProvider(providerKey: MachineProviderKey): void {
  void window.api?.machines?.list({ providerKey, force: true })
}

/** The active worktree, when it runs on this computer and so can host a local command. */
function localActiveWorktreeId(): string | null {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  const worktree = worktreeId ? findWorktreeById(state.worktreesByRepo, worktreeId) : undefined
  if (!worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  return isLocalExecutionHost(getWorktreeExecutionHostId(worktree, repo)) ? worktree.id : null
}

/**
 * Runs the provider's sign-in command where the user can see it: a new terminal tab in the active
 * local worktree. With nowhere local to run it, opens the provider's settings instead.
 */
export function signInToMachineProvider(providerKey: MachineProviderKey): void {
  const argv = useAppStore.getState().machineProviders[providerKey]?.capabilities?.signInCommand
  const worktreeId = localActiveWorktreeId()
  if (!argv || !worktreeId) {
    openMachineProviderSettings()
    return
  }
  const store = useAppStore.getState()
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform: CLIENT_PLATFORM,
      isRemote: false,
      terminalWindowsShell: store.settings?.terminalWindowsShell
    }) ?? 'posix'
  // Why: the composer keeps its draft, and the sign-in terminal must not sit under the dialog.
  store.closeModal()
  const tab = store.createTab(worktreeId)
  store.setActiveTab(tab.id)
  store.queueTabStartupCommand(tab.id, { command: buildShellCommandFromArgv(argv, shell) })
}

/** What a provider group's own picker row does; creating a machine belongs to the composer. */
export function runMachineProviderRowAction(
  kind: 'sign-in' | 'retry' | 'details',
  providerKey: MachineProviderKey
): void {
  switch (kind) {
    case 'sign-in':
      signInToMachineProvider(providerKey)
      return
    case 'retry':
      retryMachineProvider(providerKey)
      return
    case 'details':
      openMachineProviderSettings()
  }
}
