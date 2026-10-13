// Starts the relay with `wrangler dev` (or uses RELAY_URL) and provides a small WebSocket client for tests
// and the load test.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const TEST_PUBLISH_KEY = "kltp_test_0123456789abcdefghijklmnopqrstuvwxyzABCD";
const relayDir = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Returns { url, key, stop }.
export async function startRelay() {
  if (process.env.RELAY_URL) {
    return { url: process.env.RELAY_URL.replace(/\/$/, ""), key: process.env.RELAY_KEY ?? TEST_PUBLISH_KEY, stop: async () => {} };
  }
  const port = await freePort();
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", `PUBLISH_KEY:${TEST_PUBLISH_KEY}`, "--persist-to", `.wrangler/test-${port}`],
    { cwd: relayDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch {
      // Not up yet.
    }
    await sleep(300);
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error(`wrangler dev did not start:\n${log}`);
  }
  return {
    url,
    key: TEST_PUBLISH_KEY,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createRoom(relay, title = "") {
  const response = await fetch(`${relay.url}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${relay.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(`create room failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function viewerUrl(relay, room) {
  return `${relay.url.replace(/^http/, "ws")}/api/rooms/${room}/live`;
}

// A WebSocket that queues parsed messages so tests can wait for the one they expect.
export class Client {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`WebSocket error: ${url}`));
    });
    this.ws.onmessage = ({ data }) => {
      let message = data;
      try {
        message = JSON.parse(data);
      } catch {
        // Plain text (pong).
      }
      if (typeof message === "object" && message) message.__at = performance.now();
      this.messages.push(message);
      this.flush();
    };
    this.ws.onclose = ({ code, reason }) => {
      this.closed = { code, reason };
      this.flush();
    };
  }

  send(message) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const index = this.messages.findIndex(waiter.match);
      if (index >= 0) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(this.messages.splice(index, 1)[0]);
      } else if (this.closed && waiter.untilClose) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(null);
      }
    }
  }

  // Resolves with the first queued or future message that matches (removing it from the queue).
  next(match, timeoutMs = 5000) {
    const predicate = typeof match === "string" ? (message) => message?.t === match : match;
    return new Promise((resolve, reject) => {
      const waiter = {
        match: predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for message (${typeof match === "string" ? match : "predicate"})`));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.flush();
    });
  }

  waitClose(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      const previous = this.ws.onclose;
      this.ws.onclose = (event) => {
        previous(event);
        clearTimeout(timer);
        resolve(this.closed);
      };
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Ignore.
    }
  }
}

// Connects and authenticates as the room's host.
export async function connectHost(room) {
  const host = new Client(room.socketUrl);
  await host.opened;
  host.send({ t: "auth", token: room.hostToken });
  const welcome = await host.next("welcome");
  return { host, welcome };
}
