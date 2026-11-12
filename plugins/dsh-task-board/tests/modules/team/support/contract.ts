/**
 * The frozen wire samples under `team-hub/contract/`.
 *
 * Protocol amendment A4 point 9 freezes one request and one response example per
 * Host endpoint in the hub's own repository (`team-hub/contract/<interface>.json`),
 * plus the WebSocket handshake and the event catalogue, and both sides test
 * against the same files so a drift on either side fails a test. This module is
 * the fake hub's reading half: it loads the samples, matches one outgoing call to
 * its sample by method and path template, and compares what the provider actually
 * sent with what the sample shows.
 *
 * The samples are EXAMPLES, not schemas, so the comparison is deliberately
 * two-sided with three named allowances: a member the specification makes optional
 * may be absent (`OPTIONAL_BODY_KEYS`), a member whose interior is the Host's own
 * document is compared only as an object (`OPEN_MEMBERS`), and a member the
 * example shows as `null` is nullable, so any value is accepted there.
 *
 * The comparison is recursive. An object is compared member by member at every
 * depth, and an array element by element: an element may only carry the members
 * the example used somewhere in that array, and MUST carry the ones every example
 * element showed. That is what catches a renamed field inside `agents[]` or an
 * issue object that lost a member, instead of only checking the outermost keys.
 *
 * `Authorization` values in the samples are placeholders, so only the header's
 * presence and its `Bearer ` prefix are compared.
 *
 * @module dsh-task-board-team/tests/support/contract
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file's own location. */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../../../..')

/** Directory the hub side publishes its samples into (read-only for this package). */
export const CONTRACT_DIR = join(REPO_ROOT, 'team-hub', 'contract')

/** One frozen sample. */
export interface ContractSample {
  /** Interface id the sample declares, e.g. `hosts.register`. */
  interface: string
  /** File name the sample came from. */
  file: string
  method?: string
  path?: string
  request: RequestExample
  response: ResponseExample
}

/** The request half of one sample. */
export interface RequestExample {
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
}

/** The response half of one sample. */
export interface ResponseExample {
  status?: number
  body?: Record<string, unknown>
}

/** What the loader found. */
export interface ContractSet {
  /** Whether the hub side publishes samples in this checkout. */
  present: boolean
  samples: ContractSample[]
}

/**
 * Protocol-optional members one example does not need to show.
 *
 * Each entry names keys the wire specification explicitly makes optional for that
 * endpoint, by their path inside the body: `error` is a member of the body, while
 * `options[].description` is a member of every element of `options`.
 */
export const OPTIONAL_BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'issues.claim': ['execution_attempt_id', 'lease_token'],
  'issues.settle': ['error'],
  'hosts.register': [],
  'questions.create': ['options[].description', 'multi_select'],
}

/**
 * Protocol-optional members one answer may omit, by their path inside the
 * response body.
 *
 * A response nests what a request sends (`question.options[]` against
 * `options[]`), so the response paths are their own list instead of being reused
 * from {@link OPTIONAL_BODY_KEYS}.
 */
export const OPTIONAL_RESPONSE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'questions.create': ['question.options[].description'],
}

/**
 * Members whose interior is the Host's own document rather than the hub's shape.
 *
 * `verification_evidence` is whatever this Host verified and the hub stores
 * opaquely, so the example fixes only that the member is an object.
 */
export const OPEN_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'issues.settle': ['verification_evidence'],
}

/**
 * Read every sample the hub side published.
 * @param dir - directory to read; defaults to {@link CONTRACT_DIR}.
 * @returns the samples, and `present: false` when the directory holds none.
 */
