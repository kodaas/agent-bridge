// Filesystem layer. Everything lives under one private directory owned by the
// current OS user (0700 dirs, 0600 files). Writes are atomic (tmp + rename) and
// reads refuse symlinks, foreign-owned files, and oversized files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function bridgeHome() {
  return path.resolve(process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge'));
}

function checkOwnedPrivateDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`refusing to use symlinked directory: ${dir}`);
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
  if (UID !== null && st.uid !== UID) throw new Error(`directory not owned by current user: ${dir}`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

// Create (if needed) and validate every directory from the bridge home down to `dir`.
export function ensurePrivateDir(dir) {
  const home = bridgeHome();
  const rel = path.relative(home, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes bridge home: ${dir}`);
  fs.mkdirSync(path.dirname(home), { recursive: true });
  let cur = home;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    cur = part ? path.join(cur, part) : cur;
    try {
      fs.mkdirSync(cur, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    checkOwnedPrivateDir(cur);
  }
  return dir;
}

export function writeFileAtomic(dir, name, data) {
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, name));
}

// Write into `dir` via a temp file that lives in `tmpDir` (same filesystem), so
// readers of `dir` never see partial files.
export function deliverFileAtomic(tmpDir, dir, name, data) {
  const tmpName = `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  writeFileAtomic(tmpDir, tmpName, data);
  fs.renameSync(path.join(tmpDir, tmpName), path.join(dir, name));
}

export function readFileSafe(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (UID !== null && st.uid !== UID) throw new Error('file not owned by current user');
    if (st.size > maxBytes) throw new Error(`file too large (${st.size} bytes)`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonSafe(file, maxBytes = 256 * 1024) {
  return JSON.parse(readFileSafe(file, maxBytes));
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function removeQuietly(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid belongs to another user: not one of our sessions.
    return false;
  }
}
