import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { BOARD, SCHEDULE, missingFields, type Candidate, type Proposal } from '../actions/protocol.js';
import type { ActionRequest } from '../actions/service.js';
import { readChatHealth } from './chat-transport.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { templates, week } from './action-templates.js';

const css = `
.wsa-action{margin:12px 0 7px;max-width:690px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}
.wsa-action-header,.wsa-action-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 14px}
.wsa-action-header{border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-module-platform);border-radius:10px 10px 0 0}
.wsa-action-header h3{font-size:14px;font-weight:500;margin:0 0 3px}.wsa-action small,.wsa-action dt{color:var(--dsw-alias-label-secondary);font-size:12px}
.wsa-action-state{font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 6px}
.wsa-action-state[data-state=ready],.wsa-action-state[data-state=succeeded]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.wsa-action-body{padding:12px 14px;container-type:inline-size}.wsa-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;margin:0}
.wsa-action-wide{grid-column:1/-1}.wsa-action dd{margin:3px 0 0;white-space:pre-wrap}.wsa-action label.wsa-action-field{display:flex;flex-direction:column;gap:4px}
.wsa-action :is(input:not([type=checkbox]),textarea,select){border:1px solid var(--dsw-alias-border-l2);color:inherit;background:var(--dsw-alias-bg-base);border-radius:6px;padding:6px 8px;min-width:0;font:inherit}
.wsa-action textarea{resize:vertical;min-height:62px}.wsa-action fieldset{padding:0;border:0;min-width:0;margin:0}.wsa-action fieldset label{display:inline-flex;align-items:center;gap:3px;margin:5px 10px 0 0}
.wsa-action-note{margin:9px 0 0;color:var(--dsw-alias-label-secondary)}.wsa-action-footer{border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-action-buttons{display:flex;align-items:center;gap:7px;margin-left:auto;flex-wrap:wrap}
.wsa-action button{background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 11px;font:inherit;cursor:pointer}
.wsa-action button[data-primary=true]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);border-color:transparent;color:var(--dsw-static-neutral-bluish-00)}
.wsa-action button:disabled{opacity:.5;cursor:default}.wsa-action :is(button,input,textarea,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:2px}
@container (max-width:470px){.wsa-action-grid{grid-template-columns:minmax(0,1fr)}}
`;
const STATUS: Record<Proposal['status'], string> = { needs_input:'待补充', ready:'待确认', unavailable:'待提交', submitting:'正在创建',
  unknown:'待核实', succeeded:'已创建', dismissed:'未创建', expired:'草稿已过期' };
type Slot = { turn: { turn: number; end?: { seq: number }; status: string }; sessionId: string };
const copy = (value: Candidate) => structuredClone(value);

function date(iso: string, zone: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle:'medium', timeStyle:'short', hour12:false }).format(new Date(iso));
}
function frequency(value: Extract<Candidate, { actionId: typeof SCHEDULE }>) {
  const schedule = value.params.schedule;
  if (!schedule?.kind) return schedule?.time;
  return (schedule.kind === 'weekly' ? '每周 ' + (schedule.weekdays ?? []).map(n => week[n-1]).join('、') : '每天') + ' ' + (schedule.time ?? '');
}

