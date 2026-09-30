// Work out which "project" a directory belongs to. All git worktrees of one
// repository share a project (keyed by the common .git dir), so a Codex session
// in a worktree can talk to a Claude session in the main checkout.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function gitBranch(dir) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

export function resolveProject(dir) {
  const real = fs.realpathSync(dir);
  const explicit = process.env.AGENT_BRIDGE_PROJECT;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], real);
  const worktree = git(['rev-parse', '--show-toplevel'], real) || real;
  let key;
  let root;
  if (explicit) {
    key = `name:${explicit}`;
    root = worktree;
  } else if (common) {
    const commonReal = fs.realpathSync(common);
    key = `git:${commonReal}`;
    root = path.basename(commonReal) === '.git' ? path.dirname(commonReal) : worktree;
  } else {
    key = `dir:${real}`;
    root = real;
  }
  return { id: hash(`agent-bridge/v1/project\0${key}`), key, root, worktree, cwd: real, branch: gitBranch(real) };
}
