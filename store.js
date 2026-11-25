/**
 * Host-side local store + manifest-diff sync engine for the workbench.
 *
 * Reads always come from the local store (offline-capable, labelled with
 * the sync watermark). Draft writes land locally first (marked dirty) and
 * push immediately when online, otherwise queue for reconnect. Submit and
 * feedback stay online-only (server state machine). Conflicts between a
 * dirty local copy and a newer server copy resolve via diff3; overlapping
 * regions wait for manual resolution in the panel.
 *
 * The store only ever holds records the binding user was authorized to
 * see; the server's sync `delete` task purges lost-visibility copies.
 * Sync protocol adapted from obsidian-fast-note-sync's manifest-diff
 * semantics (Apache-2.0); independent implementation.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diff3 } from './diff3.js';

const DATA_ROOT = join(homedir(), '.aecpt');
const LEGACY_DATA_ROOT = join(homedir(), '.aecompute');
if (!existsSync(DATA_ROOT) && existsSync(LEGACY_DATA_ROOT)) {
  renameSync(LEGACY_DATA_ROOT, DATA_ROOT);
}
export const DATA_DIR = join(DATA_ROOT, 'dsh');
/** Shared-library PDFs downloaded by the agent tool, one folder per account. */
export const LIBRARY_DIR = join(DATA_ROOT, 'library');
const EXPORT_DIR = join(DATA_ROOT, 'exports');
const ACCOUNTS_PATH = join(DATA_DIR, 'accounts.json');

export class NetworkError extends Error {
  constructor(cause) {
    super(String(cause?.message || cause));
    this.name = 'NetworkError';
  }
}

export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function hashKey(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function legacyStoreKey(identity) {
  return hashKey(`${identity.serverUrl}#${identity.username}`);
}

/** One cache per account: the server's database identity (falling back to
 * its address) plus the server user id, which survives renames. Older
 * bindings without a user id keep the address + username key. */
export function storeKey(identity) {
  if (identity.userId === undefined || identity.userId === null || identity.userId === '') {
    return legacyStoreKey(identity);
  }
  return hashKey(`${identity.serverInstance || identity.serverUrl}#u${identity.userId}`);
}

function storePath(identity) {
  return join(DATA_DIR, `${storeKey(identity)}.json`);
}

function emptyStore() {
  return {
    lastSync: null,
    online: false,
    lastError: '',
    authExpired: false,
    reports: {},
    pending: [],
  };
}

export function loadStore(binding) {
  const path = storePath(binding);
  if (!existsSync(path) && storeKey(binding) !== legacyStoreKey(binding)) {
    // First load after the account gained a user id: adopt the old cache.
    const legacy = join(DATA_DIR, `${legacyStoreKey(binding)}.json`);
    if (existsSync(legacy)) renameSync(legacy, path);
  }
  let store = null;
  if (existsSync(path)) {
    try {
      store = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Corrupt store: start fresh rather than block the panel.
    }
  }
  store ??= emptyStore();
  // Identity fields follow the current binding (a moved server keeps its cache).
  store.serverUrl = binding.serverUrl;
  store.username = binding.username;
  store.userId = binding.userId ?? store.userId ?? null;
  store.serverInstance = binding.serverInstance ?? store.serverInstance ?? '';
  return store;
}

function readAccounts() {
  if (!existsSync(ACCOUNTS_PATH)) return { last: null, accounts: {} };
  try {
    const value = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
    return { last: value.last ?? null, accounts: value.accounts ?? {} };
  } catch {
    return { last: null, accounts: {} };
  }
}

function writeAccounts(value) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${ACCOUNTS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, ACCOUNTS_PATH);
}

/** Record the account this device is bound to; it stays the reference for
 * reconnect checks after a disconnect. */
export function rememberAccount(identity) {
  const accounts = readAccounts();
  const key = storeKey(identity);
  accounts.accounts[key] = {
    serverUrl: identity.serverUrl,
    serverInstance: identity.serverInstance || '',
    userId: identity.userId ?? null,
    username: identity.username || '',
    fullName: identity.fullName || '',
    studentNumber: identity.studentNumber || '',
    updatedAt: new Date().toISOString(),
  };
  accounts.last = key;
  writeAccounts(accounts);
}

export function lastAccount() {
  const accounts = readAccounts();
  return accounts.last ? accounts.accounts[accounts.last] ?? null : null;
}

/** Local work that exists only on this device for an account. */
export function localWorkSummary(identity) {
  if (!existsSync(storePath(identity))) {
    return { cached: false, pendingCount: 0, conflictCount: 0, unsubmittedSummaries: 0, lastSync: null };
  }
  const store = loadStore(identity);
  const entries = Object.values(store.reports);
  return {
    cached: true,
    pendingCount: store.pending.length,
    conflictCount: entries.filter(entry => entry.conflict).length,
    unsubmittedSummaries: entries.reduce((count, entry) => {
      const submitted = new Set((entry.payload.summary_records ?? []).map(record => record.id));
      return count + (entry.localSummaryRecords ?? []).filter(record => !submitted.has(record.id)).length;
    }, 0),
    lastSync: store.lastSync,
  };
}