export function createActionCard(ctx: Context, inManager: (sessionId: string) => boolean, workspaceLabel: () => string) {
  let tokenPromise: ReturnType<typeof readChatHealth> | undefined;
  async function request(sessionId: string, body: ActionRequest, signal?: AbortSignal): Promise<Proposal | null> {
    try {
      const { token } = await (tokenPromise ??= readChatHealth());
      if (!token) throw Error('快捷操作授权已失效，请重新打开大肥鱼');
      const response = await fetch('/api/workspace-superagent/actions', {
        method:'POST', credentials:'same-origin', cache:'no-store', signal,
        headers:{ 'content-type':'application/json', [CONTROL_TOKEN_HEADER]:token },
        body: JSON.stringify({ sessionId, request:body }),
      });
      if (response.status === 403) tokenPromise = undefined;
      const value = await response.json() as { ok?:boolean; error?:string; proposal?:Proposal | null };
      if (!response.ok || !value.ok) throw Error(value.error ?? '操作未完成，请重试');
      return value.proposal ?? null;
    } catch (error) {
      if (!signal?.aborted) tokenPromise = undefined;
      throw error;
    }
  }
  async function open(value: Proposal) {
    const id = value.resultId;
    if (!id) throw Error('没有可打开的结果');
    if (value.candidate.actionId === BOARD) {
      const board = ctx.get('taskBoard') as { openTaskFromHost?(id: string): Promise<boolean> } | undefined;
      if (!await board?.openTaskFromHost?.(id)) throw Error('当前看板无法打开这张卡片，请到任务看板核对');
    } else {
      const nav = ctx.get('scheduleNavigation') as { openTask(id: string): boolean } | undefined;
      if (!nav?.openTask(id)) throw Error('当前定时任务详情不可用，请到定时任务管理页核对');
    }
  }
  function Card({ turn, sessionId }: Slot) {
    const [proposal,setProposal] = React.useState<Proposal | null>(null);
    const [edit,setEdit] = React.useState<Candidate | null>(null);
    const [busy,setBusy] = React.useState(false);
    const [error,setError] = React.useState('');
    const [inspect,setInspect] = React.useState(false);
    const confirmation = React.useRef<HTMLButtonElement>(null);
    const resultButton = React.useRef<HTMLButtonElement>(null);
    const focus = React.useRef<'confirm' | 'result' | undefined>(undefined);
    const enabled = inManager(sessionId) && turn.status === 'closed';
    React.useEffect(() => {
      if (!enabled) return;
      const controller = new AbortController();
      void request(sessionId,{ op:'read',turn:turn.turn },controller.signal).then(value => {
        if (!controller.signal.aborted) setProposal(value);
      }).catch(cause => { if (!controller.signal.aborted) console.warn('大肥鱼快捷操作读取失败',cause); });
      return () => controller.abort();
    },[enabled,sessionId,turn.turn,turn.end?.seq]);
    React.useEffect(() => {
      if (focus.current === 'confirm' && confirmation.current) { confirmation.current.focus(); focus.current=undefined; }
      if (focus.current === 'result' && resultButton.current) { resultButton.current.focus(); focus.current=undefined; }
    },[proposal,edit]);
    if (!enabled || !proposal) return null;
    const card = proposal, shown = edit ?? card.candidate, isSchedule = shown.actionId === SCHEDULE;
    const template = templates[shown.actionId], kind = template.kind;
    const target = workspaceLabel();
    const state = card.status;
    const title = state === 'succeeded' ? card.candidate.params.title : kind + (state === 'unknown' ? '创建结果' : '草稿');
    const draftForm = state === 'needs_input' || state === 'unavailable';
    const form = draftForm || (state === 'ready' && edit !== null);
    const work = async (op: 'save' | 'confirm' | 'dismiss' | 'reconcile' | 'open') => {
      if (busy) return;
      setBusy(true); setError('');
      try {
        const base = { id:card.id, revision:card.revision };
        const body: ActionRequest = op === 'save' ? { ...base,op,proposal:shown } : op === 'confirm'
          ? { ...base,op,expectedNextRunAt:card.nextRunAt } : { ...base,op };
        const next = await request(sessionId,body);
        if (!next) throw Error('草稿已失效，请重新发起');
        if (next.turn !== turn.turn) { setProposal(null); return; }
        if (op === 'open') await open(next);
        if (op === 'save') { setEdit(null); if (next.status === 'ready') focus.current='confirm'; }
        if (op === 'confirm' && next.status === 'ready') setError('请核对最新草稿，再点击创建');
        if (op === 'confirm' || op === 'reconcile') {
          setInspect(false);
          if (next.status === 'succeeded') focus.current='result';
          if (op === 'reconcile' && next.status === 'unknown') setError('暂未查到确定结果，可到管理页核对');
        }
        setProposal(next);
      } catch (cause) {
        if (op === 'confirm') setInspect(true);
        setError(op === 'confirm' ? '未收到确认，请先核实结果' : cause instanceof Error ? cause.message : '操作未完成，请重试');
      } finally { setBusy(false); }
    };
    const setText = (key: string, value: string) => setEdit({ ...shown, params:{ ...shown.params,[key]:value } } as Candidate);
    const setSchedule = (patch: Record<string,unknown>) => {
      if (shown.actionId !== SCHEDULE) return;
      setEdit({ ...shown,params:{ ...shown.params,schedule:{ ...shown.params.schedule,...patch } } });
    };
    const need = missingFields(shown);
    const fact = (label:string,value:string | undefined,wide=false) => <div className={wide ? 'wsa-action-wide' : undefined}><dt>{label}</dt><dd>{value || '—'}</dd></div>;
    const updating = busy || state === 'submitting';
    const schedule = shown.actionId === SCHEDULE ? shown.params.schedule : undefined;
    const values = { ...shown.params, ...schedule };
    return <section className="wsa-action" aria-label={kind + '快捷操作'} data-action-status={state}>
      <style>{css}</style>
      <div className="wsa-action-header"><div><h3>{title}</h3><small>{template.area}{target && ' · ' + target}</small></div>
        <span role="status" className="wsa-action-state" data-state={state}>{updating && state !== 'succeeded' ? '正在处理' : inspect ? '待核实' : STATUS[state]}</span></div>
      {state !== 'dismissed' && state !== 'expired' && <div className="wsa-action-body">
        {form ? <div className="wsa-action-grid">{template.fields.map(field => {
          const { key, label, control, wide, maxLength, options } = field;
          if (control === 'weekdays') {
            if (schedule?.kind !== 'weekly') return null;
            const days = schedule.weekdays ?? [];
            return <fieldset key={key} className="wsa-action-wide"><legend>{label}</legend>{week.map((day,index) => {
              const n = index + 1;
              return <label key={day}><input type="checkbox" checked={days.includes(n)} disabled={updating} onChange={e => {
                const chosen = e.target.checked ? [...days,n] : days.filter(d => d !== n);
                setSchedule({ weekdays:chosen.length ? chosen : undefined });
              }} />{day}</label>;
            })}</fieldset>;
          }
          const value = values[key as keyof typeof values];
          const change = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
            const next = e.target.value;
            if (key === 'kind') setSchedule({ kind:next || undefined, ...(next !== 'weekly' ? { weekdays:undefined } : {}) });
            else if (key === 'time' || key === 'timeZone') setSchedule({ [key]:next });
            else setText(key,next);
          };
          const props = { value:typeof value === 'string' ? value : '', disabled:updating, onChange:change };
          return <label key={key} className={'wsa-action-field' + (wide ? ' wsa-action-wide' : '')}>{label}
            {control === 'textarea' ? <textarea {...props} maxLength={maxLength} /> :
              control === 'select' ? <select {...props}>
                {key === 'kind' && <option value="">请选择</option>}
                {options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select> : <input {...props} type={control} maxLength={maxLength} />}
          </label>;
        })}</div> : <dl className="wsa-action-grid">
          {state !== 'succeeded' && fact(isSchedule ? '任务名称' : '卡片标题',shown.params.title)}
          {shown.actionId === SCHEDULE ? <>
            {fact('运行频率',frequency(shown))}
            {fact('时区',shown.params.schedule?.timeZone)}
            {fact('投递位置','专用会话（首次运行时创建）')}
            {fact('执行内容',shown.params.instruction,true)}
          </> : <>{fact('所在列',shown.params.column === 'backlog' ? '待规划' : '待办')}{fact('任务说明',shown.params.description,true)}</>}
        </dl>}
        {isSchedule && !form && card.nextRunAt && shown.params.schedule?.timeZone && <p className="wsa-action-note">
          {state === 'succeeded' ? '创建时的下次运行：' : '预计下次运行：'}{date(card.nextRunAt,shown.params.schedule.timeZone)}
        </p>}
        {isSchedule && state !== 'succeeded' && <p className="wsa-action-note">专用会话只处理定时指令，不授予工具权限。</p>}
        {card.submissionIssue && <p className="wsa-action-note" role="status">{card.submissionIssue === 'schedule_preview_failed'
          ? '无法预览下次运行。请检查运行时间、频率和时区。'
          : '创建入口暂不可用，你可以先填写并保存草稿。'}</p>}
        {(state === 'unknown' || inspect) && <p className="wsa-action-note" role="status">这次提交可能已经生效，核实前请勿重复创建。</p>}
        {error && <p className="wsa-action-note" role="alert">{error}</p>}
      </div>}
      <div className="wsa-action-footer">
        <small>{form ? (need.length ? '待填写：'+need.map(k => template.fields.find(field => field.key === k)?.label).join('、') :
          card.submissionIssue === 'entry_unavailable' ? '' : '预览后再确认创建') :
          state === 'ready' && !inspect ? (isSchedule ? '按计划运行，不会立即执行' : '加入看板，不会启动执行') : ''}</small>
        <div className="wsa-action-buttons">
          {form && <>
            <button disabled={updating} onClick={() => draftForm ? void work('dismiss') : setEdit(null)}>{draftForm ? '暂不创建' : '返回'}</button>
            <button data-primary="true" disabled={updating || (!!need.length && card.submissionIssue !== 'entry_unavailable')} onClick={() => void work('save')}>
              {card.submissionIssue === 'entry_unavailable' ? (edit ? '保存草稿' : '重新检查') : '预览' + kind}
            </button>
          </>}
          {!form && state === 'ready' && !inspect && <>
            <button disabled={updating} onClick={() => { setEdit(copy(shown)); setError(''); }}>修改</button>
            <button ref={confirmation} data-primary="true" disabled={updating} onClick={() => void work('confirm')}>创建{kind}</button>
          </>}
          {(state === 'unknown' || inspect) && <button data-primary="true" disabled={updating} onClick={() => void work('reconcile')}>核实结果</button>}
          {state === 'succeeded' && <button ref={resultButton} data-primary="true" disabled={updating} onClick={() => void work('open')}>查看{kind}</button>}
        </div>
      </div>
    </section>;
  }
  return Card;
}
