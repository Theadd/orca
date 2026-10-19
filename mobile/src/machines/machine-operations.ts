import { z } from 'zod'
import type { MachineProviderKey } from '../../../src/shared/machine-inventory'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// The desktop answers machines.* itself (its plugins run the providers). Every reply is a
// MachineActionResult: a provider failure is `ok: false` inside a successful RPC, and a desktop
// with Machines off answers `unsupported` the same way.

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  lifetime: z.enum(['persistent', 'temporary']).catch('persistent'),
  state: z.string(),
  expiresAt: z.string().optional(),
  detail: z.string().optional(),
  lastSeenAt: z.number(),
  lastError: z.string().optional()
})
export type MobileMachine = z.infer<typeof machineSchema>

const providerKeySchema = z.custom<MachineProviderKey>(
  (value) => typeof value === 'string' && /^plugin:.+\/[^/]+$/.test(value)
)

const snapshotSchema = z.object({
  providerKey: providerKeySchema,
  name: z.string(),
  clockOffsetMs: z.number().optional(),
  lastFailure: z.object({ code: z.string(), message: z.string() }).optional(),
  machines: z.array(machineSchema),
  pendingCreates: z.array(z.object({ operationId: z.string(), name: z.string() })).catch([])
})
export type MobileMachineProvider = z.infer<typeof snapshotSchema>

const failureSchema = z.object({ ok: z.literal(false), code: z.string(), message: z.string() })
export type MachineActionFailure = z.infer<typeof failureSchema>

function actionResult<Value extends z.ZodType>(value: Value) {
  return z.union([z.object({ ok: z.literal(true), value }), failureSchema])
}

export const machinesListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'machines.list-or-skip',
    method: 'machines.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('machine-providers', actionResult(z.array(snapshotSchema)))
  })
)

export const machineWake = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'machines.wake-or-skip',
    method: 'machines.wake',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('machine-woken', actionResult(machineSchema))
  })
)

export const machineSleep = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'machines.sleep-or-skip',
    method: 'machines.sleep',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('machine-slept', actionResult(machineSchema))
  })
)
