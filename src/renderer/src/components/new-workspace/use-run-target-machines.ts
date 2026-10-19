import { useCallback, useMemo, useState } from 'react'
import type { MachineTarget } from '../../../../shared/machine-inventory'
import type { MachineGroupOption, MachineOption } from '@/lib/machines/machine-group-options'
import {
  machineRowKey,
  type MachineGroupView,
  type MachineRowModel
} from './run-target-machine-rows'

/** What a provider group's own row asks for; the composer decides how to do it. */
export type MachineProviderAction = {
  kind: 'create' | 'sign-in' | 'retry' | 'details'
  group: MachineGroupOption
}

export type RunTargetMachineProps = {
  groups: readonly MachineGroupOption[]
  value: MachineTarget | null
  onChange: (machine: MachineOption | null) => void
  onProviderAction: (action: MachineProviderAction) => void
}

const CLOSING_ACTIONS = {
  'machine-create': 'create',
  'machine-sign-in': 'sign-in',
  'machine-details': 'details'
} as const

const COLLAPSED: MachineGroupView = { expanded: false, archivedOpen: false }
const NO_GROUPS: readonly MachineGroupOption[] = []

/**
 * Machine rows' share of the run-target picker: per-provider expansion, the committed machine,
 * and what each row does when taken. Rows that only reveal more rows keep the picker open.
 */
export function useRunTargetMachines(machines: RunTargetMachineProps | undefined): {
  groups: readonly MachineGroupOption[]
  views: Readonly<Record<string, MachineGroupView>>
  selected: { group: MachineGroupOption; machine: MachineOption } | null
  selectedRowKey: string | null
  /** `close` dismisses the picker for rows that finish the choice. */
  activate: (row: MachineRowModel, close: () => void) => void
} {
  const [views, setViews] = useState<Record<string, MachineGroupView>>({})
  const groups = machines?.groups ?? NO_GROUPS
  const value = machines?.value ?? null

  const selected = useMemo(() => {
    if (!value) {
      return null
    }
    for (const group of groups) {
      const machine = [...group.machines, ...group.archived].find(
        (candidate) =>
          candidate.providerKey === value.providerKey && candidate.machineId === value.machineId
      )
      if (machine) {
        return { group, machine }
      }
    }
    return null
  }, [groups, value])

  const updateView = useCallback(
    (providerKey: string, change: (view: MachineGroupView) => MachineGroupView): void =>
      setViews((current) => ({
        ...current,
        [providerKey]: change(current[providerKey] ?? COLLAPSED)
      })),
    []
  )

  const activate = useCallback(
    (row: MachineRowModel, close: () => void): void => {
      switch (row.kind) {
        case 'machine-group':
          return
        case 'machine':
          machines?.onChange(row.machine)
          close()
          return
        case 'machine-more':
          updateView(row.group.providerKey, (view) => ({
            expanded: !view.expanded,
            archivedOpen: view.expanded ? false : view.archivedOpen
          }))
          return
        case 'machine-archived':
          updateView(row.group.providerKey, (view) => ({
            ...view,
            archivedOpen: !view.archivedOpen
          }))
          return
        case 'machine-retry':
          // Why: the group refreshes in place, so the picker stays open to show the result.
          machines?.onProviderAction({ kind: 'retry', group: row.group })
          return
        case 'machine-create':
        case 'machine-sign-in':
        case 'machine-details':
          close()
          machines?.onProviderAction({ kind: CLOSING_ACTIONS[row.kind], group: row.group })
      }
    },
    [machines, updateView]
  )

  return {
    groups,
    views,
    selected,
    selectedRowKey: selected ? machineRowKey(selected.machine) : null,
    activate
  }
}
