import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { FoundationStatus } from '../status';
import zh from '../../locale/zh.json';
import en from '../../locale/en.json';
import { createChatPanel } from './chat.js';
import { createHealthPage } from './health.js';
import { createSettingsSection, type ModelCatalogRemote } from './settings.js';
import { createSidebarBot, installSidebarBotStyles } from './sidebar-bot.js';
const PANEL = 'workspace-superagent';
const NS = 'workspace-superagent';
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'workspace-superagent': 'title' | 'eyebrow' | 'heading' | 'description' | 'dependencies' | 'board' | 'admission'
      | 'available' | 'missing' | 'loading' | 'unreachable' | 'boundary'
      | 'settingsIntro' | 'settingsModel' | 'settingsEffort' | 'settingsMode' | 'settingsStandard'
      | 'settingsSelectModel' | 'settingsDefaultEffort' | `settingsEffort.${'off' | 'low' | 'medium' | 'high' | 'max'}`
      | 'settingsSave' | 'settingsSaved' | 'settingsLoading' | 'settingsCatalogError' | 'settingsUnavailable';
  }
  interface SlotMap { 'settings.section': { kind: 'list'; scope: 'root'; owner: { close(): void } } }
}
export const inject = ['slots', 'layout', 'locale', 'sessions', 'modelDirectories'];
const css = '.wsa{box-sizing:border-box;min-height:100%;padding:clamp(24px,5vw,64px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;overflow:auto}.wsa-inner{max-width:640px;margin:0 auto}.wsa-kicker{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}.wsa h1{font-size:24px;line-height:1.4;font-weight:600;margin:0 0 16px}.wsa p{line-height:1.8;overflow-wrap:anywhere}.wsa-intro{color:var(--dsw-alias-label-secondary)}.wsa-deps{border-top:1px solid var(--dsw-alias-border-l1);margin-top:40px;padding-top:24px}.wsa h2{font-size:14px;font-weight:600;margin:0 0 16px}.wsa dl{margin:0}.wsa-row{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap;padding:12px 0}.wsa dd{margin:0;color:var(--dsw-alias-label-secondary)}.wsa-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:28px}';
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: zh.ui, en: en.ui }));
  const t = ctx.locale.bind(NS);
  const Icon = createSidebarBot();
  ctx.effect(installSidebarBotStyles);
  function Page(): React.ReactElement {
    React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const [status, setStatus] = React.useState<FoundationStatus | null>(null);
    const [error, setError] = React.useState(false);
    React.useEffect(() => {
      const abort = new AbortController();
      fetch('/api/workspace-superagent/status', { credentials: 'same-origin', signal: abort.signal, cache: 'no-store' })
        .then(async response => { if (!response.ok) throw Error('HOST_STATUS_UNAVAILABLE'); return response.json(); })
        .then((value: FoundationStatus) => { if (value.stage !== 'b04' || typeof value.capabilities?.taskBoard !== 'boolean' || typeof value.capabilities?.inputAdmission !== 'boolean') throw Error('HOST_STATUS_INVALID'); setStatus(value); })
        .catch(() => { if (!abort.signal.aborted) setError(true); });
      return () => abort.abort();
    }, []);
    return <section className="wsa" data-workspace-superagent=""><style>{css}</style><div className="wsa-inner">
      <p className="wsa-kicker">{t('eyebrow')}</p><h1>{t('heading')}</h1><p className="wsa-intro">{t('description')}</p>
      <section className="wsa-deps" aria-live="polite"><h2>{t('dependencies')}</h2>{error ? <p role="status">{t('unreachable')}</p> : !status ? <p>{t('loading')}</p> : <dl>{(['taskBoard', 'inputAdmission'] as const).map((key, index) => <div className="wsa-row" key={key}><dt>{t(index === 0 ? 'board' : 'admission')}</dt><dd>{t(status.capabilities[key] ? 'available' : 'missing')}</dd></div>)}</dl>}</section>
      <p className="wsa-note">{t('boundary')}</p></div></section>;
  }
  const HealthPage = createHealthPage(ctx, Page);
  const ChatPage = createChatPanel(ctx, HealthPage, () => ctx.layout.selectPanel(PANEL as MainPanelId),
    () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL);
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: PANEL,
      children: { 'workspace-superagent.conversation': { kind: 'single', scope: 'session' } } }, ChatPage);
    // 首次进入 DSH 时默认落在超级大肥鱼页面：必须在 register 之后选择，
    // 否则 retainMainPanels 会把「未注册的面板」重置回对话页。
    // 同一次页面加载内的插件重载（HMR）沿用用户当下的页面，不再抢占。
    const landing = globalThis as unknown as { __workspaceSuperagentLandingOpened?: boolean };
    if (landing.__workspaceSuperagentLandingOpened !== true
      && ctx.layout.panelInfo.getSnapshot().activePanelId === null) {
      landing.__workspaceSuperagentLandingOpened = true;
      ctx.layout.selectPanel(PANEL as MainPanelId);
    }
    return dispose;
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: -100, label: () => t('title') }, Icon));
  ctx.inject(['remote', 'remote.session'], scope => {
    const SettingsSection = createSettingsSection(scope.get('remote') as ModelCatalogRemote, key => t(key as keyof typeof zh.ui));
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: PANEL, order: 30, label: () => t('title'),
    }, SettingsSection));
  });
}
