/**
 * The team channel: the WebSocket the hub pushes events over.
 *
 * Both halves of the transport live here rather than in the sync service: the
 * URL is derived from the configured hub (http becomes ws), and one socket is
 * a thin wrapper over whatever the deployment's WebSocket constructor is. The
 * reconnect policy stays with the service, because only it knows whether a
 * dropped connection is a lease-ending outage or a quiet restart.
 *
 * @module dsh-task-board-team/host/channel
 */

/** One open socket, as the service drives it. */
export interface SocketLike {
  /** Send one text frame. */
  send(data: string): void
  /** Close the connection; a later close event is not reported again. */
  close(): void
}

/** What one socket reports back. */
export interface SocketHandlers {
  /** One decoded text frame. */
  message(data: string): void
  /** The connection ended; the service decides whether to reconnect. */
  closed(reason?: string): void
}

/** Open one socket at `url`, presenting `headers` on the upgrade, and wire its handlers. */
export type ConnectSocket = (url: string, handlers: SocketHandlers, headers: Record<string, string>) => SocketLike

/**
 * Derive the team channel URL for one hub. The Host Token never travels in the
 * URL; it rides the upgrade's Authorization header (see {@link teamSocketHeaders}).
 * @param hubUrl - configured hub base URL (http/https or ws/wss).
 * @param teamId - team the channel belongs to.
 * @param sinceSeq - last event sequence this Host saw; 0 asks for a full replay.
 * @returns the absolute WebSocket URL.
 */
export function teamSocketUrl(hubUrl: string, teamId: string, sinceSeq: number): string {
  const base = hubUrl.trim().replace(/\/+$/, '')
  const socketBase = base.replace(/^http(s?):\/\//i, 'ws$1://')
  const path = '/api/v1/teams/' + encodeURIComponent(teamId) + '/ws'
  const query = '?since_seq=' + String(Math.max(0, Math.floor(sinceSeq)))
    + '&protocol_version=' + encodeURIComponent('1.0.0')
  return socketBase + path + query
}

/**
 * The upgrade headers the hub authenticates a Host channel with.
 * @param token - Host Token the handshake presents.
 * @returns the Authorization and protocol version headers.
 */
export function teamSocketHeaders(token: string): Record<string, string> {
  return { Authorization: 'Bearer ' + token, 'X-Team-Hub-Protocol-Version': '1.0.0' }
}

/** The platform constructor with the init form the Host runtime accepts (headers on the upgrade). */
type HeaderedWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket

/** The default socket factory: the platform WebSocket, with the headers on the upgrade. */
export const platformSocket: ConnectSocket = (url, handlers, headers) => {
  const socket = new (WebSocket as unknown as HeaderedWebSocket)(url, { headers })
  let closed = false
  socket.addEventListener('message', event => {
    const data = (event as { data?: unknown }).data
    if (typeof data === 'string') handlers.message(data)
  })
  socket.addEventListener('close', event => {
    if (closed) return
    closed = true
    handlers.closed((event as { reason?: string }).reason)
  })
  socket.addEventListener('error', () => {
    // A transport error is always followed by a close event on this platform;
    // reporting it here as well would schedule two reconnects for one failure.
  })
  return {
    send(data) {
      if (closed) return
      try {
        socket.send(data)
      } catch {
        // A send racing a close is not a decision this layer makes.
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        socket.close()
      } catch {
        // Already gone.
      }
    },
  }
}
