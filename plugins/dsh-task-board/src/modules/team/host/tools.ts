/**
 * The one model-visible tool this extension contributes: `team_comment`.
 *
 * Comments are the agent's half of the collaboration surface — the reviewer
 * reads them on the issue, and a mention in one is delivered into the session.
 * The tool registers through the board's capability face, so it lives exactly as
 * long as the board runs this extension, and it accepts no shell text, path or
 * permission: a comment is prose and nothing else.
 *
 * @module dsh-task-board-team/host/tools
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { COMMENT_LIMIT_BYTES } from '../core/hub-protocol.ts'
import type { TeamSyncService } from './service.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function json(value: unknown): Json {
  return value as Json
}

/** Byte length of one comment body, as the hub measures its own cap. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Build the comment tool.
 * @param service - the running sync service.
 * @returns the tool definition the board registers.
 */
export function buildTeamTools(service: TeamSyncService): ToolDefinition[] {
  return [defineTool({
    name: 'team_comment',
    description: 'Post one comment on the team issue behind a task board card. Use it to report progress, ask a question that does not need to block, or explain a decision to the human reviewer. Accepts taskId (the card you are working on) or issueId. The body is Markdown, must stay under the byte cap and must not carry secrets.',
    parameters: {
      taskId: { type: 'string', description: 'Task board card id that mirrors a team issue.' },
      issueId: { type: 'string', description: 'Team issue id, when the card id is not known.' },
      text: { type: 'string', required: true, description: 'Markdown comment body. Must be non-empty and under the byte cap.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') return json({ ok: false, code: 'text-required', message: 'text must be a non-empty comment body' })
      if (byteLength(text) > COMMENT_LIMIT_BYTES) {
        return json({ ok: false, code: 'text-too-long', message: 'the comment body exceeds the byte cap' })
      }
      const taskId = typeof args.taskId === 'string' && args.taskId !== '' ? args.taskId : undefined
      const issueId = typeof args.issueId === 'string' && args.issueId !== '' ? args.issueId : undefined
      if (taskId === undefined && issueId === undefined) {
        return json({ ok: false, code: 'target-required', message: 'name the card (taskId) or the issue (issueId) to comment on' })
      }
      try {
        const posted = await service.postComment({
          text,
          ...(taskId === undefined ? {} : { taskId }),
          ...(issueId === undefined ? {} : { issueId }),
        })
        return json({ ok: true, ...posted })
      } catch (error) {
        return json({ ok: false, code: 'comment-refused', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })]
}
