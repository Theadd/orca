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

// Why no Electron import: a host with no engine lists and selects the pages a desktop hosts for it.
export type BrowserClientPageQueryHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getAgentBrowserBridge'
  | 'resolveBrowserWorkspace'
  | 'getRuntimeBrowserPageRegistry'
  | 'markHeadlessBrowserSessionTabActive'
  | 'notifyHeadlessBrowserSessionTabsChanged'
>

/**
 * Tab commands for a host whose only tabs are the pages desktops host for it. "Current" is the
 * page the registry marks active, the same page workspace automation without --page drives.
 */
export class BrowserClientPageQueries {
  constructor(
    private readonly host: BrowserClientPageQueryHost,
    private readonly profileFor: (browserProfileId: string) => BrowserProfileLabel
  ) {}

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const pages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    return { tabs: pages.map((page, index) => this.row(page, index)) }
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
    const tab = page
      ? (
          await this.browserTabList({ worktree: params.worktree ?? `id:${page.workspaceId}` })
        ).tabs.find((candidate) => candidate.browserPageId === page.browserPageId)
      : undefined
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
    const page = selected
      ? this.host.getRuntimeBrowserPageRegistry().getPage(selected.browserPageId)
      : undefined
    if (!page) {
      const label = params.page ? `Browser page ${params.page}` : `Tab index ${params.index}`
      throw new BrowserError(
        'browser_tab_not_found',
        `${label} out of range (0-${listed.tabs.length - 1})`
      )
    }
    this.host.getRuntimeBrowserPageRegistry().activatePage(page.browserPageId, page.placement)
    publishSwitchedBrowserSessionTab(this.host, {
      placementKind: 'client',
      browserPageId: page.browserPageId,
      worktreeId: page.workspaceId,
      focus: params.focus
    })
    return { switched, browserPageId: page.browserPageId }
  }

  private row(page: RuntimeBrowserClientPage, index: number): BrowserTabInfo {
    const profile = this.profileFor(page.browserProfileId)
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
}
