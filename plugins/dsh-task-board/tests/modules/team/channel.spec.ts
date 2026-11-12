/**
 * The team channel handshake against a real upgrade listener.
 *
 * The hub authenticates a Host channel only through the upgrade's Authorization
 * header and refuses a token in the URL, so the platform socket is driven
 * against a local HTTP server and the request it actually sends is inspected.
 * What it has to carry is not restated here: the header names, the scheme prefix,
 * the protocol version and the path template all come from the frozen
 * `team-hub/contract/ws-handshake.json` sample the hub serves the channel under.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { platformSocket, teamSocketHeaders, teamSocketUrl } from '../../../src/modules/team/host/channel.ts'
import { loadHandshakeSample } from './support/contract.ts'

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  server = undefined
})

/** Start a listener that records the first upgrade request and drops the socket. */
async function upgradeListener(): Promise<{ port: number, upgrade: Promise<IncomingMessage> }> {
  let received: (request: IncomingMessage) => void = () => {}
  const upgrade = new Promise<IncomingMessage>(resolve => { received = resolve })
  server = createServer()
  server.on('upgrade', (request, socket) => {
    received(request)
    socket.destroy()
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  return { port: (server.address() as AddressInfo).port, upgrade }
}

/** The query of one URL, split without a URL parser: the sample host is a template. */
function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '')
}

describe('team channel handshake', () => {
  it('operator sees the Host Token presented in the upgrade header and never in the URL', async () => {
    // Given the frozen handshake sample and a hub listener
    const sample = loadHandshakeSample()
    const authorizationName = Object.keys(sample.headers).find(name => name.toLowerCase() === 'authorization')
    if (authorizationName === undefined) throw new Error('the handshake sample declares no Authorization header')
    const scheme = sample.headers[authorizationName].split(' ')[0]
    const versionName = Object.keys(sample.headers).find(name => name.toLowerCase() === 'x-team-hub-protocol-version')
    if (versionName === undefined) throw new Error('the handshake sample declares no protocol version header')
    const { port, upgrade } = await upgradeListener()
    const url = teamSocketUrl('http://127.0.0.1:' + String(port) + '/', 'team_1', 7)

    // When the platform socket opens the team channel with the Host Token
    const socket = platformSocket(url, { message() {}, closed() {} }, teamSocketHeaders('th_host_secret'))
    const request = await upgrade
    socket.close()

    // Then the upgrade carries exactly what the sample declares, and the URL only
    // the cursor and the version
    expect(request.headers[authorizationName.toLowerCase()]).toBe(scheme + ' th_host_secret')
    expect(request.headers[versionName.toLowerCase()]).toBe(sample.headers[versionName])
    const samplePath = sample.url.split('?')[0].replace(/^wss:\/\/<hub-domain>/, '').replace(':teamId', 'team_1')
    expect(String(request.url).split('?')[0]).toBe(samplePath)
    const expected = queryOf(sample.url)
    const actual = queryOf(String(request.url))
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
    expect(actual.get('protocol_version')).toBe(expected.get('protocol_version'))
    expect(actual.get('since_seq')).toBe('7')

    // And the credential is nowhere in the URL the hub refuses (sample: token in
    // the query string answers UNAUTHORIZED)
    const rejected = sample.rejected.filter(entry => entry.case === 'token in the query string')
    expect(rejected.map(entry => entry.error)).toEqual(['UNAUTHORIZED'])
    expect(String(request.url)).not.toContain('th_host_secret')
  })
})
