import http from 'node:http';
import { calendar } from './engine.js';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export const LAN_TIME_ZONE = 'Asia/Shanghai';
const MAX_MEMBERS = 128;
const MAX_BODY = 8192;
const MAX_RESPONSE = 524288;
const OFFLINE_AFTER = 45000;
const SYNC_INTERVAL = 15000;
const clone = value => structuredClone(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const credential = () => randomBytes(32).toString('hex');
const validCredential = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const zone = value => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return typeof value === 'string'; } catch { return false; } };
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function label(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Array.from(value.trim()).length < 1 || Array.from(value.trim()).length > 32 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Name must contain 1–32 characters');
  return value.trim();
}
export function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(address) === 6 && !address.includes('%')) {
    const lower = address.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || (lower.startsWith('::ffff:') && isPrivateAddress(lower.slice(7)));
  }
  return false;
}
function addressText(address) {
  if (!address || !isPrivateAddress(address.host) || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) throw new TypeError('A private or loopback IP literal and port are required');
  return (isIP(address.host) === 6 ? '[' + address.host + ']' : address.host) + ':' + address.port;
}
function parseInvite(input, override) {
  if (typeof input !== 'string' || input.length > 1024) throw new TypeError('Invalid forest invitation');
  let url;
  try { url = new URL(input); } catch { throw new TypeError('Invalid forest invitation'); }
  if (url.protocol !== 'dshforest:' || url.username || url.password || url.search || !/^\/[0-9a-f-]+$/i.test(url.pathname)) throw new TypeError('Invalid forest invitation');
  let host = url.hostname.replace(/^\[|\]$/g, '');
  let port = Number(url.port);
  addressText({ host, port });
  if (override !== undefined) {
    // Parse the literal directly: WHATWG http URLs normalize hex/octal IPv4 and aliases.
    if (typeof override !== 'string' || override.length > 100) throw new TypeError('Invalid LAN address');
    const match = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+)):([0-9]{1,5})$/.exec(override);
    if (!match) throw new TypeError('Invalid LAN address');
    host = match[1] ?? match[2]; port = Number(match[3]);
  }
  const address = { host, port };
  addressText(address);
  const roomId = url.pathname.slice(1), invitation = url.hash.slice(1);
  if (!uuid(roomId) || !validCredential(invitation)) throw new TypeError('Invalid forest invitation');
  return { address, roomId, credential: invitation };
}
function localProfile(input) {
  if (!input || !uuid(input.id) || !input.counts || !Number.isSafeInteger(input.total) || input.total < 0) throw new TypeError('Invalid local forest profile');
  const counts = {};
  for (const key of ['day', 'week', 'month']) {
    const value = input.counts[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > input.total) throw new TypeError('Invalid forest counts');
    counts[key] = value;
  }
  if (!input.days || typeof input.days !== 'object' || Array.isArray(input.days) || Object.keys(input.days).length > 64) throw new TypeError('Invalid daily counts');
  let sum = 0;
  for (const [day, count] of Object.entries(input.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(count) || count < 0 || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) throw new TypeError('Invalid daily count');
    sum += count;
  }
  if (sum > input.total) throw new TypeError('Daily counts exceed total');
  return { id: input.id, nickname: label(input.nickname), counts, days: clone(input.days), total: input.total };
}
function publicMember(member, now) {
  const profile = localProfile(member), current = calendar(now, LAN_TIME_ZONE);
  const counts = { day: 0, week: 0, month: 0 };
  for (const [day, count] of Object.entries(profile.days)) {
    if (day > current.day) continue;
    if (day === current.day) counts.day += count;
    if (day >= current.week) counts.week += count;
    if (day.slice(0, 7) === current.month) counts.month += count;
  }
  return { ...profile, counts, updatedAt: member.updatedAt, online: now - Date.parse(member.updatedAt) <= OFFLINE_AFTER };
}
function validateMembers(members) {
  if (!Array.isArray(members) || members.length > MAX_MEMBERS) throw new TypeError('Invalid members');
  const ids = new Set();
  for (const member of members) {
    localProfile(member);
    if (ids.has(member.id) || typeof member.updatedAt !== 'string' || !Number.isFinite(Date.parse(member.updatedAt))) throw new TypeError('Invalid member identity');
    ids.add(member.id);
  }
}
function restoreState(saved) {
  if (!saved || saved.version !== 1 || !['none', 'host', 'member'].includes(saved.mode)) throw new TypeError('Invalid saved LAN state');
  if (saved.mode === 'none') return { version: 1, mode: 'none' };
  label(saved.name);
  if (!zone(saved.timeZone) || !uuid(saved.roomId) || !validCredential(saved.credential)) throw new TypeError('Invalid saved room');
  validateMembers(saved.members);
  if (saved.mode === 'host') {
    if (!uuid(saved.hostId) || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 || !saved.members.some(member => member.id === saved.hostId)) throw new TypeError('Invalid saved host');
    for (const member of saved.members) if (!validCredential(member.auth)) throw new TypeError('Invalid saved pairing');
  } else {
    addressText(saved.address);
    if (!uuid(saved.memberId) || !validCredential(saved.auth)) throw new TypeError('Invalid saved member pairing');
    if (saved.members.some(member => member.auth !== undefined)) throw new TypeError('Invalid public member cache');
  }
  return clone(saved);
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Private-IP-only HTTP room. Persisted pairing authenticates each member update. */
export class ForestLan {
  constructor({ saved, save, getLocal, onChange, now = Date.now } = {}) {
    if (typeof save !== 'function' || typeof getLocal !== 'function' || typeof now !== 'function') throw new TypeError('save, getLocal and now are required');
    this.state = saved === undefined ? { version: 1, mode: 'none' } : restoreState(saved);
    this.save = save; this.getLocal = getLocal; this.onChange = onChange; this.now = now;
    this.queue = Promise.resolve(); this.server = null; this.timer = null;
    this.requests = new Set(); this.sockets = new Set();
    this.closed = false; this.status = this.state.mode === 'none' ? 'idle' : 'disconnected';
    this.error = undefined; this.lastSyncAt = undefined;
  }
  _enqueue(operation) {
    if (this.closed) return Promise.reject(new Error('Forest LAN is closed'));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  _emit() { if (this.onChange) { try { this.onChange(this.snapshot()); } catch { /* View callbacks cannot roll back saved state. */ } } }
  async _commit(next) {
    await this.save(clone(next));
    this.state = next;
  }
  _profile(timeZone = this.state.timeZone ?? LAN_TIME_ZONE) { return localProfile(this.getLocal(timeZone)); }
  _view(state = this.state) {
    return { name: state.name, timeZone: state.timeZone, members: state.members.map(member => publicMember(member, this.now())) };
  }
  _addresses(port = this.state.port) {
    const hosts = new Set();
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && isPrivateAddress(entry.address)) hosts.add(entry.address);
    return [...hosts, '127.0.0.1'].map(host => host + ':' + port);
  }
  snapshot() {
    const state = this.state;
    const result = { mode: state.mode, name: state.name ?? '', timeZone: state.timeZone ?? LAN_TIME_ZONE, status: this.status, members: state.mode === 'none' ? [] : this._view().members };
    if (state.mode === 'host') {
      result.addresses = this._addresses();
      result.invite = 'dshforest://' + result.addresses[0] + '/' + state.roomId + '#' + state.credential;
    }
    if (this.lastSyncAt) result.lastSyncAt = this.lastSyncAt;
    if (this.error) result.error = this.error;
    return clone(result);
  }
  /** For Host persistence only. Never return this through a UI wire. */
  exportState() { return clone(this.state); }
  _startTimer() {
    if (this.timer || this.closed || this.state.mode === 'none') return;
    this.timer = setInterval(() => { this.sync().catch(() => {}); }, SYNC_INTERVAL);
    this.timer.unref();
  }
  async _stopServer() {
    const server = this.server; this.server = null;
    if (!server) return;
    const done = new Promise(resolve => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await done;
  }
  async _listen(port) {
    if (this.server) return this.server.address().port;
    const server = http.createServer((request, response) => this._incoming(request, response));
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
    server.on('connection', socket => {
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      const fail = error => { server.close(); reject(error); };
      server.once('error', fail);
      server.listen({ host: '0.0.0.0', port }, () => { server.off('error', fail); resolve(); });
    });
    this.server = server;
    server.on('error', error => { this.status = 'error'; this.error = error.code ?? 'LAN server error'; this._emit(); });
    return server.address().port;
  }
  _send(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    const data = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data), connection: 'close' });
    response.end(data);
  }
  async _incoming(request, response) {
    let size = 0;
    try {
      if (request.method !== 'POST' || !isPrivateAddress(request.socket.remoteAddress)) throw new HttpError(403, 'Private LAN POST required');
      const match = /^\/forest\/v1\/([0-9a-f-]+)\/(join|sync|leave)$/.exec(request.url ?? '');
      if (!match) throw new HttpError(404, 'Unknown room endpoint');
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { this._send(response, 413, { error: 'Request too large' }); request.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
      const result = await this._enqueue(async () => {
        const state = this.state;
        if (state.mode !== 'host' || match[1] !== state.roomId) throw new HttpError(404, 'Unknown room');
        const action = match[2];
        const profile = localProfile(body);
        if (profile.id === state.hostId) throw new HttpError(409, 'Host identity is reserved');
        const auth = request.headers['x-forest-auth'];
        if (!validCredential(auth)) throw new HttpError(403, 'Member authentication required');
        const member = state.members.find(item => item.id === profile.id);
        if (action === 'join') {
          if (!equal(request.headers['x-forest-invite'], state.credential)) throw new HttpError(403, 'Invalid invitation');
          if (member && !equal(member.auth, auth)) throw new HttpError(403, 'Identity is already paired');
          if (!member && state.members.length >= MAX_MEMBERS) throw new HttpError(409, 'Room is full');
        } else if (action === 'leave' && !member && equal(request.headers['x-forest-invite'], state.credential)) {
          // The previous deletion may have succeeded before the member could save its local state.
          return this._view();
        } else if (!member || !equal(member.auth, auth)) throw new HttpError(403, 'Invalid member pairing');
        const next = clone(state);
        if (action === 'leave') next.members = next.members.filter(item => item.id !== profile.id);
        else {
          const entry = { ...profile, auth, updatedAt: new Date(this.now()).toISOString() };
          const index = next.members.findIndex(item => item.id === profile.id);
          if (index === -1) next.members.push(entry); else next.members[index] = entry;
        }
        await this._commit(next);
        this._emit();
        return this._view();
      });
      this._send(response, 200, result);
    } catch (error) {
      this._send(response, error.status ?? (error instanceof TypeError ? 400 : 500), { error: error.status || error instanceof TypeError ? error.message : 'Room update could not be saved' });
    }
  }
  _request(state, action, profile) {
    addressText(state.address);
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(profile);
      const request = http.request({ host: state.address.host, port: state.address.port, method: 'POST', path: '/forest/v1/' + state.roomId + '/' + action, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forest-auth': state.auth, ...(['join', 'leave'].includes(action) ? { 'x-forest-invite': state.credential } : {}) }
      }, response => {
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE) response.destroy(new Error('Room response too large')); else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Invalid room response')); return; }
          if (response.statusCode !== 200) { reject(new HttpError(response.statusCode, typeof result.error === 'string' ? result.error.slice(0, 160) : 'Room request rejected')); return; }
          try {
            label(result.name);
            if (!zone(result.timeZone) || result.timeZone !== state.timeZone) throw new TypeError('Room time zone mismatch');
            validateMembers(result.members);
            if (result.members.some(member => member.auth !== undefined)) throw new TypeError('Room leaked authentication');
            resolve({ name: result.name, timeZone: result.timeZone, members: result.members.map(member => publicMember(member, this.now())) });
          } catch (error) { reject(error); }
        });
      });
      this.requests.add(request);
      request.setTimeout(5000, () => request.destroy(new Error('LAN request timed out')));
      request.on('error', reject);
      request.on('close', () => this.requests.delete(request));
      request.end(body);
    });
  }
  async _sync() {
    if (this.state.mode === 'none') return this.snapshot();
    try {
      const profile = this._profile();
      if (this.state.mode === 'host') {
        if (!this.server) await this._listen(this.state.port);
        if (profile.id !== this.state.hostId) throw new Error('Local forest identity changed');
        const next = clone(this.state), index = next.members.findIndex(member => member.id === profile.id);
        next.members[index] = { ...next.members[index], ...profile, updatedAt: new Date(this.now()).toISOString() };
        await this._commit(next);
      } else {
        if (profile.id !== this.state.memberId) throw new Error('Local forest identity changed');
        // Join is idempotent with the persisted pairing and repairs a lost response.
        const result = await this._request(this.state, 'join', profile);
        await this._commit({ ...clone(this.state), ...result });
      }
      this.status = 'connected'; this.error = undefined; this.lastSyncAt = new Date(this.now()).toISOString();
      this._startTimer(); this._emit();
      return this.snapshot();
    } catch (error) {
      this.status = 'disconnected'; this.error = String(error.message).slice(0, 200);
      this._startTimer(); this._emit(); throw error;
    }
  }
  sync() { return this._enqueue(() => this._sync()); }
  restore() {
    return this._enqueue(async () => {
      if (this.state.mode === 'none') return this.snapshot();
      return this._sync();
    });
  }
  operate(input = { action: 'status' }) {
    return this._enqueue(async () => {
      if (!input || !['room-create', 'room-join', 'room-leave', 'room-refresh', 'status'].includes(input.action)) throw new TypeError('Unknown LAN action');
      if (input.action === 'status') return this.snapshot();
      if (input.action === 'room-refresh') return this._sync();
      if (input.action === 'room-leave') {
        if (this.state.mode === 'none') return this.snapshot();
        // Keep the pairing when remote deletion fails, so retrying leave remains safe.
        if (this.state.mode === 'member') await this._request(this.state, 'leave', this._profile()).catch(() => {});
        await this._commit({ version: 1, mode: 'none' });
        clearInterval(this.timer); this.timer = null;
        await this._stopServer();
        this.status = 'idle'; this.error = undefined; this.lastSyncAt = undefined; this._emit();
        return this.snapshot();
      }
      if (this.state.mode !== 'none') throw new Error('Leave the current room first');
      if (input.action === 'room-create') {
        const profile = this._profile(LAN_TIME_ZONE), name = label(input.roomName, '任务森林');
        const port = await this._listen(0);
        const next = { version: 1, mode: 'host', name, roomId: randomUUID(), credential: credential(), timeZone: LAN_TIME_ZONE, port, hostId: profile.id, members: [{ ...profile, auth: credential(), updatedAt: new Date(this.now()).toISOString() }] };
        try { await this._commit(next); } catch (error) { await this._stopServer(); throw error; }
        this.status = 'connected'; this.error = undefined; this.lastSyncAt = new Date(this.now()).toISOString();
        this._startTimer(); this._emit(); return this.snapshot();
      }
      const invitation = parseInvite(input.invite, input.address);
      const profile = this._profile(LAN_TIME_ZONE);
      const next = { version: 1, mode: 'member', name: label(input.roomName, '任务森林'), timeZone: LAN_TIME_ZONE, ...invitation, memberId: profile.id, auth: credential(), members: [] };
      // Save before the first request so network interruption cannot orphan the pairing.
      await this._commit(next);
      try { return await this._sync(); } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          await this._commit({ version: 1, mode: 'none' });
          clearInterval(this.timer); this.timer = null; this.status = 'idle'; this._emit();
        }
        throw error;
      }
    });
  }
  async close() {
    if (this.closed) return this.queue;
    this.closed = true;
    clearInterval(this.timer); this.timer = null;
    for (const request of this.requests) request.destroy(new Error('Forest LAN closed'));
    await this.queue;
    await this._stopServer();
    this.status = this.state.mode === 'none' ? 'idle' : 'disconnected';
  }
}
