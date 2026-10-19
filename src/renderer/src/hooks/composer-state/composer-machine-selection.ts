import { useEffect, useMemo, useState } from 'react'
import type { MachineTarget } from '../../../../shared/machine-inventory'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  buildMachineGroupOptions,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'
import {
  ensureMachinesLoaded,
  refreshMachineProviders,
  useMachineProviders
} from '@/store/machines'

// Composer-open freshness: reopening within this window reuses the last list.
const COMPOSER_LIST_MAX_AGE_MS = 30_000

export type ComposerMachineSelection = {
  groups: MachineGroupOption[]
  value: MachineTarget | null
  /** The committed machine, or null when it is no longer listed. */
  selected: MachineOption | null
  setValue: (value: MachineTarget | null) => void
}

/** Machine groups for the Run-on picker and the machine the composer will run on. */
export function useComposerMachineSelection({
  enabled,
  projectId,
  projectHostSetups
}: {
  enabled: boolean
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
}): ComposerMachineSelection | null {
  const [value, setValue] = useState<MachineTarget | null>(null)
  const providers = useMachineProviders()

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: providers only run while the picker can show them, never in the background.
    ensureMachinesLoaded()
    refreshMachineProviders(COMPOSER_LIST_MAX_AGE_MS)
  }, [enabled])

  const groups = useMemo(() => {
    const projectHostIds = new Set(
      projectHostSetups
        .filter((setup) => setup.projectId === projectId)
        .map((setup) => setup.hostId)
    )
    return buildMachineGroupOptions({ snapshots: providers, projectHostIds, allowCreate: false })
  }, [projectHostSetups, projectId, providers])

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

  return enabled ? { groups, value, selected, setValue } : null
}
