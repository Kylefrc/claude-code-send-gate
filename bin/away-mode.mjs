#!/usr/bin/env node
// Away mode. While ON, ~/.claude/away.flag exists and the send gate denies EVERY gated
// action, approval token or not. Turn it on before you leave Claude running unattended.
//
// "on" and "status" run anywhere. "off" needs a person at a real terminal (a code typed on
// /dev/tty), so Claude cannot lift away mode from its Bash tool. Run "off" in your own terminal.
//
// Usage:
//   node ~/.claude/bin/away-mode.mjs on
//   node ~/.claude/bin/away-mode.mjs off
//   node ~/.claude/bin/away-mode.mjs status
import { existsSync, writeFileSync, unlinkSync, statSync, mkdirSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

const HOME = process.env.HOME || process.env.USERPROFILE;
const FLAG = join(HOME, '.claude', 'away.flag');
const cmd = (process.argv[2] || 'status').toLowerCase();

function confirmOnTty(lines) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); } catch { return 'no-tty'; }
  try {
    const code = String(randomInt(1000, 10000));
    writeSync(fd, `${lines.join('\n')}\n\nType ${code} and press Return to continue (anything else cancels): `);
    const buf = Buffer.alloc(256);
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, null); } catch { return 'read-failed'; }
    return buf.toString('utf8', 0, n).trim() === code ? 'ok' : 'cancelled';
  } finally { try { closeSync(fd); } catch {} }
}

if (cmd === 'on') {
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  writeFileSync(FLAG, `away since ${new Date().toISOString()}\n`);
  console.log('Away mode ON. Sends, posts and payments are blocked, approved or not.');
} else if (cmd === 'off') {
  if (!existsSync(FLAG)) { console.log('Away mode is already OFF.'); process.exit(0); }
  const verdict = confirmOnTty(['Turning away mode OFF. After this, gated actions can run again once you approve each one.']);
  if (verdict === 'no-tty') {
    console.error('Away mode stays ON. Turning it off needs a person at a real terminal and none is attached.\nOpen your own terminal window (not Claude) and run: node ~/.claude/bin/away-mode.mjs off');
    process.exit(1);
  }
  if (verdict !== 'ok') { console.error('Away mode stays ON. The code did not match.'); process.exit(1); }
  unlinkSync(FLAG);
  console.log('Away mode OFF. Each send still needs your explicit approval.');
} else if (existsSync(FLAG)) {
  console.log(`Away mode is ON (since ${statSync(FLAG).mtime.toISOString()}).`);
} else {
  console.log('Away mode is OFF.');
}