/** Delete one account's local cache, personal feed store and downloaded
 * library PDFs (shared-device cleanup). */
export function forgetAccountCache(identity) {
  const key = storeKey(identity);
  rmSync(storePath(identity), { force: true });
  rmSync(join(DATA_DIR, `feeds-${key}.json`), { force: true });
  rmSync(join(LIBRARY_DIR, key), { recursive: true, force: true });
  const accounts = readAccounts();
  delete accounts.accounts[key];
  if (accounts.last === key) accounts.last = null;
  writeAccounts(accounts);
}

const SUMMARY_MODEL_PATH = join(DATA_DIR, 'summary-model.json');

export function loadSummaryModelSetting() {
  if (!existsSync(SUMMARY_MODEL_PATH)) return { mode: 'session' };
  try {
    const value = JSON.parse(readFileSync(SUMMARY_MODEL_PATH, 'utf8'));
    if (value?.mode === 'fixed' && value.provider && value.model) return value;
  } catch {
    // Fall through to the safe default.
  }
  return { mode: 'session' };
}

export function saveSummaryModelSetting(value) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SUMMARY_MODEL_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, SUMMARY_MODEL_PATH);
}

const SUMMARY_STATE_PATH = join(DATA_DIR, 'summary-checkpoints.json');

// Checkpoints live inside the per-account store, so the session id alone is
// unique there and survives a server address change.
function summaryKey(sessionId) {
  return `session:${sessionId}`;
}

function legacySummaryKey(binding, sessionId) {
  return createHash('sha256')
    .update(`${binding.serverUrl}#${binding.username}#${sessionId}`)
    .digest('hex')
    .slice(0, 24);
}

function readSummaryState() {
  if (!existsSync(SUMMARY_STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SUMMARY_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function summaryCheckpoint(store, binding, sessionId) {
  const legacy = legacySummaryKey(binding, sessionId);
  return store.summaryCheckpoints?.[summaryKey(sessionId)]
    ?? store.summaryCheckpoints?.[legacy]
    ?? readSummaryState()[legacy]
    ?? null;
}

export function loadSummaryCheckpoint(binding, sessionId) {
  return summaryCheckpoint(loadStore(binding), binding, sessionId);
}

/** Collect every summary fragment for this account, ordered by relevance to
 * `sessionId` and `cwd`: current session first, same-workspace sessions next,
 * then other recent fragments. */
export function listAccountSummaryFragments(binding, sessionId, { cwd = '', workspaceLimit = 30 } = {}) {
  const store = loadStore(binding);
  const cwds = store.sessionWorkspaces || {};
  const normCwd = String(cwd || '').trim();
  const all = [];
  for (const entry of Object.values(store.reports)) {
    if (entry.payload?.author?.username !== binding.username) continue;
    const reportId = String(entry.payload.id);
    const period = entry.payload.period || '';
    const periodLabel = entry.payload.period_label || period;
    const status = entry.payload.status || 'draft';
    for (const record of effectiveSummaryRecords(entry)) {
      if (!record?.id) continue;
      const recCwd = record.session_id ? (cwds[record.session_id] || '') : '';
      const relation = sessionId && record.session_id === sessionId
        ? 'session'
        : (normCwd && recCwd && recCwd === normCwd ? 'workspace' : 'other');
      all.push({
        ...record,
        reportId,
        period,
        periodLabel,
        reportStatus: status,
        relation,
      });
    }
  }
  const byNewest = (a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || Number(b.to_seq || 0) - Number(a.to_seq || 0);
  const sessionFragments = all.filter(item => item.relation === 'session').sort(byNewest);
  const sameWorkspace = all.filter(item => item.relation === 'workspace').sort(byNewest);
  const otherFragments = all.filter(item => item.relation === 'other').sort(byNewest);
  const workspaceFragments = [...sameWorkspace, ...otherFragments].slice(0, workspaceLimit);
  const fragments = [...sessionFragments, ...workspaceFragments];
  return { fragments, sessionFragments, workspaceFragments };
}

export function rememberCurrentPeriod(binding, info) {
  if (!info?.period) return;
  const store = loadStore(binding);
  store.currentPeriod = { period: info.period, label: info.label || info.period };
  saveStore(store);
}

export function fallbackCurrentPeriod(binding) {
  const store = loadStore(binding);
  if (store.currentPeriod?.period) return store.currentPeriod;
  const latest = listPayloads(store).find(r => r.author?.username === binding.username && r.period);
  if (latest) return { period: latest.period, label: latest.period_label || latest.period };
  return null;
}

/** Look up selected fragment ids in this account's store, sorted chronologically
 * so the LLM reads prior progress and open issues in real time order. */
export function findSummaryRecordsByIds(binding, ids, { max = 10 } = {}) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const wanted = new Set(ids.map(id => String(id || '').trim()).filter(Boolean).slice(0, max));
  if (!wanted.size) return [];
  const store = loadStore(binding);
  const found = [];
  const seen = new Set();
  for (const entry of Object.values(store.reports)) {
    if (entry.payload?.author?.username !== binding.username) continue;
    const period = entry.payload.period || '';
    for (const record of effectiveSummaryRecords(entry)) {
      if (!record?.id || !wanted.has(record.id) || seen.has(record.id)) continue;
      seen.add(record.id);
      found.push({ period, record });
    }
  }
  return found.sort((a, b) =>
    String(a.record.created_at || '').localeCompare(String(b.record.created_at || ''))
    || Number(a.record.to_seq || 0) - Number(b.record.to_seq || 0));
}

/** Return up to `limit` most recent summary records for `sessionId` across all
 * weeks of this account, sorted chronologically. */
export function sessionSummaries(binding, sessionId, limit = 5) {
  if (!sessionId || sessionId === 'manual') return [];
  const { sessionFragments } = listAccountSummaryFragments(binding, sessionId);
  return sessionFragments
    .slice(0, limit)
    .reverse()
    .map(item => ({
      period: item.period,
      record: {
        id: item.id,
        session_id: item.session_id,
        from_seq: item.from_seq,
        to_seq: item.to_seq,
        created_at: item.created_at,
        provider: item.provider,
        model: item.model,
        summary: item.summary,
      },
    }));
}

/** Find the most recent summary record already captured for `sessionId`. */
export function latestSessionSummary(binding, sessionId) {
  const list = sessionSummaries(binding, sessionId, 1);
  return list.length ? list[list.length - 1] : null;
}

export function saveSummaryCheckpoint(binding, sessionId, checkpoint) {
  const store = loadStore(binding);
  store.summaryCheckpoints = {
    ...(store.summaryCheckpoints || {}),
    [summaryKey(sessionId)]: checkpoint,
  };
  saveStore(store);
}

// A draft, its summary history and the checkpoint share one atomic store write.
// Serialize mutations so background sync cannot replace a newer local snapshot.
const storeWrites = new Map();
function withStoreLock(operation) {
  return async (binding, ...args) => {
    const key = storePath(binding);
    const previous = storeWrites.get(key);
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(() => operation(binding, ...args));
    storeWrites.set(key, current);
    try {
      return await current;
    } finally {
      if (storeWrites.get(key) === current) storeWrites.delete(key);
    }
  };
}

export function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const path = storePath(store);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Token-authenticated server call; network failures raise NetworkError. */
export async function serverFetch(binding, path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${binding.serverUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${binding.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal,
    });
  } catch (error) {
    throw new NetworkError(error);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, data, text };
}

function effectiveSummaryRecords(entry) {
  if (!entry) return [];
  if (entry.recordsDirty) return entry.localSummaryRecords ?? [];
  if (entry.serverAcceptedRecords === false && entry.localSummaryRecords?.length) {
    return entry.localSummaryRecords;
  }
  if (Array.isArray(entry.payload?.summary_records)) return entry.payload.summary_records;
  return entry.localSummaryRecords ?? [];
}

function sameRecordIds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, idx) => item?.id === b[idx]?.id);
}

