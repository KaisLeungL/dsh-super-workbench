import * as React from 'react';
import { createActionCard } from './action-card.js';
import { createPersonalPanel } from './personal-panel.js';
import { Icon } from './icons.js';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type { HealthView } from '../app/health/view.js';
import { localMottoDay, type DailyMotto } from '../app/health/chat-input.js';
import { attachChatTransport, mutateChat, readChatHealth, type ChatModelDirectories, type ChatReference } from './chat-transport.js';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'workspace-superagent.conversation': { kind: 'single'; scope: 'session' };
  }
}
const CHILD = 'workspace-superagent.conversation';
const css = `
.wsa-chat{--wsa-ease:cubic-bezier(.23,1,.32,1);display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.wsa-chat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:0 14px 0 22px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-chat-title{display:flex;align-items:center;gap:8px;min-width:0}
.wsa-chat-head strong{display:block;font-size:13.5px;font-weight:600;line-height:1.4;letter-spacing:.01em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wsa-chat-toggle{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color 160ms var(--wsa-ease),color 160ms var(--wsa-ease),transform 160ms var(--wsa-ease)}
.wsa-chat-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-chat-toggle:active{transform:scale(.94)}
.wsa-chat-toggle[aria-expanded="true"]{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-chat-toggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-chat-main{display:flex;flex:1;min-height:0;min-width:0;position:relative}.wsa-chat-body{flex:1;min-height:0;min-width:0;overflow:auto}
.wsa-chat-native{height:100%;min-height:0}.wsa-chat-native [data-conversation-content]{height:100%}
.wsa-chat-detail{width:min(332px,42%);flex:none;border-left:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);min-height:0;overflow:hidden}
.wsa-chat-empty{max-width:520px;margin:12vh auto 0;padding:24px}.wsa-chat-empty h2{font-size:22px}
.wsa-chat-status{padding:8px 20px;color:var(--dsw-alias-label-secondary);font-size:13px}
.wsa-chat :is(.wsa-chat-empty,.wsa-chat-status)>button{color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 12px;font:inherit}
.wsa-chat :is(.wsa-chat-empty,.wsa-chat-status)>button:disabled{opacity:.5}
.wsa-chat-scrim{display:none}
.wsa-chat[data-ready="false"] [data-composer-seat],
.wsa-chat [data-slot="conversation.input.permission"],.wsa-chat [data-slot="conversation.input.plan"],
.wsa-chat [data-slot="conversation.input.model"]{display:none!important}
@media(max-width:1100px){
  .wsa-chat-scrim{display:block;position:absolute;inset:0;z-index:20;margin:0;padding:0;border:0;background:rgb(0 0 0 / .26);cursor:default;animation:wsa-chat-fade 160ms var(--wsa-ease)}
  .wsa-chat-detail{position:absolute;inset:0 0 0 auto;z-index:21;width:min(332px,90%);background:var(--dsw-alias-bg-base);box-shadow:-24px 0 60px -20px rgb(0 0 0 / .42);animation:wsa-chat-drawer 180ms var(--wsa-ease)}
}
@keyframes wsa-chat-fade{from{opacity:0}}
@keyframes wsa-chat-drawer{from{opacity:0;transform:translateX(14px)}}
@media(prefers-reduced-motion:reduce){.wsa-chat-scrim,.wsa-chat-detail{animation:none}}
`;

function FixedChat({ renderSlot }: { renderSlot(key: 'conversation.session', owner: { view: 'chat' }): React.ReactNode }) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>;
}

function Transcript({ renderFactorySlot }: PropsRenderFactories) {
  // 0.2.2-rc.1 的原生会话 Factory，由 ui-conversation 提供。
  const render = renderFactorySlot as unknown as (key: 'conversation.content',
    owner: { variant: 'embedded'; phase: 'active'; hero: false },
    options: { slots: { views: typeof FixedChat } }) => React.ReactNode;
  return <div className="wsa-chat-native">{render('conversation.content', { variant: 'embedded', phase: 'active', hero: false },
    { slots: { views: FixedChat } })}</div>;
}

class ChatPanelBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error('超级大肥鱼 面板加载失败', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="wsa-chat" data-superagent-chat="">
      <style>{css}</style>
      <header className="wsa-chat-head"><strong>超级大肥鱼</strong></header>
      <div className="wsa-chat-empty">
        <p role="status">暂时无法显示主理对话。</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>重新加载对话</button>
      </div>
    </section>;
  }
}

export function createChatPanel(ctx: Context, HealthPage: React.ComponentType, openChat: () => void, isChatOpen: () => boolean) {
  let managerId: string | null = null;
  let workspaceLabel = '';
  let workspaceListStyle: HTMLStyleElement | undefined;
  function setManagerId(id: string | null) {
    managerId = id;
    // 主理的工作区绑定用于恢复会话，只隐藏侧栏中与绑定 ID 匹配的行。
    if (workspaceListStyle) workspaceListStyle.textContent = id
      ? `[data-slot="sidebar.workspaces"] [data-row-key="${CSS.escape('session:' + id)}"]{display:none!important}` : '';
  }
  const OpenManager = () => <button type="button" onClick={openChat}>打开超级大肥鱼</button>;
  const slots = ctx.slots as unknown as {
    inject(name: 'conversation.composer', fn: () => unknown): unknown;
    register(options: { name: 'conversation.composer'; select(owner: { sessionId?: string }): true | null },
      component: typeof OpenManager): unknown;
  };
  slots.inject('conversation.composer', () => slots.register({
    name: 'conversation.composer', select: ({ sessionId }) => sessionId && sessionId === managerId && !isChatOpen() ? true : null,
  }, OpenManager));
  ctx.effect(() => {
    const abort = new AbortController();
    const style = document.createElement('style');
    workspaceListStyle = style;
    document.head.append(style);
    setManagerId(managerId);
    void readChatHealth(abort.signal)
      .then(({ health }) => { if (!abort.signal.aborted && managerId === null) setManagerId(health.chat?.sessionId ?? null); })
      .catch(() => {});
    return () => {
      abort.abort();
      style.remove();
      if (workspaceListStyle === style) workspaceListStyle = undefined;
    };
  });
  const Card = createActionCard(ctx, sessionId => isChatOpen() && sessionId === managerId, () => workspaceLabel);
  const PersonalPanel = createPersonalPanel(ctx);
  const actions = ctx.slots as unknown as {
    inject(name: string, register: () => unknown): unknown;
    register(config: { name: string; id: string; order: number; inject(sessionId: string): { sessionId: string } }, component: typeof Card): unknown;
  };
  actions.inject('conversation.chat.turnTail', () => actions.register({
    name:'conversation.chat.turnTail',id:'workspace-superagent-actions',order:10,inject:sessionId => ({sessionId}),
  },Card));
  ctx.slots.inject(CHILD, () => ctx.slots.register({ name: CHILD }, Transcript));

  function ChatPage({ SessionProvider, renderSlot }: PropsRenderSlots<typeof CHILD>) {
    const Provider = SessionProvider as unknown as (props: { session: ChatReference; children: React.ReactNode }) => React.ReactNode;
    const [health, setHealth] = React.useState<HealthView>();
    const [motto, setMotto] = React.useState<DailyMotto | null>(null);
    const [reference, setReference] = React.useState<ChatReference>();
    const [notice, setNotice] = React.useState('');
    const [historyError, setHistoryError] = React.useState(false);
    const [historyAttempt, retryHistory] = React.useReducer(attempt => attempt + 1, 0);
    const [details, setDetails] = React.useState(() => {
      try { const saved = window.localStorage.getItem('workspace-superagent-personal-open'); return saved === null ? window.innerWidth > 1100 : saved === 'true'; }
      catch { return false; }
    });
    const [diagnostics, setDiagnostics] = React.useState(false);
    const [connecting, setConnecting] = React.useState(false);
    const token = React.useRef<string | null>(null);
    const pending = React.useRef(false);
    const state = health?.chat;
    const toggleDetails = () => setDetails(open => {
      try { window.localStorage.setItem('workspace-superagent-personal-open', String(!open)); } catch { /* 保持当前窗口状态。 */ }
      return !open;
    });
    React.useEffect(() => {
      if (!details || diagnostics) return;
      const narrow = window.matchMedia('(max-width: 1100px)');
      const keydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !narrow.matches) return;
        // 委派详情自己处理 Escape，避免连同抽屉一起关闭。
        if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
        toggleDetails();
      };
      window.addEventListener('keydown', keydown);
      return () => window.removeEventListener('keydown', keydown);
    }, [details, diagnostics]);

    function adopt(next: HealthView) {
      setManagerId(next.chat?.sessionId ?? null);
      workspaceLabel = next.chat?.workspace ?? '';
      setHealth(next);
    }
    async function refresh(signal?: AbortSignal) {
      const { health: next, token: ownerToken } = await readChatHealth(signal);
      token.current = ownerToken;
      if (!signal?.aborted) adopt(next);
      return next;
    }
    const mutate = (body: object, signal?: AbortSignal) => mutateChat(body, token.current, signal);
    async function connect(snapshot: HealthView, signal?: AbortSignal) {
      if (!snapshot.summary || pending.current) return;
      pending.current = true;
      setConnecting(true); setNotice('');
      try {
        const result = await mutate({ revision: snapshot.summary.manager.revision }, signal);
        if (result.health && !signal?.aborted) adopt(result.health);
      } catch (error) {
        if (!signal?.aborted) setNotice(error instanceof Error ? error.message : '连接未完成。');
      } finally {
        pending.current = false;
        if (!signal?.aborted) setConnecting(false);
      }
    }
    React.useEffect(() => {
      const abort = new AbortController();
      void refresh(abort.signal).then(next => {
        if (!abort.signal.aborted && next.chat?.sessionId && !next.chat.ready && !next.chat.reason &&
            next.summary?.manager.lifecycle === 'paused') void connect(next, abort.signal);
      }).catch(error => { if (!abort.signal.aborted) setNotice(error.message); });
      return () => abort.abort();
    }, [diagnostics]);
    React.useEffect(() => {
      if (!state?.ready || diagnostics) return;
      const abort = new AbortController();
      let shownDay: string | undefined;
      let requesting = false;
      async function refreshMotto() {
        const day = localMottoDay();
        if (shownDay === day || requesting) return;
        setMotto(null);
        requesting = true;
        try {
          const { dailyMotto } = await mutateChat({ dailyMotto: true }, token.current, abort.signal);
          if (!abort.signal.aborted && dailyMotto?.day === localMottoDay()) {
            shownDay = dailyMotto.day;
            setMotto(dailyMotto);
          }
        } catch { /* 标语暂不可用时显示主理名称。 */ }
        finally { requesting = false; }
      }
      void refreshMotto();
      const timer = window.setInterval(() => void refreshMotto(), 60_000);
      return () => { window.clearInterval(timer); abort.abort(); };
    }, [state?.ready, diagnostics]);
    React.useEffect(() => {
      setReference(undefined);
      setHistoryError(false);
      const sessionId = state?.sessionId;
      if (!sessionId || diagnostics) return;
      const abort = new AbortController();
      let retained: ChatReference | undefined;
      let detach: (() => void) | undefined;
      let timer: number | undefined;
      let attempt = 0;
      const release = () => {
        try { detach?.(); }
        finally { retained?.release(); detach = undefined; retained = undefined; }
      };
      async function open(id: string) {
        const sessions = ctx.get('sessions') as unknown as { retain(id: string, options: { source: string; signal: AbortSignal }): ChatReference };
        retained = sessions.retain(id, { source: 'workspaceSuperagent', signal: abort.signal });
        await retained.ready;
        abort.signal.throwIfAborted();
        detach = attachChatTransport(retained, ctx.get('modelDirectories') as ChatModelDirectories, mutate);
        setReference(retained);
      }
      // 会话目录在页面加载后异步到达，而默认页可能在目录就绪前打开；此时主理会话还不在目录里，
      // 等目录到达后重试，而不是直接报加载失败。
      const failed = (error: unknown) => {
        if (abort.signal.aborted) return;
        release();
        if (!(error instanceof Error && error.message.includes('unknown session'))) {
          console.error('超级大肥鱼 会话加载失败', error);
          setHistoryError(true);
          return;
        }
        if (attempt >= 60) { setHistoryError(true); return; }
        attempt += 1;
        timer = window.setTimeout(() => { if (!abort.signal.aborted) void open(sessionId).catch(failed); }, 300);
      };
      void open(sessionId).catch(failed);
      return () => { abort.abort(); if (timer !== undefined) window.clearTimeout(timer); release(); };
    }, [state?.sessionId, diagnostics, historyAttempt]);
    return <section className="wsa-chat" data-superagent-chat="" data-ready={state?.ready === true}>
      <style>{css}</style>
      <header className="wsa-chat-head"><div className="wsa-chat-title"><strong>{motto?.day === localMottoDay() ? motto.text : '超级大肥鱼'}</strong></div>
        <button type="button" className="wsa-chat-toggle" title={diagnostics ? '返回对话' : details ? '收起个人面板' : '打开个人面板'}
          aria-label={diagnostics ? '返回对话' : details ? '收起个人面板' : '打开个人面板'}
          aria-expanded={!diagnostics && details} aria-controls={details ? 'wsa-personal-detail' : undefined}
          onClick={() => diagnostics ? setDiagnostics(false) : toggleDetails()}>
          <Icon name={diagnostics ? 'back' : 'panel'} size={17} />
        </button>
      </header>
      {diagnostics ? <div className="wsa-chat-body"><HealthPage /></div> : <>
        {state?.sessionId && !state.ready && <div className="wsa-chat-status" role="status">
          {notice || state.reason || (connecting ? '正在连接主理…' : '主理尚未连接。')}{!state.reason &&
            <button type="button" disabled={connecting} onClick={() => health && void connect(health)}>重新连接</button>}
        </div>}
        <div className="wsa-chat-main"><div className="wsa-chat-body">
          {state?.sessionId && reference?.sessionId === state.sessionId
            ? <Provider session={reference}>{renderSlot(CHILD, {})}</Provider>
            : <div className="wsa-chat-empty"><h2>你好，我是你的主理。</h2><p>你可以问我任务进展，也可以让我帮你整理下一步。</p>
              <p role="status">{historyError ? '暂时无法加载主理对话。' :
                notice || state?.reason || health?.reason || (!health ? '正在读取主理状态…' : state?.sessionId ? '正在加载对话…' : '')}</p>
              {historyError ? <button type="button" onClick={retryHistory}>重新加载对话</button> :
                state && !state.sessionId && <button type="button" disabled={connecting || !!state.reason}
                  onClick={() => health && void connect(health)}>{connecting ? '正在连接…' : '开始对话'}</button>}
            </div>}
        </div>
        {details && <button type="button" className="wsa-chat-scrim" aria-label="收起个人面板" tabIndex={-1} onClick={toggleDetails} />}
        {details && <aside className="wsa-chat-detail" id="wsa-personal-detail" aria-label="个人面板">
          {state?.sessionId ? <PersonalPanel key={state.sessionId} sessionId={state.sessionId} workspace={state.workspace}
            automationText={'主理后台' + (health?.automation?.accepting ? '运行中' : '已暂停')}
            onDiagnostics={() => setDiagnostics(true)} /> : <p>主理会话尚未就绪。</p>}
        </aside>}</div>
      </>}
    </section>;
  };
  return function ChatPanel(props: PropsRenderSlots<typeof CHILD>) {
    return <ChatPanelBoundary><ChatPage {...props} /></ChatPanelBoundary>;
  };
}
