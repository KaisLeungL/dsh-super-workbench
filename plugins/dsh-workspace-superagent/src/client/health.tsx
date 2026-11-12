import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { HealthView } from '../app/health/view.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';

const copy = {
  title: '主理运行状态', description: '查看持久状态、依赖与运行限额。暂停或停止自动化后，原卡与会话仍保留。',
  loading: '正在读取宿主健康状态…', unreachable: '未能读取宿主状态，请刷新重试。',
  stale: '旧样本，宿主状态未确认', staleSampled: '旧样本采样时间',
  refresh: '刷新状态', pause: '暂停自动化', resume: '恢复自动化', stop: '停止自动化',
  pending: '正在处理控制请求…', success: '宿主已处理请求，以下为重新读取的实际状态。',
  failure: '控制未完成，请以刷新后的持久状态为准。', sampled: '采样时间',
  queues: '候选队列', normal: '普通队列', control: '控制队列', evals: 'Eval 状态与时限',
  jobs: '内部计算 Job', capacity: '容量观测', audit: '请求审计', dependencies: '宿主依赖',
  contextSources: '上下文来源', sourceRegistered: '已注册', sourceUnavailable: '当前不可用',
  native: '原生卡执行', unavailable: '未提供', empty: '当前没有持久运行项。',
  columnName: '项目', columnValue: '当前值', columnState: '状态', columnDeadline: '期限',
  db: 'SQLite 主文件', wal: 'WAL 文件', artifacts: '未墓碑工件索引', disk: '磁盘可用量',
  artifactNote: '工件值来自索引，未作为磁盘实占。容量文件观测与数据库摘要分开采样。',
  scoped: '已核有限范围', reconcile: '待对账', gate: '完整 E37 仍需独立验收',
  available: '可用', missing: '缺失或旧能力', replaced: '已换代，等待人工恢复',
  paused: '已暂停', running: '运行中', stopped: '已停止', unknown: '未知',
  effects: '未知效果', active: '占用名额', handle: '自有计时器', notDelivered: '尚无已验证投递回执',
  original: '基础入口', summaryMissing: '运行时不可用，保留基础入口。', close: '处理结束',
} as const;
type Key = keyof typeof copy;
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'workspace-superagent-health': Key } }
const css = `
.wsa-health-viewport{height:100%;min-height:0;min-width:0;width:100%;overflow:auto}
.wsa-health{box-sizing:border-box;padding:32px;max-width:1060px;margin:auto;color:var(--dsw-alias-label-primary);font:inherit}
.wsa-health *{box-sizing:border-box}.wsa-health h1{font-size:24px;line-height:1.4;margin:0 0 12px;font-weight:600}
.wsa-health h2{font-size:16px;margin:0 0 16px}.wsa-health p{max-width:72ch;line-height:1.7;overflow-wrap:anywhere}
.wsa-health-header{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.wsa-health-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.wsa-health-actions{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.wsa-health button{font:inherit;font-size:13px;padding:8px 14px;min-height:36px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.wsa-health button:hover:enabled{background:var(--dsw-alias-bg-hover)}.wsa-health button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}.wsa-health button:disabled{opacity:.55;cursor:default}
.wsa-health-status{display:inline-block;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 9px;font-size:13px}
.wsa-health-section{border-top:1px solid var(--dsw-alias-border-l1);padding-top:24px;margin-top:28px}
.wsa-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.wsa-health-scroll{overflow:auto}
.wsa-health table{border-collapse:collapse;width:100%;font-size:13px}.wsa-health th,.wsa-health td{text-align:left;padding:11px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);line-height:1.6;overflow-wrap:anywhere}.wsa-health th{font-weight:500;color:var(--dsw-alias-label-secondary)}
.wsa-health dl{margin:0}.wsa-health dl>div{display:flex;justify-content:space-between;gap:18px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.wsa-health dd{margin:0;text-align:right;overflow-wrap:anywhere}
.wsa-health-message{padding:12px 0;line-height:1.7}.wsa-health ul{padding-left:20px;line-height:1.8}.wsa-health-id{font-family:monospace;overflow-wrap:anywhere}
@media(max-width:650px){.wsa-health{padding:20px 16px}.wsa-health-grid{grid-template-columns:1fr}.wsa-health button{min-height:42px}}
`;
const date = (value: number | null): string => value === null ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const bytes = (value: number | null): string => value === null ? '未提供' : (value / (1024*1024)).toFixed(2) + ' MiB';
const states: Record<string,string> = { queued: '排队中', dispatching: '投递中，尚未核回执', delivered: '已验证投递', paused: '已暂停',
  retry_wait: '已证明可重试，等待', unavailable: '不可用，待核对', completed: '已完成', running: '计算中',
  failed: '失败', cancelled: '已取消', interrupted: '重启中断', unknown: '未知，待对账' };