function entryFromPayload(payload, previous) {
  const isDraft = payload.status === 'draft';
  const keepLocalRecords = Boolean(
    previous?.recordsDirty
    || (isDraft && previous?.serverAcceptedRecords === false && previous?.localSummaryRecords?.length
      && !(payload.summary_records?.length))
    || (!Array.isArray(payload.summary_records) && previous?.localSummaryRecords),
  );
  return {
    payload,
    localSummaryRecords: keepLocalRecords
      ? previous.localSummaryRecords
      : (Array.isArray(payload.summary_records) ? payload.summary_records : previous?.localSummaryRecords),
    recordsDirty: Boolean(previous?.recordsDirty),
    serverAcceptedRecords: Array.isArray(payload.summary_records)
      ? (keepLocalRecords ? previous?.serverAcceptedRecords : true)
      : previous?.serverAcceptedRecords,
    localId: previous?.localId,
    contentHash: contentHash(payload.content),
    revision: payload.revision,
    baseContent: payload.content ?? '',
    baseRevision: payload.revision,
    dirty: false,
    localContent: null,
    conflict: null,
    lastCompiledBackup: isDraft ? (previous?.lastCompiledBackup ?? null) : null,
    lastCompiledAt: previous?.lastCompiledAt ?? null,
    lastCompiledModel: previous?.lastCompiledModel ?? '',
    lastCompiledRecordIds: previous?.lastCompiledRecordIds ?? [],
  };
}

function queueEdit(store, key) {
  const entry = store.reports[key];
  const content = entry.localContent !== null && entry.localContent !== undefined
    ? entry.localContent
    : (entry.payload.content ?? '');
  const summaryRecords = entry.recordsDirty ? (entry.localSummaryRecords ?? []) : undefined;
  store.pending = store.pending.filter(op => !(op.op === 'edit' && op.key === key));
  const pendingCreate = store.pending.find(op => op.op === 'create' && op.key === key);
  if (pendingCreate) {
    pendingCreate.content = content;
    if (summaryRecords !== undefined) pendingCreate.summaryRecords = summaryRecords;
    return;
  }
  store.pending.push({
    op: 'edit',
    key,
    id: entry.payload.id,
    content,
    ...(summaryRecords !== undefined ? { summaryRecords } : {}),
    baseRevision: entry.baseRevision,
  });
}

