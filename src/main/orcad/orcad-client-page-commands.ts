/**
 * The browser commands orcad answers itself. Pages a paired desktop hosts for it live in this
 * runtime's lease and page registries, so opening one never needs a browser engine here. With no
 * engine those pages are every tab this host has, so the tab commands answer from the registry.
 * With an engine, tab commands stay the engine's, as before.
 */
import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import { browserUnavailableError } from '../runtime/runtime-browser-commands-factory'
import {
  closeBrowserPageWithoutEngine,
  closeRegisteredBrowserClientPage,
  resolveClientPageToClose,
  retireRuntimeBrowserClientPage
} from '../runtime/browser/browser-client-page-close'
import {
  createBrowserClientPage,
  createBrowserPageOnPairedHost,
  DEFAULT_BROWSER_PROFILE_ID,
  hasPairedPageHost,
  openBrowserUrlOnClient
} from '../runtime/browser/browser-client-page-opening'
import { BrowserClientPageQueries } from '../runtime/browser/browser-client-page-queries'
import type { RuntimeBrowserClientPage } from '../runtime/runtime-browser-page-registry'
import { browserTabCreateClientPageStartsActive } from '../runtime/browser-tab-create-publication'

type Forward = (args: unknown[]) => unknown

const CLIENT_PAGE_TAB_QUERIES = [
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
      if (engineAvailable()) {
        // Why: client pages live in this runtime's registry, never in the engine. An active one is
        // also what workspace automation without --page drives, so an implicit close takes it.
        const active =
          params.page || params.index !== undefined
            ? undefined
            : await activeClientPage(host, params)
        return active
          ? retireRuntimeBrowserClientPage(host, active)
          : ((await closeRegisteredBrowserClientPage(host, params)) ?? forward(args))
      }
      const page = await resolveClientPageToClose(host, clientPageQueries(host), params)
      return page
        ? retireRuntimeBrowserClientPage(host, page)
        : closeBrowserPageWithoutEngine(host, params, browserUnavailableError)
    }
  }
  const query = CLIENT_PAGE_TAB_QUERIES.find((candidate) => candidate === name)
  if (query) {
    return (...args: unknown[]) => {
      if (!engineAvailable()) {
        return servesClientPages(host)
          ? callTabQuery(clientPageQueries(host), query, args)
          : forward(args)
      }
      return query === 'browserTabSwitch'
        ? afterEngineSelects(host, args[0], () => forward(args))
        : forward(args)
    }
  }
  return undefined
}

/**
 * Runs an engine create or switch, then hands the workspace's selection to the engine tab: the
 * dispatcher sends workspace automation without --page to the active client page, so one left
 * active would keep taking commands meant for the tab the engine now reports as current.
 */
function afterEngineSelects(
  host: RuntimeBrowserCommandHost,
  params: unknown,
  run: () => unknown
): unknown {
  if (host.getRuntimeBrowserPageRegistry().listPages().length === 0) {
    return run()
  }
  return (async () => {
    const result = await run()
    const worktree =
      isRecord(params) && typeof params.worktree === 'string' ? params.worktree : null
    const pages = host.getRuntimeBrowserPageRegistry()
    pages.deactivateGlobal()
    if (worktree) {
      pages.deactivateWorkspace((await host.resolveBrowserWorkspace(worktree)).id)
    }
    return result
  })()
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
  if (!engineAvailable() || !browserTabCreateClientPageStartsActive(params?.activate)) {
    return forward([params, caller])
  }
  return afterEngineSelects(host, params, () => forward([params, caller]))
}

async function activeClientPage(
  host: RuntimeBrowserCommandHost,
  params: { worktree?: string }
): Promise<RuntimeBrowserClientPage | undefined> {
  if (!params.worktree) {
    return undefined
  }
  const workspaceId = (await host.resolveBrowserWorkspace(params.worktree)).id
  return host
    .getRuntimeBrowserPageRegistry()
    .listPages(workspaceId)
    .find((page) => page.active)
}

function servesClientPages(host: RuntimeBrowserCommandHost): boolean {
  return host.getRuntimeBrowserPageRegistry().listPages().length > 0 || hasPairedPageHost(host)
}

function clientPageQueries(host: RuntimeBrowserCommandHost): BrowserClientPageQueries {
  return new BrowserClientPageQueries(host, (browserProfileId) => ({
    id: browserProfileId,
    label: browserProfileId === DEFAULT_BROWSER_PROFILE_ID ? 'Default' : browserProfileId
  }))
}

function callTabQuery(
  queries: BrowserClientPageQueries,
  name: (typeof CLIENT_PAGE_TAB_QUERIES)[number],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
