// Core of agent-bridge: session registry, encrypted messaging, inbox handling.
// One Bridge instance lives inside each MCP server process, i.e. one per
// Claude Code or Codex session.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateIdentity, fingerprint, signObject, verifyObject, seal, open } from './crypto.mjs';
import { resolveProject, gitBranch } from './project.mjs';
import {
  bridgeHome,
  ensurePrivateDir,
  writeFileAtomic,
  deliverFileAtomic,
  readJsonSafe,
  listDir,
  removeQuietly,
  pidAlive,
} from './store.mjs';

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const LIMITS = {
  maxMessageBytes: envInt('AGENT_BRIDGE_MAX_MESSAGE_BYTES', 8 * 1024),
  maxStatusChars: 280,
  maxNameChars: 40,
  rateWindowMs: 60_000,
  rateMaxMessages: envInt('AGENT_BRIDGE_RATE_LIMIT', 30),
  inboxMaxFiles: 200,
  heartbeatMs: 10_000,
  unresponsiveMs: 45_000,
  deadAfterMs: 10 * 60_000,
  gcAfterMs: 24 * 60 * 60_000,
  maxClockSkewMs: 5 * 60_000,
  maxMessageAgeMs: 7 * 24 * 60 * 60_000,
  historyMax: 200,
  maxRecentFiles: 8,
};

export class BridgeError extends Error {}

// Whether an idle Claude Code session can be woken by the Stop-hook watcher. A
// background waiter would keep one-shot `claude -p` and SDK runs from exiting,
// so by default only interactive sessions get it (AGENT_BRIDGE_WAKE=always|never overrides).
export function idleWakeEnabled(env = process.env) {
  const mode = String(env.AGENT_BRIDGE_WAKE || 'auto').toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return !String(env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk-');
}

const MSG_ID_RE = /^m-[0-9a-f]{16}$/;
const SESSION_ID_RE = /^[0-9a-f]{16}$/;
const BROADCAST = new Set(['all', '*', 'everyone', 'broadcast']);

// Strip terminal escapes, control characters, and invisible/bidi characters,
// and defang anything that could close the <peer-message> wrapper.
export function sanitizeText(s) {
  return String(s)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/<(\/?)(peer-message)/gi, '&lt;$1$2');
}

const oneLine = (s, max) => sanitizeText(s).replace(/\s+/g, ' ').trim().slice(0, max);

export function sanitizeName(s) {
  return String(s ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.maxNameChars);
}

export class Bridge {
  constructor({ host = 'unknown', hostVersion = null, hostSessionId = null, preferredName = null, wakeable = false } = {}) {
    this.identity = generateIdentity();
    this.host = oneLine(host, 20) || 'unknown';
    this.hostVersion = hostVersion ? oneLine(hostVersion, 40) : null;
    this.hostSessionId = hostSessionId ? oneLine(hostSessionId, 100) : null;
    this.preferredName = sanitizeName(preferredName);
    this.wakeable = Boolean(wakeable);
    this.name = null;
    this.status = '';
    this.state = 'idle';
    this.activity = null;
    this.recentFiles = [];
    this.startedAt = Date.now();
    this.project = null;
    this.pending = [];
    this.history = [];
    this.seen = new Set();
    this.announced = new Set();
    this.sendTimes = [];
    this.quarantined = 0;
    this.autoContinues = 0;
    this.knownPeers = new Map();
    this.introduced = false;
    this.beats = 0;
    this.lastWrite = 0;
    this.timer = null;
    this.left = false;
  }

  get id() {
    return this.identity.id;
  }

  get joined() {
    return this.project !== null && !this.left;
  }

  // ---- paths -------------------------------------------------------------

  projectDir() {
    return path.join(bridgeHome(), 'projects', this.project.id);
  }
  sessionsDir() {
    return path.join(this.projectDir(), 'sessions');
  }
  inboxDir(id) {
    return path.join(this.projectDir(), 'inbox', id);
  }
  quarantineDir() {
    return path.join(this.projectDir(), 'quarantine');
  }
  ensureInbox(id) {
    const base = this.inboxDir(id);
    ensurePrivateDir(path.join(base, 'new'));
    ensurePrivateDir(path.join(base, 'tmp'));
    return base;
  }

  // ---- lifecycle ---------------------------------------------------------

