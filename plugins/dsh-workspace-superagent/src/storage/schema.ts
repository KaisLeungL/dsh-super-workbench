export const SCHEMA_VERSION = 2;
export const APPLICATION_ID = 0x57534131;
export const V1_TABLES = [
  'deployment', 'manager_instance', 'policy_revision', 'verified_actor', 'business_decision',
  'resource_binding', 'source_instance', 'thread', 'input_snapshot', 'trigger', 'eval', 'route_result',
  'coordination', 'execution_ref', 'subscription', 'disposition', 'input_recipient', 'reroute',
  'effect', 'effect_attempt', 'internal_job', 'job_receipt', 'question', 'brief_slot', 'plan_item',
  'board_snapshot', 'search_index', 'artifact_index', 'artifact_protection', 'audit',
] as const;
// 所有可变实体有修订/代次；JSON 只保存聚合内容，关键身份、CAS 与唯一性由 SQLite 约束。
export const V1_SCHEMA = `
CREATE TABLE deployment(singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, domain_id TEXT NOT NULL UNIQUE, complete INTEGER NOT NULL CHECK(complete=1), schema_hash TEXT NOT NULL);
CREATE TABLE manager_instance(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, lifecycle TEXT NOT NULL, pin INTEGER NOT NULL, session_id TEXT UNIQUE, binding_state TEXT NOT NULL, workspace_id TEXT, preset TEXT, policy_version INTEGER NOT NULL, scope_version INTEGER NOT NULL, stop_epoch INTEGER NOT NULL, intent_revision INTEGER NOT NULL);
CREATE TABLE policy_revision(version INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE verified_actor(actor_id TEXT PRIMARY KEY, proof_ref TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE business_decision(id TEXT PRIMARY KEY, intent_revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE resource_binding(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE source_instance(id TEXT PRIMARY KEY, stable_key TEXT NOT NULL UNIQUE, resource_id TEXT NOT NULL REFERENCES resource_binding(id), revision INTEGER NOT NULL, cursor TEXT NOT NULL);
CREATE TABLE thread(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instance(id), external_key TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resource_binding(id), UNIQUE(source_id,external_key));
CREATE TABLE input_snapshot(ref TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE trigger(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instance(id), external_id TEXT NOT NULL, revision INTEGER NOT NULL, resource_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(source_id,external_id,revision));
CREATE TABLE eval(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, control INTEGER NOT NULL, bytes INTEGER NOT NULL, queued_at INTEGER NOT NULL, attempt INTEGER NOT NULL, deadline_basis TEXT, deadline INTEGER, remaining INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), paused_from TEXT);
CREATE TABLE route_result(eval_id TEXT NOT NULL REFERENCES eval(id), trigger_id TEXT NOT NULL REFERENCES trigger(id), body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(eval_id,trigger_id));
CREATE TABLE coordination(board_task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, execution_id TEXT NOT NULL, execution_generation INTEGER NOT NULL);
CREATE TABLE execution_ref(execution_id TEXT PRIMARY KEY, board_task_id TEXT NOT NULL, generation INTEGER NOT NULL, watermark INTEGER NOT NULL, released_watermark INTEGER NOT NULL DEFAULT -1);
CREATE TABLE subscription(board_task_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES thread(id), purpose TEXT NOT NULL CHECK(purpose IN ('work','context')), PRIMARY KEY(board_task_id,thread_id,purpose));
CREATE TABLE disposition(input_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES trigger(id), trigger_revision INTEGER NOT NULL, state TEXT NOT NULL, reroute_generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE input_recipient(input_id TEXT NOT NULL REFERENCES disposition(input_id), execution_id TEXT NOT NULL REFERENCES execution_ref(execution_id), execution_generation INTEGER NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('work','context')), watermark INTEGER NOT NULL, state TEXT NOT NULL, rpc_id TEXT NOT NULL, native_item_id TEXT, input_hash TEXT NOT NULL, receipt_ref TEXT, PRIMARY KEY(input_id,execution_id,execution_generation,purpose));
CREATE TABLE reroute(input_id TEXT NOT NULL REFERENCES disposition(input_id), generation INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(input_id,generation));
CREATE TABLE effect(seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_key TEXT NOT NULL, generation INTEGER NOT NULL, operation_key TEXT NOT NULL UNIQUE, board_task_id TEXT NOT NULL, destination TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(effect_key,generation));
CREATE TABLE effect_attempt(id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE REFERENCES effect(seq), generation INTEGER NOT NULL, request_id TEXT NOT NULL, receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)), late INTEGER NOT NULL DEFAULT 0);
CREATE TABLE internal_job(id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, cancel_generation INTEGER NOT NULL, released INTEGER NOT NULL, started_at INTEGER, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE job_receipt(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES internal_job(id), attempt INTEGER NOT NULL, cancel_generation INTEGER NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)), late INTEGER NOT NULL, UNIQUE(job_id,attempt,cancel_generation));
CREATE TABLE question(id TEXT PRIMARY KEY, event_key TEXT NOT NULL, purpose TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, audience TEXT NOT NULL, close_ref TEXT, body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(event_key,purpose));
CREATE TABLE brief_slot(slot_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE UNIQUE INDEX brief_occurrence ON brief_slot(json_extract(body,'$.localDate'),json_extract(body,'$.kind'));
CREATE TABLE plan_item(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, board_task_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE board_snapshot(board_task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, as_of INTEGER NOT NULL, stale INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE search_index(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, invalidated INTEGER NOT NULL, resource_id TEXT NOT NULL, audience TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE artifact_index(ref TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, tombstone TEXT);
CREATE TABLE artifact_protection(ref TEXT NOT NULL REFERENCES artifact_index(ref), owner TEXT NOT NULL, PRIMARY KEY(ref,owner));
CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
`;
export const AUDIT_SCHEMA = `
CREATE TABLE native_audit_cursor(session_identity TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, registration_hash TEXT NOT NULL, registration TEXT NOT NULL CHECK(json_valid(registration)), inspected_offset INTEGER NOT NULL CHECK(inspected_offset>=0), prefix_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0));
CREATE TABLE native_request_audit(request_key TEXT PRIMARY KEY, session_identity TEXT NOT NULL REFERENCES native_audit_cursor(session_identity), basis_hash TEXT NOT NULL, basis TEXT NOT NULL CHECK(json_valid(basis)), boundary_hash TEXT, boundary TEXT CHECK(boundary IS NULL OR json_valid(boundary)), settlement_seq INTEGER CHECK(settlement_seq IS NULL OR settlement_seq>=0), event_hash TEXT, state TEXT NOT NULL CHECK(state IN ('prepared','unknown','verified')), eligibility TEXT NOT NULL CHECK(eligibility IN ('live','audit-only')), input_ref TEXT UNIQUE REFERENCES input_snapshot(ref), input_hash TEXT, evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)), reason TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(session_identity,settlement_seq));
`;
export const TABLES = [...V1_TABLES, 'native_request_audit', 'native_audit_cursor'] as const;
export const SCHEMA = V1_SCHEMA + AUDIT_SCHEMA;
