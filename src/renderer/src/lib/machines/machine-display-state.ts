import type { MachineState } from '../../../../shared/machine-inventory'
import { translate } from '@/i18n/i18n'

/** The one vocabulary the UI uses; provider states outside it fold into these. */
export type MachineDisplayState =
  | 'starting'
  | 'running'
  | 'sleeping'
  | 'archived'
  | 'unreachable'
  | 'gone'

export function getMachineDisplayState(state: MachineState): MachineDisplayState {
  switch (state) {
    case 'creating':
    case 'waking':
      return 'starting'
    case 'running':
      return 'running'
    case 'sleeping':
      return 'sleeping'
    case 'archived':
      return 'archived'
    case 'gone':
      return 'gone'
    // Why: an error or unknown verdict is not evidence the machine is gone; it needs attention.
    case 'error':
    case 'unknown':
    case 'unreachable':
      return 'unreachable'
  }
}

export function getMachineDisplayStateLabel(state: MachineDisplayState): string {
  switch (state) {
    case 'starting':
      return translate('auto.lib.machines.machineDisplayState.starting', 'Starting')
    case 'running':
      return translate('auto.lib.machines.machineDisplayState.running', 'Running')
    case 'sleeping':
      return translate('auto.lib.machines.machineDisplayState.sleeping', 'Sleeping')
    case 'archived':
      return translate('auto.lib.machines.machineDisplayState.archived', 'Archived')
    case 'unreachable':
      return translate('auto.lib.machines.machineDisplayState.unreachable', 'Unreachable')
    case 'gone':
      return translate('auto.lib.machines.machineDisplayState.gone', 'Gone')
  }
}

/** Submitting on a stopped machine wakes it first; a running one is used as is. */
export function machineNeedsWake(state: MachineState): boolean {
  return state === 'sleeping' || state === 'archived'
}
