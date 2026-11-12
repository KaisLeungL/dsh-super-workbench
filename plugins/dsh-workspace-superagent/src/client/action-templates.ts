import { BOARD, SCHEDULE, type ActionId } from '../actions/protocol.js';

export const week = ['周一','周二','周三','周四','周五','周六','周日'];
const recurrence = [{ value:'daily', label:'每天' }, { value:'weekly', label:'每周' }];
const columns = [{ value:'todo', label:'待办' }, { value:'backlog', label:'待规划' }];
type Field = {
  key: 'title' | 'instruction' | 'description' | 'column' | 'kind' | 'time' | 'timeZone' | 'weekdays';
  label: string;
  control: 'text' | 'textarea' | 'select' | 'time' | 'weekdays';
  wide?: boolean;
  maxLength?: number;
  options?: readonly { value:string; label:string }[];
};
export const templates: Record<ActionId, { kind:string; area:string; fields:readonly Field[] }> = {
  [SCHEDULE]: {
    kind:'定时任务', area:'定时任务',
    fields:[
      { key:'title', label:'任务名称', control:'text', wide:true, maxLength:120 },
      { key:'instruction', label:'执行内容', control:'textarea', wide:true, maxLength:4000 },
      { key:'kind', label:'运行频率', control:'select', options:recurrence },
      { key:'time', label:'运行时间', control:'time' },
      { key:'weekdays', label:'运行日期', control:'weekdays', wide:true },
      { key:'timeZone', label:'时区', control:'text', maxLength:96 },
    ],
  },
  [BOARD]: {
    kind:'任务卡片', area:'任务看板',
    fields:[
      { key:'title', label:'卡片标题', control:'text', wide:true, maxLength:120 },
      { key:'description', label:'任务说明', control:'textarea', wide:true, maxLength:4000 },
      { key:'column', label:'所在列', control:'select', options:columns },
    ],
  },
};
