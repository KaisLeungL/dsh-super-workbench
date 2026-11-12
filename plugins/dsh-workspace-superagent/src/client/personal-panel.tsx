import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { readChatHealth } from './chat-transport.js';
import { Icon, type IconName } from './icons.js';

export interface PersonalTodo {
  id: string;
  title: string;
  localDate: string;
  done: boolean;
  revision: number;
  boardTaskId?: string;
  sourceUnavailable?: boolean;
}
export interface PersonalSchedule {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'ended';
  scheduledAt?: string;
  timingLabel: string;
}
export interface PersonalActivity {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  worker?: string;
  events?: { title: string; at: number; summary?: string }[];
  taskId?: string;
  sessionId?: string;
}
interface Resource<T> { available: boolean; items: T[]; error?: string }
export interface PersonalSnapshot {
  ok: true;
  todos: Resource<PersonalTodo>;
  schedules: Resource<PersonalSchedule>;
  activities: Resource<PersonalActivity>;
  boardCandidates: Resource<{ id: string; title: string; status: string }>;
}
export interface PersonalPanelProps {
  sessionId: string;
  workspace: string;
  automationText: string;
  onDiagnostics(): void;
}
type Page = 'overview' | 'todos' | 'activities';
type TodoFilter = 'all' | 'pending' | 'done';
type ActivityFilter = 'all' | 'waiting' | 'finished';
type Tone = 'neutral' | 'waiting' | 'success' | 'error';

