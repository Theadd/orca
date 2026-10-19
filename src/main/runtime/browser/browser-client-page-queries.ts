import { BrowserError } from '../../browser/browser-error'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../../shared/runtime-types'
import { publishSwitchedBrowserSessionTab } from '../browser-tab-create-publication'
import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

type BrowserProfileLabel = { id: string; label: string }

/** The tab row a client-hosted page lists as; `index` is its place after any engine tabs. */
export function clientPageTabRow(
  page: RuntimeBrowserClientPage,
  index: number,
  profile: BrowserProfileLabel
): BrowserTabInfo {
  return {
    browserPageId: page.browserPageId,
    index,
    url: page.url,
    title: page.title,
    active: page.active,
    loadError: null,
    certificateFailure: null,
    worktreeId: page.workspaceId,
    profileId: profile.id,
    profileLabel: profile.label
  }
}

// Why no Electron import: a host with no engine lists and selects the pages a desktop hosts for it.
export type BrowserClientPageQueryHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getAgentBrowserBridge'
  | 'resolveBrowserWorkspace'
  | 'getRuntimeBrowserPageRegistry'
  | 'markHeadlessBrowserSessionTabActive'
  | 'notifyHeadlessBrowserSessionTabsChanged'
>

/** The tabs a host's own engine holds, beside the pages desktops host for it; null without one. */
export type BrowserEngineTabs = {
  list(params: { worktree?: string }): Promise<BrowserTabListResult>
  switchTo(params: {
    page: string
    worktree?: string
    focus?: boolean
  }): Promise<BrowserTabSwitchResult>
}

/** Tab commands over a host's engine tabs, if any, followed by its client-hosted pages. */
export class BrowserClientPageQueries {
  constructor(
    private readonly host: BrowserClientPageQueryHost,
    private readonly profileFor: (browserProfileId: string) => BrowserProfileLabel,
    private readonly engine: BrowserEngineTabs | null
  ) {}

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const pages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    const clientPageActive = pages.some((page) => page.active)
    const engineTabs = this.engine
      ? (await this.engine.list(params)).tabs.map((tab) => ({
          ...tab,
          active: clientPageActive ? false : tab.active
        }))
      : []
    const tabs = [
      ...engineTabs,
      ...pages.map((page, offset) =>
        clientPageTabRow(page, engineTabs.length + offset, this.profileFor(page.browserProfileId))
      )
    ]
    if (tabs.length > 0 && !tabs.some((tab) => tab.active)) {
      tabs[0] = { ...tabs[0]!, active: true }
    }
    return { tabs: tabs.map((tab, index) => ({ ...tab, index })) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabShowResult> {
    const tab = (await this.browserTabList(params)).tabs.find((candidate) => candidate.active)
    if (!tab) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { tab }
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const page = this.host.getRuntimeBrowserPageRegistry().getPage(params.page)
    const worktree = params.worktree ?? (page ? `id:${page.workspaceId}` : undefined)
    const tab = (await this.browserTabList({ worktree })).tabs.find(
      (candidate) => candidate.browserPageId === params.page
    )
    if (!tab) {
      throw new BrowserError('browser_tab_not_found', `Browser page ${params.page} was not found`)
    }
    return { tab }
  }

  async browserTabSwitch(params: {
    index?: number
    page?: string
    worktree?: string
    focus?: boolean
  }): Promise<BrowserTabSwitchResult> {
    const listed = await this.browserTabList({ worktree: params.worktree })
    const switched = params.page
      ? listed.tabs.findIndex((tab) => tab.browserPageId === params.page)
      : (params.index ?? -1)
    const selected = listed.tabs[switched]
    if (!selected) {
      const label = params.page ? `Browser page ${params.page}` : `Tab index ${params.index}`
      throw new BrowserError(
        'browser_tab_not_found',
        `${label} out of range (0-${listed.tabs.length - 1})`
      )
    }
    const pages = this.host.getRuntimeBrowserPageRegistry()
    const page = pages.getPage(selected.browserPageId)
    if (page) {
      activateClientPageTab(this.host, page, params.focus)
      return { switched, browserPageId: page.browserPageId }
    }
    if (!this.engine) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${selected.browserPageId} was not found`
      )
    }
    const result = await this.engine.switchTo({
      page: selected.browserPageId,
      ...(params.worktree ? { worktree: params.worktree } : {}),
      ...(params.focus !== undefined ? { focus: params.focus } : {})
    })
    // Why: an engine tab now leads, so no client page may still claim to be active beside it.
    pages.deactivateGlobal()
    const workspaceId =
      typeof selected.worktreeId === 'string'
        ? selected.worktreeId
        : params.worktree
          ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
          : undefined
    if (workspaceId) {
      pages.deactivateWorkspace(workspaceId)
    }
    return { switched, browserPageId: result.browserPageId }
  }
}

/** Makes a client-hosted page its workspace's active tab and publishes the switch. */
export function activateClientPageTab(
  host: BrowserClientPageQueryHost,
  page: RuntimeBrowserClientPage,
  focus: boolean | undefined
): void {
  host.getRuntimeBrowserPageRegistry().activatePage(page.browserPageId, page.placement)
  publishSwitchedBrowserSessionTab(host, {
    placementKind: 'client',
    browserPageId: page.browserPageId,
    worktreeId: page.workspaceId,
    focus
  })
}