export function loadContractSamples(dir: string = CONTRACT_DIR): ContractSet {
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return { present: false, samples: [] }
  }
  const samples: ContractSample[] = []
  for (const file of names) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    if (typeof record.interface !== 'string') continue
    const request = typeof record.request === 'object' && record.request !== null
      ? record.request as Record<string, unknown>
      : {}
    const response = typeof record.response === 'object' && record.response !== null
      ? record.response as Record<string, unknown>
      : {}
    samples.push({
      interface: record.interface,
      file,
      ...(typeof record.method === 'string' ? { method: record.method } : {}),
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      request: {
        ...(isRecord(request.headers) ? { headers: request.headers as Record<string, string> } : {}),
        ...(isRecord(request.query) ? { query: request.query as Record<string, string> } : {}),
        ...(isRecord(request.body) ? { body: request.body as Record<string, unknown> } : {}),
      },
      response: {
        ...(typeof response.status === 'number' ? { status: response.status } : {}),
        ...(isRecord(response.body) ? { body: response.body as Record<string, unknown> } : {}),
      },
    })
  }
  return { present: samples.length > 0, samples }
}

/** One handshake the hub refuses, as `ws-handshake.json` lists it. */
export interface RejectedHandshake {
  case: string
  example: string
  status: number
  error: string
}

/** The frozen team-channel handshake sample. */
export interface HandshakeSample {
  /** URL template the hub serves the channel on. */
  url: string
  /** Upgrade headers a Host handshake has to present. */
  headers: Record<string, string>
  /** The handshakes the hub answers with a refusal. */
  rejected: RejectedHandshake[]
}

