import type { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolExecutionInput, type ToolsService } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'

/** Exercise the published batch executor while keeping single-call fixture assertions readable. */
export async function executeTool(tools: ToolsService, input: ToolExecutionInput) {
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
  })
  const settled = batch.results.find((entry) => entry.callId === input.callId)
  if (settled === undefined) throw new Error('Missing fixture tool result')
  return settled.result
}

/** Tools and their selected executor now have separate published plugin contracts. */
export async function installToolRuntime(ctx: Context, mode: 'native' | 'ptc' = 'native') {
  const fiber = await ctx.plugin(ToolRuntime)
  fiber.ctx.tools.setExecutor(mode === 'ptc' ? new PtcExecutor(fiber.ctx) : new NativeToolExecutor(fiber.ctx))
  return fiber
}
