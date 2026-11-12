/**
 * The board's own vector glyphs.
 *
 * Every control glyph the board draws comes from here, so one action always
 * has one metaphor and one stroke recipe: a 16-unit viewBox, `currentColor`,
 * 1.3 stroke, round caps and joins — the same recipe the sidebar panel glyph
 * (`native-panel.tsx`) uses, which is why the board's chrome and its sidebar
 * row read as one product. Icon-only controls pass a localized `title` and an
 * accessible name at the call site; the glyph itself is always decorative.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/board/icons
 */
import type { ReactNode, ReactElement } from 'react'

/** Stroke geometry shared by every board glyph. */
const GLYPH = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** Props of one board glyph: the shared recipe plus an explicit pixel size. */
export interface BoardIconProps {
  /** Rendered square edge in CSS pixels. */
  size?: number
}

/** Render one board glyph through the shared stroke recipe. */
function Glyph({ size = 14, children }: BoardIconProps & { children: ReactNode }): ReactElement {
  return (
    <svg {...GLYPH} width={size} height={size}>
      {children}
    </svg>
  )
}

/** Dismiss a transient surface. */
export function IconClose(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Glyph>
}

export function IconAttach(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="m5.5 9 4.4-4.4a1.7 1.7 0 0 1 2.4 2.4l-5.5 5.5a2.8 2.8 0 0 1-4-4l6-6a3.2 3.2 0 0 1 4.5 4.5L8 12.4" /></Glyph>
}

/** Add: create a task, a label row, or a subtask. */
export function IconPlus(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M8 3.5v9M3.5 8h9" /></Glyph>
}

export function IconSearch(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><circle cx="6.8" cy="6.8" r="4.1" /><path d="m9.8 9.8 3.5 3.5" /></Glyph>
}

export function IconArchive(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M2.5 5.5V3h11v2.5Zm.8 0V13h9.4V5.5M6.6 8.1h2.8" /></Glyph>
}

export function IconMore(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M3.5 8h.1M7.95 8h.1M12.4 8h.1" strokeWidth="2" /></Glyph>
}

/** Open the execution's session transcript. */
export function IconFolder(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M2 5V3.5h4l1.5 1.8H14v7.2H2Z" /></Glyph>
}

/** Open the execution session transcript. */
export function IconSession(props: BoardIconProps): ReactElement {
  return (
    <Glyph {...props}>
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" />
      <path d="M5.3 6.6l1.9 1.7-1.9 1.7M8.8 10h2.4" />
    </Glyph>
  )
}

/** Switch a column to single-line cards. */
export function IconCompactRows(props: BoardIconProps): ReactElement {
  return <Glyph {...props}><path d="M3 4.5h10M3 8h10M3 11.5h10" /></Glyph>
}

/** Switch a column back to full cards. */
export function IconExpandRows(props: BoardIconProps): ReactElement {
  return (
    <Glyph {...props}>
      <rect x="2.6" y="2.6" width="10.8" height="4.4" rx="1.2" />
      <rect x="2.6" y="9" width="10.8" height="4.4" rx="1.2" />
    </Glyph>
  )
}

/** A scheduled run: the recurrence mark on a card. */
export function IconClock(props: BoardIconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 5.2V8l2 1.4" />
    </Glyph>
  )
}
