// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { MachineGroupOption, MachineOption } from '@/lib/machines/machine-group-options'
import RunTargetCombobox from './RunTargetCombobox'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const PROVIDER = 'plugin:omarchy/omarchy' as const

const localOption: ReadyProjectHostSetupOption = {
  id: 'local-setup',
  kind: 'ready',
  projectId: 'project',
  hostId: 'local',
  repoId: 'repo',
  label: 'Local Mac',
  detail: '~/code/acme-web',
  path: '~/code/acme-web'
}

function machine(name: string, state: MachineOption['state'] = 'running'): MachineOption {
  return {
    providerKey: PROVIDER,
    machineId: name,
    name,
    state,
    lifetime: 'persistent',
    expiresAt: null
  }
}

const group: MachineGroupOption = {
  providerKey: PROVIDER,
  name: 'Omarchy',
  status: { kind: 'ready' },
  machines: ['omarchy-dev', 'pr-2231', 'perf-bench', 'gpu-box'].map((name) => machine(name)),
  archived: [],
  canCreate: false
}

function renderPicker(
  machines: Partial<React.ComponentProps<typeof RunTargetCombobox>['machines']> = {}
) {
  const onChange = vi.fn()
  const onProviderAction = vi.fn()
  const onHostChange = vi.fn()
  render(
    <RunTargetCombobox
      hostOptions={[localOption]}
      hostValue="local-setup"
      onHostChange={onHostChange}
      recipes={[]}
      recipeValue={null}
      machines={{ groups: [group], value: null, onChange, onProviderAction, ...machines }}
    />
  )
  return { onChange, onProviderAction, onHostChange, field: screen.getByRole('combobox') }
}

afterEach(cleanup)

describe('run target machines', () => {
  it('labels the provider group without making the label a choice', () => {
    renderPicker()
    expect(screen.getByText('Omarchy').closest('[role="option"]')).toBeNull()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).not.toContain(
      'Omarchy'
    )
  })

  it('caps the group and expands it in place without closing', () => {
    const { field } = renderPicker()
    fireEvent.focus(field)
    expect(screen.queryByRole('option', { name: /gpu-box/ })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: /Show all \(4\)/ }))

    expect(screen.getByRole('option', { name: /gpu-box/ })).toBeTruthy()
    expect(field.getAttribute('aria-expanded')).toBe('true')
  })

  it('commits a machine and clears the host and recipe choices', () => {
    const onRecipeChange = vi.fn()
    const onChange = vi.fn()
    render(
      <RunTargetCombobox
        hostOptions={[localOption]}
        hostValue="local-setup"
        recipes={[]}
        recipeValue={null}
        onRecipeChange={onRecipeChange}
        machines={{ groups: [group], value: null, onChange, onProviderAction: vi.fn() }}
      />
    )

    fireEvent.click(screen.getByRole('option', { name: /pr-2231/ }))

    expect(onChange).toHaveBeenCalledWith(group.machines[1])
    expect(onRecipeChange).toHaveBeenCalledWith(null)
  })

  it('reaches machine rows with the arrow keys, skipping the group label', () => {
    const { field, onChange } = renderPicker()
    fireEvent.focus(field)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(group.machines[0])
  })

  it('paints the committed machine in the field with its state', () => {
    renderPicker({ value: { providerKey: PROVIDER, machineId: 'pr-2231' } })
    const field = screen.getByRole('combobox', { name: 'Run on' })
    const shown = field.parentElement?.parentElement?.textContent ?? ''
    expect(shown).toContain('pr-2231')
    expect(shown).toContain('Omarchy')
    expect(shown).toContain('Running')
  })

  it('turns a sign-in group into one row that asks the composer to sign in', () => {
    const signIn = { ...group, status: { kind: 'sign-in' as const }, machines: [] }
    const { onProviderAction } = renderPicker({ groups: [signIn] })

    fireEvent.click(screen.getByRole('option', { name: 'Sign in to Omarchy' }))

    expect(onProviderAction).toHaveBeenCalledWith({ kind: 'sign-in', group: signIn })
  })
})
