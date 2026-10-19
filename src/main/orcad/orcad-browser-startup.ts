import { BrowserError } from '../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import {
  browserUnavailableError,
  setRuntimeBrowserCommandsFactory
} from '../runtime/runtime-browser-commands-factory'
import {
  closeBrowserPageWithoutEngine,
  closeRegisteredBrowserClientPage
} from '../runtime/browser/browser-client-page-close'
import {
  createBrowserClientPage,
  createBrowserPageOnPairedHost,
  DEFAULT_BROWSER_PROFILE_ID,
  hasPairedPageHost,
  openBrowserUrlOnClient,
  type BrowserClientPageCaller,
  type BrowserClientPageCreateParams
} from '../runtime/browser/browser-client-page-opening'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import {
  resolveOrcadBrowserProvider,
  type OrcadBrowserProvider,
  type OrcadBrowserProviderOptions
} from './orcad-browser-provider'

/** Browser discovery must not hold core RPC readiness hostage to a desktop authorization UI. */
export function startOrcadBrowserProvider(options: OrcadBrowserProviderOptions): {
  ready: Promise<void>
  stop(): Promise<void>
} {
  const controller = new AbortController()
  let provider: OrcadBrowserProvider | null = null
  let startupError: unknown
  let stopping: Promise<void> | undefined
  const engineAvailable = (): boolean => !controller.signal.aborted && !!provider?.isAvailable()
  setRuntimeBrowserCommandsFactory(
    (host) => {
      let commands: RuntimeBrowserCommands | undefined
      // Every member resolves through the getter, so the target needs no members of its own.
      const target: RuntimeBrowserCommands = Object.create(null)
      return new Proxy(target, {
        get: (_target, property) => {
          if (property === 'then' || typeof property !== 'string') {
            return undefined
          }
          const forward = (args: unknown[]): unknown => {
            if (!engineAvailable() || !provider) {
              throw browserUnavailableError()
            }
            commands ??= provider.factory(host)
            return callBrowserCommand(commands, property, args)
          }
          if (property === 'browserOpenUrlOnClient') {
            // Why: the page renders on a paired desktop, so open-url never needs this host's engine.
            return (...args: Parameters<RuntimeBrowserCommands['browserOpenUrlOnClient']>) =>
              openBrowserUrlOnClient(host, args[0])
          }
          if (property === 'browserTabCreate') {
            return (...args: Parameters<RuntimeBrowserCommands['browserTabCreate']>) => {
              const [params, caller] = args
              if (params?.placement?.kind === 'client') {
                return createOrcadBrowserClientPage(
                  host,
                  { ...params, placement: params.placement },
                  caller
                )
              }
              // Why: with no engine here, a desktop hosting this server's pages is the only browser.
              if (!params?.placement && !engineAvailable() && hasPairedPageHost(host)) {
                return createBrowserPageOnPairedHost(
                  host,
                  params ?? {},
                  orcadBrowserProfileId(params?.profileId)
                )
              }
              return forward(args)
            }
          }
          if (property === 'browserTabClose') {
            // Why: client-hosted pages live in this runtime's registry, never in the provider.
            return async (...args: Parameters<RuntimeBrowserCommands['browserTabClose']>) => {
              const params = args[0] ?? {}
              if (!engineAvailable()) {
                return closeBrowserPageWithoutEngine(host, params, browserUnavailableError)
              }
              return (await closeRegisteredBrowserClientPage(host, params)) ?? forward(args)
            }
          }
          return (...args: unknown[]) => forward(args)
        }
      })
    },
    {
      headless: true,
      clientHostingWithoutEngine: true,
      isAvailable: engineAvailable
    }
  )
  const ready = Promise.resolve()
    .then(() => resolveOrcadBrowserProvider({ ...options, signal: controller.signal }))
    .then(
      // Why the factory stays installed without a provider: it still serves desktop-hosted pages.
      (resolved) => {
        provider = resolved
      },
      (error: unknown) => {
        startupError = error
        if (!controller.signal.aborted) {
          console.warn('[orcad] Browser startup failed:', error)
        }
      }
    )
  return {
    ready,
    stop: () => {
      controller.abort()
      stopping ??= ready.then(async () => {
        await provider?.stop()
        // Unexpected resolver errors may include failed cleanup of a partially started provider.
        if (startupError) {
          throw startupError
        }
      })
      return stopping
    }
  }
}

type BrowserCommandMember = (this: RuntimeBrowserCommands, ...args: unknown[]) => unknown

function isBrowserCommandMember(value: unknown): value is BrowserCommandMember {
  return typeof value === 'function'
}

/** The proxy forwards by name; anything that is not a command method is refused, not invoked. */
function callBrowserCommand(
  commands: RuntimeBrowserCommands,
  name: string,
  args: unknown[]
): unknown {
  const member: unknown = name in commands ? commands[name] : undefined
  if (!isBrowserCommandMember(member)) {
    throw new BrowserError(BROWSER_UNAVAILABLE_ERROR_CODE, `Unknown browser command: ${name}`)
  }
  return member.call(commands, ...args)
}

/** A client-placed page on a host with no profile registry. */
async function createOrcadBrowserClientPage(
  host: RuntimeBrowserCommandHost,
  params: BrowserClientPageCreateParams & { worktree?: string; profileId?: string },
  caller: BrowserClientPageCaller | undefined
): Promise<{ browserPageId: string }> {
  const worktree = params.worktree ? await host.resolveBrowserWorkspace(params.worktree) : undefined
  const browserProfileId = orcadBrowserProfileId(params.profileId)
  return createBrowserClientPage(host, params, { worktree, browserProfileId, caller })
}

// Why only the default: orcad has no profile registry to describe any other to a desktop.
function orcadBrowserProfileId(profileId: string | undefined): string {
  if (profileId !== undefined && profileId !== DEFAULT_BROWSER_PROFILE_ID) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return DEFAULT_BROWSER_PROFILE_ID
}
