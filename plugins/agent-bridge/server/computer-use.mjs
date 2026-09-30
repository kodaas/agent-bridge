// Let Claude Code delegate desktop-app tasks to Codex's Computer Use.
//
// Codex's Computer Use runtime is private to Codex, and every app it touches
// must be approved by the user inside Codex. Instead of reaching into that
// runtime, we run a one-off headless Codex task: Codex's own model drives its
// own Computer Use under its own per-app approvals, in a read-only shell
// sandbox, and we hand its report back to Claude.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BridgeError, sanitizeText } from './bridge.mjs';
import { bridgeHome, ensurePrivateDir, pidAlive, removeQuietly } from './store.mjs';

export const CU_LIMITS = { maxTaskChars: 4000, maxApps: 10, defaultTimeoutSec: 600, maxTimeoutSec: 1800 };

const oneLine = (s, max) => sanitizeText(s).replace(/\s+/g, ' ').trim().slice(0, max);

export function findCodex() {
  const candidates = [
    process.env.AGENT_BRIDGE_CODEX_BIN,
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'codex')),
    path.join(os.homedir(), '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      }
    } catch {
      // try the next one
    }
  }
  return null;
}

// Offered to Claude Code sessions only (Codex has Computer Use natively), on
// macOS, when a Codex CLI is installed. AGENT_BRIDGE_COMPUTER_USE=off hides it.
export function computerUseAvailable(host) {
  if (host !== 'claude') return false;
  if (String(process.env.AGENT_BRIDGE_COMPUTER_USE || 'auto').toLowerCase() === 'off') return false;
  if (process.platform !== 'darwin' && !process.env.AGENT_BRIDGE_CODEX_BIN) return false;
  return findCodex() !== null;
}

// One desktop driver at a time, machine-wide.
function acquireLock(owner) {
  const file = path.join(ensurePrivateDir(bridgeHome()), 'computer-use.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, owner, startedAt: Date.now() }));
      fs.closeSync(fd);
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) removeQuietly(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // unreadable: treat as stale
      }
      if (holder && pidAlive(holder.pid)) {
        const mins = Math.max(1, Math.round((Date.now() - holder.startedAt) / 60_000));
        throw new BridgeError(`Computer Use is busy: ${oneLine(holder.owner, 60)} started a task ~${mins}m ago. Try again when it finishes.`);
      }
      removeQuietly(file);
    }
  }
  throw new BridgeError('Could not acquire the Computer Use lock.');
}

export function buildPrompt({ task, apps, requester }) {
  const scope = apps.length
    ? `Only operate these apps: ${apps.join(', ')}. If the task needs any other app, stop and say so.`
    : 'Only operate the apps the task needs.';
  return [
    `You are carrying out a desktop task for the user's Claude Code session "${requester}", delegated through the agent-bridge plugin.`,
    '',
    '<task>',
    task,
    '</task>',
    '',
    'Rules:',
    `- Use Computer Use for the app work. ${scope}`,
    "- Don't edit files or run shell commands that change anything.",
    "- Don't send messages or email, submit forms, make purchases, delete data, change settings, or type passwords or other credentials unless the task explicitly asks for that exact action.",
    '- If Computer Use is not approved for an app, stop and name the app. Do not try to work around approvals.',
    '- Finish with a concise report: what you did, what you observed (quote relevant on-screen text), and anything you could not do.',
  ].join('\n');
}

export function validateRequest({ task, apps, timeout_seconds: timeout }) {
  if (typeof task !== 'string' || !task.trim()) throw new BridgeError('`task` must describe what Codex should do.');
  if (task.length > CU_LIMITS.maxTaskChars) throw new BridgeError(`\`task\` is too long (max ${CU_LIMITS.maxTaskChars} characters).`);
  if (apps !== undefined && !Array.isArray(apps)) throw new BridgeError('`apps` must be a list of app names.');
  const cleanApps = [...new Set((apps || []).map((a) => oneLine(a, 100)).filter(Boolean))];
  if (cleanApps.length > CU_LIMITS.maxApps) throw new BridgeError(`List at most ${CU_LIMITS.maxApps} apps.`);
  const timeoutSec = Math.min(Math.max(Number(timeout) || CU_LIMITS.defaultTimeoutSec, 30), CU_LIMITS.maxTimeoutSec);
  return { task: sanitizeText(task).trim(), apps: cleanApps, timeoutSec };
}

