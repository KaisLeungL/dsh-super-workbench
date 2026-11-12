import * as React from 'react';
import fishIcon from './assets/super-fat-fish.png';

const styles = `
[data-wsa-bot-row]{padding-inline-end:38px}
[data-wsa-bot-row="expanded"]{
  min-height:136px;flex-direction:column;justify-content:center;gap:4px;padding:10px 36px;
  background-color:var(--dsw-alias-interactive-bg-hover);
}
[data-wsa-bot-row="expanded"] .wsa-bot-icon{width:82px;height:82px}
[data-wsa-bot-row="expanded"] > span:last-child{font-weight:600;text-align:center}
[data-wsa-bot-entry] > button:not(:first-child):not(.wsa-bot-toggle){right:34px;top:50%;transform:translateY(-50%)}
[data-wsa-bot-entry="expanded"] > button:not(:first-child):not(.wsa-bot-toggle){right:auto;left:4px;top:4px;transform:none}
.wsa-bot-toggle-anchor{position:relative;height:0;margin-top:-2px;flex:none}
.wsa-bot-toggle-anchor > .wsa-bot-toggle{top:auto;bottom:2px;transform:none}
[data-wsa-bot-row="expanded"] + .wsa-bot-toggle-anchor > .wsa-bot-toggle{bottom:103px}
.wsa-bot-toggle{
  position:absolute;inset-inline-end:4px;top:50%;transform:translateY(-50%);
  width:28px;height:28px;display:grid;place-items:center;padding:0;border:0;
  border-radius:var(--dsw-radius-sm,6px);background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;
}
[data-wsa-bot-entry="expanded"] > .wsa-bot-toggle{top:5px;transform:none}
.wsa-bot-toggle:hover{color:var(--dsw-alias-label-primary)}
.wsa-bot-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #4d6bfe);outline-offset:-2px}
.wsa-bot-toggle::after{content:'';width:7px;height:7px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:translateY(-2px) rotate(45deg)}
.wsa-bot-toggle[aria-expanded="true"]::after{transform:translateY(2px) rotate(225deg)}
.wsa-bot-icon{display:block;object-fit:contain}
`;

export function createSidebarBot() {
  let expanded = true;
  return function SidebarBot({ size = 16 }: { size?: number }) {
    const icon = React.useRef<HTMLImageElement>(null);
    React.useLayoutEffect(() => {
      const row = icon.current?.closest('button');
      const entry = row?.parentElement;
      // 图标槽也会出现在「更多」和窄轨。只扩展带文字的一级导航行。
      if (!row || !entry || row.childElementCount !== 2) return;
      const direct = entry.tagName === 'NAV';
      if (!direct && (entry.parentElement?.tagName !== 'NAV' || entry.firstElementChild !== row)) return;

      const toggle = row.ownerDocument.createElement('button');
      const anchor = direct ? row.ownerDocument.createElement('div') : null;
      if (anchor) {
        anchor.className = 'wsa-bot-toggle-anchor';
        anchor.append(toggle);
      }
      toggle.type = 'button';
      toggle.className = 'wsa-bot-toggle';
      const update = () => {
        const state = expanded ? 'expanded' : 'collapsed';
        row.dataset.wsaBotRow = state;
        if (!direct) entry.dataset.wsaBotEntry = state;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', expanded ? '收起超级大肥鱼' : '展开超级大肥鱼');
        toggle.title = expanded ? '收起' : '展开';
      };
      toggle.onclick = () => { expanded = !expanded; update(); };
      update();
      row.after(anchor ?? toggle);
      return () => {
        (anchor ?? toggle).remove();
        delete row.dataset.wsaBotRow;
        if (!direct) delete entry.dataset.wsaBotEntry;
      };
    }, []);
    return <img ref={icon} className="wsa-bot-icon" src={fishIcon} alt="" width={size} height={size} draggable={false} />;
  };
}

export function installSidebarBotStyles() {
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
  return () => style.remove();
}