  // Join the project containing `dir`. A session joins exactly once: later
  // working-directory changes (e.g. `cd` in a shell tool) don't move it.
  join(dir) {
    if (this.left) throw new BridgeError('This session has left the bridge.');
    if (this.project) return;
    const project = resolveProject(dir);
    this.project = project;
    ensurePrivateDir(this.sessionsDir());
    ensurePrivateDir(this.quarantineDir());
    this.ensureInbox(this.id);
    const meta = path.join(this.projectDir(), 'project.json');
    if (!fs.existsSync(meta)) {
      writeFileAtomic(this.projectDir(), 'project.json', JSON.stringify({ root: project.root, key: project.key }));
    }
    this.name = this.pickName();
    this.writeRecord();
    this.gc();
    if (!this.timer) {
      this.timer = setInterval(() => this.heartbeat(), LIMITS.heartbeatMs);
      this.timer.unref();
    }
  }

  pickName() {
    const fallback = `${sanitizeName(this.host) || 'agent'}-${this.id.slice(0, 4)}`;
    const wanted = this.preferredName || fallback;
    const taken = this.sessions().some((s) => s.alive && s.id !== this.id && s.name?.toLowerCase() === wanted.toLowerCase());
    return taken ? `${wanted.slice(0, LIMITS.maxNameChars - 5)}-${this.id.slice(0, 4)}` : wanted;
  }

  heartbeat() {
    if (!this.joined) return;
    this.beats += 1;
    try {
      if (this.beats % 6 === 0) this.project.branch = gitBranch(this.project.cwd);
      this.writeRecord();
      if (this.beats % 30 === 0) this.gc();
    } catch (err) {
      process.stderr.write(`agent-bridge: heartbeat failed: ${err.message}\n`);
    }
  }