/** Apply one sync task to the store. */
function applyTask(store, task) {
  if (task.action === 'delete') {
    const key = String(task.id);
    delete store.reports[key];
    store.pending = store.pending.filter(op => op.key !== key && op.id !== task.id);
    return;
  }
  if (task.action === 'noop') return;
  if (task.action === 'push') {
    const key = String(task.id);
    const entry = store.reports[key];
    if (entry?.dirty && !entry.conflict) queueEdit(store, key);
    return;
  }
  if (task.action === 'pull') {
    const payload = task.report;
    const key = String(payload.id);
    const existing = store.reports[key];
    if (existing?.dirty && existing.baseRevision < payload.revision) {
      // Server moved past our base: three-way merge.
      // A finalized report cannot accept queued edits. Keep the local draft
      // and its records for recovery if another client submitted first.
      if (payload.status !== 'draft') {
        existing.payload = payload;
        existing.revision = payload.revision;
        return;
      }
      const result = diff3(existing.baseContent, existing.localContent, payload.content ?? '');
      existing.payload = payload;
      existing.revision = payload.revision;
      existing.baseContent = payload.content ?? '';
      existing.baseRevision = payload.revision;
      existing.contentHash = contentHash(payload.content);
      if (result.clean) {
        existing.localContent = result.merged;
        existing.conflict = null;
        queueEdit(store, key);
      } else {
        existing.conflict = {
          base: existing.baseContent,
          local: existing.localContent,
          server: payload.content ?? '',
          merged: result.merged,
          regions: result.conflicts,
        };
      }
      return;
    }
    if (existing?.dirty) {
      // Server at our base (push task normally covers this): keep local.
      existing.payload = { ...existing.payload, ...payload, content: existing.localContent };
      return;
    }
    store.reports[key] = entryFromPayload(payload, existing);
  }
}

/** Push queued ops; stops at the first network failure (stays offline). */
async function flushPending(binding, store) {
  const remaining = [];
  const createdIds = new Map();
  for (const op of store.pending) {
    try {
      if (op.op === 'create') {
        const res = await serverFetch(binding, '/reports/', {
          method: 'POST',
          body: JSON.stringify({
            period: op.period,
            content: op.content,
            ...(op.project ? { project: op.project } : {}),
            ...(op.summaryRecords?.length ? { summary_records: op.summaryRecords } : {}),
          }),
        });
        store.online = true;
        const entry = store.reports[op.key];
        const snapshot = res.data?.error?.snapshot;
        // Recover a summary draft if the server saved the POST but its response was lost.
        const sameDraft = res.status === 409 && entry?.localSummaryRecords?.length &&
          res.data.error.code === 'period_exists' && snapshot?.status === 'draft' &&
          snapshot.content === op.content && (snapshot.project?.id ?? null) === (op.project ?? null);
        if (res.ok || sameDraft) {
          const payload = res.ok ? res.data : snapshot;
          const id = String(payload.id);
          const echoed = !op.summaryRecords?.length || sameRecordIds(payload.summary_records, op.summaryRecords);
          delete store.reports[op.key];
          store.reports[id] = {
            ...entryFromPayload(payload, {
              ...entry,
              recordsDirty: false,
              serverAcceptedRecords: echoed,
            }),
            localId: op.key,
          };
          createdIds.set(op.key, id);
          continue;
        }
        if (res.status === 409 || res.status === 400) {
          // Period taken or invalid: keep the local copy, surface the error.
          const entry = store.reports[op.key];
          if (entry) entry.payload.syncError = res.data?.error?.detail || '同步被拒绝';
          remaining.push(op);
          continue;
        }
        remaining.push(op);
        continue;
      }
      if (op.op === 'edit') {
        const entry = store.reports[op.key];
        if (!entry || entry.payload.status !== 'draft') continue;
        const res = await serverFetch(binding, `/reports/${op.id}/`, {
          method: 'PATCH',
          body: JSON.stringify({
            content: op.content,
            revision: op.baseRevision,
            ...(op.summaryRecords !== undefined ? { summary_records: op.summaryRecords } : {}),
          }),
        });
        store.online = true;
        if (res.ok) {
          entry.payload = res.data;
          entry.baseContent = res.data.content ?? '';
          entry.baseRevision = res.data.revision;
          entry.revision = res.data.revision;
          entry.contentHash = contentHash(res.data.content);
          entry.dirty = false;
          entry.localContent = null;
          entry.conflict = null;
          if (op.summaryRecords !== undefined) {
            const echoed = sameRecordIds(res.data.summary_records, op.summaryRecords);
            entry.localSummaryRecords = echoed ? res.data.summary_records : op.summaryRecords;
            entry.recordsDirty = false;
            entry.serverAcceptedRecords = echoed;
          }
          continue;
        }
        if (res.status === 409) {
          // Server newer: drop the op; the next sync pull runs diff3.
          continue;
        }
        remaining.push(op);
        continue;
      }
    } catch (error) {
      if (error instanceof NetworkError) {
        store.online = false;
        remaining.push(op);
        // Push the rest back and stop; we are offline.
        const idx = store.pending.indexOf(op);
        remaining.push(...store.pending.slice(idx + 1));
        break;
      }
      remaining.push(op);
    }
  }
  store.pending = remaining;
  return createdIds;
}

