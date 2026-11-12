import * as React from 'react';
import CSS from './style.css?raw';
import DICTS from './strings.json';
import { ISLAND_WIDTH, ISLAND_HEIGHT, TREE_ASSETS, treeAssetFor, treePlacement, forestPlacements } from './artwork.js';
import { island as islandImage, grid as gridImage, treeImages } from './asset-urls.js';
function createPlugin(React) {
  const h = React.createElement;
  const { useState, useEffect, useRef, useSyncExternalStore, useId } = React;
  function Icon({ name, ...props }) {
    const paths = {
      leaf: 'M19 3C9 2 3 8 6 15c5 5 12 1 13-12ZM5 20 15 9',
      arrow: 'M5 12h14m-5-5 5 5-5 5',
      left: 'm14 6-6 6 6 6', right: 'm10 6 6 6-6 6',
      close: 'm6 6 12 12M6 18 18 6',
      room: 'M3 19h18M5 19V8l7-5 7 5v11M9 19v-6h6v6',
      refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
      lock: 'M6 10h12v10H6ZM8 10V7a4 4 0 0 1 8 0v3',
      check: 'm5 12 4 4L19 6', shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z',
    };
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className: 'tfIcon', ...props }, h('path', { d: paths[name] ?? paths.leaf }));
  }
  function Button({ children, icon, primary, ...props }) { return h('button', { type: 'button', className: 'tfButton' + (primary ? ' tfPrimary' : ''), ...props }, icon && h(Icon, { name: icon }), children); }
  function Progress({ count }) { return h('span', { className: 'tfProgress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 16, 'aria-valuenow': count }, h('span', { style: { width: Math.max(0, Math.min(count, 16)) / 16 * 100 + '%' } })); }
  function Art({ count, island = 1, positions, className = 'tfTileArt', as = 'div', children }) {
    const trees = forestPlacements(count, island, positions);
    return h(as, { className, 'aria-hidden': children ? undefined : true }, h(as, { className: className === 'tfArt' ? 'tfArtImage' : undefined },
      h('svg', { viewBox: `0 0 ${ISLAND_WIDTH} ${ISLAND_HEIGHT}`, 'aria-hidden': true },
        h('image', { href: islandImage, width: ISLAND_WIDTH, height: ISLAND_HEIGHT }),
        h('image', { href: gridImage, width: ISLAND_WIDTH, height: ISLAND_HEIGHT }),
        trees.map(p => h('g', { key: p.position, 'data-tree-kind': p.asset.id },
          h('ellipse', { cx: p.x, cy: p.y, rx: 46, ry: 12, fill: '#527849', opacity: .16 }),
          h('image', { href: treeImages[p.asset.id], x: p.left, y: p.top, width: p.width, height: p.height }))))), children);
  }
  function TreeMark({ island = 1, position = 1 }) { const asset = treeAssetFor(island, position); return h('img', { src: treeImages[asset.id], alt: '', 'data-tree-kind': asset.id }); }
  function MiniForest({ count }) {
    return h('svg', { className: 'tfMiniForest', viewBox: '0 0 132 48', 'aria-hidden': true },
      Array.from({ length: Math.min(count, 8) }, (_, i) => h('image', { key: i, href: treeImages[TREE_ASSETS[i].id], x: i * 13 - 4, y: 5 - i % 2 * 4, width: 32, height: 40 })),
      count > 8 && h('text', { x: 131, y: 39, fill: 'currentColor', fontSize: 11, textAnchor: 'end' }, '+' + (count - 8)));
  }
  function Modal({ title, close, children }) {
    const ref = useRef(null);
    const id = useId();
    useEffect(() => {
      const el = ref.current;
      const previous = document.activeElement;
      el.showModal();
      return () => { el.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    return h('dialog', { ref, 'aria-labelledby': id, onCancel: event => { event.preventDefault(); close(); }, onClick: event => { if (event.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } } },
      h('div', { className: 'tfModalHeader' }, h('h2', { id }, title), h('button', { type: 'button', onClick: close, 'aria-label': title }, h(Icon, { name: 'close' }))),
      h('div', { className: 'tfModalBody' }, children));
  }
  return {
    inject: ['taskBoard', 'slots', 'locale'],
    apply(ctx) {
      const board = ctx.get('taskBoard');
      if (!board?.registerView || !board?.registerBanner) { console.error('[task-forest] The task board needs the provider view extension.'); return; }
      const locale = ctx.get('locale');
      for (const [lang, dict] of Object.entries(DICTS)) ctx.effect(() => locale.register('task-forest', lang, dict));
      const translate = locale.bind('task-forest');
      const t = (key, args = {}) => String(translate(key)).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? ''));
      let state = { view: null, error: null, connected: true, celebration: null, toast: null };
      let stopped = false;
      let toastTimer;
      const listeners = new Set();
      const notify = () => { for (const fn of [...listeners]) fn(); };
      const patch = value => { state = { ...state, ...value }; notify(); };
      const accept = (view, initial = false) => {
        const previous = state.view?.total;
        const celebration = !initial && previous !== undefined && Math.floor(view.total / 16) > Math.floor(previous / 16) ? Math.floor(view.total / 16) : state.celebration;
        const toast = !initial && previous !== undefined && view.total > previous && !celebration ? { title: t('earned'), description: t('bannerProgress', { total: view.total, island: view.currentIsland, count: view.currentCount }) } : state.toast;
        patch({ view, error: null, connected: true, celebration, toast });
        if (toast && toast !== state.toast) clearTimeout(toastTimer);
        if (toast) { clearTimeout(toastTimer); toastTimer = setTimeout(() => patch({ toast: null }), 5000); }
      };
      const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
      async function request(input, update = true) {
        const response = await fetch('/api/task-forest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        const value = await response.json();
        if (!response.ok || value.error && value.total === undefined) throw new Error(value.error || t('loadError'));
        if (!stopped && update) accept(value);
        return value;
      }
      const reload = () => request({ action: 'status' }).catch(error => { if (!stopped) patch({ error: error.message }); });
      ctx.effect(() => {
        reload();
        const events = new EventSource('/api/task-forest/events');
        events.onmessage = event => { try { if (!stopped) accept(JSON.parse(event.data), !state.view); } catch (error) { console.error('[task-forest]', error); } };
        events.onerror = () => { if (!stopped) patch({ connected: false }); };
        return () => { stopped = true; events.close(); clearTimeout(toastTimer); listeners.clear(); };
      });
      function useForest() {
        const current = useSyncExternalStore(subscribe, () => state, () => state);
        useSyncExternalStore(locale.subscribe.bind(locale), locale.getSnapshot.bind(locale), locale.getSnapshot.bind(locale));
        return current;
      }
      const date = (value, full = false) => new Intl.DateTimeFormat(locale.getSnapshot().active, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(full ? { year: 'numeric' } : {}), timeZone: state.view?.timeZone ?? 'Asia/Shanghai' }).format(new Date(value));
      function Root({ children, className = '' }) { return h('div', { className: 'tfRoot ' + className, 'data-dsh-plugin': 'task-forest' }, h('style', null, CSS), children); }
      function Loading() { const s = useForest(); return h('div', { className: 'tfLoad', role: 'status' }, s.error ? h(React.Fragment, null, h('p', null, t('loadError')), h('p', { className: 'tfError' }, s.error), h(Button, { onClick: reload }, t('retry'))) : t('loading')); }
      function RoomDialog({ close }) {
        const { view } = useForest();
        const room = view.room;
        const [nickname, setNickname] = useState(view.identity.nickname);
        const [roomName, setRoomName] = useState(t('roomDefault'));
        const [invite, setInvite] = useState('');
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState('');
        const [notice, setNotice] = useState('');
        const [confirm, setConfirm] = useState(false);
        const nameId = useId(), roomId = useId(), inviteId = useId();
        async function act(input, done) { setBusy(true); setError(''); setNotice(''); try { await request(input); setNotice(t('saved')); done?.(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
        const field = (label, id, input) => h('div', { className: 'tfField' }, h('label', { htmlFor: id }, label), input);
        return h(Modal, { title: t('roomTitle'), close: busy ? () => {} : close },
          h('form', { onSubmit: event => { event.preventDefault(); act({ action: 'profile', nickname: nickname.trim() }); } }, field(t('nickname'), nameId, h('div', { className: 'tfInputRow' }, h('input', { id: nameId, className: 'tfInput', value: nickname, maxLength: 32, required: true, onChange: e => setNickname(e.target.value), disabled: busy }), h(Button, { type: 'submit', disabled: busy || !nickname.trim() }, t('saveProfile'))))),
          h('div', { className: 'tfFormDivider' }),
          room.mode === 'none' ? h(React.Fragment, null,
            h('form', { onSubmit: event => { event.preventDefault(); act({ action: 'room-create', roomName: roomName.trim() }); } }, field(t('roomName'), roomId, h('div', { className: 'tfInputRow' }, h('input', { id: roomId, className: 'tfInput', value: roomName, maxLength: 32, required: true, onChange: e => setRoomName(e.target.value), disabled: busy }), h(Button, { type: 'submit', primary: true, disabled: busy || !roomName.trim() }, t('create'))))),
            h('form', { onSubmit: event => { event.preventDefault(); act({ action: 'room-join', invite: invite.trim() }); } }, field(t('invite'), inviteId, h('textarea', { id: inviteId, className: 'tfInput', value: invite, rows: 3, maxLength: 1024, placeholder: t('invitePlaceholder'), onChange: e => setInvite(e.target.value), disabled: busy, spellCheck: false })), h(Button, { type: 'submit', disabled: busy || !invite.trim() }, t('join'))), h('p', { className: 'tfHelp' }, t('joinHint')))
          : h(React.Fragment, null,
            h('div', { className: 'tfSectionTitle' }, room.name, h('span', { className: 'tfPill' }, t(room.status === 'connected' || room.mode === 'host' ? 'connected' : 'offline'))),
            room.invite && field(t('invite'), inviteId, h('textarea', { id: inviteId, className: 'tfInput', value: room.invite, readOnly: true, rows: 3, onFocus: e => e.target.select(), spellCheck: false })),
            room.invite && h(Button, { icon: 'room', disabled: busy, onClick: async () => { try { await navigator.clipboard.writeText(room.invite); setNotice(t('copied')); } catch { setNotice(t('copyFail')); } } }, t('copy')),
            h('p', { className: 'tfHelp' }, t(room.mode === 'host' ? 'hostHint' : 'joinHint')),
            h('div', { className: 'tfFormDivider' }),
            h('p', { className: 'tfHelp' }, t(room.mode === 'host' ? 'closeHint' : 'leaveHint')),
            confirm ? h('div', { className: 'tfDialogActions' }, h(Button, { disabled: busy, onClick: () => setConfirm(false) }, t('cancel')), h(Button, { disabled: busy, onClick: () => act({ action: 'room-leave' }, () => setConfirm(false)) }, t(room.mode === 'host' ? 'confirmClose' : 'confirm'))) : h(Button, { disabled: busy, onClick: () => setConfirm(true) }, t(room.mode === 'host' ? 'closeRoom' : 'leave'))),
          h('p', { className: 'tfHelp' }, t('privacy')),
          error && h('p', { className: 'tfError', role: 'alert' }, error),
          notice && h('p', { className: 'tfNotice', role: 'status' }, notice),
          h('div', { className: 'tfDialogActions' }, h(Button, { disabled: busy, onClick: close }, t(busy ? 'saving' : 'close'))));
      }
      function RewardDialog({ reward, close, openTask }) {
        const [taskExists, setTaskExists] = useState(null);
        const [sourceError, setSourceError] = useState(false);
        const [attempt, setAttempt] = useState(0);
        useEffect(() => {
          let active = true;
          setTaskExists(null); setSourceError(false);
          // This read action refreshes the board mirror through its own channel.
          // A stale browser snapshot cannot establish that a source was deleted.
          board.dispatch({ extensionId: 'task-forest', action: 'status' }).then(ok => {
            if (!active) return;
            if (!ok) { setSourceError(true); return; }
            setTaskExists(board.snapshot().tasks.some(task => task.id === reward.taskId));
          }, () => { if (active) setSourceError(true); });
          return () => { active = false; };
        }, [reward.taskId, attempt]);
        return h(Modal, { title: t('record'), close }, h('div', { className: 'tfRecord' }, h(Art, { count: 1, island: reward.island, positions: [reward.position] }), h('h3', null, reward.title), h('dl', null, h('dt', null, t('time')), h('dd', null, date(reward.completedAt, true)), h('dt', null, t('island', { n: String(reward.island).padStart(2, '0') })), h('dd', null, t('earnedPlace', { island: reward.island, position: reward.position }))), taskExists === null && !sourceError && h('p', { className: 'tfHelp', role: 'status' }, t('loading')), taskExists === false && h('p', { className: 'tfHelp' }, t('removed')), sourceError && h('p', { className: 'tfError', role: 'alert' }, t('loadError')), h('div', { className: 'tfDialogActions' }, sourceError && h(Button, { onClick: () => setAttempt(value => value + 1) }, t('retry')), h(Button, { onClick: close }, t('close')), taskExists === true && h(Button, { primary: true, onClick: () => { close(); openTask(reward.taskId); } }, t('viewTask')))));
      }
      function Notifications({ navigate, onIsland }) {
        const s = useForest();
        return h(React.Fragment, null,
          s.toast && h('div', { className: 'tfToast', role: 'status' }, h('strong', null, s.toast.title), h('p', null, s.toast.description)),
          s.celebration && h(Modal, { title: t('celebrate', { n: s.celebration }), close: () => patch({ celebration: null }) }, h('div', { className: 'tfCelebration' }, h(Art, { count: 16, island: s.celebration }), h('h3', null, t('celebrate', { n: s.celebration })), h('p', null, t('celebrateHint')), h('div', { className: 'tfDialogActions' }, h(Button, { onClick: () => { const n = s.celebration; patch({ celebration: null }); onIsland?.(n); navigate?.('task-forest.forest'); } }, t('stay')), h(Button, { primary: true, onClick: () => { patch({ celebration: null }); onIsland?.(s.view.currentIsland); navigate?.('task-forest.forest'); } }, t('continue'))))));
      }
      function Forest({ openTask, navigate }) {
        const s = useForest();
        const [selected, setSelected] = useState(null);
        const [islandData, setIslandData] = useState(null);
        const [islandError, setIslandError] = useState('');
        const [roomOpen, setRoomOpen] = useState(false);
        const [reward, setReward] = useState(null);
        const view = s.view;
        const island = selected ?? view?.currentIsland ?? 1;
        useEffect(() => {
          if (!view) return;
          let valid = true;
          setIslandError('');
          request({ action: 'island', island }, false).then(value => { if (valid) setIslandData(value.island); }, error => { if (valid) setIslandError(error.message); });
          return () => { valid = false; };
        }, [island, view?.revision, view?.total]);
        if (!view) return h(Root, { className: 'tfPage' }, h(Loading));
        const count = Math.min(16, Math.max(0, view.total - (island - 1) * 16));
        const rewards = islandData?.island === island ? islandData.rewards : [];
        const firstTile = Math.max(1, Math.min(island - 2, view.currentIsland - 4));
        const tiles = Array.from({ length: Math.min(view.currentIsland, 6) }, (_, i) => firstTile + i).filter(n => n <= view.currentIsland);
        return h(Root, { className: 'tfPage tfPageEnter' }, h('div', { className: 'tfWrap' },
          h('header', { className: 'tfHeading' }, h('div', null, h('div', { className: 'tfEyebrow' }, t('eyebrow')), h('h1', null, t('headline')), h('p', null, t('intro'))), h('div', { className: 'tfActions' }, h(Button, { icon: 'room', onClick: () => setRoomOpen(true) }, t(view.room.mode === 'none' ? 'notJoined' : 'manage')), h(Button, { onClick: () => navigate('task-forest.ranking') }, t('ranking'), h(Icon, { name: 'arrow' })))),
          !s.connected && h('p', { className: 'tfConnection', role: 'status' }, t('connectionLost')),
          view.error && h('p', { className: 'tfError', role: 'alert' }, view.error),
          h('div', { className: 'tfStats' }, [['total', view.total, 'trees'], ['islands', view.completedIslands], ['today', view.counts.day, 'trees']].map(([key, value, unit]) => h('div', { className: 'tfStat', key }, h('span', null, t(key)), h('strong', null, value, unit && h('small', null, t(unit)))))),
          h('div', { className: 'tfMainGrid' }, h('div', null,
            h('section', { className: 'tfIslandStage' }, h('div', { className: 'tfStageTop' }, h('h2', null, t('island', { n: String(island).padStart(2, '0') })), h('span', { className: 'tfPill' }, h('i', { className: 'tfDot' }), t(count === 16 ? 'complete' : 'current'))),
              h(Art, { count, island, className: 'tfArt' }, h('svg', { className: 'tfArtHits', viewBox: `0 0 ${ISLAND_WIDTH} ${ISLAND_HEIGHT}`, role: 'group', 'aria-label': t('island', { n: island }) }, rewards.map(r => {
                const p = treePlacement(island, r.position);
                return h('ellipse', { className: 'tfTreeHit', key: r.id, cx: p.x, cy: p.y - p.height * .4, rx: p.width * .35, ry: p.height * .4, tabIndex: 0, role: 'button', 'aria-label': t('treeLabel', { n: r.position, title: r.title }), onClick: () => setReward(r), onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setReward(r); } } });
              }))),
              h('div', { className: 'tfStageBottom' }, h('div', { className: 'tfProgressInfo' }, h('strong', null, t(view.total === 0 ? 'first' : 'progress', { n: count })), h(Progress, { count }), h('p', null, t(count === 16 ? 'islandDone' : view.total === 0 ? 'firstHint' : 'remaining', { n: 16 - count })), islandError && h('p', { className: 'tfError', role: 'alert' }, islandError)), h('div', { className: 'tfIslandNav' }, h(Button, { icon: 'left', 'aria-label': t('previous'), disabled: island <= 1, onClick: () => setSelected(island - 1) }), h(Button, { icon: 'right', 'aria-label': t('next'), disabled: island >= view.currentIsland, onClick: () => setSelected(island + 1) })))),
            h('section', { className: 'tfCollection' }, h('div', { className: 'tfCollectionHead' }, h('h2', null, t('collection')), h(Button, { onClick: () => navigate('board') }, t('goBoard'))), h('div', { className: 'tfCollectionItems' }, tiles.map(n => { const c = Math.max(0, Math.min(16, view.total - (n - 1) * 16)); return h('button', { type: 'button', className: 'tfIslandTile', 'aria-current': n === island, key: n, onClick: () => setSelected(n) }, h(Art, { count: c, island: n }), h('strong', null, t('island', { n: String(n).padStart(2, '0') })), h('small', null, `${c} / 16 · ${t(c === 16 ? 'complete' : 'current')}`)); }), h('button', { type: 'button', className: 'tfIslandTile', disabled: true }, h('div', { className: 'tfLocked' }, h(Icon, { name: 'lock' })), h('strong', null, t('locked')), h('small', null, t('unlock')))))),
            h('aside', { className: 'tfAside' }, h('h2', { className: 'tfSectionTitle' }, t('recent'), h(Icon, { name: 'leaf' })), h('p', { className: 'tfAsideIntro' }, t('recentHint')), h('div', { className: 'tfRecentList' }, view.recent.length ? view.recent.slice(0, 5).map(r => h('button', { type: 'button', className: 'tfRecent', key: r.id, onClick: () => setReward(r), title: t('source') }, h('span', { className: 'tfRecentMark' }, h(TreeMark, { island: r.island, position: r.position })), h('span', null, h('span', { className: 'tfRecentTitle' }, r.title), h('span', { className: 'tfRecentMeta' }, date(r.completedAt), h('br'), t('earnedPlace', { island: r.island, position: r.position }))))) : h('p', { className: 'tfEmpty' }, t('emptyRecent'))), h('div', { className: 'tfRule' }, h('strong', null, t('rule')), h('p', null, t('ruleHint'))))),
          roomOpen && h(RoomDialog, { close: () => setRoomOpen(false) }), reward && h(RewardDialog, { reward, close: () => setReward(null), openTask }), h(Notifications, { navigate, onIsland: setSelected })));
      }
      function Ranking({ navigate }) {
        const s = useForest();
        const [period, setPeriod] = useState('day');
        const [roomOpen, setRoomOpen] = useState(false);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState('');
        const view = s.view;
        if (!view) return h(Root, { className: 'tfPage' }, h(Loading));
        const room = view.room;
        const local = { ...view.identity, counts: view.counts, total: view.total, online: true };
        const members = [...(room.mode === 'none' ? [local] : room.members)];
        if (!members.some(m => m.id === local.id)) members.push(local);
        members.sort((a, b) => (b.counts?.[period] ?? 0) - (a.counts?.[period] ?? 0) || a.nickname.localeCompare(b.nickname));
        let rank = 0, previous = -1;
        const rows = members.map((member, i) => { const count = member.counts?.[period] ?? 0; if (count !== previous) rank = i + 1; previous = count; return { ...member, count, rank }; });
        async function refresh() { setBusy(true); setError(''); try { await request({ action: 'room-refresh' }); } catch (e) { setError(e.message); } finally { setBusy(false); } }
        return h(Root, { className: 'tfPage tfPageEnter' }, h('div', { className: 'tfWrap' },
          h('header', { className: 'tfHeading' }, h('div', null, h('div', { className: 'tfEyebrow' }, t('rankEyebrow')), h('h1', null, t('rankTitle')), h('p', null, t('rankIntro'))), h('div', { className: 'tfActions' }, room.mode !== 'none' && h('span', { className: 'tfPill' }, h('i', { className: 'tfDot' }), room.name), h(Button, { icon: 'room', onClick: () => setRoomOpen(true) }, t(room.mode === 'none' ? 'create' : 'manage')))),
          room.mode === 'none' && h('div', { className: 'tfRoomWelcome' }, h(Icon, { name: 'room' }), h('div', null, h('strong', null, t('roomEmpty')), h('p', null, t('roomHint'))), h('div', { className: 'tfActions' }, h(Button, { primary: true, onClick: () => setRoomOpen(true) }, t('create')), h(Button, { onClick: () => setRoomOpen(true) }, t('join')))),
          !s.connected && h('p', { className: 'tfConnection' }, t('connectionLost')),
          (error || room.error) && h('p', { className: 'tfError', role: 'alert' }, error || room.error),
          h('div', { className: 'tfRankingGrid' }, h('section', null, h('div', { className: 'tfRankToolbar' }, h('div', { className: 'tfSegments', role: 'group', 'aria-label': t('ranking') }, ['day', 'week', 'month'].map(p => h('button', { type: 'button', key: p, 'aria-pressed': p === period, onClick: () => setPeriod(p) }, t(p)))), h('span', { className: 'tfSync' }, room.lastSyncAt ? t('syncTime', { time: date(room.lastSyncAt) }) : t('allLocal')), room.mode !== 'none' && h(Button, { icon: 'refresh', disabled: busy, onClick: refresh, 'aria-label': t('refresh') })),
            h('div', { className: 'tfTableWrap' }, h('table', { className: 'tfRankTable' }, h('thead', null, h('tr', null, ['rank', 'companion', 'planted', 'smallForest'].map(k => h('th', { key: k, scope: 'col' }, t(k))))), h('tbody', null, rows.map(member => h('tr', { key: member.id, 'data-me': member.id === view.identity.id }, h('td', null, h('span', { className: 'tfRankNumber' }, String(member.rank).padStart(2, '0'))), h('td', null, h('div', { className: 'tfPerson' }, h('span', { className: 'tfAvatar', 'aria-hidden': true }, Array.from(member.nickname).slice(0, 2).join('')), h('div', { style: { minWidth: 0 } }, h('div', { className: 'tfPersonName' }, h('span', { title: member.nickname }, member.nickname), member.id === view.identity.id && h('span', { className: 'tfMe' }, t('me'))), h('small', null, t(member.online ? 'online' : 'offline'))))), h('td', null, h('span', { className: 'tfCount' }, member.count, h('small', null, t('trees')))), h('td', null, h(MiniForest, { count: member.count }))))))),
            h('p', { className: 'tfRankFoot' }, t('rankRule'), ' ', room.timeZone ?? view.timeZone, h('br'), t('privacy'))),
            h('aside', { className: 'tfAside tfMyProgress' }, h('h2', { className: 'tfSectionTitle' }, t('myProgress')), h('div', { className: 'tfBigCount' }, view.total, h('small', null, t('trees'))), h('p', null, t('island', { n: String(view.currentIsland).padStart(2, '0') })), h(Art, { count: view.currentCount, island: view.currentIsland }), h(Progress, { count: view.currentCount }), h('div', { className: 'tfProgressCaption' }, h('span', null, `${view.currentCount} / 16`), h('span', null, t('current'))), h('p', { className: 'tfEncouragement' }, t('encouragement')), h(Button, { style: { marginTop: 17 }, onClick: () => navigate('task-forest.forest') }, t('forest'), h(Icon, { name: 'arrow' })))),
          roomOpen && h(RoomDialog, { close: () => setRoomOpen(false) }), h(Notifications, { navigate })));
      }
      function Banner({ navigate } = {}) {
        const { view } = useForest();
        const progress = view && t('bannerProgress', { total: view.total, island: view.currentIsland, count: view.currentCount });
        return h(Root, null,
          navigate && h('button', {
            type: 'button',
            className: 'tfBanner',
            'aria-label': [t('bannerLink'), progress].filter(Boolean).join(' · '),
            title: progress ?? t('bannerLink'),
            onClick: () => navigate('task-forest.forest'),
          },
          h(Art, { count: view?.currentCount ?? 0, island: view?.currentIsland ?? 1, className: 'tfBannerArt', as: 'span' }),
          view && h(React.Fragment, null,
            h('strong', { className: 'tfBannerIsland' }, t('island', { n: view.currentIsland })),
            h('span', { className: 'tfBannerCount' }, `${view.currentCount} / 16`),
            h(Progress, { count: view.currentCount })),
          h(Icon, { name: 'right' })),
          h(Notifications, { navigate }));
      }
      function CardDecoration({ task }) { useForest(); const reward = task.integrations?.['task-forest']; if (!reward?.rewarded) return null; return h(Root, null, h('span', { className: 'tfBadge', title: t('earnedPlace', { island: reward.island, position: reward.position }) }, h(Icon, { name: 'leaf', width: 12, height: 12 }), t('earned'))); }
      function TaskDetail({ task }) {
        useForest();
        const reward = task.integrations?.['task-forest'];
        return h(Root, null, h('details', { className: 'tfDetail' },
          h('summary', null, t('forest'), reward?.rewarded && h('span', { className: 'tfBadge' }, t('earned'))),
          h('p', null, reward?.rewarded ? t('earnedPlace', { island: reward.island, position: reward.position }) : t(task.parentId ? 'childRule' : 'pendingRule')),
          h('p', null, t('ruleHint'))));
      }
      ctx.effect(() => board.registerView({ id: 'task-forest.forest', label: () => t('forest'), render: Forest, order: 20 }));
      ctx.effect(() => board.registerView({ id: 'task-forest.ranking', label: () => t('ranking'), render: Ranking, order: 30 }));
      ctx.effect(() => board.registerBanner(Banner));
      for (const [name, Component] of [['task-board.card.decoration', CardDecoration], ['task-board.detail.section', TaskDetail]]) ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'task-forest', order: 20 }, Component));
    },
  };
}

const plugin = createPlugin(React);
export const inject = plugin.inject;
export const apply = plugin.apply;
