window.__ModuleLoader__.load({
  id: '@local/dsh-pomodoro-clock',
  factory: function factory(require) {
  const React = require('react');
  const h = React.createElement;
  const NS = 'localPomodoro';
  const dictionaries = {
    zh: {
      title: '番茄时钟', focus: '专注', break: '短休息', focusing: '专注中', resting: '休息中',
      paused: '已暂停', focusDone: '专注完成', breakDone: '休息结束', startFocus: '开始专注',
      startBreak: '开始休息', pause: '暂停', resume: '继续', reset: '重置', minimize: '收起番茄钟',
      loading: '正在同步', error: '暂时无法同步，请重试。', retry: '重试', ready: '准备开始',
      finishedFocus: '做得好，休息一下吧', finishedBreak: '准备好下一段专注了吗',
      switchHint: '暂停后可切换模式', syncing: '正在连接番茄钟',
      notifyEnable: '开启桌面通知', notifyDenied: '桌面通知未开启，将在页面提醒。',
    },
    en: {
      title: 'Pomodoro clock', focus: 'Focus', break: 'Short break', focusing: 'Focusing', resting: 'Resting',
      paused: 'Paused', focusDone: 'Focus complete', breakDone: 'Break complete', startFocus: 'Start focus',
      startBreak: 'Start break', pause: 'Pause', resume: 'Resume', reset: 'Reset', minimize: 'Minimize timer',
      loading: 'Syncing', error: 'Could not sync. Please try again.', retry: 'Retry', ready: 'Ready to start',
      finishedFocus: 'Nice work. Take a breather.', finishedBreak: 'Ready for your next focus?',
      switchHint: 'Pause to switch modes', syncing: 'Connecting to the timer',
      notifyEnable: 'Enable desktop notifications', notifyDenied: 'Desktop notifications are off. Reminders appear here.',
    },
  };
  const css = `
    .dshp-entry,.dshp-panel{font-family:inherit;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
    .dshp-entry{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:28px;height:32px;padding:4px;border:0;border-radius:7px;background:transparent;cursor:pointer;flex:0 1 auto;white-space:nowrap;font-size:12px;line-height:1.3;transition:background 150ms ease-out}
    .dshp-entry[data-active=true]{padding-inline:7px;background:var(--dsw-alias-bg-layer-2)}
    .dshp-entry:hover{background:var(--dsw-alias-bg-layer-2)}
    .dshp-entry:active{transform:translateY(1px)}
    .dshp-entry-count{font-variant-numeric:tabular-nums;font-weight:500}
    .dshp-entry-status{font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary)}
    .dshp-entry[data-wide=false]{font-size:10px;padding-inline:2px}
    .dshp-entry[data-wide=false][data-active=true] .dshp-tomato{display:none}
    .dshp-panel{position:fixed;pointer-events:auto;width:204px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;isolation:isolate;padding:14px 16px 16px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;animation:dshp-appear 160ms cubic-bezier(.22,1,.36,1) both}
    .dshp-heading{display:flex;align-items:center;gap:7px;margin:0 0 10px}
    .dshp-title{font-size:12px;font-weight:500;line-height:20px;margin:0;flex:1}
    .dshp-minimize{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:5px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
    .dshp-minimize:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
    .dshp-modes{display:flex;width:fit-content;margin:0 auto;padding:2px;gap:1px;border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
    .dshp-mode{min-height:24px;padding:2px 10px;border:0;border-radius:5px;font:inherit;font-size:11px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
    .dshp-mode[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-overlay)}
    .dshp-mode:disabled{cursor:default}
    .dshp-time{margin:12px 0 10px;font-size:40px;line-height:46px;font-weight:400;letter-spacing:-1.3px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
    .dshp-controls{display:flex;align-items:center;justify-content:center;gap:6px}
    .dshp-primary{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:30px;min-width:106px;padding:5px 12px;border:0;border-radius:7px;font:inherit;font-size:11px;line-height:20px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);cursor:pointer;white-space:nowrap}
    .dshp-primary:hover{opacity:.9}
    .dshp-primary:active{transform:translateY(1px)}
    .dshp-primary:disabled{opacity:.5;cursor:wait}
    .dshp-reset{display:grid;place-items:center;flex:none;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
    .dshp-reset:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
    .dshp-reset:disabled{opacity:.5;cursor:wait}
    .dshp-hint{margin:10px 0 0;text-align:center;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
    .dshp-error{margin:10px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary)}
    .dshp-retry{margin-inline-start:5px;padding:0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}
    .dshp-notify-enable{display:block;margin:9px auto 0;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:17px;text-decoration:underline;cursor:pointer}
    .dshp-entry:focus-visible,.dshp-panel button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
    .dshp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
    @keyframes dshp-appear{from{opacity:0;transform:translateY(5px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
    @media(prefers-reduced-motion:reduce){.dshp-panel{animation:none}.dshp-entry{transition:none}.dshp-entry:active,.dshp-primary:active{transform:none}}
  `;
  // BEGIN completion notifier
  function createCompletionNotifier({ readClaim = () => null, writeClaim = () => {}, withLock = (_name, run) => run(), present, notify, onError = () => {} }) {
  let lastKey;
  let disposed = false;
  async function completed(state) {
    if (disposed || state?.status !== 'completed' || !['focus', 'break'].includes(state.mode) ||
        !Number.isSafeInteger(state.revision)) return false;
    const key = state.mode + ':' + state.revision;
    if (lastKey === key) return false;
    lastKey = key;
    const run = async () => {
      if (disposed) return false;
      try { if (readClaim() === key) return false; } catch (error) { onError(error); }
      try { writeClaim(key); } catch (error) { onError(error); }
      if (disposed) return false;
      try { present(state); } catch (error) { onError(error); }
      try { await notify(state, key); } catch (error) { onError(error); }
      return true;
    };
    try { return await withLock('dsh-pomodoro-completion', run); }
    catch (error) { onError(error); return run(); }
  }
  return { completed, dispose() { disposed = true; } };
}
  // END completion notifier
  function Icon({ name, size = 14 }) {
    const paths = { play: 'm8 5 10 7-10 7V5Z', pause: 'M8 5v14M16 5v14',
      reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6', minus: 'M6 12h12' };
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true }, h('path', { d: paths[name] }));
  }
  function Tomato({ color = false, size = 20 }) {
    return h('svg', { className: 'dshp-tomato', width: size, height: size, viewBox: '0 0 32 32',
      fill: 'none', 'aria-hidden': true, style: { flexShrink: 0 } },
      h('path', { d: 'M16 11C6 6 2 16 6 24c3 7 17 7 21 0 4-8-1-18-11-13Z',
        fill: color ? '#ec6b61' : 'none', stroke: color ? '#ec6b61' : 'currentColor', strokeWidth: 1.8 }),
      h('path', { d: 'm16 12-6-4 5 1 2-6 2 6 5-1-5 5', fill: color ? '#629b73' : 'none',
        stroke: color ? '#629b73' : 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
      color && h('path', { d: 'M10 15c-2 2-3 4-2 6', stroke: '#ffd8d1', strokeWidth: 1.7, strokeLinecap: 'round' }));
  }
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'zh', dictionaries.zh));
      ctx.effect(() => ctx.locale.register(NS, 'en', dictionaries.en));
      const t = ctx.locale.bind(NS);
      let view = { state: null, deadlineMono: 0, open: false, pending: false, error: false, left: 12, bottom: 80, userOpened: false,
        notificationPermission: typeof Notification === 'function' ? Notification.permission : 'unsupported' };
      const listeners = new Set();
      const controllers = new Set();
      const trigger = { current: null };
      let disposed = false;
      const endpoint = new URL('api/local-pomodoro', document.baseURI);
      const notices = new Set();
      const notifier = createCompletionNotifier({
        readClaim: () => localStorage.getItem('dsh.pomodoro.last-completion'),
        writeClaim: key => localStorage.setItem('dsh.pomodoro.last-completion', key),
        withLock: (name, run) => navigator.locks?.request ? navigator.locks.request(name, run) : run(),
        present() { position(); patch({ open: true, userOpened: false }); },
        notify(state, key) {
          if (typeof Notification !== 'function' || Notification.permission !== 'granted') return;
          const focus = state.mode === 'focus';
          const notice = new Notification(t(focus ? 'focusDone' : 'breakDone'), {
            body: t(focus ? 'finishedFocus' : 'finishedBreak'),
            tag: 'dsh-pomodoro-' + key,
          });
          notices.add(notice);
          notice.onclick = () => { window.focus(); position(); patch({ open: true, userOpened: false }); notice.close(); };
          notice.onclose = () => notices.delete(notice);
        },
        onError: error => console.error('[pomodoro notification]', error),
      });
      ctx.effect(() => () => {
        notifier.dispose();
        for (const notice of notices) notice.close();
        notices.clear();
      });
      const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
      const snapshot = () => view;
      function patch(fields) {
        if (disposed) return;
        view = { ...view, ...fields };
        for (const fn of listeners) fn();
      }
      function accept(state) {
        if (!state || !['focus', 'break'].includes(state.mode) ||
            !['idle', 'paused', 'running', 'completed'].includes(state.status) ||
            !Number.isFinite(state.serverNow) || !Number.isFinite(state.remainingMs)) {
          throw new Error('Invalid Pomodoro response');
        }
        if (view.state && state.revision < view.state.revision) return;
        const completed = view.state?.status === 'running' && state.status === 'completed';
        patch({ state, error: false,
          deadlineMono: performance.now() + Math.max(0, (state.endsAt ?? state.serverNow) - state.serverNow),
          ...(completed ? { open: true, userOpened: false } : {}) });
        void notifier.completed(state);
      }
      async function request(input, busy = true) {
        if (disposed || (busy && view.pending)) return;
        const abort = new AbortController();
        controllers.add(abort);
        const timeout = setTimeout(() => abort.abort(), 10_000);
        if (busy) patch({ pending: true });
        try {
          const response = await fetch(endpoint, {
            method: input.action === 'status' ? 'GET' : 'POST',
            credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
            ...(input.action === 'status' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
          });
          if (!response.ok) throw new Error('Pomodoro request failed: ' + response.status);
          const result = await response.json();
          accept(result);
          if (input.action === 'start' && result.mode === 'focus' && result.status === 'running') close(true);
        } catch (error) {
          if (!disposed) { console.error('[pomodoro]', error); patch({ error: true }); }
        } finally {
          clearTimeout(timeout);
          controllers.delete(abort);
          if (busy) patch({ pending: false });
        }
      }
      function position() {
        if (!trigger.current) return;
        const rect = trigger.current.getBoundingClientRect();
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - 216));
        const bottom = Math.max(12, Math.min(window.innerHeight - rect.top + 12, window.innerHeight - 240));
        if (view.left !== left || view.bottom !== bottom) patch({ left, bottom });
      }
      function close(restoreFocus = false) {
        patch({ open: false, userOpened: false });
        if (restoreFocus) trigger.current?.focus();
      }
      function requestNotificationPermission() {
        if (typeof Notification !== 'function' || Notification.permission !== 'default') return;
        try {
          Promise.resolve(Notification.requestPermission()).then(permission => {
            patch({ notificationPermission: permission });
          }).catch(error => console.error('[pomodoro notification permission]', error));
        } catch (error) { console.error('[pomodoro notification permission]', error); }
      }
      function useView() {
        const data = React.useSyncExternalStore(subscribe, snapshot, snapshot);
        React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot());
        const [mono, setMono] = React.useState(() => performance.now());
        const running = data.state?.status === 'running';
        React.useEffect(() => {
          if (!running) return;
          setMono(performance.now());
          const timer = setInterval(() => setMono(performance.now()), 250);
          return () => clearInterval(timer);
        }, [running, data.deadlineMono]);
        const seconds = data.state ? Math.ceil(Math.max(0,
          running ? data.deadlineMono - performance.now() : data.state.remainingMs) / 1000) : null;
        React.useEffect(() => {
          if (running && seconds === 0) request({ action: 'status' }, false);
        }, [running, seconds]);
        const time = seconds === null ? '--:--' :
          String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        return { ...data, time };
      }
      function statusText(state) {
        if (!state) return t('loading');
        if (state.status === 'running') return t(state.mode === 'focus' ? 'focusing' : 'resting');
        if (state.status === 'paused') return t('paused');
        if (state.status === 'completed') return t(state.mode === 'focus' ? 'focusDone' : 'breakDone');
        return t('ready');
      }
      function Entry({ wide }) {
        const data = useView();
        const active = data.state && data.state.status !== 'idle';
        const time = data.time.replace(':', '：');
        const label = active ? time + ' ' + statusText(data.state) : t('title');
        return h('button', {
          ref: node => { trigger.current = node; },
          className: 'dshp-entry', type: 'button', 'data-active': !!active, 'data-wide': wide,
          'aria-label': label, title: label, 'aria-expanded': data.open,
          'aria-controls': data.open ? 'dshp-dialog' : undefined, 'aria-haspopup': 'dialog',
          onClick() {
            if (view.open) close();
            else { position(); patch({ open: true, userOpened: true }); if (view.error) request({ action: 'status' }); }
          },
        }, h(Tomato, { size: active ? 16 : 21 }),
        active && h('span', { className: 'dshp-entry-count' }, time),
        active && wide && h('span', { className: 'dshp-entry-status' }, statusText(data.state)));
      }
      function Panel() {
        const data = useView();
        const panelRef = React.useRef(null);
        const primaryRef = React.useRef(null);
        const state = data.state;
        React.useEffect(() => {
          if (!data.open) return;
          position();
          if (data.userOpened) primaryRef.current?.focus();
          const outside = event => {
            if (!panelRef.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
          };
          const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } };
          document.addEventListener('pointerdown', outside, true);
          document.addEventListener('keydown', escape);
          window.addEventListener('resize', position);
          window.addEventListener('scroll', position, true);
          return () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', escape);
            window.removeEventListener('resize', position);
            window.removeEventListener('scroll', position, true);
          };
        }, [data.open]);
        let action = 'start', mode = state?.mode ?? 'focus', icon = 'play';
        let primary = t(mode === 'focus' ? 'startFocus' : 'startBreak');
        if (state?.status === 'running') { action = 'pause'; primary = t('pause'); icon = 'pause'; }
        if (state?.status === 'paused') { action = 'resume'; primary = t('resume'); }
        if (state?.status === 'completed') {
          mode = state.mode === 'focus' ? 'break' : 'focus';
          primary = t(mode === 'focus' ? 'startFocus' : 'startBreak');
        }
        return h(React.Fragment, null,
          h('style', null, css),
          data.open && h('section', {
            ref: panelRef, id: 'dshp-dialog', className: 'dshp-panel', role: 'dialog',
            'aria-labelledby': 'dshp-title', 'aria-modal': false,
            style: { left: data.left, bottom: data.bottom },
          },
            h('header', { className: 'dshp-heading' },
              h(Tomato, { color: true, size: 17 }),
              h('h2', { id: 'dshp-title', className: 'dshp-title' }, t('title')),
              h('button', { type: 'button', className: 'dshp-minimize', 'aria-label': t('minimize'),
                title: t('minimize'), onClick: () => close(true) }, h(Icon, { name: 'minus', size: 12 }))),
            h('div', { className: 'dshp-modes', role: 'group', 'aria-label': t('title') },
              ...['focus', 'break'].map(value => h('button', {
                key: value, type: 'button', className: 'dshp-mode', 'aria-pressed': state?.mode === value,
                disabled: !state || data.pending || state.status === 'running',
                title: state?.status === 'running' ? t('switchHint') : t(value),
                onClick: () => request({ action: 'select', mode: value }),
              }, t(value)))),
            h('div', { className: 'dshp-time', role: 'timer', 'aria-live': 'off' }, data.time),
            h('div', { className: 'dshp-controls' },
              h('button', { ref: primaryRef, type: 'button', className: 'dshp-primary',
                disabled: !state || data.pending,
                onClick: () => {
                  if (action === 'start' || action === 'resume') requestNotificationPermission();
                  request({ action, ...(action === 'start' ? { mode } : {}) });
                },
              }, h(Icon, { name: icon, size: 12 }), primary),
              state && state.status !== 'idle' && h('button', {
                type: 'button', className: 'dshp-reset', title: t('reset'), 'aria-label': t('reset'),
                disabled: data.pending, onClick: () => request({ action: 'reset' }),
              }, h(Icon, { name: 'reset', size: 13 }))),
            state?.status === 'completed' && h('p', { className: 'dshp-hint' },
              t(state.mode === 'focus' ? 'finishedFocus' : 'finishedBreak')),
            state?.status === 'paused' && h('p', { className: 'dshp-hint' }, t('paused')),
            data.error && h('p', { className: 'dshp-error', role: 'alert' },
              t('error'), h('button', { type: 'button', className: 'dshp-retry',
                disabled: data.pending, onClick: () => request({ action: 'status' }) }, t('retry'))),
            !state && !data.error && h('p', { className: 'dshp-hint' }, t('syncing')),
            data.notificationPermission === 'default' && h('button', {
              className: 'dshp-notify-enable', type: 'button', onClick: requestNotificationPermission,
            }, t('notifyEnable')),
            data.notificationPermission === 'denied' && h('p', { className: 'dshp-hint' }, t('notifyDenied')),
            h('span', { className: 'dshp-sr', role: 'status', 'aria-live': 'polite' }, statusText(state)),
          ));
      }
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'local-pomodoro', order: 10, label: () => t('title'),
      }, Entry));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'local-pomodoro.window.notifications', order: 10,
      }, Panel));
      ctx.effect(() => {
        const events = new EventSource(new URL('api/local-pomodoro/events', document.baseURI));
        events.onmessage = event => {
          try { accept(JSON.parse(event.data)); } catch (error) { console.error('[pomodoro]', error); patch({ error: true }); }
        };
        events.onerror = () => { if (!disposed) patch({ error: true }); };
        const refresh = () => { if (document.visibilityState === 'visible') request({ action: 'status' }, false); };
        document.addEventListener('visibilitychange', refresh);
        request({ action: 'status' }, false);
        return () => {
          disposed = true;
          events.close();
          document.removeEventListener('visibilitychange', refresh);
          for (const controller of controllers) controller.abort();
          controllers.clear();
          listeners.clear();
        };
      });
    },
  };
}
});
