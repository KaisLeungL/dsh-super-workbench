import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTaskBoardRoutes, type TaskBoardConnectionTrust } from '../src/host-routes.ts'
import type { TaskBoardHostService } from '../src/host-service.ts'
import { TASK_BOARD_SCHEMA_VERSION, TASK_BOARD_WRITE_CAPABILITIES } from '../src/protocol.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
async function server(connection?: TaskBoardConnectionTrust) {
  const accepted: unknown[][] = []
  const service = { async applyVerified(...args: unknown[]) { accepted.push(args); return { tasks: [] } } } as unknown as TaskBoardHostService
  const routes = makeTaskBoardRoutes(service, { connection: () => connection })
  const http = createServer((req, res) => { void routes.find(route => route.path === '/api/task-board/action')!.handler(req, res) })
  servers.push(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('test did not bind')
  return { accepted, url: 'http://127.0.0.1:' + address.port + '/api/task-board/action' }
}
const envelope = {
  schemaVersion: TASK_BOARD_SCHEMA_VERSION, capabilities: [...TASK_BOARD_WRITE_CAPABILITIES],
  requestId: 'recovery', initiator: 'human',
  action: { kind: 'reconcile-uncertain', taskId: 'task', executionId: 'uncertain' },
}
async function submit(url: string, cookie?: string) {
  return await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(envelope),
  })
}
describe('authenticated unknown-start recovery route', () => {
  it('operator cannot recover through loopback or a forged browser identity', async () => {
    // Given a loopback route without signed-browser verification.
    const host = await server()
    // When a request claims human origin and a browser cookie.
    const response = await submit(host.url, 'dsh-auth-test=forged')
    // Then no recovery is authorized.
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'authenticated human action required' })
    expect(host.accepted).toEqual([])
  })

  it('operator needs a browser cookie validated by the Host connection to recover', async () => {
    // Given the real route guard with an injected signed-cookie verifier.
    const browserPeer = {}
    const verified = (request: { headers: { cookie?: string } }) => request.headers.cookie === 'dsh-auth-test=verified'
    const host = await server({ requestRejection: request => verified(request) ? undefined : 401, browserPeer, admit: request => verified(request) ? { peer: browserPeer } : { rejection: 401 } })
    // When a rejected cookie and a verified browser submit the same recovery.
    const denied = await submit(host.url, 'dsh-auth-test=forged')
    const admitted = await submit(host.url, 'dsh-auth-test=verified')
    // Then authority is forwarded separately from the untrusted initiator.
    expect(denied.status).toBe(403)
    expect(admitted.status).toBe(200)
    expect(host.accepted).toEqual([['recovery', envelope.action, 'human', true]])
  })
})
