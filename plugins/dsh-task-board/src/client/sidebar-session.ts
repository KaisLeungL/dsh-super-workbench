/** Reveal the row after the workspace sidebar commits the new selection. */
export function revealSidebarSession(sessionId: string): () => void {
  const sidebar = document.querySelector('[data-slot="sidebar.workspaces"]')
  if (sidebar === null) return () => {}

  let frame: number | undefined
  const rowKey = `session:${sessionId}`
  const reveal = (): void => {
    frame = undefined
    const selectedRows = sidebar.querySelectorAll<HTMLElement>('[role="treeitem"][aria-selected="true"][data-row-key]')
    for (const row of selectedRows) {
      if (row.dataset.rowKey !== rowKey || row.closest('[inert]') !== null) continue
      dispose()
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
  }
  const schedule = (): void => {
    frame ??= window.requestAnimationFrame(reveal)
  }
  // Navigation can select an existing row or cause the host to mount it.
  const observer = new MutationObserver(schedule)
  observer.observe(sidebar, { childList: true, subtree: true, attributeFilter: ['aria-selected'] })
  const timeout = window.setTimeout(dispose, 2000)
  schedule()
  return dispose

  function dispose(): void {
    observer.disconnect()
    window.clearTimeout(timeout)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
  }
}
