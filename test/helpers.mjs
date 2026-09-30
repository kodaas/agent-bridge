import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/agent-bridge');
export const SERVER = path.join(PLUGIN, 'server/index.mjs');

export function tempEnv() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-bridge-test-'));
  const home = path.join(base, 'bridge-home');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export class Client {
  constructor({ home, cwd, host = 'claude', env = {}, clientName }) {
    this.proc = spawn(process.execPath, [SERVER], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: '',
        CLAUDE_CODE_SESSION_ID: '',
        AGENT_BRIDGE_COMPUTER_USE: 'off', // opt in per test, with a fake Codex
        AGENT_BRIDGE_HOME: home,
        AGENT_BRIDGE_HOST: host,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.clientName = clientName || (host === 'codex' ? 'codex-mcp-client' : 'claude-code');
    this.nextId = 1;
    this.waiting = new Map();
    this.notifications = [];
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)(msg);
        this.waiting.delete(msg.id);
      } else if (msg.method === 'roots/list') {
        this.write({ jsonrpc: '2.0', id: msg.id, result: { roots: [] } });
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    });
  }

  write(msg) {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  async init() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.clientName, version: 'test' },
    });
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await this.request('ping', {}); // server has now processed `initialized` (and joined)
    return res.result;
  }

  async call(name, args = {}, meta) {
    const res = await this.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    if (res.error) throw new Error(res.error.message);
    return { text: res.result.content[0].text, isError: res.result.isError === true };
  }

  async hook(event, extra = {}) {
    const { text } = await this.call('bridge_hook', { event, session_id: extra.session_id || 'host-session', ...extra });
    return JSON.parse(text || '{}');
  }

  async close() {
    const exited = new Promise((r) => this.proc.once('exit', r));
    this.proc.stdin.end();
    await exited;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
