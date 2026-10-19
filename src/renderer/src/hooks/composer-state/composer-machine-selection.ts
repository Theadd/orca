import { useEffect, useMemo, useState } from 'react'
import type { MachineTarget } from '../../../../shared/machine-inventory'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  buildMachineGroupOptions,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'
import { findMachineForHost, machineTargetKey } from '@/lib/machines/machine-host-match'
import { ensureMachinesLoaded, refreshMachineProviders, useMachineSources } from '@/store/machines'

// Composer-open freshness: reopening within this window reuses the last list.
const COMPOSER_LIST_MAX_AGE_MS = 30_000

export type ComposerMachineSelection = {
  groups: MachineGroupOption[]
  /** The chosen machine; a selected host that runs on a machine counts as choosing it. */
  value: MachineTarget | null
  /** The committed machine, or null when it is no longer listed. */
  selected: MachineOption | null
  setValue: (value: MachineTarget | null) => void
  /** Hosts that are machines; the picker lists them as machines, never as plain hosts. */
  machineHostIds: ReadonlySet<string>
}

/** Machine groups for the Run-on picker and the machine the composer will run on. */
export function useComposerMachineSelection({
  enabled,
  projectId,
  projectHostSetups,
  selectedHostId
}: {
  enabled: boolean
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
  /** Host of the selected project location. */
  selectedHostId: string | null
}): ComposerMachineSelection | null {
  const [chosen, setValue] = useState<MachineTarget | null>(null)
  const sources = useMachineSources()

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: providers only run while the picker can show them, never in the background.
    ensureMachinesLoaded()
    refreshMachineProviders(COMPOSER_LIST_MAX_AGE_MS)
  }, [enabled])

  const { groups, machineHostIds } = useMemo(() => {
    const hostIds = new Set<string>()
    const keys = new Set<string>()
    for (const setup of projectHostSetups) {
      const match = findMachineForHost(setup.hostId, sources)
      if (!match) {
        continue
      }
      hostIds.add(setup.hostId)
      if (setup.projectId === projectId) {
        keys.add(
          machineTargetKey({ providerKey: match.snapshot.providerKey, machineId: match.machine.id })
        )
      }
    }
    return {
      groups: buildMachineGroupOptions({
        snapshots: sources.self,
        boundMachineKeys: keys,
        allowCreate: false
      }),
      machineHostIds: hostIds
    }
  }, [projectHostSetups, projectId, sources])

  const value = useMemo((): MachineTarget | null => {
    if (chosen) {
      return chosen
    }
    // Why: reopening on a machine-backed location must still wake that machine on submit.
    const match = selectedHostId ? findMachineForHost(selectedHostId, sources) : null
    return match && match.environmentId === null
      ? { providerKey: match.snapshot.providerKey, machineId: match.machine.id }
      : null
  }, [chosen, selectedHostId, sources])

  const selected = useMemo(() => {
    if (!value) {
      return null
    }
    return (
      groups
        .flatMap((group) => [...group.machines, ...group.archived])
        .find(
          (machine) =>
            machine.providerKey === value.providerKey && machine.machineId === value.machineId
        ) ?? null
    )
  }, [groups, value])

  return enabled ? { groups, value, selected, setValue, machineHostIds } : null
}
