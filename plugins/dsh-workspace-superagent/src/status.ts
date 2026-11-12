export const CONTROL_TOKEN_HEADER = 'x-workspace-superagent-control-token';

/** 依赖探测不代替健康、会话或业务验收。 */
export interface FoundationStatus {
  version: string;
  stage: 'b04';
  capabilities: { taskBoard: boolean; inputAdmission: boolean };
}
