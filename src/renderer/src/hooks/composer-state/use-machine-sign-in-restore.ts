import { useEffect, useMemo, useRef } from 'react'
import { signInToMachineProvider } from '@/lib/machines/machine-provider-actions'
import { useAppStore } from '@/store'
import type { ComposerMachineSelection } from './composer-machine-selection'

/**
 * Signing in closes the dialog so the sign-in terminal isn't hidden under it; the modal composer
 * keeps no draft, so this hands sign-in a way back with the typed name and the opening target.
 */
export function useMachineSignInRestore(
  machineSelection: ComposerMachineSelection | null | undefined,
  modalData: Record<string, unknown>,
  name: string
): ComposerMachineSelection | null {
  const latest = useRef({ modalData, name })
  useEffect(() => {
    latest.current = { modalData, name }
  }, [modalData, name])

  return useMemo(() => {
    if (!machineSelection) {
      return null
    }
    const { picker } = machineSelection
    return {
      ...machineSelection,
      picker: {
        ...picker,
        onProviderAction: (action) => {
          if (action.kind !== 'sign-in') {
            picker.onProviderAction(action)
            return
          }
          const reopen = { ...latest.current.modalData, prefilledName: latest.current.name }
          signInToMachineProvider(action.group.providerKey, () =>
            useAppStore.getState().openModal('new-workspace-composer', reopen)
          )
        }
      }
    }
  }, [machineSelection])
}
