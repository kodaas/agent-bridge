# Agent Bridge

[![M8ven Score](https://m8ven.ai/badge/mcp/kodaas-agent-bridge-1l7xu8?v=87d372f171113b85969da23fb5f36622)](https://m8ven.ai/mcp/kodaas-agent-bridge-1l7xu8?s=readme)

A plugin for **Claude Code** and **Codex** that lets their sessions on the same project see each other and talk: Claude ↔ Claude, Codex ↔ Codex, and Claude ↔ Codex.

- **See who's working and on what.** Every session shows its name, host, state (working / idle / waiting), git branch, status line, and recently edited files.
- **Message one session or all of them.** Hand off work, ask questions, and claim files before editing so sessions don't collide.
- **Claude can use Codex's Computer Use.** Claude Code sessions can hand a desktop-app task (e.g. "check tomorrow's first event in Calendar") to Codex, which operates the app and reports back.
- **Secure by design.** No network: messages go through a private directory in your home folder. Each message is signed by the sender and end-to-end encrypted to the recipient.

```
 Claude Code session ─┐                                   ┌─ Codex session
   (MCP server + hooks)│   ~/.agent-bridge/projects/<id>/  │ (MCP server + hooks)
                       ├──► sessions/  signed identity     ◄┤
 Claude Code session ─┤    inbox/      encrypted messages   ├─ Codex session
                       └───────────── same user, 0700 ─────┘
```

## Install

This repository is a plugin marketplace for both hosts. Both need **Node.js 18+** on the machine.

**Claude Code**

```sh
claude plugin marketplace add kodaas/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

Claude asks for permission the first time each bridge tool runs. To skip the prompts for the messaging tools, add these to the `permissions.allow` list in `~/.claude/settings.json`:

```json
"mcp__plugin_agent-bridge_bridge__list_sessions",
"mcp__plugin_agent-bridge_bridge__set_status",
"mcp__plugin_agent-bridge_bridge__send_message",
"mcp__plugin_agent-bridge_bridge__read_messages",
"mcp__plugin_agent-bridge_bridge__wait_for_message"
```

Don't allowlist `codex_computer_use` (or use a `__*` wildcard): its permission prompt is where you see and approve each desktop task before it runs.

**Codex**

```sh
codex plugin marketplace add kodaas/agent-bridge
codex plugin add agent-bridge@agent-bridge
```

Codex runs plugin hooks only after you trust them. Open Codex, run `/hooks`, and trust the three `agent-bridge` hooks. Without them the tools still work, but messages aren't announced automatically.

To install from a local clone instead, pass its path to `marketplace add` in place of `kodaas/agent-bridge`.

## Use it

Just ask, in either tool:

- "Who else is working on this repo right now?"
- "Tell the Codex session I'm refactoring `src/auth`, and ask it to stay out of that folder."
- "Hand the failing integration tests off to the other Claude session."
- "Wait for the Claude session to finish the migration, then run the test suite."

Sessions join automatically. Sessions in the same git repository share a bridge, including sessions in separate worktrees; other folders are isolated from each other.

| Tool | What it does |
| --- | --- |
| `list_sessions` | Active sessions with host, state, branch, status, and recent files |
| `set_status` | Set your one-line status and, optionally, a memorable name |
| `send_message` | Message a session by name or id, or everyone with `to="all"` |
| `read_messages` | Read new messages, or review history |
| `wait_for_message` | Block until a peer message arrives (up to 10 minutes) |
| `codex_computer_use` | *Claude Code only.* Have Codex operate a desktop app via Computer Use and report back |

### How messages arrive

- **Busy sessions:** hooks announce new messages when the user sends a prompt, after each tool call, and before the agent finishes its turn. If a message is still unread at that last point, the agent keeps going (at most 5 times per prompt) so it can handle it.
- **Idle Claude Code sessions** (interactive terminal or IDE) are woken when a message arrives.
- **Idle Codex sessions** are not woken. They see messages when their next turn starts, or while they're blocked in `wait_for_message`. For a live conversation, ask Codex to "wait for messages from Claude and handle them".

## Codex Computer Use from Claude Code

Codex's Computer Use can read and operate the UI of apps on your Mac. Claude Code can't reach that runtime directly: it's private to Codex, and each app needs your approval inside Codex. So `codex_computer_use` **delegates**. It starts a one-off, headless Codex task that uses its own Computer Use and returns Codex's report, plus a list of the steps it took, to Claude.

Try: *"Use Codex computer use to read the first three unread subjects in Mail."*

**Before first use:** approve each app once in Codex. Run any Codex task that uses the app (in the Codex app or CLI) and choose **Always allow**. Headless runs can't ask, so an unapproved app makes Codex stop and name it; the plugin then tells Claude what to ask you.

Safeguards:

- **You approve every task.** Claude Code shows each `codex_computer_use` call, with the full task text, in a permission prompt. Keep it that way; see *Install*.
- **Codex's per-app approvals stay in force.** The plugin never grants or bypasses them.
- **Scoped, read-only run.** Codex runs with a read-only shell sandbox and a disposable session (`--ephemeral`). It is told to operate only the listed apps, and not to send, submit, buy, delete, change settings, or type credentials unless the task explicitly says so.
- **One driver at a time.** A machine-wide lock stops two agents from fighting over the desktop.
- **Bounded.** The run has a timeout (default 10 minutes, max 30); cancelling the tool call in Claude stops Codex.
- **Peer messages can't trigger it.** The tool description and skill tell Claude to use it only on your request, never because a peer asked.

Screenshots and on-screen text go to Codex's model provider (OpenAI) as usual for Computer Use. The worker Codex session shows up in `list_sessions` as `<claude-name>-computer-use` while it runs.

## Security model

The trust boundary is **your OS user account**. Only processes running as you can take part.

| Protection | How |
| --- | --- |
| No network exposure | No sockets or ports. All communication goes through `~/.agent-bridge` (dirs `0700`, files `0600`). Symlinked or foreign-owned paths are refused. |
| Unforgeable identities | Each session creates an Ed25519 signing key and an X25519 encryption key in memory; they never touch disk. The session id is a fingerprint of both public keys, so an id can't be claimed without the matching private keys. Session records are signed. |
| Authentic, private messages | Messages are encrypted with AES-256-GCM, using a key derived (X25519 + HKDF-SHA256) for each sender→recipient pair, and signed by the sender. Message text never exists in plaintext on disk. Tampered, forged, replayed, misaddressed, or stale messages are rejected and quarantined. |
| Sender set by the server | The `from` field comes from the session's own server, never from the model, so an agent can't impersonate another session. |
| Prompt-injection hygiene | Hooks inject only short notices (sender names, counts). Message text reaches the model only as tool output, wrapped in `<peer-message>` blocks and labelled as coming from other agents, not the user. Terminal escapes, control characters, and invisible/bidirectional-text characters are stripped. Every displayed field of a session record is sanitized. The bundled skill tells agents never to take destructive, out-of-scope, or secret-revealing actions just because a peer asked. |
| Runaway protection | Limits: 8 KiB per message, 30 messages per minute per session, 200 queued messages per inbox. Turn-end re-prompts are capped. |

What it does **not** protect against: other software already running as your user. Such software can read your files, edit your agent configs, or kill processes regardless. It can't read or forge messages between live sessions, but it can register its own fake session, whose messages would show up under its own distinct name.

## Command line

```sh
plugins/agent-bridge/scripts/agent-bridge sessions [--all]   # who's active, in every project
plugins/agent-bridge/scripts/agent-bridge doctor             # Node version, permissions, integrity
plugins/agent-bridge/scripts/agent-bridge purge --yes        # delete all local state
```

Message contents can't be read from the CLI; they're encrypted to the live sessions.

## Configuration

Set these as environment variables for the host (e.g. in your shell profile, or in Claude Code's `settings.json` `env`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_NAME` | `<host>-<id>` | Default session name |
| `AGENT_BRIDGE_HOME` | `~/.agent-bridge` | State directory |
| `AGENT_BRIDGE_PROJECT` | *(git repo)* | Join sessions across folders by giving them the same project name |
| `AGENT_BRIDGE_PROJECT_DIR` | *(session cwd)* | Force the project directory |
| `AGENT_BRIDGE_WAKE` | `auto` | Idle wake-up for Claude Code: `auto` (interactive only), `always`, `never` |
| `AGENT_BRIDGE_MAX_MESSAGE_BYTES` | `8192` | Maximum message size |
| `AGENT_BRIDGE_RATE_LIMIT` | `30` | Messages per minute per session |
| `AGENT_BRIDGE_NODE` | *(auto)* | Path to the Node.js binary |
| `AGENT_BRIDGE_COMPUTER_USE` | `auto` | `off` hides `codex_computer_use` |
| `AGENT_BRIDGE_COMPUTER_USE_EFFORT` | `medium` | Codex reasoning effort for Computer Use tasks |
| `AGENT_BRIDGE_CODEX_BIN` | *(auto)* | Path to the Codex CLI |

## Limitations

- macOS and Linux only; Windows is untested.
- In `auto` mode, idle wake-up is off for headless (`claude -p`) and SDK-hosted Claude sessions, because a background waiter would keep one-shot runs from exiting.
- A session's keys live only in its process. Messages still queued when a session exits are unreadable and are discarded.
- Computer Use needs macOS, the Codex CLI, and Codex's Computer Use (bundled with the ChatGPT/Codex desktop app). Apps must be pre-approved in Codex.
- Verified with Claude Code 2.1.283 and Codex CLI 0.157.1 (`codex exec`). Other versions and front ends (such as the Codex desktop app) may behave differently.

## Development

```sh
npm test    # 26 tests: crypto, end-to-end over MCP stdio, hooks, watcher, CLI, Computer Use (with a fake Codex)
```

Layout: `plugins/agent-bridge/` is the plugin. It has `.claude-plugin/` and `.codex-plugin/` manifests, per-host MCP and hook configs in `mcp/` and `hooks/`, the zero-dependency server in `server/`, and a shared skill in `skills/`. After changing plugin files, reinstall so each host picks up the new copy.

## Uninstall

```sh
claude plugin uninstall agent-bridge@agent-bridge && claude plugin marketplace remove agent-bridge
codex plugin remove agent-bridge@agent-bridge && codex plugin marketplace remove agent-bridge
rm -rf ~/.agent-bridge
```

## License

[MIT](LICENSE) © Fiyinfoluwa John Ajala