export function runComputerUse({ task, apps = [], timeoutSec = CU_LIMITS.defaultTimeoutSec, cwd, requester, signal, onProgress }) {
  const codex = findCodex();
  if (!codex) throw new BridgeError('Codex CLI not found. Install Codex, or set AGENT_BRIDGE_CODEX_BIN.');
  const release = acquireLock(requester);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-cu-'));
  const lastFile = path.join(tmp, 'last-message.txt');
  const effort = oneLine(process.env.AGENT_BRIDGE_COMPUTER_USE_EFFORT || 'medium', 20).replace(/[^a-z]/g, '') || 'medium';
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--sandbox', 'read-only',
    '--cd', cwd,
    '--output-last-message', lastFile,
    '-c', `model_reasoning_effort="${effort}"`,
    buildPrompt({ task, apps, requester }),
  ];
  const started = Date.now();
  const child = spawn(codex, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_NAME: `${requester}-computer-use`.slice(0, 40) },
  });

  return new Promise((resolve, reject) => {
    const steps = [];
    const notApproved = new Set();
    let lastMessage = '';
    let stderr = '';
    let buffer = '';
    let stopped = null;
    let killTimer = null;

    const handle = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const item = ev.item || {};
      if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') lastMessage = item.text;
      if (item.type !== 'mcp_tool_call') return;
      const computer = item.server === 'cua_repl' || item.server === 'node_repl';
      if (ev.type === 'item.started' && computer) {
        let title = '';
        try {
          title = JSON.parse(item.arguments || '{}').title || '';
        } catch {
          // untitled step
        }
        steps.push({ id: item.id, title: oneLine(title || `${item.server}.${item.tool}`, 120), status: 'running' });
        onProgress?.(`Codex Computer Use step ${steps.length}: ${steps.at(-1).title}`);
      }
      if (ev.type === 'item.completed') {
        const step = steps.find((s) => s.id === item.id);
        if (step) step.status = item.status || 'completed';
        const blob = JSON.stringify(item.result ?? '') + JSON.stringify(item.error ?? '');
        for (const m of blob.matchAll(/not approved to use ([^"\\]+?)(?:\\n|"|\\|$)/g)) notApproved.add(oneLine(m[1], 100));
      }
    };

    const stop = (reason) => {
      if (stopped || child.exitCode !== null) return;
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutSec * 1000);
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      release();
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        handle(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (err) => {
      finish();
      removeQuietly(tmp);
      reject(new BridgeError(`Could not start Codex: ${err.message}`));
    });
    child.on('close', (code) => {
      if (buffer.trim()) handle(buffer);
      finish();
      let report = '';
      try {
        report = fs.readFileSync(lastFile, 'utf8').trim();
      } catch {
        report = lastMessage.trim();
      }
      removeQuietly(tmp);
      resolve({ code, report, steps, notApproved: [...notApproved], stopped, stderr, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

export function formatComputerUseResult(r, { timeoutSec }) {
  const lines = [];
  if (r.stopped === 'timeout') lines.push(`Codex was stopped after the ${timeoutSec}s timeout.`);
  if (r.stopped === 'cancelled') lines.push('The Codex task was cancelled.');
  if (r.report) lines.push(`Codex report:\n${sanitizeText(r.report)}`);
  else if (!r.stopped) lines.push(`Codex exited (code ${r.code}) without a report.${r.stderr ? `\n${sanitizeText(r.stderr).slice(-1500)}` : ''}`);
  if (r.steps.length) {
    lines.push(`\nComputer Use steps (${r.steps.length}, ${r.seconds}s):`);
    r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title} [${s.status}]`));
  }
  if (r.notApproved.length) {
    lines.push(
      `\nCodex is not approved to use: ${r.notApproved.join(', ')}. Approval is the user's decision and must be given in Codex: ` +
        'run any Codex task that uses the app in the Codex app or CLI and choose "Always allow" when asked. Then retry.',
    );
  }
  return lines.join('\n');
}