/** One event of the server catalogue, with the payload the hub really sends. */
export interface EventSample {
  event: string
  recipient: string
  payload: Record<string, unknown>
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/**
 * Read the handshake sample.
 *
 * A checkout without the sample fails here rather than skipping: the channel
 * headers are an interface the hub and the Host share, so "no sample" must not
 * read as "nothing to check" (protocol amendment A4 point 9).
 * @param dir - directory holding the samples; defaults to {@link CONTRACT_DIR}.
 * @returns the URL template, the headers and the refused variants.
 */
export function loadHandshakeSample(dir: string = CONTRACT_DIR): HandshakeSample {
  const record = readJson(join(dir, 'ws-handshake.json'))
  const headers: Record<string, string> = {}
  if (isRecord(record.headers)) {
    for (const [name, value] of Object.entries(record.headers)) headers[name] = String(value)
  }
  const rejected: RejectedHandshake[] = []
  if (Array.isArray(record.rejected)) {
    for (const entry of record.rejected) {
      if (!isRecord(entry)) continue
      rejected.push({
        case: String(entry.case ?? ''),
        example: String(entry.example ?? ''),
        status: typeof entry.status === 'number' ? entry.status : 0,
        error: String(entry.error ?? ''),
      })
    }
  }
  return { url: String(record.url ?? ''), headers, rejected }
}

/**
 * Read the server event catalogue.
 *
 * The fake hub pushes events out of this catalogue instead of out of payloads
 * written by hand, so an event or a payload shape the hub does not send cannot
 * pass here.
 * @param dir - directory holding the samples; defaults to {@link CONTRACT_DIR}.
 * @returns every event by its name.
 */
export function loadEventCatalogue(dir: string = CONTRACT_DIR): Map<string, EventSample> {
  const record = readJson(join(dir, 'ws-events.json'))
  const events = new Map<string, EventSample>()
  if (!Array.isArray(record.events)) return events
  for (const entry of record.events) {
    if (!isRecord(entry) || typeof entry.event !== 'string') continue
    events.set(entry.event, {
      event: entry.event,
      recipient: String(entry.recipient ?? ''),
      payload: isRecord(entry.payload) ? entry.payload : {},
    })
  }
  return events
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Match one call to its sample by method and path template.
 * @param set - the loaded samples.
 * @param method - HTTP method of the call.
 * @param path - request path, e.g. `/api/v1/teams/team_1/hosts/register`.
 * @returns the sample, or undefined when the samples do not describe this call.
 */
export function sampleForCall(set: ContractSet, method: string, path: string): ContractSample | undefined {
  const wanted = path.split('?')[0]
  for (const sample of set.samples) {
    if (sample.method !== method || sample.path === undefined) continue
    if (matchesTemplate(sample.path, wanted)) return sample
  }
  return undefined
}

function matchesTemplate(template: string, path: string): boolean {
  const expected = template.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return false
  return expected.every((segment, index) => segment.startsWith(':') ? actual[index] !== '' : segment === actual[index])
}

/** The fields of one call the comparison looks at. */
export interface ActualCall {
  headers: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
  /** Method and path, for the message. */
  method: string
  path: string
}

/** How one member's absence or addition is judged while the comparison recurses. */
interface CompareContext {
  /** Body paths the specification makes optional. */
  optional: readonly string[]
  /** Body paths whose interior is not the hub's shape. */
  open: readonly string[]
  /** Whether an undeclared member is reported (a request) or tolerated (a response). */
  closed: boolean
}

/** The path of one member, relative to its body or array element. */
function memberPath(path: string, key: string): string {
  return path === '' ? key : path + '.' + key
}

/**
 * Compare one real call with its sample.
 * @param sample - the frozen sample.
 * @param actual - what the provider really sent.
 * @returns one message per difference; empty means the call matches the example.
 */
export function compareRequest(sample: ContractSample, actual: ActualCall): string[] {
  const problems: string[] = []
  const context: CompareContext = {
    optional: OPTIONAL_BODY_KEYS[sample.interface] ?? [],
    open: OPEN_MEMBERS[sample.interface] ?? [],
    closed: true,
  }
  compareHeaders(sample, actual, problems)
  compareObject(sample.request.query ?? {}, actual.query, sample.interface + ' query', '', context, problems)
  const declaredBody = sample.request.body ?? {}
  if (isEmptyBodyExample(sample)) {
    // An example that shows `{}` for a POST still fixes which optional members the
    // specification allows there, and nothing else.
    for (const key of Object.keys(actual.body)) {
      if (!context.optional.includes(key)) problems.push(sample.interface + ' body.' + key + ' is not part of this interface')
    }
    return problems
  }
  compareObject(declaredBody, actual.body, sample.interface + ' body', '', context, problems)
  return problems
}

function isEmptyBodyExample(sample: ContractSample): boolean {
  const body = sample.request.body
  return sample.method !== 'GET' && body !== undefined && Object.keys(body).length === 0
}

function compareHeaders(sample: ContractSample, actual: ActualCall, problems: string[]): void {
  const declared = sample.request.headers
  if (declared === undefined) return
  const present = new Set(Object.keys(actual.headers).map(name => name.toLowerCase()))
  for (const name of Object.keys(declared)) {
    const wanted = name.toLowerCase()
    if (!present.has(wanted)) {
      problems.push(sample.interface + ' sends no ' + name + ' header')
      continue
    }
    if (wanted === 'authorization') {
      const value = actual.headers[name] ?? actual.headers[wanted] ?? ''
      if (!/^Bearer \S+$/.test(value)) problems.push(sample.interface + ' Authorization is not a Bearer credential')
    }
  }
}

/**
 * Compare one object with the object its sample shows, member by member.
 * @param declared - the example.
 * @param actual - the value really sent or answered.
 * @param where - human-readable position, for the message.
 * @param path - the same position as a body path, so allowances can match it.
 * @param context - which allowances this interface declares.
 * @param problems - collected differences.
 */
function compareObject(
  declared: Record<string, unknown>,
  actual: Record<string, unknown>,
  where: string,
  path: string,
  context: CompareContext,
  problems: string[],
): void {
  if (context.closed) {
    for (const key of Object.keys(actual)) {
      if (key in declared) continue
      if (context.optional.includes(memberPath(path, key))) continue
      problems.push(where + '.' + key + ' is not part of this interface')
    }
  }
  for (const [key, value] of Object.entries(declared)) {
    const mine = actual[key]
    if (mine === undefined) {
      if (!context.optional.includes(memberPath(path, key))) problems.push(where + '.' + key + ' is missing')
      continue
    }
    compareValue(value, mine, where + '.' + key, memberPath(path, key), context, problems)
  }
}

/** The JSON kind of one value, as the messages name it. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Compare one value with the value its sample shows, recursing into objects and
 * into every element of an array.
 * @param declared - the example value.
 * @param actual - the value really sent or answered.
 * @param where - human-readable position, for the message.
 * @param path - the same position as a body path, so allowances can match it.
 * @param context - which allowances this interface declares.
 * @param problems - collected differences.
 */
function compareValue(
  declared: unknown,
  actual: unknown,
  where: string,
  path: string,
  context: CompareContext,
  problems: string[],
): void {
  // A member whose interior is the Host's own document: the example fixes that it
  // is an object and nothing about what it holds.
  if (context.open.includes(path)) return
  if (Array.isArray(declared)) {
    if (!Array.isArray(actual)) {
      problems.push(where + ' is ' + kindOf(actual) + ', the sample shows array')
      return
    }
    compareArray(declared, actual, where, path, context, problems)
    return
  }
  if (isRecord(declared)) {
    if (!isRecord(actual)) {
      problems.push(where + ' is ' + kindOf(actual) + ', the sample shows object')
      return
    }
    compareObject(declared, actual, where, path, context, problems)
    return
  }
  // A member the example shows as null is nullable: the sample fixes its name and
  // its presence, while what fills it belongs to the live value.
  if (declared === null || actual === null) return
  if (typeof declared !== typeof actual) {
    problems.push(where + ' is ' + kindOf(actual) + ', the sample shows ' + kindOf(declared))
  }
}

/**
 * Compare every element of an array with the elements its sample shows.
 *
 * A member is allowed at an element when the example used it anywhere in that
 * array, and required when every example element carried it: that is the only
 * reading of an example list that covers both a member the protocol makes
 * optional and a rename the hub or the Host would otherwise ship unnoticed.
 * @param declared - the example array.
 * @param actual - the array really sent or answered.
 * @param where - human-readable position, for the message.
 * @param path - the same position as a body path, so allowances can match it.
 * @param context - which allowances this interface declares.
 * @param problems - collected differences.
 */
function compareArray(
  declared: readonly unknown[],
  actual: readonly unknown[],
  where: string,
  path: string,
  context: CompareContext,
  problems: string[],
): void {
  if (declared.length === 0) return
  const examples = declared.filter(isRecord)
  const allowed = new Set(examples.flatMap(example => Object.keys(example)))
  const required = examples.length === 0
    ? []
    : Object.keys(examples[0]).filter(key => examples.every(example => key in example))
  const elementPath = path + '[]'
  for (const [index, mine] of actual.entries()) {
    const at = where + '[' + String(index) + ']'
    const example = declared[index] ?? declared[declared.length - 1]
    if (!isRecord(example)) {
      compareValue(example, mine, at, elementPath, context, problems)
      continue
    }
    if (!isRecord(mine)) {
      problems.push(at + ' is ' + kindOf(mine) + ', the sample shows object')
      continue
    }
    const row = mine as Record<string, unknown>
    for (const key of Object.keys(row)) {
      if (allowed.has(key) || context.optional.includes(memberPath(elementPath, key))) continue
      problems.push(at + '.' + key + ' is not part of this interface')
    }
    for (const key of required) {
      if (key in row || context.optional.includes(memberPath(elementPath, key))) continue
      problems.push(at + '.' + key + ' is missing')
    }
    for (const [key, value] of Object.entries(row)) {
      const owner = examples.find(entry => key in entry)
      if (owner === undefined) continue
      compareValue(owner[key], value, at + '.' + key, memberPath(elementPath, key), context, problems)
    }
  }
}

/**
 * Compare one response body with the sample that describes it.
 *
 * A response is compared one-sided: every member the example shows has to be
 * there, with the example's kind, while a member the hub added after the example
 * was frozen is not a drift in the Host.
 * @param sample - the frozen sample.
 * @param body - the body the fake hub is about to answer with.
 * @returns one message per declared member that is missing or of another kind.
 */
export function compareResponse(sample: ContractSample, body: Record<string, unknown> | undefined): string[] {
  const declared = sample.response.body
  if (declared === undefined || body === undefined) return []
  const problems: string[] = []
  const context: CompareContext = {
    optional: OPTIONAL_RESPONSE_KEYS[sample.interface] ?? [],
    open: OPEN_MEMBERS[sample.interface] ?? [],
    closed: false,
  }
  compareObject(declared, body, sample.interface + ' response', '', context, problems)
  return problems
}
