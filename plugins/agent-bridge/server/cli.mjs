#!/usr/bin/env node
// Human-facing CLI: list sessions, check the installation, or wipe local state.
// Message bodies are end-to-end encrypted between sessions and can't be read here.

import fs from 'node:fs';
import path from 'node:path';
import { Bridge } from './bridge.mjs';
import { hostLabel } from './format.mjs';
import { bridgeHome, listDir, readJsonSafe, removeQuietly } from './store.mjs';

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const projectsDir = () => path.join(bridgeHome(), 'projects');

const tryRead = (file) => {
  try {
    return readJsonSafe(file, 64 * 1024);
  } catch {
    return null;
  }
};

function projects() {
  return listDir(projectsDir()).map((id) => {
    const dir = path.join(projectsDir(), id);
    const records = [];
    let invalid = 0;
    for (const file of listDir(path.join(dir, 'sessions'))) {
      const rec = tryRead(path.join(dir, 'sessions', file));
      if (rec && `${rec.id}.json` === file && Bridge.verifyRecord(rec, id)) records.push({ ...rec, liveness: Bridge.liveness(rec) });
      else invalid += 1;
    }
    return { id, dir, root: tryRead(path.join(dir, 'project.json'))?.root, records, invalid };
  });
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function sessions() {
  let shown = 0;
  for (const p of projects()) {
    const recs = p.records.filter((r) => flags.has('--all') || r.liveness === 'alive' || r.liveness === 'unresponsive');
    if (!recs.length) continue;
    console.log(`\n${p.root || p.id}`);
    for (const r of recs.sort((a, b) => b.updatedAt - a.updatedAt)) {
      shown += 1;
      const unread = listDir(path.join(p.dir, 'inbox', r.id, 'new')).length;
      const state = r.liveness === 'alive' ? r.state : r.liveness;
      console.log(
        `  ${r.name.padEnd(22)} ${hostLabel(r.host).padEnd(12)} ${state.padEnd(13)} ${ago(r.updatedAt).padEnd(9)} id ${r.id}` +
          `${r.branch ? `  (${r.branch})` : ''}${unread ? `  ${unread} unread` : ''}`,
      );
      if (r.status) console.log(`  ${''.padEnd(22)} ${r.status}`);
    }
  }
  if (!shown) console.log(flags.has('--all') ? 'No sessions recorded.' : 'No active sessions. (Use --all to include ended ones.)');
}

function doctor() {
  const problems = [];
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`node ${process.versions.node}: ${major >= 18 ? 'ok' : 'too old (need 18+)'}`);
  if (major < 18) problems.push('Node.js 18+ is required.');
  const home = bridgeHome();
  console.log(`state directory: ${home}`);
  const checkDir = (dir) => {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) problems.push(`${dir} is not a real directory`);
      else if (typeof process.getuid === 'function' && st.uid !== process.getuid()) problems.push(`${dir} is owned by another user`);
      else if (st.mode & 0o077) problems.push(`${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)})`);
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push(`${dir}: ${err.message}`);
    }
  };
  checkDir(home);
  checkDir(projectsDir());
  let records = 0;
  let invalid = 0;
  let quarantined = 0;
  for (const p of projects()) {
    for (const sub of ['', 'sessions', 'inbox', 'quarantine']) checkDir(path.join(p.dir, sub));
    records += p.records.length + p.invalid;
    invalid += p.invalid;
    quarantined += listDir(path.join(p.dir, 'quarantine')).length;
  }
  console.log(`session records: ${records} (${invalid} failed verification)`);
  console.log(`quarantined messages (last 24h): ${quarantined}`);
  if (invalid) problems.push(`${invalid} session record(s) failed signature verification and are ignored.`);
  if (quarantined) problems.push(`${quarantined} message(s) failed verification and were quarantined.`);
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
}

function purge() {
  const home = bridgeHome();
  const active = projects().flatMap((p) => p.records.filter((r) => r.liveness === 'alive' || r.liveness === 'unresponsive'));
  if (active.length && !flags.has('--force')) {
    console.error(`${active.length} session(s) are still active. Close them first, or pass --force.`);
    process.exitCode = 1;
    return;
  }
  if (!flags.has('--yes')) {
    console.error(`This deletes ${home}. Re-run with --yes to confirm.`);
    process.exitCode = 1;
    return;
  }
  removeQuietly(home);
  console.log(`Deleted ${home}.`);
}

switch (command) {
  case 'sessions':
  case 'ls':
    sessions();
    break;
  case 'doctor':
    doctor();
    break;
  case 'purge':
    purge();
    break;
  default:
    console.log(`agent-bridge: local messaging between Claude Code and Codex sessions

Usage:
  agent-bridge sessions [--all]       List active sessions in every project
  agent-bridge doctor                 Check Node version, permissions, and record integrity
  agent-bridge purge --yes [--force]  Delete all local agent-bridge state

State directory: ${bridgeHome()} (override with AGENT_BRIDGE_HOME)`);
}
