import * as React from 'react';
import { nativeChatModel, type ChatModelSelection } from '../app/health/chat-input.js';
import { mutateChat, readChatHealth } from './chat-transport.js';

type Reasoning = { defaultEffort?: string; efforts: readonly { id: string; name: string }[] };
type Provider = { id: string; name: string; models: readonly { id: string; name: string; reasoning?: Reasoning }[] };
export interface ModelCatalogRemote {
  session: { modelCatalog(): Promise<{ ok: true; value: { groups: readonly Provider[] } } | { ok: false }> };
}
const route = ({ provider, model }: ChatModelSelection) => JSON.stringify([provider, model]);
const css = `
.wsa-settings{padding:4px 2px;color:var(--dsw-alias-label-primary)}
.wsa-settings h2{margin:0 0 8px;font-size:16px}
.wsa-settings p{margin:0 0 16px;color:var(--dsw-alias-label-secondary)}
.wsa-settings label,.wsa-settings dl>div{display:grid;grid-template-columns:minmax(88px,1fr) minmax(0,2fr);align-items:center;gap:12px;margin:0 0 12px}
.wsa-settings dd{margin:0}
.wsa-settings :is(select,button){font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;min-width:0}
.wsa-settings button:disabled{opacity:.5}
.wsa-settings [role="status"]{display:inline;margin-inline-start:12px}
`;

export function createSettingsSection(remote: ModelCatalogRemote, t: (key: string) => string) {
  return function SettingsSection() {
    const [state, setState] = React.useState<{ sessionId: string; token: string | null; model: ChatModelSelection }>();
    const [groups, setGroups] = React.useState<readonly Provider[]>([]);
    const [model, setModel] = React.useState<ChatModelSelection>();
    const [notice, setNotice] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const request = React.useRef<AbortSignal>();
    React.useEffect(() => {
      const abort = new AbortController();
      request.current = abort.signal;
      async function load() {
        const [{ health, token }, catalog] = await Promise.all([
          readChatHealth(abort.signal), remote.session.modelCatalog(),
        ]);
        abort.signal.throwIfAborted();
        if (!catalog.ok) throw Error(t('settingsCatalogError'));
        const revision = health.summary?.manager.revision;
        const chat = health.chat;
        const current = chat?.sessionId && !chat.ready && !chat.reason && health.summary?.manager.lifecycle === 'paused' && revision !== undefined
          ? (await mutateChat({ revision }, token, abort.signal)).health?.chat : chat;
        abort.signal.throwIfAborted();
        if (!current?.sessionId || !current.ready) throw Error(current?.reason || t('settingsUnavailable'));
        setGroups(catalog.value.groups.filter(group => nativeChatModel(group.id)));
        setState({ sessionId: current.sessionId, token, model: current.model });
        setModel(current.model);
      }
      void load().catch(error => { if (!abort.signal.aborted) setNotice(error.message); });
      return () => abort.abort();
    }, []);
    const options = groups.flatMap(group => group.models.map(entry => ({
      key: route({ provider: group.id, model: entry.id }), provider: group.id, group: group.name, entry,
    })));
    const option = model && options.find(item => item.key === route(model));
    const reasoning = option?.entry.reasoning;
    const effort = model?.reasoningEffort ?? reasoning?.defaultEffort ?? '';
    const unchanged = state && model && route(state.model) === route(model) && state.model.reasoningEffort === model.reasoningEffort;
    async function save(event: React.FormEvent) {
      event.preventDefault();
      if (!state || !model || !option || unchanged || saving) return;
      const signal = request.current;
      setSaving(true); setNotice('');
      try {
        await mutateChat({ sessionId: state.sessionId, model }, state.token, signal);
        if (!signal?.aborted) {
          setState({ ...state, model });
          setNotice(t('settingsSaved'));
        }
      } catch (error) {
        if (!signal?.aborted) setNotice(error instanceof Error ? error.message : t('settingsUnavailable'));
      } finally {
        if (!signal?.aborted) setSaving(false);
      }
    }
    return <section className="wsa-settings" data-workspace-superagent-settings="">
      <style>{css}</style><h2>{t('title')}</h2><p>{t('settingsIntro')}</p>
      <form onSubmit={save}>
        <label>{t('settingsModel')}<select value={model ? route(model) : ''} disabled={!state || saving} onChange={event => {
          const next = options.find(item => item.key === event.target.value);
          if (next) {
            const defaultEffort = next.entry.reasoning?.defaultEffort;
            setModel({ provider: next.provider, model: next.entry.id, ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}) });
            setNotice('');
          }
        }}>
          {!option && <option value={model ? route(model) : ''} disabled>{model?.model ?? t('settingsSelectModel')}</option>}
          {options.map(item => <option key={item.key} value={item.key}>{item.entry.name} · {item.group}</option>)}
        </select></label>
        <label>{t('settingsEffort')}<select value={effort} disabled={!reasoning?.efforts.length || saving} onChange={event => {
          if (model) { setModel({ ...model, reasoningEffort: event.target.value }); setNotice(''); }
        }}>
          {!reasoning?.efforts.some(level => level.id === effort) && <option value={effort} disabled>{effort || t('settingsDefaultEffort')}</option>}
          {reasoning?.efforts.map(level => {
            const label = t('settingsEffort.' + level.id);
            return <option key={level.id} value={level.id}>{label === 'settingsEffort.' + level.id ? level.name : label}</option>;
          })}
        </select></label>
        <dl><div><dt>{t('settingsMode')}</dt><dd>{t('settingsStandard')}</dd></div></dl>
        <button type="submit" disabled={!state || !option || unchanged || saving}>{t('settingsSave')}</button>
        <span role="status">{notice || (!state && !saving ? t('settingsLoading') : '')}</span>
      </form>
    </section>;
  };
}
