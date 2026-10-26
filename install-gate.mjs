#!/usr/bin/env node
// Installs only the send gate into ~/.claude. Safe to re-run.
//   - copies hooks/send-gate.mjs, bin/approve-send.mjs, bin/away-mode.mjs
//     (never overwrites a file that already exists unless you pass --force)
//   - backs up ~/.claude/settings.json to settings.json.bak-send-gate, then adds one
//     PreToolUse hook entry. Other hooks and settings are left as they are.
//   - running it twice does not add the hook twice
// Usage:
//   node install-gate.mjs             install
//   node install-gate.mjs --dry-run   show what would change, change nothing
//   node install-gate.mjs --uninstall remove the hook entry and the three files
//   --force                           overwrite / remove files even if they differ from this copy
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) { console.error('HOME is not set. Nothing was changed.'); process.exit(1); }
const CLAUDE = join(HOME, '.claude');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const UNINSTALL = args.includes('--uninstall');
const known = new Set(['--force', '--dry-run', '--uninstall']);
const bad = args.filter((a) => !known.has(a));
if (bad.length) { console.error(`Unknown option: ${bad.join(' ')}\nUsage: node install-gate.mjs [--dry-run] [--uninstall] [--force]`); process.exit(1); }

const say = (s) => console.log(s);
const rel = (p) => relative(HOME, p);
const FILES = [
  ['hooks/send-gate.mjs', join(CLAUDE, 'hooks', 'send-gate.mjs')],
  ['bin/approve-send.mjs', join(CLAUDE, 'bin', 'approve-send.mjs')],
  ['bin/away-mode.mjs', join(CLAUDE, 'bin', 'away-mode.mjs')],
];
const same = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };

const settingsPath = join(CLAUDE, 'settings.json');
const backupPath = `${settingsPath}.bak-send-gate`;
const MARKER = 'send-gate.mjs';
const GATE_CMD = 'PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" node "$HOME/.claude/hooks/send-gate.mjs" || { echo "send-gate could not run, so this call is blocked. Usually node is not on PATH: start Claude Code from a normal terminal." >&2; exit 2; }';

// Read settings first. If it is not valid JSON we stop before touching anything.
let settings = {};
const hadSettings = existsSync(settingsPath);
if (hadSettings) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { say(`! ${settingsPath} is not valid JSON. Fix it, then re-run. Nothing was changed.`); process.exit(1); }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    say(`! ${settingsPath} is not a JSON object. Nothing was changed.`); process.exit(1);
  }
}

function writeSettings() {
  if (DRY) return;
  mkdirSync(CLAUDE, { recursive: true });
  const tmp = `${settingsPath}.tmp-send-gate`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, settingsPath);
}
function backup() {
  if (!hadSettings) return;
  if (existsSync(backupPath)) { say(`  keep    ${rel(backupPath)} (backup already exists)`); return; }
  say(`  backup  ${rel(backupPath)}`);
  if (!DRY) copyFileSync(settingsPath, backupPath);
}

say(`${UNINSTALL ? 'Uninstalling the send gate from' : 'Installing the send gate into'} ${CLAUDE}${DRY ? ' (dry run, nothing is written)' : ''}`);

if (!UNINSTALL) {
  for (const [srcRel, dest] of FILES) {
    const src = join(SRC, srcRel);
    if (!existsSync(src)) { say(`! missing ${srcRel} next to install-gate.mjs. Run this from the send-gate folder.`); process.exit(1); }
  }
  for (const [srcRel, dest] of FILES) {
    const src = join(SRC, srcRel);
    if (existsSync(dest)) {
      if (same(src, dest)) { say(`  keep    ${rel(dest)} (already installed, identical)`); continue; }
      if (!FORCE) { say(`  keep    ${rel(dest)} (exists and differs; --force to replace)`); continue; }
    }
    say(`  copy    ${rel(dest)}`);
    if (!DRY) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); }
  }
  settings.hooks ||= {};
  settings.hooks.PreToolUse ||= [];
  if (JSON.stringify(settings.hooks.PreToolUse).includes(MARKER)) {
    say(`  keep    PreToolUse hook ${MARKER} (already wired)`);
  } else {
    backup();
    // No matcher: runs for every tool call. The gate itself decides what to block.
    settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: GATE_CMD, timeout: 5 }] });
    say(`  wire    PreToolUse -> ${MARKER}`);
    writeSettings();
  }
  if (DRY) say('\nDry run only. Nothing was changed.');
  else say('\nDone. Next:');
  if (!DRY) {
  say(`  1. Run the tests: node "${join(SRC, 'tests', 'test-send-gate.mjs')}"   (expect: 0 failed)`);
  say('  2. In Claude Code, run /hooks to confirm the PreToolUse hook is listed. If it is not, start a new session.');
  say('  3. Try it: ask Claude to send a test message through a connected mail or chat tool. It should be blocked.');
  say('  4. To let one send through, run node ~/.claude/bin/approve-send.mjs "<recipient>" in your OWN terminal window (it asks you to type a code), then tell Claude to retry.');
  }
} else {
  // Remove our hook entries, keep everything else.
  let removed = 0;
  const pre = settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : null;
  if (pre) {
    const kept = [];
    for (const group of pre) {
      const inner = Array.isArray(group && group.hooks) ? group.hooks : null;
      if (!inner) { kept.push(group); continue; }
      const left = inner.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(MARKER)));
      removed += inner.length - left.length;
      if (left.length) kept.push({ ...group, hooks: left });
    }
    if (removed) {
      backup();
      if (kept.length) settings.hooks.PreToolUse = kept; else delete settings.hooks.PreToolUse;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      say(`  unwire  PreToolUse ${MARKER} (${removed} entr${removed === 1 ? 'y' : 'ies'})`);
      writeSettings();
    }
  }
  if (!removed) say(`  keep    settings.json (no ${MARKER} hook found)`);
  for (const [srcRel, dest] of FILES) {
    if (!existsSync(dest)) { say(`  skip    ${rel(dest)} (not there)`); continue; }
    if (!same(join(SRC, srcRel), dest) && !FORCE) { say(`  keep    ${rel(dest)} (differs from this copy; --force to remove)`); continue; }
    say(`  remove  ${rel(dest)}`);
    if (!DRY) unlinkSync(dest);
  }
  say('\nLeft in place on purpose: ~/.claude/send-gate.json (your config), ~/.claude/state/send-gate/ (the log), and any settings.json backup.');
  if (!DRY) say('Start a new Claude Code session so the hook stops loading.');
}
