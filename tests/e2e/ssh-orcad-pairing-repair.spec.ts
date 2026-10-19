/**
 * A managed SSH host whose server dropped this desktop's pairing (its device removed host-side,
 * then the server restarted) is paired again over SSH, and the open pane answers typing again on
 * its own. A server that now holds another host key is never paired: connecting reports another
 * server, and the saved pairing is kept.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import { reconnect } from './helpers/orcad-convert-flow'
import {
  echoMarker,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const DEVICES = '/root/.orca/orca-devices.json'
const KEYPAIR = '/root/.orca/orca-e2ee-keypair.json'
const KILL_ORCAD = 'kill -TERM $(cat /root/.orca-remote/orcad-*/.orcad-pid)'

async function pairing(page: Page, environmentId: string) {
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.id === environmentId
  )
  return {
    revision: environment?.pairingRevision ?? environment?.createdAt ?? null,
    deviceId: environment?.pairedDeviceId ?? null
  }
}

function reconnectBanner(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const pane = document.querySelector(`[data-terminal-tab-id="${id}"]`) ?? document
    return (
      pane
        .querySelector('[data-terminal-remote-runtime-reconnect-banner]')
        ?.getAttribute('data-terminal-remote-runtime-reconnect-banner') ?? null
    )
  }, tabId)
}

test('a host that dropped this desktop is paired again over SSH and its pane answers', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const tabId = await openTerminalTab(page, seeded.worktreeId)
    await echoMarker(page, tabId, 'BEFORE_REVOKE')
    const before = await pairing(page, environmentId)
    expect(before.deviceId).toBeTruthy()

    // Host side, as an admin would: remove this desktop's device, then restart the server.
    host.exec!(
      `node -e 'const f=process.argv[1];const fs=require("fs");` +
        `fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8"))` +
        `.filter((d)=>d.deviceId!==process.argv[2])))' ${DEVICES} ${before.deviceId}`
    )
    host.exec!(KILL_ORCAD)

    try {
      await expectTerminalAnswers(page, tabId, 4 * 60_000)
    } catch (error) {
      console.log(
        '[pairing-repair] evidence',
        JSON.stringify({
          banner: await reconnectBanner(page, tabId),
          pane: (await readPairedPaneContent(page, tabId)).slice(-600),
          devices: host.exec!(`cat ${DEVICES}`)
        })
      )
      await page.screenshot({ path: testInfo.outputPath('after-revoke.png') })
      throw error
    }
    const after = await pairing(page, environmentId)
    expect(after.revision).not.toBe(before.revision)
    expect(after.deviceId).not.toBe(before.deviceId)
    await expect.poll(() => reconnectBanner(page, tabId)).toBeNull()
    await page.screenshot({ path: testInfo.outputPath('repaired.png') })
  })
})

test('a server that now holds another host key is never paired, and connecting says so', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const tabId = await openTerminalTab(page, seeded.worktreeId)
    await echoMarker(page, tabId, 'BEFORE_RESET')
    const before = await pairing(page, environmentId)

    // The server's identity is reset: a new key and no devices, as a wiped profile would have.
    host.exec!(`rm -f ${KEYPAIR} ${DEVICES} && ${KILL_ORCAD}`)

    // The first connect may find the server down and start it; the next one meets the new key.
    let connected = ''
    await expect
      .poll(
        async () => {
          // The helper throws when the connect is refused; the refusal is the answer here.
          connected = await reconnect(page, seeded.targetId).catch((error: unknown) =>
            String(error)
          )
          return connected
        },
        { timeout: 3 * 60_000, intervals: [1_000, 5_000] }
      )
      .toMatch(/orcad_identity_mismatch/)
    expect(connected).not.toMatch(/pairing_repair/)
    expect(await pairing(page, environmentId)).toEqual(before)
    // Nothing re-pairs in the background either.
    await page.waitForTimeout(20_000)
    expect(await pairing(page, environmentId)).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath('foreign.png') })
  })
})
