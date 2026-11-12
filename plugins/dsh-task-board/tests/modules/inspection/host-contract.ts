import type { TaskBoardExtensionHost } from '../../../src/core/extension.ts'
import type { InspectionHost } from '../../../src/modules/inspection/core/contract.ts'

/** 编译时对齐原子推荐服务，运行时不加载原看板模块。 */
export const assertHostContract = (host: TaskBoardExtensionHost): InspectionHost => host
