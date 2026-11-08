#!/usr/bin/env node
// Installs the skill `page-review` from skill/ into Claude Code and Codex, links the command `hrev` to the Claude Code copy,
// and restarts the running review servers on request. Run it again after each change: it replaces the installed copies.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `Usage: npm run deploy -- [options]
Options:
  --only <claude|codex>  install into one agent only (default: both)
  --skip-tests           install without the tests
  --restart              restart the running review servers, so that they run the new code;
                         a server whose agent works on notes does not restart: the command lists it
  --force                with --restart: restart the servers with a working agent too (it stops the agent)`;
const { values: opt } = parseArgs({
  options: { only: { type: 'string' }, 'skip-tests': { type: 'boolean' }, restart: { type: 'boolean' }, force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' } },
});
if (opt.help) { console.log(USAGE); process.exit(0); }
if (opt.force && !opt.restart) { console.error('--force works only with --restart.'); process.exit(1); }

const SKILL = 'page-review';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO, 'skill');
// the folders that are only for the development of the skill
const NOT_INSTALLED = new Set(['test']);
const TARGETS = {
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills', SKILL),
  codex: join(homedir(), '.agents', 'skills', SKILL),
};
if (opt.only && !TARGETS[opt.only]) fail(`--only takes claude or codex, not "${opt.only}".`);
const targets = Object.entries(TARGETS).filter(([agent]) => !opt.only || agent === opt.only);

function fail(message) { console.error(message); process.exit(1); }
const run = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options }).status === 0;
const git = args => {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

// The install deletes the target folder, so it deletes only an earlier copy of this skill.
function isSkillCopy(dir) {
  const skillFile = join(dir, 'SKILL.md');
  return statSync(dir).isDirectory() && existsSync(skillFile) &&
    new RegExp(`^name:\\s*${SKILL}\\s*$`, 'm').test(readFileSync(skillFile, 'utf8'));
}

function install(target) {
  if (existsSync(target) && !isSkillCopy(target)) fail(`${target} is not a copy of the skill ${SKILL}: delete it by hand.`);
  rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  cpSync(SOURCE, target, { recursive: true, filter: src => !NOT_INSTALLED.has(basename(src)) || dirname(src) !== SOURCE });
  const commit = git(['rev-parse', 'HEAD']);
  const changed = git(['status', '--porcelain', '--', 'skill']);
  writeFileSync(join(target, 'INSTALLED.json'), JSON.stringify({
    source: REPO, commit, uncommittedChanges: changed === null ? null : changed !== '', installed: new Date().toISOString(),
  }, null, 2) + '\n');
}

if (!opt['skip-tests']) {
  console.log('Running the tests...');
  if (!run(process.execPath, ['--test', join(SOURCE, 'test', 'server.test.mjs')])) fail('The tests failed: nothing is installed.');
}

// The old installed module scans ports. Run it once during the upgrade, before replacing it.
const legacy = [];
for (const [, target] of targets) {
  const file = join(target, 'servers.mjs');
  if (existsSync(file) && readFileSync(file, 'utf8').includes('export const scan =')) {
    const old = await import(pathToFileURL(file).href + '?legacy');
    legacy.push(...await old.servers());
    break;
  }
}

for (const [agent, target] of targets) {
  install(target);
  console.log(`Installed for ${agent}: ${target}`);
}

// npm links the command to the installed folder; on Windows npm is a .cmd file, so it needs a shell
const commandHome = targets[0][1];
const { register } = await import(pathToFileURL(join(commandHome, 'registry.mjs')).href);
for (const s of legacy) register({ ...s, id: randomUUID(), legacy: true });
console.log(`Linking the command hrev to ${commandHome}...`);
if (!run('npm', ['install', '-g', '--no-fund', '--no-audit', `"${commandHome}"`], { shell: true })) fail('npm could not install the command hrev.');

// npm can leave the old bin files when the linked package.json already has the new bin name.
const prefix = spawnSync('npm', ['prefix', '-g'], { shell: true, encoding: 'utf8', windowsHide: true });
if (prefix.status !== 0) fail('npm could not find the global command folder.');
const binDir = process.platform === 'win32' ? prefix.stdout.trim() : join(prefix.stdout.trim(), 'bin');
for (const name of process.platform === 'win32' ? ['reviewer', 'reviewer.cmd', 'reviewer.ps1'] : ['reviewer']) {
  const file = join(binDir, name);
  if (!existsSync(file)) continue;
  const owned = lstatSync(file).isSymbolicLink()
    ? realpathSync(file) === realpathSync(join(commandHome, 'open.mjs'))
    : process.platform === 'win32' && readFileSync(file, 'utf8').replaceAll('\\', '/').includes('/node_modules/page-review/open.mjs');
  if (owned) rmSync(file);
}

const { servers } = await import(pathToFileURL(join(commandHome, 'servers.mjs')).href);
const running = await servers();
// a restart stops the agent of the server; a server of an older version tells no agent state
const BUSY_AGENT = new Set(['working', 'stopping']);
const busy = s => BUSY_AGENT.has(s.agent?.state);
const show = s => `  http://localhost:${s.port}/  ${s.root}` + (busy(s) ? `\n    agent: ${s.agent.text}` : '');
if (!running.length) console.log('No review servers run.');
else if (!opt.restart) {
  console.log('These review servers run the old code until they restart (npm run deploy -- --restart, or hrev restart in the project):');
  for (const s of running) console.log(show(s));
} else {
  const refused = opt.force ? [] : running.filter(busy);
  for (const s of running.filter(s => !refused.includes(s))) {
    run(process.execPath, [join(commandHome, 'open.mjs'), 'restart', '--root', s.root, '--port', String(s.port)], { cwd: s.root });
  }
  if (refused.length) {
    console.error('These review servers did not restart: their agent works on notes, and a restart stops it.\n' +
      'Restart them later, or now with npm run deploy -- --restart --force:');
    for (const s of refused) console.error(show(s));
    process.exitCode = 1;
  }
}
