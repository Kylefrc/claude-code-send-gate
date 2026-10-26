#!/usr/bin/env node
// Regression test for hooks/send-gate.mjs and the two scripts beside it. Runs every case in a
// throwaway HOME, so it never touches your real ~/.claude. Usage: node tests/test-send-gate.mjs
// (exit 1 on any failure). The approve-send and away-mode terminal checks drive a pseudo-terminal
// with python3; without python3 those cases are counted as skipped, not passed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, '..', 'hooks', 'send-gate.mjs');
const APPROVE = join(HERE, '..', 'bin', 'approve-send.mjs');
const AWAY = join(HERE, '..', 'bin', 'away-mode.mjs');

function run(home, payload) {
  const r = spawnSync(process.execPath, [GATE], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  if (r.status !== 0) return `exit${r.status}`;
  if (!r.stdout.trim()) return 'allow';
  try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { return 'garbled'; }
}
const freshHome = () => { const h = mkdtempSync(join(tmpdir(), 'gate-test-')); mkdirSync(join(h, '.claude'), { recursive: true }); return h; };
const mcp = (tool_name, tool_input = {}) => ({ tool_name, tool_input });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const js = (tool_name, code) => ({ tool_name, tool_input: tool_name.includes('devtools') ? { function: code } : { text: code } });

let pass = 0, fail = 0;
function expect(name, got, want) {
  if (got === want) { pass++; } else { fail++; console.log(`FAIL  ${name}: got ${got}, want ${want}`); }
}

// --- classification (no token, no away flag) ---
const H = freshHome();
const scriptDir = mkdtempSync(join(tmpdir(), 'gate-scripts-'));
writeFileSync(join(scriptDir, 'notify.mjs'), "await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: '{}' })\n");
writeFileSync(join(scriptDir, 'report.mjs'), "const r = await fetch('https://api.stripe.com/v1/charges'); console.log(await r.json())\n");

writeFileSync(join(scriptDir, 'sneaky.mjs'), "import { execFileSync } from 'node:child_process'; execFileSync('node', [process.env.HOME + '/.claude/bin/approve-send.mjs', 'x'])\n");
writeFileSync(join(scriptDir, 'ptyrun.py'), "import pty\npty.fork()\n");
writeFileSync(join(scriptDir, 'plain.mjs'), "console.log('hello')\n");
const CASES = [
  ['gmail send', mcp('mcp__gmail__send_email'), 'deny'],
  ['gmail send draft', mcp('mcp__gmail__send_draft'), 'deny'],
  ['gmail create draft', mcp('mcp__gmail__create_draft'), 'allow'],
  ['gmail search', mcp('mcp__gmail__search_emails'), 'allow'],
  ['gmail list sent', mcp('mcp__gmail__list_sent_messages'), 'allow'],
  ['outlook reply', mcp('mcp__outlook__reply_to_message'), 'deny'],
  ['outlook forward', mcp('mcp__outlook__forwardMessage'), 'deny'],
  ['slack post', mcp('mcp__slack__slack_post_message'), 'deny'],
  ['slack camel post', mcp('mcp__slack__chatPostMessage'), 'deny'],
  ['slack history', mcp('mcp__slack__get_channel_history'), 'allow'],
  ['stripe refund', mcp('mcp__stripe__create_refund'), 'deny'],
  ['stripe list refunds', mcp('mcp__stripe__list_refunds'), 'allow'],
  ['stripe get transfer', mcp('mcp__stripe__get_transfer'), 'allow'],
  ['stripe payment', mcp('mcp__stripe__create_payment_link'), 'deny'],
  ['x tweet', mcp('mcp__x__post_tweet'), 'deny'],
  ['sms', mcp('mcp__twilio__send_sms'), 'deny'],
  ['shop place order', mcp('mcp__shop__place_order'), 'deny'],
  ['shop get order', mcp('mcp__shop__get_order'), 'allow'],
  ['github get issue', mcp('mcp__github__get_issue'), 'allow'],
  ['calendar list', mcp('mcp__gcal__list_events'), 'allow'],
  ['non-mcp Read', mcp('Read', { file_path: '/etc/hosts' }), 'allow'],
  ['non-mcp Write', mcp('Write', { file_path: '/tmp/x', content: 'send it' }), 'allow'],
  ['bash ls', bash('ls -la'), 'allow'],
  ['bash curl GET stripe', bash('curl -s https://api.stripe.com/v1/charges -u sk_test:'), 'allow'],
  ['bash curl POST stripe', bash('curl -X POST https://api.stripe.com/v1/refunds -d charge=ch_1'), 'deny'],
  ['bash curl data slack', bash("curl https://hooks.slack.com/services/T/B/X --data '{\"text\":\"hi\"}'"), 'deny'],
  ['bash curl POST unrelated host', bash('curl -X POST https://httpbin.org/post'), 'allow'],
  ['bash mail', bash('echo hi | mail -s test a@b.com'), 'deny'],
  ['bash sendmail', bash('sendmail a@b.com < note.txt'), 'deny'],
  ['bash "email" word only', bash('grep -r "mail" ~/notes'), 'allow'],
  ['bash script POST slack', bash(`node ${join(scriptDir, 'notify.mjs')}`), 'deny'],
  ['bash script GET stripe', bash(`node ${join(scriptDir, 'report.mjs')}`), 'allow'],
  ['bash python requests post', bash("python3 -c \"import requests; requests.post('https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json')\""), 'deny'],
  ['devtools click Send', js('mcp__chrome-devtools__evaluate_script', "() => document.querySelector('[aria-label=\"Send\"]').click()"), 'deny'],
  ['chrome js click send btn', js('mcp__claude-in-chrome__javascript_tool', "const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='Send'); b.click()"), 'deny'],
  ['devtools read title', js('mcp__chrome-devtools__evaluate_script', '() => document.title'), 'allow'],
  ['devtools save draft', js('mcp__chrome-devtools__evaluate_script', "() => document.querySelector('[aria-label=\"Save\"]').click()"), 'allow'],
  ['garbage payload', 'not json', 'allow'],

  // --- coverage added after a gap review: other senders ---
  ['osascript Mail send', bash(`osascript -e 'tell application "Mail" to send newMessage'`), 'deny'],
  ['osascript display dialog', bash(`osascript -e 'display dialog "hi"'`), 'allow'],
  ['wget post-data twilio', bash(`wget --post-data="Body=hi" https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json`), 'deny'],
  ['wget GET twilio', bash('wget -q https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json'), 'allow'],
  ['curl POST hubspot emails', bash('curl -X POST https://api.hubapi.com/marketing/v3/emails -d @mail.json'), 'deny'],
  ['curl GET hubspot contacts', bash('curl -s https://api.hubapi.com/crm/v3/objects/contacts'), 'allow'],
  ['curl POST quickbooks invoice', bash('curl -X POST https://quickbooks.api.intuit.com/v3/company/1/invoice --json @i.json'), 'deny'],
  ['gh issue comment', bash('gh issue comment 12 --body "thanks"'), 'deny'],
  ['gh pr create', bash('gh pr create --title x --body y'), 'deny'],
  ['gh api POST', bash('gh api repos/o/r/issues -X POST -f title=x'), 'deny'],
  ['gh issue list', bash('gh issue list'), 'allow'],
  ['gh pr view', bash('gh pr view 4'), 'allow'],
  ['git push (not gated by default)', bash('git push origin main'), 'allow'],
  ['aws ses send-email', bash('aws ses send-email --from a@b.com --to c@d.com --subject s --text t'), 'deny'],
  ['aws sns publish', bash('aws sns publish --topic-arn arn:x --message hi'), 'deny'],
  ['aws s3 ls', bash('aws s3 ls'), 'allow'],
  ['aws ses list-identities', bash('aws ses list-identities'), 'allow'],
  ['stripe cli refund create', bash('stripe refunds create --charge ch_1'), 'deny'],
  ['stripe cli customers list', bash('stripe customers list'), 'allow'],
  ['python smtplib', bash(`python3 -c "import smtplib; s=smtplib.SMTP('mail.x'); s.sendmail('a@b.c','d@e.f','hi')"`), 'deny'],
  ['node twilio sdk', bash(`node -e "client.messages.create({to:'+1',body:'hi'})"`), 'deny'],
  ['python urlopen data to slack', bash(`python3 -c "import urllib.request as u; u.urlopen('https://hooks.slack.com/services/T/B/X', data=b'{}')"`), 'deny'],
  ['mailer after pipe', bash('cat note.txt | sendmail a@b.com'), 'deny'],
  ['mailer after &&', bash('cd /tmp && mail -s hi a@b.com < note.txt'), 'deny'],
  ['mailer via sudo', bash('sudo -u nobody sendmail a@b.com'), 'deny'],
  ['curl inside $()', bash('echo "$(curl -X POST https://slack.com/api/chat.postMessage -d text=hi)"'), 'deny'],
  ['curl inside bash -c', bash(`bash -c "curl -X POST https://hooks.slack.com/services/T/B/X -d '{}'"`), 'deny'],
  ['mailer inside bash -c', bash(`bash -c "echo hi | sendmail a@b.com"`), 'deny'],
  ['mailer inside sh -c single quotes', bash(`sh -c 'mail -s hi a@b.com < n.txt'`), 'deny'],
  ['python heredoc requests.post', bash(`python3 <<'EOF'\nimport requests\nrequests.post('https://api.twilio.com/x')\nEOF`), 'deny'],

  // --- false positives that used to be denied ---
  ['git commit message mentions sendmail', bash(`git commit -m 'fix sendmail handling'`), 'allow'],
  ['grep for a curl POST string', bash(`grep -rn "curl -X POST https://api.stripe.com/v1/refunds" docs/`), 'allow'],
  ['echo a curl POST string', bash(`echo 'curl -X POST https://slack.com/api/chat.postMessage -d text=hi'`), 'allow'],
  ['cat a file then grep mail', bash('cat notes.md | grep mail'), 'allow'],

  // --- MCP names that send or move money without the obvious word ---
  ['mcp create_invoice', mcp('mcp__qb__create_invoice'), 'deny'],
  ['mcp finalize_invoice', mcp('mcp__stripe__finalize_invoice'), 'deny'],
  ['mcp void_invoice', mcp('mcp__stripe__void_invoice'), 'deny'],
  ['mcp cancel_subscription', mcp('mcp__stripe__cancel_subscription'), 'deny'],
  ['mcp list_invoices', mcp('mcp__stripe__list_invoices'), 'allow'],
  ['mcp get_invoice', mcp('mcp__qb__get_invoice'), 'allow'],
  ['mcp add_issue_comment', mcp('mcp__github__add_issue_comment'), 'deny'],
  ['mcp merge_pull_request', mcp('mcp__github__merge_pull_request'), 'deny'],
  ['mcp schedule_event', mcp('mcp__calendly__schedule_event'), 'deny'],
  ['mcp list_comments', mcp('mcp__github__list_comments'), 'allow'],
  ['mcp github create_issue (needs the github pack)', mcp('mcp__github__create_issue'), 'allow'],
];
for (const [name, p, want] of CASES) expect(name, run(H, p), want);

// --- token flow ---
// A token is what approve-send.mjs writes after a person types its code. These cases write the same
// file by hand so the hook's side can be tested without a terminal; the terminal side is tested below.
const T = freshHome();
const tokPath = (home) => join(home, '.claude', 'state', 'send-gate', 'send-approved');
const mint = (home, note = 'test', match = '') => {
  mkdirSync(join(home, '.claude', 'state', 'send-gate'), { recursive: true });
  writeFileSync(tokPath(home), JSON.stringify({ approvedAt: new Date().toISOString(), note, ...(match ? { match } : {}) }) + '\n');
};
mint(T);
expect('token: first gated call allowed', run(T, mcp('mcp__gmail__send_email')), 'allow');
expect('token: consumed, second call denied', run(T, mcp('mcp__gmail__send_email')), 'deny');
mint(T);
expect('token: ungated call does not consume it', run(T, bash('ls')), 'allow');
expect('token: still there for the gated call', run(T, mcp('mcp__gmail__send_email')), 'allow');
mint(T);
const tok = tokPath(T);
const old = new Date(Date.now() - 10 * 60 * 1000);
utimesSync(tok, old, old);
expect('token: stale token denied', run(T, mcp('mcp__gmail__send_email')), 'deny');
expect('token: stale token removed', existsSync(tok) ? 'present' : 'removed', 'removed');

// --- token tied to a recipient (approve-send --match) ---
const M = freshHome();
mint(M, 'invoice reminder', 'jane@example.com');
expect('match: call for another recipient denied', run(M, mcp('mcp__gmail__send_email', { to: 'bob@example.com' })), 'deny');
expect('match: wrong call did not burn the token', existsSync(tokPath(M)) ? 'present' : 'removed', 'present');
expect('match: call for the approved recipient allowed', run(M, mcp('mcp__gmail__send_email', { to: 'Jane@Example.com', body: 'hi' })), 'allow');
expect('match: token used up by the right call', existsSync(tokPath(M)) ? 'present' : 'removed', 'removed');
mint(M, 'slack note', 'hooks.slack.com/services/T/B/X');
expect('match: shell call that contains the match', run(M, bash(`curl -X POST https://hooks.slack.com/services/T/B/X -d '{}'`)), 'allow');
mint(M, 'x', 'jane@example.com');
const oldM = new Date(Date.now() - 10 * 60 * 1000);
utimesSync(tokPath(M), oldM, oldM);
expect('match: stale token with a match is still denied', run(M, mcp('mcp__gmail__send_email', { to: 'jane@example.com' })), 'deny');

// --- away mode beats a token ---
const A = freshHome();
writeFileSync(join(A, '.claude', 'away.flag'), 'away\n');
mint(A, 'x');
expect('away: denied even with token', run(A, mcp('mcp__gmail__send_email')), 'deny');
expect('away: token not consumed by the away deny', existsSync(tokPath(A)) ? 'present' : 'removed', 'present');
expect('away: reads still fine', run(A, mcp('mcp__gmail__search_emails')), 'allow');

// --- Claude cannot approve its own send or edit the gate ---
const G = freshHome();
mint(G, 'real approval');
const gp = (rel) => join(G, '.claude', rel);
const GUARD = [
  ['guard: bash runs approve-send', bash('node ~/.claude/bin/approve-send.mjs "jane@example.com"'), 'deny'],
  ['guard: bash runs approve-send by other path', bash('cd ~/.claude/bin && node ./approve-send.mjs x'), 'deny'],
  ['guard: bash writes the token file', bash(`echo '{}' > ~/.claude/state/send-gate/send-approved`), 'deny'],
  ['guard: bash lifts away mode', bash('node ~/.claude/bin/away-mode.mjs off'), 'deny'],
  ['guard: bash removes away flag', bash('rm ~/.claude/away.flag'), 'deny'],
  ['guard: bash edits the config', bash(`echo '{"allowTools":[".*"]}' > ~/.claude/send-gate.json`), 'deny'],
  ['guard: bash edits the hook', bash(`sed -i '' 's/deny/allow/' ~/.claude/hooks/send-gate.mjs`), 'deny'],
  ['guard: bash node -e writes the config', bash(`node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/send-gate.json','{}')"`), 'deny'],
  ['guard: bash runs the uninstaller', bash('node uninstall.mjs'), 'deny'],
  ['guard: bash builds a pty with python', bash(`python3 -c "import pty; pty.spawn(['sh'])"`), 'deny'],
  ['guard: bash uses script to fake a terminal', bash('script -q /dev/null node something.mjs'), 'deny'],
  ['guard: bash uses pexpect', bash(`python3 -c "import pexpect; pexpect.spawn('x')"`), 'deny'],
  ['guard: a script file that names approve-send', bash(`node ${join(scriptDir, 'sneaky.mjs')}`), 'deny'],
  ['guard: a script file that builds a pty', bash(`python3 ${join(scriptDir, 'ptyrun.py')}`), 'deny'],
  ['guard: ordinary python is fine', bash(`python3 -c "print(1 + 1)"`), 'allow'],
  ['guard: ordinary script is fine', bash(`node ${join(scriptDir, 'plain.mjs')}`), 'allow'],
  ['guard: Write to the config', mcp('Write', { file_path: gp('send-gate.json'), content: '{}' }), 'deny'],
  ['guard: Edit the hook', mcp('Edit', { file_path: gp('hooks/send-gate.mjs'), old_string: 'a', new_string: 'b' }), 'deny'],
  ['guard: Write the token', mcp('Write', { file_path: gp('state/send-gate/send-approved'), content: '{}' }), 'deny'],
  ['guard: Write elsewhere is fine', mcp('Write', { file_path: join(G, 'notes.txt'), content: 'x' }), 'allow'],
  ['guard: away-mode on is fine', bash('node ~/.claude/bin/away-mode.mjs on'), 'allow'],
  ['guard: away-mode status is fine', bash('node ~/.claude/bin/away-mode.mjs status'), 'allow'],
  ['guard: reading the log is fine', bash('tail -20 ~/.claude/state/send-gate/send-gate.log'), 'allow'],
  ['guard: running the tests is fine', bash('node tests/test-send-gate.mjs > /tmp/out.txt'), 'allow'],
];
for (const [name, p, want] of GUARD) expect(name, run(G, p), want);
expect('guard: a real approval is not used up by a guard deny', existsSync(tokPath(G)) ? 'present' : 'removed', 'present');
expect('guard: the real approval still works', run(G, mcp('mcp__gmail__send_email')), 'allow');

// --- config overrides ---
const C = freshHome();
writeFileSync(join(C, '.claude', 'send-gate.json'), JSON.stringify({
  extraGatedTools: ['^mcp__crm__update_deal$'], allowTools: ['^mcp__slack__send_message_to_self$'], extraHosts: ['api.mycrm.com'],
  extraShellPatterns: ['\\bgit\\s+push\\b'],
}));
expect('config: extra gated tool', run(C, mcp('mcp__crm__update_deal')), 'deny');
expect('config: allow-listed tool', run(C, mcp('mcp__slack__send_message_to_self')), 'allow');
expect('config: extra host', run(C, bash('curl -X POST https://api.mycrm.com/deals')), 'deny');
expect('config: extra shell pattern (git push)', run(C, bash('git push origin main')), 'deny');
expect('config: extra shell pattern inside bash -c', run(C, bash(`bash -c "git push origin main"`)), 'deny');
expect('config: extra shell pattern ignores quoted text', run(C, bash(`git commit -m 'explain git push'`)), 'allow');
expect('config: extra shell pattern leaves git status alone', run(C, bash('git status')), 'allow');
writeFileSync(join(C, '.claude', 'send-gate.json'), '{ broken json');
expect('config: broken config falls back to defaults', run(C, mcp('mcp__gmail__send_email')), 'deny');

// --- the approval scripts need a person at a real terminal ---
// 1. With no terminal (how Claude's Bash tool runs things) nothing is written and the exit code is not 0.
//    The scripts run under python's setsid(), so they have no controlling terminal even if this test was
//    started from one. Piped stdin does not help: the code is read from /dev/tty, not from stdin.
const havePy = spawnSync('python3', ['-I', '-c', 'import pty']).status === 0;
const NO_TTY_DRIVER = `
import os, sys, subprocess
os.setsid()
r = subprocess.run(sys.argv[1:], input=b"1234\\n1234\\n1234\\n", capture_output=True)
sys.stdout.write(str(r.returncode))
`;
const noTty = (script, args, home) => spawnSync('python3', ['-I', '-c', NO_TTY_DRIVER, process.execPath, script, ...args],
  { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }).stdout;
const N = freshHome();
const AW = freshHome();
writeFileSync(join(AW, '.claude', 'away.flag'), 'away\n');
if (havePy) {
  expect('approve-send: no terminal, exit 1', noTty(APPROVE, ['jane@example.com'], N), '1');
  expect('approve-send: no terminal writes no token', existsSync(tokPath(N)) ? 'written' : 'none', 'none');
  expect('approve-send: no note is a usage error', noTty(APPROVE, [], N), '2');
  expect('away-mode off: no terminal, exit 1', noTty(AWAY, ['off'], AW), '1');
  expect('away-mode off: no terminal, flag stays', existsSync(join(AW, '.claude', 'away.flag')) ? 'on' : 'off', 'on');
  expect('away-mode on: works without a terminal', String(spawnSync(process.execPath, [AWAY, 'on'], { env: { ...process.env, HOME: N, USERPROFILE: N }, encoding: 'utf8' }).status), '0');
}

// 2. With a pseudo-terminal that has a person typing the code, it works; a wrong code does not.
const PTY_DRIVER = `
import os, pty, sys, re, select, time
mode = sys.argv[1]            # right | wrong
argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
buf = b''
sent = False
end = time.time() + 10
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 4096)
        except OSError: break
        if not d: break
        buf += d
    m = re.search(rb'Type (\\d{4}) and press Return', buf)
    if m and not sent:
        code = m.group(1).decode() if mode == 'right' else '0000'
        os.write(fd, (code + '\\n').encode()); sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(str(os.WEXITSTATUS(status)))
`;
const ptyRun = (mode, script, args, home) => spawnSync('python3', ['-I', '-c', PTY_DRIVER, mode, process.execPath, script, ...args],
  { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
let skipped = 0;
if (!havePy) {
  skipped = 13;
  console.log('SKIP  13 terminal cases: python3 with the pty module was not found');
} else {
  const P = freshHome();
  expect('approve-send: wrong code, exit 1', ptyRun('wrong', APPROVE, ['jane@example.com'], P).stdout, '1');
  expect('approve-send: wrong code writes no token', existsSync(tokPath(P)) ? 'written' : 'none', 'none');
  expect('approve-send: right code, exit 0', ptyRun('right', APPROVE, ['--match', 'jane@example.com', 'invoice reminder'], P).stdout, '0');
  expect('approve-send: right code writes the token', existsSync(tokPath(P)) ? 'written' : 'none', 'written');
  const written = JSON.parse(readFileSync(tokPath(P), 'utf8'));
  expect('approve-send: token carries note and match', `${written.note}|${written.match}`, 'invoice reminder|jane@example.com');
  expect('approve-send: token from a real terminal lets the matching send through', run(P, mcp('mcp__gmail__send_email', { to: 'jane@example.com' })), 'allow');
  const P2 = freshHome();
  writeFileSync(join(P2, '.claude', 'away.flag'), 'away\n');
  ptyRun('right', AWAY, ['off'], P2);
  expect('away-mode off: right code lifts it', existsSync(join(P2, '.claude', 'away.flag')) ? 'on' : 'off', 'off');
  rmSync(P, { recursive: true, force: true }); rmSync(P2, { recursive: true, force: true });
}

for (const d of [H, T, M, A, G, C, N, AW, scriptDir]) rmSync(d, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
