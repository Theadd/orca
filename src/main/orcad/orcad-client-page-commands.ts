/**
 * The browser commands orcad serves itself: pages a paired desktop hosts for it live in this
 * runtime's lease and page registries, so they need no browser engine on this host.
 */
import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import { browserUnavailableError } from '../runtime/runtime-browser-commands-factory'
import {
  closeBrowserPageWithoutEngine,
  closeRegisteredBrowserClientPage
} from '../runtime/browser/browser-client-page-close'
import {
  createBrowserClientPage,
  createBrowserPageOnPairedHost,
  DEFAULT_BROWSER_PROFILE_ID,
  hasPairedPageHost,
  openBrowserUrlOnClient
} from '../runtime/browser/browser-client-page-opening'
import { BrowserClientPageQueries } from '../runtime/browser/browser-client-page-queries'

type Forward = (args: unknown[]) => unknown

const ENGINE_FREE_TAB_QUERIES = [
  'browserTabList',
  'browserTabCurrent',
  'browserTabShow',
  'browserTabSwitch'
] as const

/** The member orcad answers for `name`, or undefined to send it to the engine. */
export function orcadClientPageCommand(
  host: RuntimeBrowserCommandHost,
  name: string,
  forward: Forward,
  engineAvailable: () => boolean
): ((...args: never[]) => unknown) | undefined {
  if (name === 'browserOpenUrlOnClient') {
    return (...args: Parameters<RuntimeBrowserCommands['browserOpenUrlOnClient']>) =>
      openBrowserUrlOnClient(host, args[0])
  }
  if (name === 'browserTabCreate') {
    return (...args: Parameters<RuntimeBrowserCommands['browserTabCreate']>) =>
      createTab(host, args, forward, engineAvailable)
  }
  if (name === 'browserTabClose') {
    return async (...args: Parameters<RuntimeBrowserCommands['browserTabClose']>) => {
      const params = args[0] ?? {}
      if (!engineAvailable()) {
        return closeBrowserPageWithoutEngine(host, params, browserUnavailableError)
      }
      return (await closeRegisteredBrowserClientPage(host, params)) ?? forward(args)
    }
  }
  const query = ENGINE_FREE_TAB_QUERIES.find((candidate) => candidate === name)
  if (query) {
    // Why only without an engine: then the desktop-hosted pages are every tab this host has.
    return (...args: unknown[]) =>
      engineAvailable() || !servesClientPages(host)
        ? forward(args)
        : callTabQuery(new BrowserClientPageQueries(host, orcadProfileLabel), query, args)
  }
  return undefined
}

function createTab(
  host: RuntimeBrowserCommandHost,
  [params, caller]: Parameters<RuntimeBrowserCommands['browserTabCreate']>,
  forward: Forward,
  engineAvailable: () => boolean
): unknown {
  if (params?.placement?.kind === 'client') {
    const placement = params.placement
    return (async () => {
      const worktree = params.worktree
        ? await host.resolveBrowserWorkspace(params.worktree)
        : undefined
      return createBrowserClientPage(
        host,
        { ...params, placement },
        { worktree, browserProfileId: orcadBrowserProfileId(params.profileId), caller }
      )
    })()
  }
  // Why only for this host's own CLI: a paired client that left placement out asked for the server.
  if (
    !params?.placement &&
    !caller?.pairedDeviceId &&
    !engineAvailable() &&
    hasPairedPageHost(host)
  ) {
    return createBrowserPageOnPairedHost(
      host,
      params ?? {},
      orcadBrowserProfileId(params?.profileId)
    )
  }
  return forward([params, caller])
}

function servesClientPages(host: RuntimeBrowserCommandHost): boolean {
  return hasPairedPageHost(host) || host.getRuntimeBrowserPageRegistry().listPages().length > 0
}

function callTabQuery(
  queries: BrowserClientPageQueries,
  name: (typeof ENGINE_FREE_TAB_QUERIES)[number],
  args: unknown[]
): unknown {
  const params: Record<string, unknown> = isRecord(args[0]) ? args[0] : {}
  const worktree = typeof params.worktree === 'string' ? params.worktree : undefined
  const page = typeof params.page === 'string' ? params.page : undefined
  switch (name) {
    case 'browserTabList':
      return queries.browserTabList({ worktree })
    case 'browserTabCurrent':
      return queries.browserTabCurrent({ worktree })
    case 'browserTabShow':
      if (!page) {
        throw new BrowserError('invalid_argument', 'Missing required --page')
      }
      return queries.browserTabShow({ page, worktree })
    case 'browserTabSwitch':
      return queries.browserTabSwitch({
        worktree,
        page,
        index: typeof params.index === 'number' ? params.index : undefined,
        focus: typeof params.focus === 'boolean' ? params.focus : undefined
      })
  }
}

// Why only the default: orcad has no profile registry to describe any other to a desktop.
function orcadBrowserProfileId(profileId: string | undefined): string {
  if (profileId !== undefined && profileId !== DEFAULT_BROWSER_PROFILE_ID) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return DEFAULT_BROWSER_PROFILE_ID
}

function orcadProfileLabel(browserProfileId: string): { id: string; label: string } {
  return {
    id: browserProfileId,
    label: browserProfileId === DEFAULT_BROWSER_PROFILE_ID ? 'Default' : browserProfileId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
