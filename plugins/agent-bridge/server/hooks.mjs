// Lifecycle hooks (UserPromptSubmit, PostToolUse, Stop) reach the MCP server
// through `mcp_tool` hook handlers, which both Claude Code and Codex support.
// That ties each hook to its own session's server with no IPC guesswork.
//
// Hooks only ever inject short notices built from verified, sanitized metadata
// (sender names, counts). Message bodies reach the model solely as tool output
// from read_messages / wait_for_message: hosts treat hook context as trusted
// (Codex injects it as a developer message), and peer content must not be.

import { gitBranch } from './project.mjs';
import { formatIntro, hostLabel } from './format.mjs';

export const MAX_AUTO_CONTINUES = 5; // Stop-hook re-prompts per user turn (loop guard)

const context = (event, text) =>
  text ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) : '{}';

// Describe unread messages. With `onlyNew`, stay quiet about ones already announced.
function notice(bridge, { onlyNew = true } = {}) {
  bridge.drain();
  const unannounced = bridge.pending.filter((m) => !bridge.announced.has(m.id));
  const lines = [];
  if (bridge.pending.length && (!onlyNew || unannounced.length)) {
    for (const m of bridge.pending) bridge.announced.add(m.id);
    const senders = [...new Set(bridge.pending.map((m) => `${m.fromName} (${hostLabel(m.fromHost)})`))].join(', ');
    const replies = bridge.pending.filter((m) => m.expectsReply).length;
    lines.push(
      `[agent-bridge] ${bridge.pending.length} unread peer message(s) from ${senders}` +
        `${replies ? `; ${replies} expect a reply` : ''}. Call the agent-bridge read_messages tool to read them.`,
    );
  }
  const rejected = bridge.takeQuarantineCount();
  if (rejected) lines.push(`[agent-bridge] ${rejected} incoming message(s) failed signature/decryption checks and were discarded.`);
  return lines.join('\n');
}

function rosterNotice(bridge) {
  const { peers, joined, left } = bridge.rosterChanges();
  if (!bridge.introduced) {
    if (!peers.length) return '';
    bridge.introduced = true;
    return formatIntro(bridge, peers);
  }
  const lines = [];
  for (const p of joined) lines.push(`[agent-bridge] Session joined: ${p.name} (${hostLabel(p.host)}${p.branch ? `, branch ${p.branch}` : ''}).`);
  if (left.length) lines.push(`[agent-bridge] Session(s) left: ${left.map((p) => p.name).join(', ')}.`);
  return lines.join('\n');
}

export function handleHook(bridge, event, args) {
  switch (event) {
    case 'UserPromptSubmit': {
      bridge.autoContinues = 0;
      bridge.project.branch = gitBranch(bridge.project.cwd);
      bridge.state = 'working';
      bridge.writeRecord();
      return context(event, [rosterNotice(bridge), notice(bridge, { onlyNew: false })].filter(Boolean).join('\n'));
    }
    case 'PostToolUse': {
      bridge.recordToolUse(args.tool_name, args.tool_input);
      return context(event, notice(bridge));
    }
    case 'Stop': {
      bridge.drain();
      if (bridge.pending.length && bridge.autoContinues < MAX_AUTO_CONTINUES) {
        bridge.autoContinues += 1;
        return JSON.stringify({
          decision: 'block',
          reason: `${notice(bridge, { onlyNew: false })} Handle them before you finish: reply with send_message when a reply is expected or useful.`,
        });
      }
      bridge.setState('idle');
      if (bridge.pending.length) {
        return JSON.stringify({ systemMessage: `agent-bridge: ${bridge.pending.length} peer message(s) unread; the agent will be told on the next prompt.` });
      }
      return '{}';
    }
    default:
      return '{}';
  }
}
