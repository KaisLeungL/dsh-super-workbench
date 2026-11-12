/** Browser-only provider views; the board still owns task selection and lifecycle. */
import { Component, createElement, useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { BoardController } from '../core/controller.ts'
import type { TaskBoardProviderView, TaskBoardProviderViewProps } from '../core/extension.ts'
import type { TaskBoardClientService } from './service.ts'
import { t } from './locales.ts'
import css from './provider-views.module.css'

/** Keep a broken contribution from removing the board or its navigation. */
class ContributionBoundary extends Component<{
  source: unknown
  children: ReactNode
  fallback?: ReactNode
}, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown): void {
    console.error('[dsh-task-board] provider component failed', error)
  }
  componentDidUpdate(previous: Readonly<{ source: unknown }>): void {
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false })
  }
  render(): ReactNode { return this.state.failed ? (this.props.fallback ?? null) : this.props.children }
}

function viewLabel(view: TaskBoardProviderView): string {
  try { return view.label() } catch (error) {
    console.error('[dsh-task-board] provider view label failed', error)
    return view.id
  }
}

/** A small content-level switcher, without duplicating the board's own header. */
export function ProviderViews({ controller, service, children }: {
  controller: BoardController
  service: TaskBoardClientService
  children: ReactNode
}): ReactNode {
  const views = useSyncExternalStore(service.subscribeViews, service.getViews, service.getViews)
  const banners = useSyncExternalStore(service.subscribeViews, service.getBanners, service.getBanners)
  const [selected, setSelected] = useState('board')
  const prefix = useId()
  const active = selected === 'board' || views.some(view => view.id === selected) ? selected : 'board'
  // A removed id must not become selected again if the provider registers later.
  useEffect(() => { if (active !== selected) setSelected('board') }, [active, selected])
  const navigate = useCallback((id: string): void => {
    if (id === 'board' || service.getViews().some(view => view.id === id)) setSelected(id)
  }, [service])
  const openTask = useCallback((id: string): void => {
    setSelected('board')
    controller.openTask(id)
  }, [controller])
  const props: TaskBoardProviderViewProps = { openTask, navigate }
  const view = views.find(entry => entry.id === active)
  const ids = ['board', ...views.map(entry => entry.id)]
  const showBanners = active === 'board' && banners.length > 0
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index === -1) return
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % ids.length; break
      case 'ArrowLeft': next = (index - 1 + ids.length) % ids.length; break
      case 'Home': next = 0; break
      case 'End': next = ids.length - 1; break
      default: return
    }
    event.preventDefault()
    navigate(ids[next]!)
    tabs[next]?.focus()
  }

  return (
    <div className={css.root}>
      {(views.length > 0 || showBanners) && (
        <div className={css.navigation}>
          {views.length > 0 && (
            <div className={css.tabs} role="tablist" aria-label={t('board.title')} onKeyDown={onTabKeyDown}>
              {ids.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  className={css.tab}
                  role="tab"
                  id={`${prefix}-tab-${index}`}
                  aria-controls={`${prefix}-panel-${index}`}
                  aria-selected={active === id}
                  tabIndex={active === id ? 0 : -1}
                  onClick={() => navigate(id)}
                >
                  {id === 'board' ? t('board.tab') : viewLabel(views[index - 1]!)}
                </button>
              ))}
            </div>
          )}
          {showBanners && (
            <div className={css.banners}>
              {banners.map(banner => (
                <ContributionBoundary key={banner.id} source={banner}>
                  {createElement(banner.component, { navigate })}
                </ContributionBoundary>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className={css.boardPane}
        hidden={active !== 'board'}
        role={views.length > 0 ? 'tabpanel' : undefined}
        id={`${prefix}-panel-0`}
        aria-labelledby={views.length > 0 ? `${prefix}-tab-0` : undefined}
      >
        {active === 'board' && children}
      </div>
      {views.map((entry, index) => (
        <div key={entry.id} className={css.providerPane} role="tabpanel" hidden={entry !== view} id={`${prefix}-panel-${index + 1}`} aria-labelledby={`${prefix}-tab-${index + 1}`}>
          {entry === view && (
            <ContributionBoundary source={entry} fallback={(
              <button type="button" className={css.tab} onClick={() => navigate('board')}>{t('board.backToBoard')}</button>
            )}>
              {createElement(entry.render, props)}
            </ContributionBoundary>
          )}
        </div>
      ))}
    </div>
  )
}
