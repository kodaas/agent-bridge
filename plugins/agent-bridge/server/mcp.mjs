// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), just enough
// for tools. No dependencies, so the plugin runs anywhere Node 18+ exists.

import readline from 'node:readline';

const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

export class McpServer {
  constructor({ name, version, instructions, tools, onInitialized }) {
    this.info = { name, version };
    this.instructions = instructions;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.onInitialized = onInitialized;
    this.clientInfo = null;
    this.clientCapabilities = {};
    this.inflight = new Map();
    this.outstanding = new Map();
    this.nextId = 1;
  }

  start() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      this.dispatch(msg).catch((err) => process.stderr.write(`agent-bridge: ${err.stack || err}\n`));
    });
    return new Promise((resolve) => rl.on('close', resolve));
  }

  send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, timeoutMs = 5000) {
    const id = `srv-${this.nextId++}`;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outstanding.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.outstanding.set(id, { resolve, reject, timer });
    });
  }

  async dispatch(msg) {
    if (msg.method === undefined) {
      const waiter = this.outstanding.get(msg.id);
      if (!waiter) return;
      this.outstanding.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || 'request failed'));
      else waiter.resolve(msg.result);
      return;
    }
    const { id, method, params = {} } = msg;
    const reply = (result) => id !== undefined && this.send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && this.send({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize': {
        this.clientInfo = params.clientInfo || null;
        this.clientCapabilities = params.capabilities || {};
        const requested = params.protocolVersion;
        reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS.at(-1),
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: this.instructions,
        });
        return;
      }
      case 'notifications/initialized':
        this.onInitialized?.(this);
        return;
      case 'notifications/cancelled':
        this.inflight.get(params.requestId)?.abort();
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({
          tools: [...this.tools.values()]
            .filter((t) => !t.hidden)
            .map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
        return;
      case 'tools/call': {
        const tool = this.tools.get(params.name);
        if (!tool) {
          fail(-32602, `Unknown tool: ${params.name}`);
          return;
        }
        const controller = new AbortController();
        this.inflight.set(id, controller);
        try {
          const text = await tool.handler(params.arguments || {}, { meta: params._meta || {}, signal: controller.signal, server: this });
          reply({ content: [{ type: 'text', text: String(text ?? '') }] });
        } catch (err) {
          const expected = err?.name === 'BridgeError' || err?.constructor?.name === 'BridgeError';
          if (!expected) process.stderr.write(`agent-bridge: tool ${params.name} failed: ${err?.stack || err}\n`);
          reply({ content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
        } finally {
          this.inflight.delete(id);
        }
        return;
      }
      default:
        if (id !== undefined) fail(-32601, `Method not found: ${method}`);
    }
  }
}
