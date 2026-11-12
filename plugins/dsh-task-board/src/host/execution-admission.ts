import type { TaskRecord } from '../core/tasks.ts'

/** 仅可信 Host 插件提供；不是模型/HTTP 可提交的批准接口。 */
export interface ExecutionAdmissionRequest {
  readonly taskId: string
  readonly executionId: string
  /** 当前留存 execution 列表的序号；不承诺跨历史裁剪单调。身份始终比较 executionId。 */
  readonly generation: number
  readonly sessionId: string
  readonly task: TaskRecord
  readonly isCurrent: () => boolean
}
export type BeforeExecutionPrompt = (requestId: string) => Promise<void>
export type AdmissionOperation = (setup?: BeforeExecutionPrompt) => Promise<void>
export interface TaskBoardExecutionAdmission {
  /** 须在托管 preset 发布前具备默认拒绝；在原 pins 之后、prompt 之前 await setup。 */
  admit(request: Readonly<ExecutionAdmissionRequest>, run: AdmissionOperation): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    taskBoardExecutionAdmission: TaskBoardExecutionAdmission
  }
}
