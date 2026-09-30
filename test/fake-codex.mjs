#!/usr/bin/env node
// Stand-in for `codex exec --json` used by the computer-use tests.
// FAKE_CODEX_SCENARIO: ok | not-approved | hang. Records its argv to FAKE_CODEX_ARGS.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGS) fs.writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify({ args, env: { AGENT_BRIDGE_NAME: process.env.AGENT_BRIDGE_NAME } }));
const out = args[args.indexOf('--output-last-message') + 1];
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const call = (id, title, status, text) => {
  const item = { id, type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: JSON.stringify({ code: '...', title }), error: null };
  emit({ type: 'item.started', item: { ...item, result: null, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { ...item, result: { content: [{ type: 'text', text }] }, status } });
};

emit({ type: 'thread.started', thread_id: 't-1' });
emit({ type: 'turn.started' });
switch (process.env.FAKE_CODEX_SCENARIO) {
  case 'not-approved':
    call('i1', 'Read Calculator app state', 'failed', 'Computer Use was not approved to use Calculator');
    fs.writeFileSync(out, 'Computer Use is not approved for Calculator, so I stopped.');
    break;
  case 'hang':
    call('i1', 'Open Notes', 'completed', 'ok');
    setInterval(() => {}, 1000);
    break;
  default:
    call('i1', 'Read Calendar state', 'completed', 'ok');
    call('i2', 'Open tomorrow', 'completed', 'ok');
    emit({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Tomorrow: 10:00 Standup.' } });
    fs.writeFileSync(out, 'Tomorrow you have one event: 10:00 Standup.\u001b[31m');
}
if (process.env.FAKE_CODEX_SCENARIO !== 'hang') emit({ type: 'turn.completed', usage: {} });
