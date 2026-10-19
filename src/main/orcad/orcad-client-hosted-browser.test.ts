import { afterEach, expect, it, vi } from 'vitest'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import {
  createRuntimeBrowserCommands,
  runtimeBrowserCommandsFactoryIsAvailable,
  runtimeBrowserCommandsFactorySupportsClientHosting,
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from '../runtime/runtime-browser-page-registry'

vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  setRuntimeBrowserCommandsFactory(null)
  setRuntimeBrowserUnavailableCause(null)
})

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'desktop-a',
  browserHostGeneration: 2,
  pageHostGeneration: 5
}

/** orcad as `orca serve` runs it with no browser engine: discovery declines, unconfigured. */
async function startWithoutEngine() {
  vi.mocked(resolveOrcadBrowserProvider).mockImplementationOnce(async () => {
    setRuntimeBrowserUnavailableCause({ reason: 'unconfigured' })
    return null
  })
  const startup = startOrcadBrowserProvider({ userDataPath: '/private-fixture' })
  await startup.ready
  return startup
}

function pairedHost(options: { desktopAttached: boolean }) {
  const pages = new RuntimeBrowserPageRegistry()
  const select = vi.fn(() => {
    if (!options.desktopAttached) {
      throw new Error('browser_host_unavailable')
    }
    return { browserHostClientId: 'desktop-a', pairedDeviceId: 'device-a' }
  })
  const createClientPage = vi.fn(async () => PLACEMENT)
  const issueClientPageCommand = vi.fn(() => ({
    event: {} as never,
    result: Promise.resolve({ status: 'completed' as const })
  }))
  const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
  const host = {
    getAgentBrowserBridge: () => null,
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserNetworkExecutionHost: async () => ({
      kind: 'native' as const,
      runtimeId: 'orcad-a',
      revision: 1
    }),
    getRuntimeBrowserPageRegistry: () => pages,
    getBrowserHostLeaseRegistry: () => ({
      authorityRuntimeId: 'orcad-a',
      authorityEpoch: 'epoch-a',
      select,
      createClientPage,
      issueClientPageCommand
    }),
    markHeadlessBrowserSessionTabActive: vi.fn(),
    notifyHeadlessBrowserSessionTabsChanged
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every member the client-page path reads; the rest of the host is engine-only.
  const commandHost = host as unknown as RuntimeBrowserCommandHost
  return { host: commandHost, pages, select, createClientPage, issueClientPageCommand }
}

it('opens open-url in the paired desktop when orcad has no browser engine', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)

  const opened = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/',
    worktree: 'id:wt-1'
  })

  expect(paired.select).toHaveBeenCalledWith(undefined, ['webview', 'automation-v1'])
  expect(paired.createClientPage).toHaveBeenCalledWith(
    expect.objectContaining({
      browserPageId: opened.browserPageId,
      browserHostClientId: 'desktop-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      workspaceId: 'wt-1'
    })
  )
  expect(paired.issueClientPageCommand).toHaveBeenCalledWith(
    expect.objectContaining({ browserPageId: opened.browserPageId }),
    { type: 'navigate', url: 'https://example.org/' }
  )
  expect(paired.pages.getPage(opened.browserPageId)).toMatchObject({
    workspaceId: 'wt-1',
    url: 'https://example.org/',
    active: true,
    placement: PLACEMENT
  })
  await startup.stop()
})

it('refuses open-url with what to do when no paired desktop hosts this server’s pages', async () => {
  const startup = await startWithoutEngine()
  const commands = createRuntimeBrowserCommands(pairedHost({ desktopAttached: false }).host)

  await expect(
    commands.browserOpenUrlOnClient({ url: 'https://example.org/', worktree: 'id:wt-1' })
  ).rejects.toMatchObject({
    code: 'browser_host_unavailable',
    message: expect.stringContaining("open a browser tab in one of this server's workspaces")
  })
  await startup.stop()
})

it('creates a client-placed tab without an engine, and only in the default profile', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const placement = { kind: 'client' as const, browserHostClientId: 'desktop-a' }

  await expect(
    commands.browserTabCreate(
      { worktree: 'id:wt-1', page: 'page-a', url: 'https://example.org/', placement },
      { pairedDeviceId: 'device-a', clientKind: 'runtime' }
    )
  ).resolves.toEqual({ browserPageId: 'page-a' })
  expect(paired.pages.getPage('page-a')?.workspaceId).toBe('wt-1')

  await expect(
    commands.browserTabCreate(
      { worktree: 'id:wt-1', profileId: 'work', placement },
      { pairedDeviceId: 'device-a', clientKind: 'runtime' }
    )
  ).rejects.toMatchObject({ code: 'invalid_argument' })
  await startup.stop()
})

it('sends an unplaced tab to the paired desktop, and refuses as before when none is attached', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const created = await createRuntimeBrowserCommands(paired.host).browserTabCreate({
    worktree: 'id:wt-1',
    url: 'https://example.org/'
  })
  expect(paired.pages.getPage(created.browserPageId)?.placement).toEqual(PLACEMENT)

  const unattached = createRuntimeBrowserCommands(pairedHost({ desktopAttached: false }).host)
  expect(() => unattached.browserTabCreate({ worktree: 'id:wt-1' })).toThrow(/unavailable/)
  await startup.stop()
})

it('advertises client hosting with no engine and keeps the engine’s own cause', async () => {
  const startup = await startWithoutEngine()

  expect(runtimeBrowserCommandsFactoryIsAvailable()).toBe(false)
  expect(runtimeBrowserCommandsFactorySupportsClientHosting()).toBe(true)
  expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'unconfigured' })
  await startup.stop()
})
