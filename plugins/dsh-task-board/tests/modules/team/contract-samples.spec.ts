/**
 * The frozen contract directory, read on its own.
 *
 * The samples under `team-hub/contract/` are the interface the hub and the Host
 * share (protocol amendment A4 point 9). The fake hub compares every call against
 * them while a spec runs, and this file checks the other half: that the checkout
 * really publishes one readable sample per Host interface, so a deleted, renamed
 * or unparsable file fails a test instead of quietly narrowing what is compared.
 */
import { describe, expect, it } from 'vitest'
import { loadContractSamples, loadEventCatalogue, loadHandshakeSample } from './support/contract.ts'

/** Every REST interface this Host speaks, as `team-hub/contract/README.md` lists them. */
const REST_INTERFACES = [
  'hosts.register',
  'hosts.heartbeat',
  'issues.list',
  'issues.claim',
  'issues.renew-lease',
  'issues.settle',
  'questions.create',
  'questions.withdraw',
  'comments.create',
  'comments.list',
]

/**
 * Samples the hub publishes for its own operators.
 *
 * This Host never calls them, but they are part of the frozen directory, so a
 * deleted or renamed file still fails here instead of narrowing what the hub and
 * this plugin share.
 */
const HUB_SIDE_INTERFACES = ['hub.bootstrap']

/** Every event the hub can push, as `ws-events.json` catalogues them. */
const HUB_EVENTS = [
  'comment.created',
  'comment.mentioned',
  'host.status_changed',
  'issue.claimed',
  'issue.created',
  'issue.rework',
  'issue.status_changed',
  'issue.updated',
  'question.answered',
  'question.created',
  'question.expired',
  'question.withdrawn',
]

describe('published contract samples', () => {
  it('operator sees every Host interface published as a readable sample', () => {
    // Given the interface list the contract directory owes this Host
    const samples = loadContractSamples()

    // When the checkout's samples are read
    const rest = samples.samples.filter(entry => entry.method !== undefined)

    // Then every interface is published, parses, and describes both halves of its
    // call, and the two WebSocket documents are published alongside them
    expect(samples.present).toBe(true)
    expect(rest.map(entry => entry.interface).sort()).toEqual([...REST_INTERFACES, ...HUB_SIDE_INTERFACES].sort())
    for (const sample of rest) {
      expect(typeof sample.path, sample.file + ' declares no path').toBe('string')
      expect(Object.keys(sample.response.body ?? {}).length, sample.file + ' declares no response body').toBeGreaterThan(0)
    }
    expect(samples.samples.map(entry => entry.interface).sort())
      .toEqual(['websocket.events', 'websocket.handshake', ...REST_INTERFACES, ...HUB_SIDE_INTERFACES].sort())
  })

  it('operator sees the channel handshake and the event catalogue readable and complete', () => {
    // Given the two documents the team channel is built from
    const handshake = loadHandshakeSample()
    const catalogue = loadEventCatalogue()

    // When this Host reads what they fix
    const presented = Object.keys(handshake.headers).map(name => name.toLowerCase()).sort()
    const events = [...catalogue.keys()].sort()

    // Then the handshake fixes the credential and version headers, names the
    // handshakes the hub refuses, and the catalogue covers every event this Host
    // has to understand
    expect(presented).toEqual(['authorization', 'x-team-hub-protocol-version'])
    expect(handshake.rejected.length).toBeGreaterThan(0)
    expect(events).toEqual([...HUB_EVENTS].sort())
    for (const sample of catalogue.values()) {
      expect(Object.keys(sample.payload).length, sample.event + ' carries no payload').toBeGreaterThan(0)
    }
  })
})
