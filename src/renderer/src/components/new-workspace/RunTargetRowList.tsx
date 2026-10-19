import React from 'react'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { HostRowIcon, RunTargetRow } from './RunTargetComboboxRow'
import { ConnectHostButton, NeedsSetupHostIcon, SetLocationButton } from './RunTargetRowActions'
import { RecipesSubmenuRow } from './RunTargetSubmenus'
import type { EphemeralVmRecipeOption, RunTargetRowModel } from './run-target-options'
import type { MachineRowModel } from './run-target-machine-rows'
import { RunTargetMachineGroupHeader, RunTargetMachineRow } from './RunTargetMachineRow'

/** The scrolling rows of the run-target picker; "Add host" is pinned outside this list. */
export default function RunTargetRowList({
  rows,
  armedKey,
  listId,
  selectedHost,
  selectedRecipeId,
  matchedRecipes,
  recipesOpen,
  connectingHostIds,
  canConnect,
  canSetLocation,
  onArm,
  onRecipesOpenChange,
  onSelectHost,
  onSelectRecipe,
  onConnectHost,
  onSetLocation,
  selectedMachineRowKey,
  now,
  onActivateMachineRow
}: {
  rows: readonly RunTargetRowModel[]
  armedKey: string | null
  listId: string
  /** The committed host, or null while a recipe holds the selection. */
  selectedHost: ReadyProjectHostSetupOption | null
  selectedRecipeId: string | null
  matchedRecipes: readonly EphemeralVmRecipeOption[]
  recipesOpen: boolean
  connectingHostIds: ReadonlySet<string>
  canConnect: boolean
  canSetLocation: boolean
  /** Arms a row and opens the submenu that row owns, if any. */
  onArm: (key: string, submenu: 'recipes' | null) => void
  onRecipesOpenChange: (open: boolean) => void
  onSelectHost: (option: ReadyProjectHostSetupOption) => void
  onSelectRecipe: (recipeId: string) => void
  onConnectHost: (option: NeedsSetupProjectHostOption) => void
  onSetLocation: (option: NeedsSetupProjectHostOption) => void
  /** Row key of the committed machine, if a machine holds the selection. */
  selectedMachineRowKey: string | null
  /** Clock for relative copy such as "seen 4m ago". */
  now: number
  onActivateMachineRow: (row: MachineRowModel) => void
}): React.JSX.Element {
  return (
    <>
      {rows.map((row, index) => {
        if (row.kind === 'add-host') {
          return null
        }
        if (row.kind === 'machine-group') {
          return <RunTargetMachineGroupHeader key={row.key} group={row.group} now={now} />
        }
        const isArmed = armedKey === row.key
        const optionId = isArmed ? `${listId}-armed` : undefined
        if (row.kind === 'ready') {
          return (
            <RunTargetRow
              key={row.key}
              icon={<HostRowIcon hostId={row.option.hostId} />}
              label={row.option.label}
              detail={row.option.path}
              armed={isArmed}
              current={row.option === selectedHost}
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={() => onSelectHost(row.option)}
            />
          )
        }
        if (row.kind === 'needs-setup') {
          // Why: hosts that still need setup follow the machine groups; a rule ends the last group.
          const closesMachineGroup = rows[index - 1]?.kind.startsWith('machine') ?? false
          const connecting = connectingHostIds.has(row.option.hostId)
          const hasConnect = Boolean(row.option.connectAction && canConnect)
          const hasSetLocation = Boolean(row.option.canSetLocation && canSetLocation)
          return (
            <React.Fragment key={row.key}>
              {closesMachineGroup ? (
                <div role="separator" className="-mx-1 my-1 h-px bg-border" />
              ) : null}
              <RunTargetRow
                icon={
                  <NeedsSetupHostIcon
                    hostId={row.option.hostId}
                    connecting={connecting}
                    attention={row.option.attention}
                  />
                }
                label={row.option.label}
                // Why: Connect / Set project location already say the next
                // step, so the detail line would only repeat that.
                detail={hasConnect || hasSetLocation ? '' : row.option.detail}
                armed={isArmed}
                current={false}
                dimmed
                optionId={optionId}
                onArm={() => onArm(row.key, null)}
                onCommit={() => onSetLocation(row.option)}
                trailing={
                  hasConnect ? (
                    <ConnectHostButton
                      connecting={connecting}
                      onConnect={() => onConnectHost(row.option)}
                    />
                  ) : hasSetLocation ? (
                    <SetLocationButton
                      hostLabel={row.option.label}
                      onSetLocation={() => onSetLocation(row.option)}
                    />
                  ) : undefined
                }
              />
            </React.Fragment>
          )
        }
        if (row.kind === 'recipes') {
          return (
            <RecipesSubmenuRow
              key={row.key}
              open={recipesOpen}
              onOpenChange={onRecipesOpenChange}
              armed={isArmed}
              optionId={optionId}
              recipes={matchedRecipes}
              selectedRecipeId={selectedRecipeId}
              onArm={() => onArm(row.key, 'recipes')}
              onSelectRecipe={onSelectRecipe}
            />
          )
        }
        return (
          <RunTargetMachineRow
            key={row.key}
            row={row}
            armed={isArmed}
            current={row.key === selectedMachineRowKey}
            optionId={optionId}
            onArm={() => onArm(row.key, null)}
            onCommit={() => onActivateMachineRow(row)}
          />
        )
      })}
    </>
  )
}
