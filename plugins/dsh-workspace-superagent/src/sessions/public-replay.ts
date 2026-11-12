import { Session, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import type { AuditSessionRegistration } from '../storage/types.js';
import type { AuditLogEvent, NativeAuditReplay } from './request-audit.js';

/** 与当前宿主共享锁定版本SDK；只解释已登记原生日志，不恢复Agent。 */
export function createPublicReplay(projections: NonNullable<Parameters<typeof Session.fromRestore>[5]>): NativeAuditReplay {
  const id = '@deepseek-ai/dsh-session@0.2.2-rc.1/format-' + SESSION_FORMAT_VERSION +
    '/e37-public-replay-v2/projections/' + createHash('sha256').update(JSON.stringify(projections.map(p => ({ type: p.type, body: String(p.project) })))).digest('hex');
  const restore = (events: readonly AuditLogEvent[], registration: AuditSessionRegistration) => {
    if (registration.formatVersion !== SESSION_FORMAT_VERSION || registration.projectionId !== id) throw Error('AUDIT_INTERPRETER_CHANGED');
    for (const event of events) if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw Error('UNKNOWN_REQUIRED_EVENT');
    return Session.fromRestore(registration.sessionId as Parameters<typeof Session.fromRestore>[0],
      structuredClone([...events]) as unknown as Parameters<typeof Session.fromRestore>[1],
      structuredClone(registration.header) as unknown as Parameters<typeof Session.fromRestore>[2],
      registration.inheritedEventCount as Parameters<typeof Session.fromRestore>[3], 'detached', projections);
  };
  return Object.freeze({
    id,
    validate(events: readonly AuditLogEvent[], registration: AuditSessionRegistration) { restore(events, registration); },
    describe(events: readonly AuditLogEvent[], registration: AuditSessionRegistration) {
      const session = restore(events, registration), header = session.requestHeader();
      if (!header) throw Error('REQUEST_HEADER_MISSING');
      return JSON.parse(JSON.stringify({ config: header.config, adapterDefaults: header.adapterDefaults ?? {},
        messages: session.deriveMessages(), tools: header.tools ?? [], toolHistory: session.toolHistory() }));
    },
  });
}