const css = `
.wsa-personal{--wsa-ease:cubic-bezier(.23,1,.32,1);--wsa-quick:160ms;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;-webkit-font-smoothing:antialiased}
.wsa-personal *{box-sizing:border-box}
.wsa-personal :where(button,input,select){font:inherit;color:inherit}
.wsa-personal :where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;margin:0;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;text-align:left}
.wsa-personal button:disabled{opacity:.45;cursor:default}
.wsa-personal p,.wsa-personal h2,.wsa-personal h3{margin:0}
.wsa-personal :focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-personal-scroll{flex:1;min-height:0;overflow:auto;padding:14px 18px 20px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}

/* 分区与标题 */
.wsa-personal-section{padding:10px 11px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base))}
.wsa-personal-section + .wsa-personal-section{margin-top:10px}
.wsa-personal-head{display:flex;align-items:center;gap:4px;min-height:32px}
.wsa-personal-head h3{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:1.4}
.wsa-personal-section-toggle{justify-content:flex-start;gap:7px;width:100%;min-height:32px;padding:0 4px;color:var(--dsw-alias-label-primary)}
.wsa-personal-section-glyph{flex:none;color:var(--dsw-alias-label-secondary)}
.wsa-personal-section-chevron{flex:none;margin-left:1px;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-section-toggle[aria-expanded="false"] .wsa-personal-section-chevron{transform:rotate(-90deg)}
.wsa-personal-count{font-size:11px;font-weight:400;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsa-personal-add{flex:none;min-height:30px;padding:0 8px;border-radius:7px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground);font-size:11.5px;font-weight:550}
.wsa-personal-add:disabled{opacity:.48}
.wsa-personal-section-body{padding-top:3px}
.wsa-personal-section-body .wsa-personal-row{padding-inline:4px}
.wsa-personal-section-body .wsa-personal-date{padding-inline:4px}
.wsa-personal-section-body .wsa-personal-note,.wsa-personal-empty{padding:7px 4px 5px}
.wsa-personal-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.wsa-personal-today-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 6px;margin:5px 0 0;padding:4px 0 0 4px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-personal-progress{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsa-personal-progress progress{appearance:none;width:34px;height:3px;overflow:hidden;border:0;border-radius:3px;background:var(--dsw-alias-border-l2);accent-color:var(--dsw-alias-label-secondary)}
.wsa-personal-progress progress::-webkit-progress-bar{background:var(--dsw-alias-border-l2)}
.wsa-personal-progress progress::-webkit-progress-value{border-radius:3px;background:var(--dsw-alias-label-secondary)}
.wsa-personal-progress progress::-moz-progress-bar{border-radius:3px;background:var(--dsw-alias-label-secondary)}
.wsa-personal-today-meta .wsa-personal-more{margin:0 0 0 auto}
.wsa-personal-spacer{flex:1}
.wsa-personal-icon{flex:none;width:28px;height:28px;border-radius:6px;color:var(--dsw-alias-label-tertiary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-icon:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-icon:active:enabled{transform:scale(.94)}

/* 行 */
.wsa-personal-list{display:flex;flex-direction:column}
.wsa-personal-row{display:flex;align-items:flex-start;gap:9px;min-width:0;min-height:34px;padding:6px 8px;border-radius:7px;transition:background-color 140ms var(--wsa-ease)}
.wsa-personal-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-personal-check{display:flex;flex:1;align-items:flex-start;gap:9px;min-width:0;cursor:pointer}
.wsa-personal-check input{position:absolute;width:16px;height:16px;margin:0;opacity:0;cursor:pointer}
.wsa-personal-check input:focus-visible{outline:none}
.wsa-personal-box{display:grid;flex:none;place-items:center;width:16px;height:16px;margin-top:1px;border:1.5px solid color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary-foreground);transition:background-color 140ms var(--wsa-ease),border-color 140ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-personal-check:hover .wsa-personal-box{border-color:color-mix(in srgb, var(--dsw-alias-label-primary) 38%, transparent)}
.wsa-personal-check:active .wsa-personal-box{transform:scale(.9)}
.wsa-personal-check input:focus-visible+.wsa-personal-box{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-personal-box svg{opacity:0;transform:scale(.7);transition:opacity 120ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-personal-check input:checked+.wsa-personal-box{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.wsa-personal-check input:checked+.wsa-personal-box svg{opacity:1;transform:scale(1)}
.wsa-personal-row-text{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.wsa-personal-title{font-size:13px;font-weight:500;line-height:1.45;letter-spacing:.005em;overflow-wrap:anywhere}
.wsa-personal-complete{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:var(--dsw-alias-label-dimmed)}
.wsa-personal-sub{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.wsa-personal-row-actions{display:flex;flex:none;align-items:center;gap:1px;margin:-2px -4px -2px 0;opacity:0;transition:opacity 140ms var(--wsa-ease)}
.wsa-personal-row:hover .wsa-personal-row-actions,.wsa-personal-row:focus-within .wsa-personal-row-actions{opacity:1}
@media(hover:none){.wsa-personal-row-actions{opacity:.75}}
.wsa-personal-row-actions button{height:24px;min-width:24px;padding:0 6px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-row-actions button:hover:enabled{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-row-actions button:active:enabled{transform:scale(.94)}

/* 条目（定时任务、活动） */
.wsa-personal-entry{width:100%;min-height:46px;align-items:center;justify-content:flex-start;gap:9px}
.wsa-personal-entry time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wsa-personal-schedule-clock{display:flex;flex:none;flex-direction:column;align-items:center;gap:1px;width:48px;padding:4px 5px 4px 0;border-right:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.wsa-personal-schedule-clock time{font-size:14px;font-weight:650;line-height:1.2;color:var(--dsw-alias-label-primary)}
.wsa-personal-schedule-clock span{font-size:10.5px;line-height:1.3;color:var(--dsw-alias-label-secondary)}
.wsa-personal-schedule-clock svg{color:var(--dsw-alias-label-secondary)}
.wsa-personal-schedule .wsa-personal-title{white-space:normal}
.wsa-personal-entry-icon{display:grid;flex:none;place-items:center;width:28px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);color:var(--dsw-alias-label-secondary);transition:border-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-entry:hover .wsa-personal-entry-icon{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.wsa-personal-entry .wsa-personal-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wsa-personal-entry-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.wsa-personal-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-caption);opacity:.85}
.wsa-personal-activity-meta{display:flex;align-items:center;gap:6px;min-width:0}
.wsa-personal-worker{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wsa-personal-worker::after{content:"·";margin-left:6px;color:var(--dsw-alias-label-dimmed)}
.wsa-personal-status{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.wsa-personal-status::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-status[data-tone="waiting"]::before{background:var(--dsw-alias-state-warn-primary)}
.wsa-personal-status[data-tone="success"]::before{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-status[data-tone="error"]::before{background:var(--dsw-alias-state-error-primary)}
.wsa-personal-date{display:flex;align-items:center;gap:8px;padding:9px 0 3px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-date::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.wsa-personal-more{justify-content:flex-start;gap:2px;min-height:28px;margin:3px 0 0;padding:0 4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-personal-more svg{opacity:.7}

/* 页脚 */
.wsa-personal-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:8px 18px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.wsa-personal-footer-status{display:grid;grid-template-columns:6px minmax(0,1fr);align-items:center;gap:1px 6px;min-width:0}
.wsa-personal-footer-note{grid-column:2;font-size:10.5px}
.wsa-personal-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-dot[data-tone="success"]{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-footer-link{flex:none;gap:3px;min-height:30px;padding:0 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
@media(hover:hover) and (pointer:fine){
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link):hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .wsa-personal-add:hover:enabled{opacity:.86}
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add){transition:transform 120ms var(--wsa-ease)}
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add):active:enabled:not(:focus-visible){transform:scale(.97)}
}

/* 子页 */
.wsa-personal-subhead{display:flex;flex:none;align-items:center;gap:4px;padding:11px 16px 11px 11px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal-subhead h2{font-size:14px;font-weight:600;line-height:1.4;letter-spacing:.01em;white-space:nowrap}
.wsa-personal-subhead .wsa-personal-spacer{margin-left:4px}
.wsa-personal-body{flex:1;min-height:0;overflow:auto;padding:0 16px 24px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-filter{display:inline-flex;gap:2px;margin:14px 0 2px;padding:2px;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)}
.wsa-personal-filter button{height:24px;padding:0 10px;border-radius:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-filter button:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-personal-filter button:active:enabled{transform:scale(.97)}
.wsa-personal-filter button[aria-pressed="true"]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.wsa-personal-group{margin-top:16px}
.wsa-personal-group>h3{display:flex;align-items:baseline;gap:6px;padding:0 8px 6px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-group>h3[data-tone="warn"]{color:var(--dsw-alias-state-warn-label)}
.wsa-personal-group>h3 span{font-weight:400;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-group .wsa-personal-row{margin:0 -8px}

/* 表单与提示 */
.wsa-personal-form{display:flex;flex-direction:column;gap:8px;padding:12px 0 2px}
.wsa-personal-form input,.wsa-personal-form select{flex:none;width:100%;min-width:0;height:32px;padding:0 9px;border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);color:var(--dsw-alias-label-primary);font-size:12px;transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-form input::placeholder{color:var(--dsw-alias-label-caption)}
.wsa-personal-form input:focus-visible,.wsa-personal-form select:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover)}
.wsa-personal-form-actions{display:flex;justify-content:flex-end;gap:6px}
.wsa-personal-form button{flex:none;height:28px;padding:0 11px;border:1px solid transparent;border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),opacity var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-form button:hover:enabled{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-form button:active:enabled{transform:scale(.97)}
.wsa-personal-form button:disabled{opacity:.42}
.wsa-personal-form button[type="submit"],.wsa-personal-form button:not([type="button"]){border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.wsa-personal-form button[type="submit"]:hover:enabled,.wsa-personal-form button:not([type="button"]):hover:enabled{opacity:.88;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.wsa-personal-form-inline{flex:1;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:6px;padding:0}
.wsa-personal-form-inline input{flex:1;width:auto;height:28px}
.wsa-personal-form-inline button{height:28px;padding:0 9px}
.wsa-personal-note{padding:6px 0 2px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.wsa-personal-note button{margin-left:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}
.wsa-personal-note button:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-personal-notice{display:flex;flex:none;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-personal-notice span{min-width:0;overflow-wrap:anywhere}
.wsa-personal-notice button{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-decoration:underline;text-underline-offset:2px}
.wsa-personal-state{padding:20px 16px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}

/* 详情弹窗 */
.wsa-personal-detail-backdrop{position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / .46);animation:wsa-personal-fade 160ms var(--wsa-ease)}
.wsa-personal .wsa-personal-dialog:focus,.wsa-personal .wsa-personal-dialog:focus-visible{outline:none}
.wsa-personal-dialog{display:flex;flex-direction:column;width:min(720px,100%);max-height:min(86vh,760px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 32px 80px -24px rgb(0 0 0 / .6),0 2px 6px rgb(0 0 0 / .18);color:var(--dsw-alias-label-primary);animation:wsa-personal-dialog-in 200ms var(--wsa-ease)}
.wsa-personal-dialog-head{display:flex;flex:none;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal-dialog-heading{flex:1;min-width:0}
.wsa-personal-dialog-kicker{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-dialog-head h2{margin:6px 0 9px;font-size:18px;font-weight:600;line-height:1.35;letter-spacing:-.01em;overflow-wrap:anywhere}
.wsa-personal-dialog-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wsa-personal-dialog-close{margin:-3px -5px 0 0}
.wsa-personal-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);font-size:11px;color:var(--dsw-alias-label-secondary)}
.wsa-personal-pill::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-pill[data-tone="waiting"]::before{background:var(--dsw-alias-state-warn-primary)}
.wsa-personal-pill[data-tone="success"]::before{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-pill[data-tone="error"]::before{background:var(--dsw-alias-state-error-primary)}
.wsa-personal-dialog-body{display:grid;flex:1;grid-template-columns:220px minmax(0,1fr);min-height:0}
.wsa-personal-timeline{min-height:0;overflow:auto;padding:14px 10px;border-right:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-timeline>h3{padding:0 6px 2px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-steps{position:relative;display:flex;flex-direction:column;gap:1px;margin-top:8px}
.wsa-personal-steps::before{content:"";position:absolute;top:15px;bottom:15px;left:14px;width:1px;background:var(--dsw-alias-border-l2)}
.wsa-personal-step{position:relative;display:flex;gap:9px;width:100%;padding:6px;border-radius:7px;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-step:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-step[aria-current="step"]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);color:var(--dsw-alias-label-primary)}
.wsa-personal-marker{position:relative;z-index:1;display:grid;flex:none;place-items:center;width:17px;height:17px;margin-top:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary-foreground)}
.wsa-personal-step[aria-current="step"] .wsa-personal-marker{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary)}
.wsa-personal-step-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.wsa-personal-step-title{font-size:12px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.wsa-personal-step time{font-size:10.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-result{min-height:0;overflow:auto;padding:18px 22px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-result time{font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-result h3{margin:5px 0 10px;font-size:15px;font-weight:600;line-height:1.4}
.wsa-personal-result p{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.wsa-personal-result-empty{font-size:12.5px!important;line-height:1.7!important;color:var(--dsw-alias-label-tertiary)!important}
.wsa-personal-dialog-footer{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal .wsa-personal-button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid transparent;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);font-size:12px;color:var(--dsw-alias-label-primary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal .wsa-personal-button:hover:enabled{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.wsa-personal .wsa-personal-button:active:enabled{transform:scale(.97)}
.wsa-personal .wsa-personal-button:disabled{opacity:.5}

@keyframes wsa-personal-fade{from{opacity:0}}
@keyframes wsa-personal-dialog-in{from{opacity:0;transform:translateY(6px) scale(.985)}}
@media(max-width:1100px){.wsa-personal-footer{padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px))}}
@media(max-width:560px){.wsa-personal-detail-backdrop{padding:12px}.wsa-personal-dialog-body{grid-template-columns:1fr}.wsa-personal-timeline{max-height:176px;border-right:0;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}}
@media(prefers-reduced-motion:reduce){.wsa-personal *{transition-duration:0ms!important;animation-duration:0ms!important}.wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add):active:enabled{transform:none}}
`;

