import * as React from 'react';

/**
 * 个人面板与顶栏共用的线性图标。
 * 统一 24 网格、1.5 描边、圆端点，随 currentColor 着色；
 * 尺寸由调用处传入，避免在 CSS 里用字号模拟图标。
 */
export type IconName =
  | 'panel' | 'back' | 'plus' | 'chevron-down' | 'chevron-right'
  | 'clock' | 'calendar' | 'route' | 'check' | 'close'
  | 'board' | 'link' | 'edit' | 'refresh';

const paths: Record<IconName, React.ReactNode> = {
  panel: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M15 4.5v15" /></>,
  back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  clock: <><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5V12l3 1.8" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>,
  route: <><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M8.4 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.6" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  board: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9h17M9.5 9v10.5" /></>,
  link: <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  edit: <><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 5v5h-5" /></>,
};

export function Icon({ name, size = 16, strokeWidth = 1.5, className }: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): React.ReactElement {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
