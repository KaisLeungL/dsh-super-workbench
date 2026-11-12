import type { Context } from '@deepseek-ai/cordis'
import * as board from './index.ts'
import * as inspection from '../modules/inspection/client/index.ts'
import * as github from '../modules/github/client/index.ts'
import * as team from '../modules/team/client/index.ts'
import * as forest from '../modules/forest/client/main.js'

/** All task-board interfaces are distributed and unloaded as one client module. */
export function apply(ctx: Context): void {
  ctx.plugin(board)
  ctx.plugin(inspection)
  ctx.plugin(github)
  ctx.plugin(team)
  ctx.plugin(forest)
}