/** Full sync cycle: flush -> manifest -> tasks -> persist. */
export const syncNow = withStoreLock(async function syncNow(binding) {
  return syncStore(binding, loadStore(binding));
});

async function syncStore(binding, store) {
  try {
    await flushPending(binding, store);
    const manifest = Object.entries(store.reports)
      .filter(([key]) => /^\d+$/.test(key))
      .map(([key, entry]) => ({
        id: Number(key),
        content_hash: entry.contentHash,
        revision: entry.revision,
        dirty: entry.dirty,
        base_revision: entry.baseRevision,
      }));
    const res = await serverFetch(binding, '/reports/sync/', {
      method: 'POST',
      body: JSON.stringify({ reports: manifest }),
    });
    if (!res.ok) {
      store.online = true;
      store.lastError = res.data?.error?.detail || `HTTP ${res.status}`;
      // Revoked or expired token: keep the cache, ask for re-authorization.
      store.authExpired = res.data?.error?.code === 'authentication_failed' || res.status === 401;
    } else {
      store.online = true;
      store.lastError = '';
      store.authExpired = false;
      for (const task of res.data.tasks || []) applyTask(store, task);
      store.lastSync = new Date().toISOString();
      // Flush again: pull-merges may have queued clean merges.
      await flushPending(binding, store);
    }
  } catch (error) {
    if (error instanceof NetworkError) {
      store.online = false;
    } else {
      store.lastError = String(error?.message || error);
    }
  }
  saveStore(store);
  return store;
}

export function reportDetail(entry) {
  const serverIds = new Set((entry.payload.summary_records ?? []).map(record => record.id));
  const records = effectiveSummaryRecords(entry);
  const content = entry.dirty && entry.payload.status === 'draft' ? entry.localContent : entry.payload.content;
  const compiledIds = Array.isArray(entry.lastCompiledRecordIds) ? entry.lastCompiledRecordIds : [];
  const compiledSet = new Set(compiledIds);
  const uncompiledCount = entry.payload.status === 'draft' && (content || '').trim()
    ? records.filter(record => !compiledSet.has(record.id)).length
    : 0;
  return {
    ...entry.payload,
    content,
    local_only: !/^\d+$/.test(String(entry.payload.id)),
    dirty: Boolean(entry.dirty || entry.recordsDirty),
    has_conflict: Boolean(entry.conflict),
    conflict: entry.conflict,
    summary_records: records,
    summary_count: records.length,
    summary_records_pending: records.filter(record => !serverIds.has(record.id)).length,
    can_undo_compile: Boolean(entry.payload.status === 'draft' && entry.lastCompiledBackup),
    last_compiled_at: entry.lastCompiledAt || null,
    last_compiled_model: entry.lastCompiledModel || '',
    compiled_record_ids: compiledIds,
    uncompiled_count: uncompiledCount,
  };
}

