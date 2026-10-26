#!/usr/bin/env node
// Mint a FRESH, single-use approval token for the send gate.
//
// THE OWNER RUNS THIS, in their own terminal window, after they said yes to one specific send.
// It will not mint anything unless a person types a code at a real terminal (/dev/tty).
// Claude's Bash tool has no terminal, so there the script fails closed and writes nothing.
//
// Usage:
//   node ~/.claude/bin/approve-send.mjs "jane@example.com - invoice reminder"
//   node ~/.claude/bin/approve-send.mjs --match jane@example.com "invoice reminder"
//
// --match TEXT (optional): the token only works for a call whose tool name or input contains TEXT
// (case-insensitive). A call that does not contain it is denied and the token is left in place.
// The next matching gated call uses the token up; it expires after 180s (tokenTtlSeconds in
// ~/.claude/send-gate.json changes that).
import { mkdirSync, writeFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

const HOME = process.env.HOME || process.env.USERPROFILE;
const GATE_DIR = join(HOME, '.claude', 'state', 'send-gate');

const args = process.argv.slice(2);
let match = '';
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--match') { match = String(args[++i] || '').trim(); } else rest.push(args[i]);
}
const note = rest.join(' ').trim();
if (!note) {
  console.error('Usage: node approve-send.mjs [--match TEXT] "<recipient or action>"');
  process.exit(2);
}

// Ask a person, at the controlling terminal, to type a random code. No terminal means no approval.
function confirmOnTty(lines) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); } catch { return 'no-tty'; }
  try {
    const code = String(randomInt(1000, 10000));
    writeSync(fd, `${lines.join('\n')}\n\nType ${code} and press Return to approve (anything else cancels): `);
    const buf = Buffer.alloc(256);
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, null); } catch { return 'read-failed'; }
    return buf.toString('utf8', 0, n).trim() === code ? 'ok' : 'cancelled';
  } finally { try { closeSync(fd); } catch {} }
}

const verdict = confirmOnTty([
  'SEND GATE approval. This lets ONE gated action through, once, in the next few minutes.',
  `  Action: ${note}`,
  match ? `  Only for a call that mentions: ${match}` : '  Not tied to a recipient (add --match TEXT to tie it to one).',
]);

if (verdict === 'no-tty') {
  console.error('Not approved. This script needs a person at a real terminal and none is attached, so nothing was written.\nOpen your own terminal window (not Claude) and run it there.');
  process.exit(1);
}
if (verdict !== 'ok') {
  console.error('Not approved. The code did not match, so nothing was written.');
  process.exit(1);
}

mkdirSync(GATE_DIR, { recursive: true });
writeFileSync(join(GATE_DIR, 'send-approved'),
  JSON.stringify({ approvedAt: new Date().toISOString(), note, ...(match ? { match } : {}) }) + '\n', { mode: 0o600 });
console.log(`Approved the next gated action (${note}${match ? `; only calls mentioning "${match}"` : ''}). Tell Claude it is approved; it expires soon.`);
