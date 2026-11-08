// Servers register their addresses at startup. Discovery checks only those addresses.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processExists, registrations } from './registry.mjs';

const TOOL = dirname(fileURLToPath(import.meta.url));
const START_MS = 10_000, STOP_MS = 10_000;
export const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

// BUSY means that the address did not answer as a review server, or timed out.
export const BUSY = { root: null };
export async function hello(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__review/hello`, { signal: AbortSignal.timeout(700) });
    const a = r.ok ? await r.json() : null;
    return a && typeof a.root === 'string' && Number.isInteger(a.pid) ? a : BUSY;
  } catch (e) {
    return e.cause?.code === 'ECONNREFUSED' ? null : BUSY;
  }
}
const matches = (a, info) => a?.root && a.pid === info.pid && samePath(a.root, info.root) &&
  (a.id === info.id || (info.legacy === true && !a.id && a.since === info.since));

export async function servers() {
  const found = await Promise.all(registrations().map(async ({ info, remove }) => {
    if (!processExists(info.pid)) { remove(); return null; }
    const answer = await hello(info.port);
    if (matches(answer, info)) return { ...answer, port: info.port };
    // Keep a live process during a timeout: a busy server can answer on the next request.
    if (answer !== BUSY) remove();
    return null;
  }));
  return found.filter(Boolean).sort((a, b) => a.port - b.port);
}

export async function stop(port) {
  const before = await hello(port);
  if (!before) return true;
  if (!before.root) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__review/quit`, { method: 'POST', signal: AbortSignal.timeout(1000) });
    if (!r.ok) return false;
  } catch { return false; }
  for (const end = Date.now() + STOP_MS; Date.now() < end; await sleep(200)) {
    const now = await hello(port);
    if (!now || (now.root && (now.pid !== before.pid || now.since !== before.since))) return true;
  }
  return false;
}

// The OS chooses a free port. A restart tries its previous port first.
export async function start(root, prefer) {
  const data = join(root, '.review');
  mkdirSync(data, { recursive: true });
  const log = openSync(join(data, 'server.log'), 'a');
  try {
    for (const port of prefer ? [prefer, 0] : [0]) {
      const child = spawn(process.execPath, [join(TOOL, 'server.mjs'), '--root', root, '--port', String(port)],
        { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true });
      let exited = false;
      child.on('exit', () => { exited = true; });
      child.on('error', () => { exited = true; });
      for (const end = Date.now() + START_MS; Date.now() < end && !exited; await sleep(200)) {
        const entry = registrations().find(({ info }) => info.pid === child.pid);
        if (entry && matches(await hello(entry.info.port), entry.info)) { child.unref(); return entry.info.port; }
      }
      if (!exited) { child.kill(); return null; }
    }
    return null;
  } finally { closeSync(log); }
}

// A separate process lets a server restart itself after it stops.
export function restartLater(root, port) {
  spawn(process.execPath, [join(TOOL, 'open.mjs'), 'restart', '--root', root, '--port', String(port)],
    { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