function localDate(day: Date): string {
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
}
function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDate(date);
}
function time(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function dateHeading(value: number): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (localDate(date) === localDate(today)) return '今天';
  if (localDate(date) === localDate(yesterday)) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}
function activityStatus(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', delegated: '已派工', running: '进行中', needs_input: '等待输入', review: '待我验收',
    succeeded: '执行成功', done: '已完成', accepted: '已验收', failed: '失败', rejected: '已拒绝',
    cancelled: '已取消', unknown: '待核实', interrupted: '已中断',
  };
  return labels[status] ?? status;
}
function statusTone(status: string): Tone {
  if (['needs_input', 'review', 'waiting', 'unknown'].includes(status)) return 'waiting';
  if (['succeeded', 'done', 'accepted'].includes(status)) return 'success';
  if (['failed', 'rejected', 'cancelled', 'interrupted'].includes(status)) return 'error';
  return 'neutral';
}
function waiting(activity: PersonalActivity): boolean {
  return ['needs_input', 'review', 'waiting', 'unknown'].includes(activity.status);
}
function finished(activity: PersonalActivity): boolean {
  return ['succeeded', 'done', 'accepted', 'failed', 'rejected', 'cancelled', 'interrupted'].includes(activity.status);
}
function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function todoMeta(item: PersonalTodo, today: string): string | undefined {
  if (item.boardTaskId) return '关联看板任务';
  if (!item.done && item.localDate < today) return '原定 ' + dateLabel(item.localDate);
  if (item.localDate > today) return dateLabel(item.localDate);
  return undefined;
}
function scheduleTime(item: PersonalSchedule): { label: string; clock?: string } {
  if (item.status === 'paused') return { label: '已暂停' };
  if (item.status === 'ended') return { label: '已结束' };
  if (!item.scheduledAt) return { label: '下次时间待确认' };
  const date = new Date(item.scheduledAt);
  if (!Number.isFinite(date.getTime())) return { label: '下次时间待确认' };
  const today = localDate(new Date());
  const label = localDate(date) === today ? '今天' : localDate(date) === tomorrow() ? '明天' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return { label, clock: time(date.getTime()) };
}
function scheduleRepeat(label?: string): string {
  if (!label) return '';
  const head = label.split(' · ')[0].trim();
  const repeat = head.replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim();
  return repeat && repeat !== head ? repeat : '';
}
function groupedActivities(items: PersonalActivity[]): [string, PersonalActivity[]][] {
  const groups = new Map<string, PersonalActivity[]>();
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = dateHeading(item.updatedAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups];
}

