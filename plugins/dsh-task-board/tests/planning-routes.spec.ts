import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTaskBoardRoutes, type TaskBoardConnectionTrust } from '../src/host-routes.ts'
import type { TaskBoardHostService } from '../src/host-service.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
async function server(connection?: TaskBoardConnectionTrust) {
  const apply = vi.fn(async () => ({ tasks: [] }))
  const routes = makeTaskBoardRoutes({ applyVerified: apply } as unknown as TaskBoardHostService, { connection: () => connection })
  const http = createServer((req, res) => { void routes.find(route => route.path === '/api/task-board/action')!.handler(req, res) })
  servers.push(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('test did not bind')
  return { apply, url: 'http://127.0.0.1:' + address.port + '/api/task-board/action' }
}
const envelope = { schemaVersion: 8, capabilities: ['planning.v1', 'human-review.v1', 'inspection-control.v1'], requestId: 'proposal', initiator: 'human', action: { kind: 'planning', taskId: 'proposal', decision: 'accept', fingerprint: 'v1' } }
describe('authenticated human planning route', () => {
  it('operator cannot approve with forged initiator or browser markers without signed Host authority', async () => {
    // Given only the local loopback fence.
    const host = await server()
    // When a caller supplies human and browser-looking headers, even a cookie.
    const response = await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: 'dsh-auth-test=forged' }, body: JSON.stringify(envelope) })
    // Then no authority is forwarded to the service.
    expect(response.status).toBe(403)
    expect(host.apply).not.toHaveBeenCalled()
  })

  it('operator cannot approve with a cookie rejected by the Host connection', async () => {
    // Given a Host verifier that rejects the credential.
    const verify = vi.fn(() => 401 as const)
    const host = await server({ requestRejection: verify })
    // When a loopback caller supplies a fabricated credential.
    const response = await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: 'dsh-auth-test=forged' }, body: JSON.stringify(envelope) })
    // Then the loopback fallback never grants approval authority.
    expect(response.status).toBe(403)
    expect(verify).toHaveBeenCalled()
    expect(host.apply).not.toHaveBeenCalled()
  })

  it('operator must present the Host browser credential even through another admitted authentication path', async () => {
    // Given an admitted connection with no browser session cookie.
    const host = await server({ requestRejection: () => undefined })
    // When the action reaches the ordinary route guard.
    const response = await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(envelope) })
    // Then it still lacks human UI authority.
    expect(response.status).toBe(403)
    expect(host.apply).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'planning', taskId: 'proposal', decision: 'accept', fingerprint: 'v1' },
    { kind: 'accept-review', taskId: 'proposal', executionId: 'run' },
    { kind: 'reconcile-uncertain', taskId: 'proposal', executionId: 'run' },
  ])('operator cannot grant human authority with an admitted API Peer for $kind', async action => {
    // Given an API credential admitted by the Host under the same cookie name.
    const host = await server({ requestRejection: () => undefined, browserPeer: {}, admit: () => ({ peer: {} }) })
    // When that distinct Peer submits a human-only decision.
    const response = await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'dsh-auth-test=api-v2' }, body: JSON.stringify({ ...envelope, action }) })
    // Then no artificial human authority reaches the ledger.
    expect(response.status).toBe(403)
    expect(host.apply).not.toHaveBeenCalled()
  })

  it('operator approves through the UI only after Host browser credential validation', async () => {
    // Given a signed-browser verifier (the SDK verification is a test seam).
    const verify = vi.fn(request => request.headers.cookie === 'dsh-auth-test=verified' ? undefined : 401 as const)
    const browserPeer = {}
    const host = await server({ requestRejection: verify, browserPeer, admit: request => verify(request) === undefined ? { peer: browserPeer } : { rejection: 401 } })
    // When the verified browser submits the current evidence fingerprint.
    const response = await fetch(host.url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'dsh-auth-test=verified' }, body: JSON.stringify(envelope) })
    // Then the route forwards explicit authority separately from the actor string.
    expect(response.status).toBe(200)
    expect(host.apply).toHaveBeenCalledWith('proposal', envelope.action, 'human', true)
  })
})