export function createHealthPage(ctx: Context, Foundation: React.ComponentType): () => React.ReactElement {
  ctx.effect(() => ctx.locale.register('workspace-superagent-health', { zh: copy, en: copy }));
  const t = ctx.locale.bind('workspace-superagent-health');
  return function HealthPage(): React.ReactElement {
    React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
    const [health, setHealth] = React.useState<HealthView | null>(null);
    const [current, setCurrent] = React.useState(false);
    const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
    const abort = React.useRef<AbortController | null>(null);
    const controlToken = React.useRef<string | null>(null);
    const load = React.useCallback(async () => {
      abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      setCurrent(false);
      try {
        const response = await fetch('/api/workspace-superagent/health', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('HEALTH_UNAVAILABLE');
        const value = await response.json() as HealthView;
        if (value.version !== 'b04' || typeof value.available !== 'boolean' || !Number.isFinite(value.sampledAt)) throw Error('HEALTH_INVALID');
        if (!controller.signal.aborted) {
          controlToken.current = response.headers.get(CONTROL_TOKEN_HEADER);
          setHealth(value); setCurrent(true); setNotice(previous => previous === t('unreachable') ? '' : previous);
        }
      } catch { if (!controller.signal.aborted) { setCurrent(false); setNotice(t('unreachable')); } }
    }, []);
    React.useEffect(() => { void load(); return () => abort.current?.abort(); }, [load]);
    const control = async (action: 'pause' | 'resume' | 'stop') => {
      if (busy || !current || !health?.summary || !health.control.enabled) return;
      setBusy(true); setNotice(t('pending'));
      const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
      try {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (controlToken.current) headers.set(CONTROL_TOKEN_HEADER, controlToken.current);
        const response = await fetch('/api/workspace-superagent/control', { method: 'POST', credentials: 'same-origin',
          headers, signal: controller.signal,
          body: JSON.stringify({ action, revision: health.summary.manager.revision }) });
        const result = await response.json() as { ok?: boolean; health?: HealthView; error?: string };
        if (!response.ok || !result.ok || result.health?.version !== 'b04') throw Error(result.error ?? t('failure'));
        if (!controller.signal.aborted) { setHealth(result.health); setNotice(t('success')); }
      } catch (error) {
        if (!controller.signal.aborted) { setNotice(error instanceof Error ? error.message : t('failure')); await load(); }
      } finally { if (!controller.signal.aborted) setBusy(false); else setBusy(false); }
    };
    if (!health?.available || !health.summary) return <div className="wsa-health-viewport"><section className="wsa-health"><style>{css}</style>
      <h1>{t('title')}</h1><p role="status">{notice || health?.reason || t('loading')}</p>
      <button onClick={() => void load()}>{t('refresh')}</button></section>{(health || notice) && <Foundation />}</div>;
    const summary = health.summary, lifecycle = summary.manager.lifecycle;
    const stateLabel = lifecycle === 'running' ? t('running') : lifecycle === 'paused' ? t('paused') : lifecycle === 'stopped' ? t('stopped') : t('unknown');
    const Row = ({ name, value }: { name: string; value: React.ReactNode }) => <div><dt>{name}</dt><dd>{value}</dd></div>;
    return <div className="wsa-health-viewport"><section className="wsa-health" data-workspace-superagent-health=""><style>{css}</style>
      <header className="wsa-health-header"><div><h1>{t('title')}</h1><p className="wsa-health-muted">{t('description')}</p></div>
        <div><span className="wsa-health-status">{current ? stateLabel : t('stale')}</span><p className="wsa-health-muted">{t(current ? 'sampled' : 'staleSampled')}：{date(health.sampledAt)}</p></div></header>
      <div className="wsa-health-actions">
        <button disabled={busy} onClick={() => void load()}>{t('refresh')}</button>
        <button disabled={busy || !current || !health.control.enabled || lifecycle !== 'running'} onClick={() => void control('pause')}>{t('pause')}</button>
        <button disabled={busy || !current || !health.control.enabled || lifecycle === 'running' || !!health.control.reason || health.capacityBlocks.length > 0} onClick={() => void control('resume')}>{t('resume')}</button>
        <button disabled={busy || !current || !health.control.enabled || lifecycle === 'stopped'} onClick={() => void control('stop')}>{t('stop')}</button>
      </div><p role="status" aria-live="polite" className="wsa-health-message">{notice || health.reason || health.automation?.reason}</p>
      {health.capacityBlocks.length > 0 && <ul role="alert">{health.capacityBlocks.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <div className="wsa-health-grid">
        <section className="wsa-health-section"><h2>{t('queues')}</h2><dl>
          <Row name={t('normal')} value={summary.queues.normal.items+' / 256；'+bytes(summary.queues.normal.bytes)} />
          <Row name={t('control')} value={summary.queues.control.items+' / 32；'+bytes(summary.queues.control.bytes)} />
          <Row name="普通最老排队时间" value={summary.queues.normal.oldestQueuedAt === null ? '队列为空' : date(summary.queues.normal.oldestQueuedAt)} />
          <Row name={t('effects')} value={String(summary.effects.unknown)} /></dl></section>
        <section className="wsa-health-section"><h2>{t('dependencies')}</h2><dl>{health.dependencies.map(dependency =>
          <Row key={dependency.name} name={dependency.name} value={dependency.changed ? t('replaced') : dependency.available ? t('available') : t('missing')} />)}</dl></section>
      </div>
      {health.contextSources?.length ? <section className="wsa-health-section"><h2>{t('contextSources')}</h2><dl>
        {health.contextSources.map(source => <Row key={source.id} name={source.id} value={t(source.available ? 'sourceRegistered' : 'sourceUnavailable')} />)}
      </dl></section> : null}
      <section className="wsa-health-section"><h2>{t('evals')}</h2>{summary.evals.truncated && <p role="alert">{summary.evals.reason}</p>}
        {!summary.evals.active.length ? <p>{t('empty')}</p> : <div className="wsa-health-scroll"><table><thead><tr>
          <th>{t('columnName')}</th><th>{t('columnState')}</th><th>{t('columnDeadline')}</th></tr></thead><tbody>{summary.evals.active.map(evaluation =>
          <tr key={evaluation.id}><td className="wsa-health-id">{evaluation.id}</td><td>{states[evaluation.state] ?? evaluation.state}，尝试{evaluation.attempt}/2</td>
          <td>{evaluation.deadline === null ? evaluation.deadlineBasis === null ? t('notDelivered') : '已冻结剩余 '+Math.ceil(evaluation.remainingMs/1000)+' 秒' : date(evaluation.deadline)}</td></tr>)}</tbody></table></div>}</section>
      <section className="wsa-health-section"><h2>{t('jobs')}</h2><p>持久占用名额：{summary.jobs.occupied} / 2；同部署未退出计算：{health.handles?.jobs.pendingResults ?? t('unavailable')} / 2；本实例运行句柄：{health.handles?.jobs.running ?? t('unavailable')}；{t('handle')}：{health.handles?.jobs.timers ?? t('unavailable')}</p>
        <dl>{Object.entries(summary.jobs.counts).map(([state, count]) => <Row key={state} name={states[state] ?? state} value={String(count)} />)}</dl>
        {summary.jobs.truncated && <p role="alert">{summary.jobs.reason}</p>}{summary.jobs.active.map(job => <p key={job.id} className="wsa-health-id">{job.id} · {states[job.state] ?? job.state} · {date(job.deadline)}</p>)}</section>
      <section className="wsa-health-section"><h2>{t('capacity')}</h2><dl>
        <Row name={t('db')} value={bytes(summary.capacity.dbBytes)} /><Row name={t('wal')} value={bytes(summary.capacity.walBytes)} />
        <Row name={t('artifacts')} value={bytes(summary.capacity.artifactIndexedBytes)} /><Row name={t('disk')} value={bytes(summary.capacity.diskAvailableBytes)} /></dl>
        <p className="wsa-health-muted">{t('artifactNote')} {t('sampled')}：{date(summary.capacity.observedAt)}</p>
        {Object.entries(summary.capacity.reasons).filter(([, reason]) => reason && reason !== 'ENOENT').map(([key, reason]) => <p key={key}>{key}：{reason}</p>)}</section>
      <section className="wsa-health-section"><h2>{t('audit')}</h2><p>{summary.audit.status === 'verified_scope' ? t('scoped') : t('reconcile')}，待核：{summary.audit.pending}</p>
        <p>{summary.audit.reason}</p><p>{health.auditGate.reason}</p><p>{t('gate')}</p></section>
      <section className="wsa-health-section"><h2>{t('native')}</h2><p>{health.nativeExecution.reason}</p></section>
    </section></div>;
  };
}