  leave() {
    if (this.left) return;
    this.left = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.project) return;
    try {
      this.state = 'ended';
      this.endedAt = Date.now();
      this.writeRecord();
      // Our private keys die with this process, so nothing left in the inbox is readable.
      removeQuietly(this.inboxDir(this.id));
    } catch {
      // best effort on shutdown
    }
  }

  // ---- registry ----------------------------------------------------------

  buildRecord() {
    const p = this.project;
    const rec = {
      v: 1,
      id: this.id,
      project: p.id,
      keys: { sign: this.identity.signPub, enc: this.identity.encPub },
      host: this.host,
      hostVersion: this.hostVersion,
      hostSessionId: this.hostSessionId,
      wakeable: this.wakeable,
      pid: process.pid,
      hostPid: process.ppid,
      name: this.name,
      status: this.status,
      state: this.state,
      cwd: p.cwd,
      worktree: p.worktree,
      root: p.root,
      branch: p.branch,
      activity: this.activity,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      endedAt: this.endedAt,
    };
    rec.sig = signObject(rec, this.identity.signKey);
    return rec;
  }

  writeRecord() {
    if (!this.project) return;
    writeFileAtomic(this.sessionsDir(), `${this.id}.json`, JSON.stringify(this.buildRecord()));
    this.lastWrite = Date.now();
  }

  // Write at most every few seconds for high-frequency updates (tool activity).
  touch(force = false) {
    if (force || Date.now() - this.lastWrite > 3000) this.writeRecord();
  }

  static verifyRecord(rec, projectId) {
    if (!rec || rec.v !== 1 || typeof rec.id !== 'string' || !SESSION_ID_RE.test(rec.id)) return false;
    if (projectId && rec.project !== projectId) return false;
    if (!rec.keys || fingerprint(rec.keys.sign, rec.keys.enc) !== rec.id) return false;
    const { sig, ...rest } = rec;
    return verifyObject(rest, sig, rec.keys.sign);
  }

  static liveness(rec, now = Date.now()) {
    if (rec.state === 'ended') return 'ended';
    if (!pidAlive(rec.pid) || now - rec.updatedAt > LIMITS.deadAfterMs) return 'dead';
    if (now - rec.updatedAt > LIMITS.unresponsiveMs) return 'unresponsive';
    return 'alive';
  }

  getRecord(id) {
    if (!SESSION_ID_RE.test(String(id))) return null;
    try {
      const rec = readJsonSafe(path.join(this.sessionsDir(), `${id}.json`), 64 * 1024);
      return rec.id === id && Bridge.verifyRecord(rec, this.project.id) ? Bridge.cleanRecord(rec) : null;
    } catch {
      return null;
    }
  }

  // A valid signature only proves a record is self-consistent; any local process
  // could mint one. Normalize every displayed field before it reaches a model.
  static cleanRecord(rec) {
    const text = (v, max) => (typeof v === 'string' ? oneLine(v, max) : null);
    const activity = rec.activity && typeof rec.activity === 'object'
      ? {
          tool: text(rec.activity.tool, 80) || 'unknown',
          files: Array.isArray(rec.activity.files) ? rec.activity.files.slice(0, LIMITS.maxRecentFiles).map((f) => text(f, 300)).filter(Boolean) : [],
          at: Number(rec.activity.at) || 0,
        }
      : null;
    return {
      ...rec,
      name: sanitizeName(rec.name) || `session-${rec.id.slice(0, 4)}`,
      host: sanitizeName(rec.host).slice(0, 20) || 'unknown',
      status: text(rec.status, LIMITS.maxStatusChars) || '',
      state: ['working', 'idle', 'waiting', 'ended'].includes(rec.state) ? rec.state : 'idle',
      branch: text(rec.branch, 100),
      cwd: text(rec.cwd, 500),
      worktree: text(rec.worktree, 500),
      root: text(rec.root, 500),
      startedAt: Number(rec.startedAt) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
      activity,
    };
  }

  sessions() {
    if (!this.project) return [];
    const out = [];
    for (const file of listDir(this.sessionsDir())) {
      if (!file.endsWith('.json')) continue;
      const rec = this.getRecord(file.slice(0, -5));
      if (!rec) continue;
      const liveness = Bridge.liveness(rec);
      out.push({ ...rec, liveness, alive: liveness === 'alive' || liveness === 'unresponsive', self: rec.id === this.id });
    }
    return out.sort((a, b) => Number(b.self) - Number(a.self) || b.updatedAt - a.updatedAt);
  }

  activePeers() {
    return this.sessions().filter((s) => s.alive && !s.self);
  }

  // ---- state updates -------------------------------------------------------

  setHostSession(id) {
    const clean = id ? oneLine(id, 100) : null;
    if (clean && clean !== this.hostSessionId) {
      this.hostSessionId = clean;
      if (this.joined) this.writeRecord();
    }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.joined) this.writeRecord();
  }

  setStatus({ status, name } = {}) {
    this.requireJoined();
    if (name !== undefined && name !== null && name !== '') {
      const clean = sanitizeName(name);
      if (!clean) throw new BridgeError('Name must contain letters, digits, ".", "_" or "-".');
      const clash = this.activePeers().find((s) => s.name?.toLowerCase() === clean.toLowerCase());
      if (clash) throw new BridgeError(`Name "${clean}" is already used by session ${clash.id}.`);
      this.name = clean;
    }
    if (status !== undefined && status !== null) this.status = oneLine(status, LIMITS.maxStatusChars);
    this.writeRecord();
  }

  recordToolUse(toolName, toolInput) {
    if (!this.joined || !toolName || /agent[-_]bridge/i.test(toolName)) return;
    let input = toolInput;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { command: input };
      }
    }
    const files = extractFiles(input && typeof input === 'object' ? input : {}).map((f) => this.relPath(f));
    const before = this.recentFiles.join('\n');
    if (files.length) {
      this.recentFiles = [...new Set([...files, ...this.recentFiles])].slice(0, LIMITS.maxRecentFiles);
    }
    const stateChanged = this.state !== 'working';
    this.state = 'working';
    this.activity = { tool: oneLine(toolName, 80), files: this.recentFiles, at: Date.now() };
    this.touch(stateChanged || before !== this.recentFiles.join('\n'));
  }

  relPath(p) {
    const clean = oneLine(p, 300);
    if (path.isAbsolute(clean)) {
      for (const base of [this.project.worktree, this.project.root]) {
        const rel = path.relative(base, clean);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel || '.';
      }
    }
    return clean;
  }

  requireJoined() {
    if (!this.joined) {
      throw new BridgeError('agent-bridge has not determined which project this session belongs to yet.');
    }
  }

  // ---- messaging -----------------------------------------------------------

  resolveTargets(to) {
    const t = String(to ?? '').trim();
    if (!t) throw new BridgeError('`to` is required: a session name, a session id (or unique prefix), or "all".');
    const peers = this.sessions().filter((s) => !s.self);
    const active = peers.filter((s) => s.alive);
    const lc = t.toLowerCase();
    const roster = () => (active.length ? active.map((s) => `${s.name} (${s.host}, id ${s.id})`).join(', ') : 'none');
    if (BROADCAST.has(lc)) {
      if (!active.length) throw new BridgeError('No other active sessions in this project.');
      return { kind: 'broadcast', targets: active };
    }
    if (lc === this.id || lc === this.name?.toLowerCase()) throw new BridgeError('That is this session.');
    let matches = peers.filter((s) => s.id === lc || s.name?.toLowerCase() === lc);
    if (!matches.length && /^[0-9a-f]{4,16}$/.test(lc)) matches = peers.filter((s) => s.id.startsWith(lc));
    const live = matches.filter((s) => s.alive);
    if (live.length === 1) return { kind: 'direct', targets: live };
    if (live.length > 1) {
      throw new BridgeError(`"${t}" is ambiguous: ${live.map((s) => `${s.name} (id ${s.id})`).join(', ')}. Use a full id.`);
    }
    if (matches.length) throw new BridgeError(`Session "${t}" has ended and can no longer receive messages. Active sessions: ${roster()}.`);
    throw new BridgeError(`No session matches "${t}". Active sessions: ${roster()}.`);
  }

  send({ to, message, replyTo, expectsReply } = {}) {
    this.requireJoined();
    if (typeof message !== 'string' || !message.trim()) throw new BridgeError('`message` must be a non-empty string.');
    const bytes = Buffer.byteLength(message, 'utf8');
    if (bytes > LIMITS.maxMessageBytes) {
      throw new BridgeError(`Message is ${bytes} bytes; the limit is ${LIMITS.maxMessageBytes}. Summarize it, or point the peer at a file.`);
    }
    if (replyTo !== undefined && replyTo !== null && replyTo !== '' && !MSG_ID_RE.test(String(replyTo))) {
      throw new BridgeError('`reply_to` must be a message id like "m-0123456789abcdef".');
    }
    const now = Date.now();
    this.sendTimes = this.sendTimes.filter((t) => now - t < LIMITS.rateWindowMs);
    if (this.sendTimes.length >= LIMITS.rateMaxMessages) {
      throw new BridgeError(`Rate limit reached (${LIMITS.rateMaxMessages} messages per minute). Slow down; avoid reply loops.`);
    }
    const { kind, targets } = this.resolveTargets(to);
    this.sendTimes.push(now);

    const id = `m-${crypto.randomBytes(8).toString('hex')}`;
    const payload = { body: message, replyTo: replyTo || null, expectsReply: Boolean(expectsReply) };
    const delivered = [];
    const failed = [];
    for (const target of targets) {
      try {
        const base = this.ensureInbox(target.id);
        if (listDir(path.join(base, 'new')).length >= LIMITS.inboxMaxFiles) throw new Error('inbox is full');
        const header = { v: 1, id, project: this.project.id, from: this.id, to: target.id, ts: now, kind };
        const envelope = seal(header, payload, this.identity, target.keys.enc);
        deliverFileAtomic(path.join(base, 'tmp'), path.join(base, 'new'), `${now}-${id}.json`, JSON.stringify(envelope));
        delivered.push(target);
      } catch (err) {
        failed.push({ target, error: err.message });
      }
    }
    if (delivered.length) {
      this.pushHistory({
        dir: 'out',
        id,
        ts: now,
        kind,
        to: delivered.map((t) => t.name),
        body: sanitizeText(message),
        replyTo: payload.replyTo,
        expectsReply: payload.expectsReply,
      });
    }
    return { id, kind, delivered, failed };
  }

  // Move verified messages from the on-disk inbox into memory. Anything that
  // fails verification is quarantined and counted, never delivered.
  drain() {
    if (!this.joined) return 0;
    const dir = path.join(this.inboxDir(this.id), 'new');
    let added = 0;
    for (const file of listDir(dir).sort().slice(0, 100)) {
      const full = path.join(dir, file);
      let msg;
      try {
        const envelope = readJsonSafe(full, LIMITS.maxMessageBytes * 2 + 16 * 1024);
        msg = this.openEnvelope(envelope);
      } catch (err) {
        this.quarantine(full, file, err.message);
        continue;
      }
      removeQuietly(full);
      if (this.seen.has(msg.id)) continue;
      this.seen.add(msg.id);
      this.pending.push(msg);
      added += 1;
    }
    return added;
  }

  openEnvelope(envelope) {
    const h = envelope?.header;
    if (!h || h.v !== 1) throw new Error('unsupported envelope');
    if (h.project !== this.project.id) throw new Error('wrong project');
    if (h.to !== this.id) throw new Error('not addressed to this session');
    if (!MSG_ID_RE.test(String(h.id))) throw new Error('malformed message id');
    const now = Date.now();
    if (typeof h.ts !== 'number' || h.ts > now + LIMITS.maxClockSkewMs || h.ts < now - LIMITS.maxMessageAgeMs) {
      throw new Error('timestamp out of range');
    }
    const sender = this.getRecord(h.from);
    if (!sender) throw new Error('unknown or unverifiable sender');
    const payload = open(envelope, this.identity, sender);
    if (typeof payload?.body !== 'string') throw new Error('malformed payload');
    return {
      id: h.id,
      ts: h.ts,
      kind: h.kind === 'broadcast' ? 'broadcast' : 'direct',
      from: sender.id,
      fromName: sender.name,
      fromHost: sender.host,
      body: sanitizeText(payload.body).slice(0, LIMITS.maxMessageBytes),
      replyTo: MSG_ID_RE.test(String(payload.replyTo)) ? payload.replyTo : null,
      expectsReply: payload.expectsReply === true,
    };
  }

  quarantine(full, file, reason) {
    this.quarantined += 1;
    process.stderr.write(`agent-bridge: rejected message ${file}: ${reason}\n`);
    try {
      fs.renameSync(full, path.join(this.quarantineDir(), `${Date.now()}-${this.id}-${file}`));
    } catch {
      removeQuietly(full);
    }
  }

  // Take pending messages up to a rough size budget (always at least one).
  takePending(maxChars = Infinity) {
    const out = [];
    let used = 0;
    while (this.pending.length) {
      const next = this.pending[0];
      const size = next.body.length + 300;
      if (out.length && used + size > maxChars) break;
      out.push(this.pending.shift());
      used += size;
    }
    for (const m of out) this.pushHistory({ dir: 'in', ...m });
    return out;
  }

  takeQuarantineCount() {
    const n = this.quarantined;
    this.quarantined = 0;
    return n;
  }

  pushHistory(entry) {
    this.history.push(entry);
    if (this.history.length > LIMITS.historyMax) this.history.splice(0, this.history.length - LIMITS.historyMax);
  }

  // Report sessions that joined or left since the last call.
  rosterChanges() {
    const peers = this.activePeers();
    const prev = this.knownPeers;
    this.knownPeers = new Map(peers.map((p) => [p.id, p.name]));
    const ids = new Set(peers.map((p) => p.id));
    return {
      peers,
      joined: peers.filter((p) => !prev.has(p.id)),
      left: [...prev].filter(([id]) => !ids.has(id)).map(([id, name]) => ({ id, name })),
    };
  }

  // ---- housekeeping --------------------------------------------------------

  gc() {
    if (!this.project) return;
    const now = Date.now();
    const sessionsDir = this.sessionsDir();
    for (const file of listDir(sessionsDir)) {
      const full = path.join(sessionsDir, file);
      const id = file.replace(/\.json$/, '');
      if (id === this.id) continue;
      const rec = this.getRecord(id);
      if (!rec) {
        // Unverifiable junk: drop it once it's clearly not a write in progress.
        try {
          if (now - fs.lstatSync(full).mtimeMs > 60 * 60_000) removeQuietly(full);
        } catch {
          // gone already
        }
        continue;
      }
      const liveness = Bridge.liveness(rec, now);
      if (liveness === 'ended' || liveness === 'dead') {
        removeQuietly(this.inboxDir(id));
        // Keep the public record for a while so its past messages still verify.
        if (now - (rec.endedAt || rec.updatedAt) > LIMITS.gcAfterMs) removeQuietly(full);
      }
    }
    const inboxRoot = path.join(this.projectDir(), 'inbox');
    for (const id of listDir(inboxRoot)) {
      const tmp = path.join(inboxRoot, id, 'tmp');
      for (const f of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) {
        try {
          if (now - fs.lstatSync(path.join(tmp, f)).mtimeMs > 60 * 60_000) removeQuietly(path.join(tmp, f));
        } catch {
          // ignore
        }
      }
      if (id !== this.id && !fs.existsSync(path.join(sessionsDir, `${id}.json`))) removeQuietly(path.join(inboxRoot, id));
    }
    for (const f of listDir(this.quarantineDir())) {
      const full = path.join(this.quarantineDir(), f);
      try {
        if (now - fs.lstatSync(full).mtimeMs > LIMITS.gcAfterMs) removeQuietly(full);
      } catch {
        // ignore
      }
    }
  }
}

// Pull file paths out of Claude Code (Edit/Write/...) and Codex (apply_patch) tool inputs.
export function extractFiles(input) {
  const out = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key]) out.push(input[key]);
  }
  for (const key of ['patch', 'input', 'command']) {
    const v = input[key];
    const text = Array.isArray(v) ? v.join('\n') : v;
    if (typeof text === 'string' && text.includes('*** ')) {
      for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
        out.push((m[1] || m[2]).trim());
      }
    }
  }
  return out;
}
