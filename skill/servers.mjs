// The review servers of this machine: each project has its own server on one of the ports from FIRST_PORT up.
// A server tells about itself at /__review/hello. The command `reviewer` (open.mjs) and the page of contents use this module.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = dirname(fileURLToPath(import.meta.url));
export const FIRST_PORT = 8765;
export const PORTS = Array.from({ length: 20 }, (_, i) => FIRST_PORT + i);
const START_MS = 10_000, STOP_MS = 10_000;

export const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

// The answer on the port: {root, pid, since, agent, open} of a review server; BUSY: another program holds the port;
// null: the port is free.
export const BUSY = { root: null };
export async function hello(port) {
  let r;
  try { r = await fetch(`http://127.0.0.1:${port}/__review/hello`, { signal: AbortSignal.timeout(700) }); }
  catch (e) { return e.name === 'TimeoutError' ? BUSY : null; }
  return r.ok ? r.json().catch(() => BUSY) : BUSY;
}

// every port with its answer: [{port, answer}]
export const scan = async () => Promise.all(PORTS.map(async port => ({ port, answer: await hello(port) })));
// the running review servers: [{port, root, pid, since, agent, open}]
export const servers = async () => (await scan()).filter(s => s.answer?.root).map(s => ({ port: s.port, ...s.answer }));

// stop the server on the port and wait until the port is free
export async function stop(port) {
  await fetch(`http://127.0.0.1:${port}/__review/quit`, { method: 'POST' }).catch(() => {});
  for (const end = Date.now() + STOP_MS; Date.now() < end; await sleep(200)) if (!(await hello(port))) return true;
  return false;
}

// Start a server for the root in the background, on the port `prefer` when it is free, else on the first free port.
// The server lives on after the caller: its own process group, its output in <root>/.review/server.log. Gives the port or null.
export async function start(root, prefer) {
  const data = join(root, '.review');
  mkdirSync(data, { recursive: true });
  const log = openSync(join(data, 'server.log'), 'a');
  const free = (await scan()).filter(s => s.answer === null).map(s => s.port);
  const order = free.includes(prefer) ? [prefer, ...free.filter(p => p !== prefer)] : free;
  for (const port of order) {
    const child = spawn(process.execPath, [join(TOOL, 'server.mjs'), '--root', root, '--port', String(port)],
      { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    let exited = false;
    child.on('exit', () => { exited = true; });
    for (const end = Date.now() + START_MS; Date.now() < end && !exited; await sleep(200)) {
      const a = await hello(port);
      if (a?.root && samePath(a.root, root)) { child.unref(); return port; }
    }
    // the port was taken in the meantime: try the next one; a server that does not answer is broken
    if (!exited) { child.kill(); return null; }
  }
  return null;
}

// Restart in a separate process, so that a server can restart itself: the process waits until the old server stops.
export function restartLater(root, port) {
  spawn(process.execPath, [join(TOOL, 'open.mjs'), 'restart', '--root', root, '--port', String(port)],
    { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