export function createPersonalPanel(ctx: Context): React.ComponentType<PersonalPanelProps> {
  return function PersonalPanel({ sessionId, automationText, onDiagnostics }: PersonalPanelProps): React.ReactElement {
    const [snapshot, setSnapshot] = React.useState<PersonalSnapshot>();
    const [notice, setNotice] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const busyRef = React.useRef(false);
    const [page, setPage] = React.useState<Page>('overview');
    const [todoFilter, setTodoFilter] = React.useState<TodoFilter>('all');
    const [activityFilter, setActivityFilter] = React.useState<ActivityFilter>('all');
    const [open, setOpen] = React.useState({ todos: true, schedules: true, activities: true });
    const sectionId = React.useId();
    const [adding, setAdding] = React.useState(false);
    const overviewAdd = React.useRef<HTMLButtonElement | null>(null);
    const [addingBoard, setAddingBoard] = React.useState(false);
    const [title, setTitle] = React.useState('');
    const [boardId, setBoardId] = React.useState('');
    const [editing, setEditing] = React.useState<string>();
    const [editTitle, setEditTitle] = React.useState('');
    const [activity, setActivity] = React.useState<PersonalActivity>();
    const [step, setStep] = React.useState(0);
    const trigger = React.useRef<HTMLButtonElement | null>(null);
    const detailDialog = React.useRef<HTMLElement | null>(null);
    const requestCounter = React.useRef(0);
    const mounted = React.useRef(true);
    const pendingRequests = React.useRef(new Map<string, string>());

    const load = React.useCallback(async (signal?: AbortSignal) => {
      const counter = ++requestCounter.current;
      try {
        const response = await fetch('/api/workspace-superagent/personal', { credentials: 'same-origin', cache: 'no-store', signal });
        const value = await response.json() as PersonalSnapshot & { error?: string };
        if (!response.ok || !value.ok || !value.todos || !value.schedules || !value.activities) throw Error(value.error ?? '无法读取个人面板');
        if (mounted.current && counter === requestCounter.current) { setSnapshot(value); setLoading(false); }
      } catch (error) {
        if (signal?.aborted || !mounted.current || counter !== requestCounter.current) return;
        setSnapshot(undefined);
        setLoading(false);
        setNotice(error instanceof Error ? error.message : '无法读取个人面板');
      }
    }, []);
    React.useEffect(() => {
      mounted.current = true;
      const controller = new AbortController();
      void load(controller.signal);
      const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
      const refresh = () => { if (document.visibilityState === 'visible') void load(); };
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', refresh);
      return () => { mounted.current = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [load, sessionId]);

    React.useEffect(() => {
      if (!activity) return;
      detailDialog.current?.focus();
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { setActivity(undefined); trigger.current?.focus(); }
      };
      window.addEventListener('keydown', keydown);
      return () => window.removeEventListener('keydown', keydown);
    }, [activity]);

    const mutate = async (request: Record<string, unknown>) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setNotice('');
      const signature = JSON.stringify(request);
      const requestId = pendingRequests.current.get(signature) ?? crypto.randomUUID();
      pendingRequests.current.set(signature, requestId);
      try {
        const { token } = await readChatHealth();
        if (!token) throw Error('连接已失效，请重新打开大肥鱼');
        const response = await fetch('/api/workspace-superagent/personal', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
          body: JSON.stringify({ sessionId, request: { ...request, requestId } }),
        });
        const value = await response.json() as PersonalSnapshot & { error?: string };
        if (!response.ok || !value.ok) {
          if (response.status === 409) { pendingRequests.current.delete(signature); await load(); }
          throw Error(value.error ?? '操作未完成');
        }
        pendingRequests.current.delete(signature);
        requestCounter.current++;
        if (mounted.current) setSnapshot(value);
        return true;
      } catch (error) {
        if (mounted.current) setNotice(error instanceof Error ? error.message : '操作未完成，请重试');
        return false;
      } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
    };
    const openSchedule = (id: string) => {
      const navigation = ctx.get('scheduleNavigation') as { openTask(id: string): boolean } | undefined;
      if (!navigation?.openTask(id)) setNotice('定时任务详情暂不可用，请在自动化任务中查看。');
    };
    const openBoard = async (id: string) => {
      const board = ctx.get('taskBoard') as { openTaskFromHost?(id: string): Promise<boolean> } | undefined;
      if (!await board?.openTaskFromHost?.(id)) setNotice('看板卡片暂时无法打开。');
    };
    const openSession = (id: string) => {
      const navigation = ctx.get('uiWorkspace') as { openSession?(id: string): void } | undefined;
      if (!navigation?.openSession) { setNotice('Worker 会话暂时无法打开。'); return; }
      navigation.openSession(id);
    };
    const openScheduleList = () => {
      const layout = ctx.get('layout') as { selectPanel?(id: string): void } | undefined;
      if (!layout?.selectPanel) { setNotice('自动化任务页面暂时无法打开。'); return; }
      layout.selectPanel('schedules');
    };
    const showActivity = (item: PersonalActivity, button: HTMLButtonElement) => {
      trigger.current = button;
      setStep(Math.max(0, (item.events?.length ?? 0) - 1));
      setActivity(item);
    };
    const closeActivity = () => { setActivity(undefined); trigger.current?.focus(); };
    const today = localDate(new Date());
    const todos = snapshot?.todos.items ?? [];
    const todayItems = todos.filter(item => item.localDate === today).sort((a, b) => Number(a.done) - Number(b.done));
    const doneToday = todayItems.filter(item => item.done).length;
    const activities = snapshot?.activities.items ?? [];
    const scheduleItems = [...(snapshot?.schedules.items ?? [])].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : b.status === 'active' ? 1 : 0;
      return (a.scheduledAt ?? '\uffff').localeCompare(b.scheduledAt ?? '\uffff');
    });
    const closeAddForm = () => { setAdding(false); overviewAdd.current?.focus(); };
    const submitCreate = async (event: React.FormEvent) => {
      event.preventDefault();
      const value = title.trim();
      if (!value || busy) return;
      if (await mutate({ op: 'create', title: value, localDate: today })) { setTitle(''); closeAddForm(); }
    };
    const submitBoard = async (event: React.FormEvent) => {
      event.preventDefault();
      const item = snapshot?.boardCandidates?.items.find(candidate => candidate.id === boardId);
      if (!item || busy) return;
      if (await mutate({ op: 'create', title: item.title, localDate: today, boardTaskId: item.id })) { setBoardId(''); setAddingBoard(false); }
    };
    const form = <>
      {adding && <form className="wsa-personal-form" onSubmit={event => void submitCreate(event)}><input autoFocus aria-label="待办标题" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="输入待办，按回车添加" /><div className="wsa-personal-form-actions"><button type="button" onClick={closeAddForm}>取消</button><button disabled={!title.trim() || busy}>添加</button></div></form>}
      {addingBoard && <form className="wsa-personal-form" onSubmit={event => void submitBoard(event)}>
        {!snapshot?.boardCandidates?.available ? <span className="wsa-personal-note">{snapshot?.boardCandidates?.error ?? '看板任务暂时不可用'}</span> :
          <select aria-label="选择看板任务" value={boardId} onChange={event => setBoardId(event.target.value)}><option value="">选择看板任务</option>{snapshot.boardCandidates.items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
        <div className="wsa-personal-form-actions"><button type="button" onClick={() => setAddingBoard(false)}>取消</button><button disabled={!boardId || busy}>添加</button></div>
      </form>}
    </>;
    const todoRow = (item: PersonalTodo, secondary = false) => <div className={'wsa-personal-row' + (item.done ? ' wsa-personal-row-done' : '')} key={item.id}>
      {editing === item.id ? <form className="wsa-personal-form wsa-personal-form-inline" onSubmit={event => { event.preventDefault(); if (editTitle.trim()) void mutate({ op: 'update', id: item.id, revision: item.revision, title: editTitle.trim() }).then(ok => { if (ok) setEditing(undefined); }); }}>
        <input autoFocus aria-label="编辑待办标题" maxLength={120} value={editTitle} onChange={event => setEditTitle(event.target.value)} /><button disabled={busy || !editTitle.trim()}>保存</button><button type="button" onClick={() => setEditing(undefined)}>取消</button>
      </form> : <>
        <label className="wsa-personal-check"><input type="checkbox" checked={item.done} disabled={busy} onChange={event => void mutate({ op: 'update', id: item.id, revision: item.revision, done: event.target.checked })} /><span className="wsa-personal-box" aria-hidden="true"><Icon name="check" size={9} strokeWidth={3} /></span><span className="wsa-personal-row-text"><span className={'wsa-personal-title' + (item.done ? ' wsa-personal-complete' : '')}>{item.title}</span>{secondary && todoMeta(item, today) && <span className="wsa-personal-sub">{todoMeta(item, today)}</span>}</span></label>
        <div className="wsa-personal-row-actions">{item.boardTaskId && <button type="button" aria-label={'打开看板任务：' + item.title} title="打开看板任务" onClick={() => void openBoard(item.boardTaskId!)}><Icon name="link" size={13} /></button>}
          {secondary && !item.sourceUnavailable && <button type="button" aria-label={'编辑：' + item.title} title="编辑" onClick={() => { setEditing(item.id); setEditTitle(item.title); }}><Icon name="edit" size={13} /></button>}
          {secondary && !item.done && <button type="button" disabled={busy} aria-label={'移到明天：' + item.title} title="移到明天" onClick={() => void mutate({ op: 'move', id: item.id, revision: item.revision, localDate: tomorrow() })}><Icon name="calendar" size={13} /></button>}
        </div></>}
    </div>;
    const activityRow = (item: PersonalActivity) => <button type="button" className="wsa-personal-row wsa-personal-entry" key={item.id} onClick={event => showActivity(item, event.currentTarget)}>
      <span className="wsa-personal-entry-icon" aria-hidden="true"><Icon name="route" size={15} /></span>
      <span className="wsa-personal-row-text"><span className="wsa-personal-entry-head"><span className="wsa-personal-title">{item.title}</span><time>{time(item.updatedAt)}</time></span><span className="wsa-personal-sub wsa-personal-activity-meta">{item.worker && <span className="wsa-personal-worker">{item.worker}</span>}<span className="wsa-personal-status" data-tone={statusTone(item.status)}>{activityStatus(item.status)}</span></span></span>
      <span className="wsa-personal-chevron" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
    </button>;
    const scheduleRow = (item: PersonalSchedule) => {
      const { clock, label } = scheduleTime(item);
      const repeat = scheduleRepeat(item.timingLabel);
      return <button type="button" className="wsa-personal-row wsa-personal-entry wsa-personal-schedule" key={item.id} onClick={() => openSchedule(item.id)}>
        <span className="wsa-personal-schedule-clock">
          {clock ? <><time dateTime={item.scheduledAt}>{clock}</time><span>{label}</span></> : <Icon name="clock" size={16} />}
        </span>
        <span className="wsa-personal-row-text"><span className="wsa-personal-title">{item.title}</span>
          {(!clock || repeat) && <span className="wsa-personal-sub">{[!clock ? label : '', repeat].filter(Boolean).join(' · ')}</span>}
        </span>
        <Icon name="chevron-right" size={14} className="wsa-personal-chevron" />
      </button>;
    };
    const error = (resource: Resource<unknown> | undefined, empty: string) => !resource?.available
      ? <p className="wsa-personal-note" role="status">{resource?.error ?? '暂时无法读取'}<button type="button" onClick={() => void load()}>重试</button></p>
      : resource.items.length === 0 && empty ? <p className="wsa-personal-empty">{empty}</p> : null;

    const visibleTodos = todos.filter(item => todoFilter === 'all' || (todoFilter === 'done' ? item.done : !item.done));
    const overdue = visibleTodos.filter(item => !item.done && item.localDate < today);
    const current = visibleTodos.filter(item => !item.done && item.localDate === today);
    const future = visibleTodos.filter(item => !item.done && item.localDate > today);
    const completed = visibleTodos.filter(item => item.done);
    const shownActivities = activities.filter(item => activityFilter === 'all' || (activityFilter === 'waiting' ? waiting(item) : finished(item)));
    const automationRunning = automationText.includes('运行中');

    const filter = (items: readonly (readonly [string, string])[], value: string, set: (next: string) => void, label: string) =>
      <div className="wsa-personal-filter" role="group" aria-label={label}>{items.map(([key, text]) => <button type="button" key={key} aria-pressed={value === key} onClick={() => set(key)}>{text}</button>)}</div>;
    const sectionToggle = (key: keyof typeof open, label: string, icon: IconName, count?: number) =>
      <h3><button type="button" className="wsa-personal-section-toggle" aria-expanded={open[key]} aria-controls={sectionId + key}
        onClick={() => setOpen(value => ({ ...value, [key]: !value[key] }))}>
        <Icon name={icon} size={15} className="wsa-personal-section-glyph" />{label}
        {count !== undefined && count > 0 && <span className="wsa-personal-count">{count} 项</span>}
        <Icon name="chevron-down" size={12} className="wsa-personal-section-chevron" />
      </button></h3>;

    return <div className="wsa-personal" data-superagent-personal=""><style>{css}</style>
      {notice && <p role="status" className="wsa-personal-notice"><span>{notice}</span><button type="button" onClick={() => void load()}>刷新</button></p>}
      {loading ? <p className="wsa-personal-state">正在读取个人面板…</p> : !snapshot ? <p className="wsa-personal-state">无法读取个人面板。<button type="button" className="wsa-personal-more" onClick={() => void load()}><Icon name="refresh" size={12} />重试</button></p> :
      page === 'overview' ? <>
        <div className="wsa-personal-scroll">
          <section className="wsa-personal-section">
            <header className="wsa-personal-head">{sectionToggle('todos', '今日待办', 'check')}
              <button type="button" className="wsa-personal-add" ref={overviewAdd} aria-label="新增待办" disabled={!snapshot.todos.available} onClick={() => {
                setOpen(value => ({ ...value, todos: true })); setAdding(true); setAddingBoard(false);
              }}><Icon name="plus" size={13} />新增</button>
            </header>
            <div className="wsa-personal-section-body" id={sectionId + 'todos'} hidden={!open.todos}>{open.todos && <>
              {form}
              {!snapshot.todos.available ? error(snapshot.todos, '') : todayItems.length > 0
                ? <div className="wsa-personal-list">{todayItems.slice(0, 5).map(item => todoRow(item))}</div>
                : !adding && <p className="wsa-personal-empty">今天还没有待办。</p>}
              <div className="wsa-personal-today-meta">
                {snapshot.todos.available && todayItems.length > 0 && <span className="wsa-personal-progress">
                  <progress value={doneToday} max={todayItems.length} aria-label="今日待办完成进度" />
                  <span aria-hidden="true">已完成 {doneToday}/{todayItems.length}</span>
                </span>}
                <button type="button" className="wsa-personal-more" onClick={() => setPage('todos')}>查看全部待办<Icon name="chevron-right" size={12} /></button>
              </div>
            </>}</div>
          </section>
          <section className="wsa-personal-section">
            <header className="wsa-personal-head">{sectionToggle('schedules', '定时任务', 'calendar', scheduleItems.length)}</header>
            <div className="wsa-personal-section-body" id={sectionId + 'schedules'} hidden={!open.schedules}>
              {scheduleItems.slice(0, 3).map(scheduleRow)}
              {error(snapshot.schedules, '还没有定时任务。')}
              {scheduleItems.length > 0 && <button type="button" className="wsa-personal-more" onClick={openScheduleList}>查看全部定时任务<Icon name="chevron-right" size={12} /></button>}
            </div>
          </section>
          <section className="wsa-personal-section">
            <header className="wsa-personal-head">{sectionToggle('activities', '近期活动', 'route')}</header>
            <div className="wsa-personal-section-body" id={sectionId + 'activities'} hidden={!open.activities}>
              {groupedActivities([...activities].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)).map(([date, rows]) => <div key={date}><p className="wsa-personal-date">{date}</p>{rows.map(activityRow)}</div>)}
              {error(snapshot.activities, '暂无委派活动。')}
              {activities.length > 0 && <button type="button" className="wsa-personal-more" onClick={() => setPage('activities')}>查看更早活动<Icon name="chevron-right" size={12} /></button>}
            </div>
          </section>
        </div>
        <footer className="wsa-personal-footer">
          <span className="wsa-personal-footer-status"><span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" /><span>{automationText}</span><span className="wsa-personal-footer-note">看板只读</span></span>
          <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>运行与诊断<Icon name="chevron-right" size={12} /></button>
        </footer>
      </> : page === 'todos' ? <>
        <header className="wsa-personal-subhead"><button type="button" className="wsa-personal-icon" aria-label="返回个人面板" onClick={() => setPage('overview')}><Icon name="back" size={15} /></button><h2>全部待办</h2><span className="wsa-personal-spacer" /><button type="button" className="wsa-personal-icon" aria-label="从看板添加" title="从看板添加" onClick={() => { setAddingBoard(true); setAdding(false); }}><Icon name="board" size={15} /></button><button type="button" className="wsa-personal-icon" aria-label="新增待办" title="新增待办" onClick={() => { setAdding(true); setAddingBoard(false); }}><Icon name="plus" size={15} /></button></header>
        <div className="wsa-personal-body">{form}{filter([['all', '全部'], ['pending', '未完成'], ['done', '已完成']] as const, todoFilter, value => setTodoFilter(value as TodoFilter), '筛选待办')}
          {error(snapshot.todos, '还没有待办。')}{snapshot.todos.available && visibleTodos.length === 0 && todos.length > 0 && <p className="wsa-personal-note">没有符合条件的待办。</p>}
          {([['已逾期', overdue], ['今天', current], ['即将到来', future], ['已完成', completed]] as [string, PersonalTodo[]][]).map(([heading, rows]) => rows.length > 0 && <section className="wsa-personal-group" key={heading}><h3 data-tone={heading === '已逾期' ? 'warn' : undefined}>{heading}<span>{rows.length} 项</span></h3>{rows.map(item => todoRow(item, true))}</section>)}
        </div>
      </> : <>
        <header className="wsa-personal-subhead"><button type="button" className="wsa-personal-icon" aria-label="返回个人面板" onClick={() => setPage('overview')}><Icon name="back" size={15} /></button><h2>委派活动</h2></header>
        <div className="wsa-personal-body">{filter([['all', '全部'], ['waiting', '待我处理'], ['finished', '已结束']] as const, activityFilter, value => setActivityFilter(value as ActivityFilter), '筛选活动')}
          {error(snapshot.activities, '暂无委派活动。')}{snapshot.activities.available && shownActivities.length === 0 && activities.length > 0 && <p className="wsa-personal-note">没有符合条件的活动。</p>}
          {groupedActivities(shownActivities).map(([date, rows]) => <section className="wsa-personal-group" key={date}><h3>{date}<span>{rows.length} 项</span></h3>{rows.map(activityRow)}</section>)}
        </div>
      </>}
      {activity && <div className="wsa-personal-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeActivity(); }}><section className="wsa-personal-dialog" role="dialog" aria-modal="true" aria-labelledby="wsa-personal-dialog-title" ref={detailDialog} tabIndex={-1}>
        <header className="wsa-personal-dialog-head"><div className="wsa-personal-dialog-heading"><p className="wsa-personal-dialog-kicker"><Icon name="route" size={12} />委派详情</p><h2 id="wsa-personal-dialog-title">{activity.title}</h2><p className="wsa-personal-dialog-meta">{activity.worker && <span>{activity.worker}</span>}<span className="wsa-personal-pill" data-tone={statusTone(activity.status)}>{activityStatus(activity.status)}</span><span>{time(activity.updatedAt)}</span></p></div><button className="wsa-personal-icon wsa-personal-dialog-close" type="button" aria-label="关闭委派详情" onClick={closeActivity}><Icon name="close" size={15} /></button></header>
        <div className="wsa-personal-dialog-body"><nav className="wsa-personal-timeline" aria-label="执行时间线"><h3>执行时间线</h3><div className="wsa-personal-steps">{activity.events?.length ? activity.events.map((event, index) => <button key={index} type="button" className="wsa-personal-step" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span className="wsa-personal-marker" aria-hidden="true">{step === index ? <Icon name="check" size={9} strokeWidth={2.6} /> : null}</span><span className="wsa-personal-step-text"><span className="wsa-personal-step-title">{event.title}</span><time>{time(event.at)}</time></span></button>) : <p className="wsa-personal-note">暂无可用的执行事件。</p>}</div></nav>
          <div className="wsa-personal-result">{activity.events?.[step] ? <><time>{time(activity.events[step].at)}</time><h3>{activity.events[step].title}</h3><p>{activity.events[step].summary || '此步骤没有提供更多内容。'}</p></> : <p className="wsa-personal-result-empty">当前状态：{activityStatus(activity.status)}</p>}</div>
        </div>{(activity.sessionId || activity.taskId) && <footer className="wsa-personal-dialog-footer">{activity.sessionId && <button type="button" className="wsa-personal-button" onClick={() => openSession(activity.sessionId!)}>打开 Worker 会话</button>}{activity.taskId && <button type="button" className="wsa-personal-button" onClick={() => void openBoard(activity.taskId!)}>打开看板卡片</button>}</footer>}
      </section></div>}
    </div>;
  };
}
