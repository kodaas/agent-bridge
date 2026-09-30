import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, tempEnv, sleep } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
let env;
const clients = [];
const open = async (opts = {}) => {
  const c = new Client({
    home: env.home,
    cwd: env.project,
    host: 'claude',
    ...opts,
    env: { AGENT_BRIDGE_COMPUTER_USE: 'auto', AGENT_BRIDGE_CODEX_BIN: FAKE, FAKE_CODEX_ARGS: path.join(env.base, 'args.json'), ...opts.env },
  });
  clients.push(c);
  await c.init();
  return c;
};
const toolNames = async (c) => (await c.request('tools/list', {})).result.tools.map((t) => t.name);

before(() => {
  env = tempEnv();
});
after(async () => {
  await Promise.all(clients.map((c) => (c.proc.exitCode === null ? c.close() : null)));
  env.cleanup();
});

test('offered to Claude Code only, and can be switched off', async () => {
  const claude = await open();
  const codex = await open({ host: 'codex' });
  const off = await open({ env: { AGENT_BRIDGE_COMPUTER_USE: 'off' } });
  assert.ok((await toolNames(claude)).includes('codex_computer_use'));
  assert.ok(!(await toolNames(codex)).includes('codex_computer_use'));
  assert.ok(!(await toolNames(off)).includes('codex_computer_use'));
  const res = await codex.call('codex_computer_use', { task: 'x' });
  assert.ok(res.isError);
  await Promise.all([claude.close(), codex.close(), off.close()]);
});

test('runs a locked-down headless Codex task and returns its report', async () => {
  const c = await open({ env: { AGENT_BRIDGE_NAME: 'planner', FAKE_CODEX_SCENARIO: 'ok' } });
  const res = await c.request('tools/call', {
    name: 'codex_computer_use',
    arguments: { task: "Check tomorrow's first event in Calendar.", apps: ['Calendar'] },
    _meta: { progressToken: 'p1' },
  });
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, undefined);
  assert.match(text, /Codex report:\nTomorrow you have one event: 10:00 Standup\.$/m);
  assert.doesNotMatch(text, /\u001b/, 'report is sanitized');
  assert.match(text, /Computer Use steps \(2, \d+s\):\n1\. Read Calendar state \[completed\]\n2\. Open tomorrow \[completed\]/);
  const progress = c.notifications.filter((m) => m.method === 'notifications/progress').map((m) => m.params.message);
  assert.deepEqual(progress, ['Codex Computer Use step 1: Read Calendar state', 'Codex Computer Use step 2: Open tomorrow']);

  const { args, env: childEnv } = JSON.parse(fs.readFileSync(path.join(env.base, 'args.json'), 'utf8'));
  assert.equal(args[0], 'exec');
  for (const flag of ['--ephemeral', '--json', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--cd') + 1], env.project);
  const prompt = args.at(-1);
  assert.match(prompt, /Claude Code session "planner"/);
  assert.match(prompt, /<task>\nCheck tomorrow's first event in Calendar\.\n<\/task>/);
  assert.match(prompt, /Only operate these apps: Calendar\./);
  assert.match(prompt, /Don't send messages or email, submit forms, make purchases/);
  assert.equal(childEnv.AGENT_BRIDGE_NAME, 'planner-computer-use');
  await c.close();
});

test('explains missing app approval instead of working around it', async () => {
  const c = await open({ env: { FAKE_CODEX_SCENARIO: 'not-approved' } });
  const { text } = await c.call('codex_computer_use', { task: 'Read the Calculator display.' });
  assert.match(text, /Read Calculator app state \[failed\]/);
  assert.match(text, /Codex is not approved to use: Calculator\. Approval is the user's decision/);
  assert.match(text, /"Always allow"/);
  await c.close();
});

test('validates input', async () => {
  const c = await open();
  assert.match((await c.call('codex_computer_use', { task: '  ' })).text, /`task` must describe/);
  assert.match((await c.call('codex_computer_use', { task: 'x'.repeat(4001) })).text, /too long/);
  assert.match((await c.call('codex_computer_use', { task: 'x', apps: 'Notes' })).text, /must be a list/);
  await c.close();
});

test('one desktop task at a time, and cancellation stops Codex', async () => {
  const a = await open({ env: { AGENT_BRIDGE_NAME: 'first', FAKE_CODEX_SCENARIO: 'hang' } });
  const b = await open({ env: { AGENT_BRIDGE_NAME: 'second', FAKE_CODEX_SCENARIO: 'ok' } });
  const id = a.nextId;
  const pending = a.request('tools/call', { name: 'codex_computer_use', arguments: { task: 'Write a note.' } });
  await sleep(800);
  const lock = path.join(env.home, 'computer-use.lock');
  assert.ok(fs.existsSync(lock));
  assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  const busy = await b.call('codex_computer_use', { task: 'Something else.' });
  assert.ok(busy.isError);
  assert.match(busy.text, /Computer Use is busy: first started a task/);

  a.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
  const res = await pending;
  assert.match(res.result.content[0].text, /The Codex task was cancelled\./);
  assert.ok(!fs.existsSync(lock), 'lock released');
  assert.match((await b.call('codex_computer_use', { task: 'Now it is free.' })).text, /Codex report/);
  await Promise.all([a.close(), b.close()]);
});