export function listPayloads(store) {
  return Object.values(store.reports)
    .map(entry => {
      const { summary_records, ...payload } = entry.payload;
      const content = entry.dirty && payload.status === 'draft' ? entry.localContent : payload.content;
      const records = effectiveSummaryRecords(entry);
      return {
        ...payload,
        content,
        local_only: !/^\d+$/.test(String(payload.id)),
        dirty: Boolean(entry.dirty || entry.recordsDirty),
        has_conflict: Boolean(entry.conflict),
        summary_count: records.length || payload.summary_count || 0,
        has_content: Boolean((content || '').trim()),
      };
    })
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

function queueCreate(store, { period, content, project, summaryRecords = [] }) {
  const key = `local-${randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const payload = {
    id: key,
    author: { id: 0, username: store.username, full_name: '' },
    period,
    project: null,
    status: 'draft',
    status_display: '草稿（待同步）',
    revision: 0,
    submitted_at: null,
    created_at: now,
    updated_at: now,
    feedback_count: 0,
    summary_count: summaryRecords.length,
    content,
    summary_records: [],
    feedback: [],
  };
  store.reports[key] = {
    ...entryFromPayload(payload),
    localSummaryRecords: [...summaryRecords],
    recordsDirty: summaryRecords.length > 0,
    baseContent: '',
    dirty: true,
    localContent: content,
  };
  store.pending.push({
    op: 'create',
    key,
    period,
    content,
    project: project || null,
    ...(summaryRecords.length ? { summaryRecords: [...summaryRecords] } : {}),
  });
  return key;
}

/** Local-first draft creation. */
export const createDraft = withStoreLock(async function createDraft(binding, { period, content, project }) {
  const store = loadStore(binding);
  try {
    const res = await serverFetch(binding, '/reports/', {
      method: 'POST',
      body: JSON.stringify({ period, content, ...(project ? { project } : {}) }),
    });
    if (res.ok) {
      store.online = true;
      store.reports[String(res.data.id)] = entryFromPayload(res.data);
      store.lastSync = new Date().toISOString();
      saveStore(store);
      return { status: 201, payload: res.data };
    }
    store.online = true;
    saveStore(store);
    return { status: res.status, payload: res.data };
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    store.online = false;
    const key = queueCreate(store, { period, content, project });
    store.reports[key].payload.status_display = '草稿（离线）';
    saveStore(store);
    return { status: 201, payload: reportDetail(store.reports[key]) };
  }
});

function queueDraftEdit(store, key, content, { summaryRecords } = {}) {
  const entry = store.reports[key];
  entry.localContent = content;
  entry.dirty = true;
  if (summaryRecords !== undefined) {
    entry.localSummaryRecords = [...summaryRecords];
    entry.recordsDirty = true;
  }
  entry.payload = {
    ...entry.payload,
    content,
    ...(summaryRecords !== undefined ? { summary_count: summaryRecords.length } : {}),
    updated_at: new Date().toISOString(),
  };
  entry.conflict = null;
  queueEdit(store, key);
}

/** Local-first draft edit. */
export const editDraft = withStoreLock(async function editDraft(binding, id, content) {
  const store = loadStore(binding);
  const key = String(id);
  const entry = store.reports[key];
  if (!entry) return { status: 404, payload: { error: { code: 'not_found', detail: '本地无此进展' } } };
  if (entry.payload.status !== 'draft') {
    return { status: 400, payload: { error: { code: 'not_draft', detail: '仅草稿可编辑' } } };
  }
  entry.lastCompiledBackup = null;
  queueDraftEdit(store, key, content);
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  return { status: 200, payload: reportDetail(store.reports[createdIds.get(key) ?? key]) };
});

function reportError(status, code, detail) {
  return { status, payload: { error: { code, detail } } };
}

/** Save a conversation progress fragment into the teaching week's summary pool
 * without cluttering the final weekly report body (`content`). */
export const saveReportSummary = withStoreLock(async function saveReportSummary(binding, {
  period, record, checkpoint, toTurn, cwd = '',
}) {
  const store = loadStore(binding);
  const sessionId = record.session_id;
  if (summaryCheckpoint(store, binding, sessionId)?.seq !== checkpoint?.seq) {
    return reportError(409, 'summary_checkpoint_changed', '已有另一条总结写入草稿，请重新总结最新对话');
  }
  await syncStore(binding, store);
  const samePeriod = Object.values(store.reports).filter(entry =>
    entry.payload.author?.username === binding.username && entry.payload.period === period);
  if (samePeriod.some(entry => entry.payload.status !== 'draft')) {
    return reportError(409, 'report_submitted', '该周期已有已提交进展，不能追加对话片段');
  }
  const draft = samePeriod.find(entry => entry.payload.status === 'draft');
  if (draft?.conflict) {
    return reportError(409, 'report_conflict', '该周期草稿有待解决冲突，请先处理');
  }
  let key;
  if (draft) {
    key = String(draft.payload.id);
    const currentContent = draft.dirty ? draft.localContent : (draft.payload.content ?? '');
    const nextRecords = [...effectiveSummaryRecords(draft), record];
    if (nextRecords.length > 100) {
      return reportError(400, 'too_many_summary_records', '单周过程记录已达上限（100 条），请先清理旧片段');
    }
    queueDraftEdit(store, key, currentContent, { summaryRecords: nextRecords });
  } else {
    key = queueCreate(store, {
      period,
      content: '',
      summaryRecords: [record],
    });
  }
  const saved = { seq: record.to_seq, turn: toTurn, period, updatedAt: record.created_at };
  (store.summaryCheckpoints ??= {})[summaryKey(sessionId)] = saved;
  if (cwd && sessionId && sessionId !== 'manual') {
    (store.sessionWorkspaces ??= {})[sessionId] = String(cwd).trim();
  }
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  const report = reportDetail(store.reports[createdIds.get(key) ?? key]);
  return { status: 200, payload: { report, checkpoint: { ...saved, reportId: String(report.id) } } };
});

/** Add a manual progress snippet directly into the teaching week's pool. */
export const addManualSummary = withStoreLock(async function addManualSummary(binding, { period, summary }) {
  const text = String(summary ?? '').replaceAll('\0', '').toWellFormed().trim();
  if (!text) return reportError(400, 'empty_summary', '请输入要记录的进展内容');
  if (text.length > 12000) return reportError(400, 'invalid_summary', '单条记录不能超过 12000 字');
  const store = loadStore(binding);
  await syncStore(binding, store);
  const samePeriod = Object.values(store.reports).filter(entry =>
    entry.payload.author?.username === binding.username && entry.payload.period === period);
  if (samePeriod.some(entry => entry.payload.status !== 'draft')) {
    return reportError(409, 'report_submitted', '该周期已提交，不能再补记片段');
  }
  const draft = samePeriod.find(entry => entry.payload.status === 'draft');
  if (draft?.conflict) {
    return reportError(409, 'report_conflict', '该周期草稿有待解决冲突，请先处理');
  }
  const record = {
    id: randomUUID(),
    session_id: 'manual',
    from_seq: 0,
    to_seq: 0,
    created_at: new Date().toISOString(),
    provider: 'manual',
    model: 'manual',
    summary: text,
  };
  let key;
  if (draft) {
    key = String(draft.payload.id);
    const currentContent = draft.dirty ? draft.localContent : (draft.payload.content ?? '');
    const nextRecords = [...effectiveSummaryRecords(draft), record];
    if (nextRecords.length > 100) {
      return reportError(400, 'too_many_summary_records', '单周过程记录已达上限（100 条），请先清理旧片段');
    }
    queueDraftEdit(store, key, currentContent, { summaryRecords: nextRecords });
  } else {
    key = queueCreate(store, { period, content: '', summaryRecords: [record] });
  }
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  const report = reportDetail(store.reports[createdIds.get(key) ?? key]);
  return { status: 200, payload: { report, record } };
});

/** Remove one unwanted progress fragment from a draft week. */
export const removeReportSummary = withStoreLock(async function removeReportSummary(binding, id, recordId) {
  const store = loadStore(binding);
  const key = String(id);
  const entry = store.reports[key];
  if (!entry || entry.payload.author?.username !== binding.username) {
    return reportError(404, 'report_not_found', '本地无此进展');
  }
  if (entry.payload.status !== 'draft') {
    return reportError(409, 'report_submitted', '已提交的进展不能删除过程记录');
  }
  if (entry.conflict) {
    return reportError(409, 'report_conflict', '该草稿有待解决冲突，请先处理');
  }
  const current = effectiveSummaryRecords(entry);
  const removed = current.find(record => record.id === recordId);
  if (!removed) {
    return reportError(404, 'summary_not_found', '未找到对应的过程片段');
  }
  const next = current.filter(record => record.id !== recordId);
  const content = entry.dirty ? entry.localContent : (entry.payload.content ?? '');
  queueDraftEdit(store, key, content, { summaryRecords: next });
  // If the deleted fragment was the latest checkpoint for its DSH session,
  // roll back the checkpoint so the user can re-summarize those turns cleanly.
  if (removed.session_id && removed.session_id !== 'manual') {
    const ckKey = summaryKey(removed.session_id);
    const ck = store.summaryCheckpoints?.[ckKey];
    if (ck && Number(ck.seq) === Number(removed.to_seq)) {
      let prev = null;
      for (const other of Object.values(store.reports)) {
        if (other.payload?.author?.username !== binding.username) continue;
        for (const rec of effectiveSummaryRecords(other)) {
          if (rec?.session_id !== removed.session_id) continue;
          if (!prev || Number(rec.to_seq || 0) > Number(prev.rec.to_seq || 0)) {
            prev = { rec, period: other.payload?.period || '' };
          }
        }
      }
      if (prev) {
        store.summaryCheckpoints[ckKey] = {
          seq: prev.rec.to_seq,
          turn: 0,
          period: prev.period,
          updatedAt: prev.rec.created_at,
        };
      } else {
        delete store.summaryCheckpoints[ckKey];
      }
    }
  }
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  return { status: 200, payload: reportDetail(store.reports[createdIds.get(key) ?? key]) };
});

/** Save a synthesized weekly report body while keeping a 1-step local undo backup. */
export const saveCompiledReport = withStoreLock(async function saveCompiledReport(binding, id, {
  content, recordIds, provider, model,
}) {
  const store = loadStore(binding);
  const key = String(id);
  const entry = store.reports[key];
  if (!entry || entry.payload.author?.username !== binding.username) {
    return reportError(404, 'report_not_found', '本地无此进展');
  }
  if (entry.payload.status !== 'draft') {
    return reportError(409, 'report_submitted', '该周期已提交，不能覆盖周报正文');
  }
  if (entry.conflict) {
    return reportError(409, 'report_conflict', '该草稿有待解决冲突，请先处理');
  }
  const previousContent = entry.dirty ? (entry.localContent ?? '') : (entry.payload.content ?? '');
  entry.lastCompiledBackup = {
    content: previousContent,
    previousRecordIds: Array.isArray(entry.lastCompiledRecordIds) ? [...entry.lastCompiledRecordIds] : [],
    previousCompiledAt: entry.lastCompiledAt || null,
    previousCompiledModel: entry.lastCompiledModel || '',
  };
  entry.lastCompiledRecordIds = [...recordIds];
  entry.lastCompiledAt = new Date().toISOString();
  entry.lastCompiledModel = `${provider}/${model}`;
  queueDraftEdit(store, key, content);
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  return { status: 200, payload: reportDetail(store.reports[createdIds.get(key) ?? key]) };
});

/** Revert the draft body to the exact text saved right before the last AI compile. */
export const undoCompiledReport = withStoreLock(async function undoCompiledReport(binding, id) {
  const store = loadStore(binding);
  const key = String(id);
  const entry = store.reports[key];
  if (!entry || entry.payload.author?.username !== binding.username) {
    return reportError(404, 'report_not_found', '本地无此进展');
  }
  if (entry.payload.status !== 'draft') {
    return reportError(409, 'report_submitted', '已提交的进展无法撤销提炼');
  }
  if (entry.conflict) {
    return reportError(409, 'report_conflict', '该草稿有待解决冲突，请先处理');
  }
  const backup = entry.lastCompiledBackup;
  if (!backup) {
    return reportError(404, 'no_compile_backup', '没有可撤销的提炼记录');
  }
  entry.lastCompiledRecordIds = backup.previousRecordIds ?? [];
  entry.lastCompiledAt = backup.previousCompiledAt ?? null;
  entry.lastCompiledModel = backup.previousCompiledModel ?? '';
  entry.lastCompiledBackup = null;
  queueDraftEdit(store, key, backup.content ?? '');
  saveStore(store);
  const createdIds = await flushPending(binding, store);
  saveStore(store);
  return { status: 200, payload: reportDetail(store.reports[createdIds.get(key) ?? key]) };
});

/** Conflict resolution: choice local|server|custom (content required for custom). */
export const resolveConflict = withStoreLock(async function resolveConflict(binding, id, { choice, content }) {
  const store = loadStore(binding);
  const key = String(id);
  const entry = store.reports[key];
  if (!entry?.conflict) return { status: 404, payload: { error: { code: 'no_conflict', detail: '无待解决冲突' } } };
  const picked = choice === 'local' ? entry.conflict.local
    : choice === 'server' ? entry.conflict.server
      : content;
  if (typeof picked !== 'string') {
    return { status: 400, payload: { error: { code: 'invalid_choice', detail: 'choice 应为 local/server/custom' } } };
  }
  entry.localContent = picked;
  entry.conflict = null;
  entry.dirty = true;
  entry.payload = { ...entry.payload, content: picked };
  queueEdit(store, key);
  try {
    await flushPending(binding, store);
    store.online = true;
  } catch (error) {
    if (error instanceof NetworkError) store.online = false;
  }
  saveStore(store);
  return { status: 200, payload: reportDetail(entry) };
});

/** Submit from either the workbench or the agent tool. */
export const submitReport = withStoreLock(async function submitReport(binding, id, { signal } = {}) {
  const store = loadStore(binding);
  const key = String(id);
  if (!/^\d+$/.test(key)) {
    return reportError(409, 'report_unsynced', '请先同步草稿，再提交进展');
  }
  if (store.reports[key]?.dirty) {
    await syncStore(binding, store);
  }
  const entry = store.reports[key];
  if (entry?.dirty && entry.payload.status === 'draft') {
    return store.online
      ? reportError(409, 'report_unsynced', '请先同步草稿并处理冲突，再提交进展')
      : reportError(503, 'offline_required', '提交进展需要在线连接');
  }
  const records = effectiveSummaryRecords(entry);
  const path = `/reports/${id}/`;
  const body = entry ? { revision: entry.revision } : {};
  try {
    if (records.length) {
      // Older servers silently ignore extra fields on submit. Check support
      // before issuing the irreversible state transition.
      const current = await serverFetch(binding, path, { signal });
      if (!current.ok) return { status: current.status, payload: current.data, text: current.text };
      if (!Array.isArray(current.data?.summary_records)) {
        return reportError(409, 'summary_records_unsupported', '工作台服务器尚不支持总结记录，请在服务器升级后提交');
      }
      body.summary_records = records;
    }
    const submitted = await serverFetch(binding, `${path}submit/`, {
      method: 'POST', body: JSON.stringify(body), signal,
    });
    if (!submitted.ok) return { status: submitted.status, payload: submitted.data, text: submitted.text };
    const received = new Map((submitted.data?.summary_records ?? []).map(record => [record.id, record]));
    if (records.some(record => !received.has(record.id))) {
      return reportError(502, 'summary_records_unconfirmed', '服务器未确认总结记录，请查看提交状态后重试');
    }
    store.reports[key] = entryFromPayload(submitted.data, entry);
    store.online = true;
    saveStore(store);
    return { status: submitted.status, payload: reportDetail(store.reports[key]) };
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return reportError(503, 'offline_required', '暂时无法连接服务器，请检查提交状态后重试');
  }
});

/** Write the Markdown export under ~/.aecpt/exports; return its path. */
export function exportToFile(store) {
  mkdirSync(EXPORT_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 10);
  const account = String(store.username || 'account').replace(/[^A-Za-z0-9_.-]/g, '_');
  const path = join(EXPORT_DIR, `aecpt-reports-${account}-${stamp}.md`);
  writeFileSync(path, exportMarkdown(store), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** Markdown export of the locally visible reports. */
export function exportMarkdown(store) {
  const lines = [
    '# AeCpt 学习/研究进展导出',
    '',
    `导出时间：${new Date().toLocaleString('zh-CN')} · 账号：${store.username} · 最后同步：${store.lastSync ? new Date(store.lastSync).toLocaleString('zh-CN') : '从未'}`,
    '',
  ];
  for (const item of listPayloads(store)) {
    lines.push(`## ${item.period_label || item.period} · ${item.author?.full_name || item.author?.username || ''}（#${item.id}）`);
    lines.push('');
    lines.push(`状态：${item.status_display}${item.dirty ? ' · 含未同步修改' : ''}${item.has_conflict ? ' · 含待解决冲突' : ''}`);
    if (item.project) lines.push(`项目：${item.project.name || item.project}`);
    lines.push('');
    lines.push(item.content || '（正文为空）');
    lines.push('');
    for (const f of item.feedback || []) {
      lines.push(`> 反馈 · ${f.author?.full_name || f.author?.username || ''}：${f.content}`);
      lines.push('');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}