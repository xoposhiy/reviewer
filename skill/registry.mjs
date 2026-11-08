// One file per server avoids shared-file updates when projects start at the same time.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const registryDir = () => process.env.PAGE_REVIEW_REGISTRY || join(homedir(), '.page-review', 'servers');
const valid = s => s && typeof s.id === 'string' && /^[a-f0-9-]{36}$/.test(s.id) &&
  typeof s.root === 'string' && s.root && Number.isInteger(s.pid) && s.pid > 0 &&
  Number.isInteger(s.port) && s.port > 0 && s.port <= 65535;

export function register(info) {
  if (!valid(info)) throw new Error('Invalid review server registration.');
  const dir = registryDir(), file = join(dir, info.id + '.json'), temp = file + '.tmp';
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, JSON.stringify(info) + '\n');
  renameSync(temp, file);
  return () => rmSync(file, { force: true });
}

export function registrations() {
  const dir = registryDir();
  let files;
  try { files = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const name of files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const file = join(dir, name);
    try {
      const info = JSON.parse(readFileSync(file, 'utf8'));
      if (!valid(info) || name !== info.id + '.json') throw new Error('Invalid registration.');
      result.push({ info, remove: () => rmSync(file, { force: true }) });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      if (e.code) throw e;
      rmSync(file, { force: true });
    }
  }
  return result;
}

export function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
