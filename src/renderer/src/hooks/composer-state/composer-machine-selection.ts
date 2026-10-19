import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MachineTarget } from '../../../../shared/machine-inventory'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  buildMachineGroupOptions,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'
import { machineNeedsWake } from '@/lib/machines/machine-display-state'
import { findMachineForHost, machineTargetKey } from '@/lib/machines/machine-host-match'
import { runMachineProviderRowAction } from '@/lib/machines/machine-provider-actions'
import { ensureMachinesLoaded, refreshMachineProviders, useMachineSources } from '@/store/machines'
import type {
  MachineProviderAction,
  RunTargetMachineProps
} from '@/components/new-workspace/use-run-target-machines'

// Composer-open freshness: reopening within this window reuses the last list.
const COMPOSER_LIST_MAX_AGE_MS = 30_000

export type SelectedMachine = { group: MachineGroupOption; machine: MachineOption }

export type ComposerMachineSelection = {
  /** The machine the composer will run on; a selected host on a listed machine counts. */
  selected: SelectedMachine | null
  /** Hosts the picker lists as their machine instead of as plain hosts. */
  machineHostIds: ReadonlySet<string>
  /** Stable props for the Run-on picker's machine rows. */
  picker: RunTargetMachineProps
  /** The selected location's machine is stopped, so nothing should probe its repo yet. */
  selectedHostAsleep: boolean
}

function findOption(
  groups: readonly MachineGroupOption[],
  target: MachineTarget
): SelectedMachine | null {
  for (const group of groups) {
    if (group.providerKey !== target.providerKey) {
      continue
    }
    const machine = [...group.machines, ...group.archived].find(
      (candidate) => candidate.machineId === target.machineId
    )
    if (machine) {
      return { group, machine }
    }
  }
  return null
}

function runProviderAction({ kind, group }: MachineProviderAction): void {
  runMachineProviderRowAction(kind, group.providerKey)
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
  const [chosen, setChosen] = useState<MachineTarget | null>(null)
  const sources = useMachineSources()

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: providers only run while the picker can show them, never in the background.
    ensureMachinesLoaded()
    refreshMachineProviders(COMPOSER_LIST_MAX_AGE_MS)
  }, [enabled])

  const groups = useMemo(() => {
    const boundKeys = new Set<string>()
    for (const setup of projectHostSetups) {
      const match = setup.projectId === projectId ? findMachineForHost(setup.hostId, sources) : null
      if (match?.environmentId === null) {
        boundKeys.add(
          machineTargetKey({ providerKey: match.snapshot.providerKey, machineId: match.machine.id })
        )
      }
    }
    return buildMachineGroupOptions({ snapshots: sources.self, boundMachineKeys: boundKeys })
  }, [projectHostSetups, projectId, sources])

  // Why: only a host whose machine is listed may hide; any other stays pickable as a host.
  const machineHostIds = useMemo(() => {
    const hostIds = new Set<string>()
    for (const setup of projectHostSetups) {
      const match = findMachineForHost(setup.hostId, sources)
      if (
        match?.environmentId === null &&
        findOption(groups, { providerKey: match.snapshot.providerKey, machineId: match.machine.id })
      ) {
        hostIds.add(setup.hostId)
      }
    }
    return hostIds
  }, [groups, projectHostSetups, sources])

  const selected = useMemo((): SelectedMachine | null => {
    if (chosen) {
      return findOption(groups, chosen)
    }
    // Why: reopening on a machine-backed location must still wake that machine on submit.
    const match = selectedHostId ? findMachineForHost(selectedHostId, sources) : null
    return match?.environmentId === null
      ? findOption(groups, { providerKey: match.snapshot.providerKey, machineId: match.machine.id })
      : null
  }, [chosen, groups, selectedHostId, sources])

  const selectedHostAsleep = useMemo(() => {
    const match = selectedHostId ? findMachineForHost(selectedHostId, sources) : null
    return match ? machineNeedsWake(match.machine.state) : false
  }, [selectedHostId, sources])

  const onChange = useCallback(
    (machine: MachineOption | null): void =>
      setChosen(
        machine ? { providerKey: machine.providerKey, machineId: machine.machineId } : null
      ),
    []
  )

  const picker = useMemo(
    (): RunTargetMachineProps => ({
      groups,
      selected,
      onChange,
      onProviderAction: runProviderAction
    }),
    [groups, onChange, selected]
  )

  return useMemo(
    () => (enabled ? { selected, machineHostIds, picker, selectedHostAsleep } : null),
    [enabled, machineHostIds, picker, selected, selectedHostAsleep]
  )
}
