#!/usr/bin/env node
// PreToolUse hook: SEND GATE.
//
// Stops Claude from reaching a human or moving money unless you said yes to THAT action.
// Covers: MCP tools that send/post/pay, shell commands that POST to messaging, CRM, accounting
// or payment APIs (and a few CLIs: gh, aws ses/sns, stripe, osascript, mail), and
// browser-automation scripts that click a Send button.
//
// WHY A HOOK: "always ask before sending" in CLAUDE.md is a request, not a control.
// In bypassPermissions / auto-accept mode nothing at the harness level stops an outbound
// email. A PreToolUse hook that returns permissionDecision "deny" blocks the call in every
// permission mode, so this gate only ever uses deny.
//
// POLICY for a gated call:
//   0. the call would approve a send or edit the gate itself -> DENY (Claude may not do that)
//   1. ~/.claude/away.flag exists                -> DENY (hard switch; nothing gets out)
//   2. a fresh single-use approval token exists  -> let it through (token consumed)
//      (a token minted with --match only fits a call that mentions that text)
//   3. otherwise                                 -> DENY, with instructions to Claude
// Tokens are minted by YOU, in your own terminal: node ~/.claude/bin/approve-send.mjs "<what>"
// That script needs a code typed at a real terminal, which Claude's Bash tool does not have.
// Every decision is logged to ~/.claude/state/send-gate/send-gate.log.
//
// Non-gated calls exit 0 silently. The hook never throws; if it cannot read its input it
// fails open (exit 0) so a bad payload never bricks a session. Settings wiring fails CLOSED
// if node itself is missing (see settings.snippet.json).
//
// This is pattern matching, not a sandbox. See the README for what it cannot see.
//
// Customize in ~/.claude/send-gate.json (all keys optional, merged over the defaults below):
//   { "extraGatedTools": ["^mcp__mycrm__update_deal$"],
//     "allowTools": ["^mcp__slack__send_message_to_self$"],
//     "extraHosts": ["api.mycrm.com"],
//     "extraShellPatterns": ["\\bgit\\s+push\\b"],   (tested against each command with quoted text removed)
//     "tokenTtlSeconds": 180 }

import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CLAUDE_DIR = join(HOME, '.claude');
const AWAY_FLAG = join(CLAUDE_DIR, 'away.flag');
const GATE_DIR = join(CLAUDE_DIR, 'state', 'send-gate');
const TOKEN = join(GATE_DIR, 'send-approved');
const LOG = join(GATE_DIR, 'send-gate.log');
const CONFIG = join(CLAUDE_DIR, 'send-gate.json');

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const toolName = String(payload.tool_name || '');
const toolInput = payload.tool_input || {};

let cfg = {};
try { if (existsSync(CONFIG)) cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) || {}; } catch { cfg = {}; }
const TTL_MS = (Number(cfg.tokenTtlSeconds) > 0 ? Number(cfg.tokenTtlSeconds) : 180) * 1000;
const toRegexes = (list) => (Array.isArray(list) ? list : []).flatMap((s) => {
  try { return [new RegExp(s, 'i')]; } catch { return []; }
});

// ---------- 1. MCP tools ----------
// The tool name is split into words (send_email -> send, email; chatPostMessage -> chat, post,
// message). It is gated when a send/pay word appears and no read word comes before it.
// So send_email, send_draft, slack_post_message, create_refund, finalize_invoice are gated, while
// create_draft, list_sent, get_post, search_messages, list_invoices pass. Drafts save; they do not send.
const SEND_WORDS = new Set(['send', 'reply', 'forward', 'publish', 'tweet', 'post', 'submit', 'pay',
  'payment', 'charge', 'refund', 'transfer', 'payout', 'sms', 'dial', 'order', 'broadcast',
  'invoice', 'finalize', 'void', 'cancel', 'comment', 'merge', 'schedule', 'book', 'notify', 'invite', 'enroll']);
const READ_WORDS = new Set(['list', 'get', 'read', 'search', 'find', 'fetch', 'query', 'lookup',
  'preview', 'retrieve', 'describe', 'count', 'status', 'history', 'view', 'show']);
const extraGated = toRegexes(cfg.extraGatedTools);
const allowTools = toRegexes(cfg.allowTools);
const extraShell = toRegexes(cfg.extraShellPatterns);
const words = (s) => s.split(/[_\-.\s]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase()).filter(Boolean);

function mcpIsGated(name) {
  if (!name.startsWith('mcp__')) return false;
  if (allowTools.some((r) => r.test(name))) return false;
  if (extraGated.some((r) => r.test(name))) return true;
  const verb = name.split('__').slice(2).join('_'); // strip mcp__<server>__
  // Browser JS tools are handled by the Send-button check below.
  if (/javascript|evaluate_script|execute_script/i.test(verb)) return false;
  const w = words(verb);
  const s = w.findIndex((x) => SEND_WORDS.has(x));
  if (s < 0) return false;
  const r = w.findIndex((x) => READ_WORDS.has(x));
  return r < 0 || s < r;
}

// ---------- 2. Shell ----------
// A command is gated when one of its parts (split on ; | & newline, outside quotes, and inside
// $(...) and backticks) is a sender, so `git commit -m "fix sendmail"` and `grep "curl -X POST ..."`
// are NOT gated: the program being run is what counts, not words it is given.
const HOSTS = [
  // mail, chat, SMS, push
  'gmail.googleapis.com', 'graph.microsoft.com', 'outlook.office.com', 'api.sendgrid.com',
  'api.mailgun.net', 'api.postmarkapp.com', 'api.resend.com', 'api.twilio.com', 'mandrillapp.com',
  'api.sparkpost.com', 'api.mailjet.com', 'api.brevo.com', 'api.sendinblue.com', 'api.mailchimp.com',
  'connect.mailerlite.com', 'api.convertkit.com', 'api.kit.com', 'a.klaviyo.com', 'rest.nexmo.com',
  'api.vonage.com', 'api.messagebird.com', 'api.plivo.com', 'api.openphone.com', 'api.dialpad.com',
  'slack.com/api', 'hooks.slack.com', 'discord.com/api', 'api.telegram.org', 'ntfy.sh',
  'api.pushover.net', 'hooks.zapier.com', 'maker.ifttt.com',
  // CRM and helpdesk
  'api.hubapi.com', 'api.hubspot.com', 'api.pipedrive.com', 'salesforce.com', 'zohoapis.com',
  'api.intercom.io', 'api.helpscout.net', 'zendesk.com/api', 'api.close.com',
  // payments and accounting
  'api.stripe.com', 'api.squareup.com', 'api.paypal.com', 'api-m.paypal.com', 'api.paddle.com',
  'api.lemonsqueezy.com', 'api.gumroad.com', 'quickbooks.api.intuit.com', 'api.xero.com',
  'api.freshbooks.com', 'gql.waveapps.com', 'api.bill.com', 'api.wise.com', 'myshopify.com/admin',
  // scheduling and field service
  'api.calendly.com', 'api.cal.com', 'api.getjobber.com', 'api.housecallpro.com',
  // public posting
  'api.github.com',
  ...(Array.isArray(cfg.extraHosts) ? cfg.extraHosts.map(String) : []),
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOST_RE = new RegExp(HOSTS.map(esc).join('|'), 'i');
const MUTATE_RE = /(-X\s*(POST|PUT|PATCH|DELETE)\b|--request[ =]\s*(POST|PUT|PATCH|DELETE)\b|--method[ =]\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data(-raw|-binary|-urlencode)?|-F|--form|--json|--upload-file)(\s|=|@)|\s-d\S|--(post-data|post-file|body-data|body-file)\b|method\s*[:=]\s*['"`]?(POST|PUT|PATCH|DELETE)|\.(post|put|patch|delete)\s*\(|requests\.(post|put|patch|delete)|\.request\(\s*['"](POST|PUT|PATCH|DELETE)|(urlopen|Request)\([^)]*\bdata\s*=|\b(http|https)\s+(POST|PUT|PATCH|DELETE)\b)/i;
// SDK calls that send without ever writing a host name in the script.
const SDK_RE = /(\bmessages\.create\s*\(|chat_postMessage|chat\.postMessage|\bsmtplib\b|\bSMTP(_SSL)?\s*\(|\.sendmail\s*\(|\.sendMail\s*\(|sgMail\.send|resend\.emails\.send|stripe\.(refunds|charges|paymentIntents|payment_intents|transfers|payouts|invoices)\.(create|finalize|pay|send)|stripe\.(Refund|Charge|PaymentIntent|Transfer|Payout)\.create|\bses\.send_email|\bsend_raw_email|sns\.publish)/i;
const MAILERS = new Set(['sendmail', 'mail', 'mailx', 'mutt', 'msmtp', 's-nail', 'ssmtp', 'swaks']);
const RUNNERS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'python', 'python2', 'python3', 'node', 'nodejs',
  'deno', 'bun', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'npx', 'uv',
  'java', 'lua', 'Rscript', 'swift', 'go']);
const OSA_RE = /\b(send|reply|forward)\b/i;
const OSA_APPS_RE = /\b(Mail|Messages|Microsoft Outlook|Outlook|Slack|Telegram|WhatsApp|Discord|Signal)\b/;
const GH_RE = /\bgh\s+(?:(issue|pr|release|gist|discussion)\s+(comment|create|merge|close|reopen|review|edit|delete)|repo\s+(create|delete)|api\b[^\n]*(?:-X\s*|--method[ =]\s*)(POST|PUT|PATCH|DELETE)\b|api\b[^\n]*\s(-f|-F|--field|--raw-field|--input)\b)/i;
const AWS_RE = /\b(ses|sesv2|sns|pinpoint|pinpoint-sms-voice-v2|connect)\s+(send-\S+|publish\S*|start-outbound\S*)/i;
const STRIPE_RE = /\bstripe\s+(?:\S+\s+)*?(create|update|delete|cancel|confirm|capture|refund|pay|send|resend|void|finalize|post)\b/i;
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'xargs', 'nice', 'timeout', 'stdbuf',
  'builtin', 'setsid', 'then', 'do', 'else', '!', 'if', 'while', 'until', '{', '(']);

function scriptText(cmd) {
  // "node send.mjs" hides the URL inside the file; read referenced scripts (bounded).
  const out = [];
  const paths = cmd.match(/[\w./~-]+\.(mjs|cjs|js|ts|py|sh|rb|scpt|applescript)\b/g) || [];
  for (const raw of paths.slice(0, 6)) {
    if (/(^|\/)(test-)?send-gate\.mjs$/.test(raw)) continue; // the gate and its own tests quote send patterns on purpose
    const p = raw.replace(/^~/, HOME);
    try { if (existsSync(p) && statSync(p).size < 512 * 1024) out.push(readFileSync(p, 'utf8')); } catch {}
  }
  return out.join('\n');
}

// Split on ; | & newline outside quotes.
function splitCommands(cmd) {
  const segs = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}
// Text inside $(...) and `...` (not inside single quotes).
function substitutions(cmd) {
  const out = [];
  let sq = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { sq = !sq; continue; }
    if (sq) continue;
    if (c === '$' && cmd[i + 1] === '(') {
      let depth = 1, j = i + 2;
      while (j < cmd.length && depth) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; j++; }
      out.push(cmd.slice(i + 2, j - 1));
      i = j - 1;
    } else if (c === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j > i) { out.push(cmd.slice(i + 1, j)); i = j; }
    }
  }
  return out;
}
function allSegments(cmd, depth = 0) {
  if (depth > 4) return [];
  const segs = splitCommands(cmd);
  for (const sub of substitutions(cmd)) segs.push(...allSegments(sub, depth + 1));
  // sh -c "..." and bash -c '...': the quoted text is itself a command line
  for (const seg of [...segs]) {
    const m = /^(?:\S+\s+)*?(?:sh|bash|zsh|dash|ksh)\s+(?:-\S+\s+)*?-\S*c\s+(["'])([\s\S]*)\1\s*$/.exec(seg);
    if (m) segs.push(...allSegments(m[2], depth + 1));
  }
  return segs;
}
const unquoted = (seg) => seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
// The program a segment runs: skips VAR=value, sudo/env/xargs and similar wrappers, and leading ( or {.
function exeOf(seg) {
  const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i].replace(/^[({]+/, '').replace(/^["']|["']$/g, '');
    if (!t) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (WRAPPERS.has(t)) {
      i++;
      while (i < toks.length) {
        if (/^-/.test(toks[i])) { i += (t === 'sudo' || t === 'doas') && /^-[ugCphT]$/.test(toks[i]) ? 2 : 1; continue; }
        if (t === 'timeout' && /^\d/.test(toks[i])) { i++; continue; }
        if (t === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) { i++; continue; }
        break;
      }
      continue;
    }
    return t.split('/').pop();
  }
  return '';
}
function bashIsGated(cmd) {
  if (!cmd) return false;
  const heredoc = /<<-?\s*['"]?\w+/.test(cmd);
  for (const seg of allSegments(cmd)) {
    const exe = exeOf(seg);
    if (!exe) continue;
    if (MAILERS.has(exe)) return true;
    if (extraShell.some((r) => r.test(unquoted(seg)))) return true;
    if (exe === 'osascript') { const t = seg + '\n' + scriptText(seg); if (OSA_RE.test(t) && OSA_APPS_RE.test(t)) return true; }
    if (exe === 'gh' && GH_RE.test(seg)) return true;
    if (exe === 'aws' && AWS_RE.test(seg)) return true;
    if (exe === 'stripe' && STRIPE_RE.test(seg)) return true;
    if (exe === 'twilio' && /\bcreate\b/i.test(seg)) return true;
    if (RUNNERS.has(exe)) {
      const body = heredoc ? cmd : seg;
      const hay = body + '\n' + scriptText(body);
      if (SDK_RE.test(hay)) return true;
      if (HOST_RE.test(hay) && MUTATE_RE.test(hay)) return true;
    }
  }
  return false;
}

// ---------- 3. Browser JS ----------
// Only a positive Send indicator is gated, so page reads and draft-saving still work.
const SEND_BUTTON_RE = /((aria-label|title|data-tooltip|innerText|textContent|name)\s*[*^$~|]?=?\s*\(?\s*['"`]\s*(send|send now|post|publish|pay|submit payment|place order)\s*['"`])|(\.click\(\)[^\n]{0,120}\b(send|publish|pay)\b)|(\b(send|publish|pay)\w*\b[^\n]{0,120}\.click\(\))/i;
function browserIsGated(name, input) {
  if (!/javascript|evaluate_script|execute_script/i.test(name)) return false;
  const code = String(input.text || input.code || input.function || input.expression || input.script || '');
  return SEND_BUTTON_RE.test(code);
}

// ---------- 4. Self-approval guard ----------
// Claude may not mint an approval, lift away mode, or edit the gate. Matching text is a speed bump,
// not a wall: the wall is that approve-send.mjs needs a code typed at a real terminal. A determined
// process can still dodge the text match (build the file name from pieces) and allocate its own pty.
const SELF_APPROVE_RE = /approve-send|send-approved|away\.flag|away-mode(\.mjs)?["']?\s+off\b|(^|[\s/"'])uninstall\.mjs|install-gate\.mjs["']?\s+--uninstall/i;
const GATE_FILE_RE = /(^|[\s/"'=])send-gate\.(mjs|json)\b/;
const WRITE_VERB_RE = /(>|\btee\b|\bsed\s+-\S*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bperl\s+-\S*i|\bchmod\b|\bln\b|\bdd\b|writeFile|appendFile|unlink|rename|rmSync|open\([^)]*['"][wa])/;
const PROTECTED_PATH_RE = /(^|\/)\.claude\/(send-gate\.json|away\.flag|hooks\/send-gate\.mjs|bin\/(approve-send|away-mode)\.mjs|state\/send-gate(\/|$))/;
// Building a pseudo-terminal is the one way a process can type the approval code itself.
const PTY_RE = /\b(pty\.(fork|spawn|openpty)|openpty|forkpty|pexpect|node-pty)\b|\bunbuffer\b|(^|[\s;&|])script\s+(-\S+\s+)*\/dev\/null|\bexpect\s+(-\S+\s+)*-[cf]\b/;
function selfApprovalAttempt() {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    const hay = cmd + '\n' + scriptText(cmd); // a script the command runs counts as part of the command
    return SELF_APPROVE_RE.test(hay) || PTY_RE.test(hay) || (GATE_FILE_RE.test(cmd) && WRITE_VERB_RE.test(cmd));
  }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) {
    const p = String(toolInput.file_path || toolInput.notebook_path || '').replace(/\\/g, '/').replace(/^~/, HOME);
    return PROTECTED_PATH_RE.test(p);
  }
  return false;
}

// ---------- decide ----------
function logLine(kind, msg) {
  try { mkdirSync(GATE_DIR, { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()}\t${kind}\t${msg}\n`); } catch {}
}
let what = toolName;
if (toolName === 'Bash') what = `Bash: ${String(toolInput.command || '').slice(0, 120)}`;
function deny(reason) {
  logLine('DENY', `${what} :: ${reason.split('\n')[0]}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
  process.exit(0);
}

if (selfApprovalAttempt()) {
  deny(`SEND GATE: this call would approve a send, lift away mode, or change the gate itself (${what}). Claude may not do that, so nothing was changed.
Only the owner does these, in their own terminal window: node ~/.claude/bin/approve-send.mjs "<what>" (it asks them to type a code), or node ~/.claude/bin/away-mode.mjs off. Tell the owner what you need and stop.`);
}

let gated = false;
if (toolName === 'Bash') {
  gated = bashIsGated(String(toolInput.command || ''));
} else if (browserIsGated(toolName, toolInput)) {
  gated = true;
} else {
  gated = mcpIsGated(toolName);
}
if (!gated) process.exit(0);

if (existsSync(AWAY_FLAG)) {
  deny('SEND GATE: away mode is ON, so nothing that reaches a person or moves money can run. It was NOT sent. Save it as a draft instead. The owner turns this off in their own terminal with: node ~/.claude/bin/away-mode.mjs off');
}

try {
  if (existsSync(TOKEN)) {
    const age = Date.now() - statSync(TOKEN).mtimeMs;
    let note = '', match = '';
    try { const t = JSON.parse(readFileSync(TOKEN, 'utf8')); note = t.note || ''; match = String(t.match || ''); } catch {}
    if (age <= TTL_MS && match) {
      // A token tied to a recipient or action only fits a call that mentions it. A wrong call does not burn it.
      const hay = (toolName + '\n' + JSON.stringify(toolInput)).toLowerCase();
      if (!hay.includes(match.toLowerCase())) {
        logLine('MISMATCH', `${what} :: token "${note}" is only for "${match}"; left in place`);
        deny(`SEND GATE: the owner's approval on file is only for a call that mentions "${match}". This call does not (${what}). It was NOT sent, and the approval was not used up. If you meant a different send, show the owner the exact text and recipient and ask them to approve that one.`);
      }
    }
    unlinkSync(TOKEN); // single use, consumed whether fresh or stale
    if (age <= TTL_MS) {
      logLine('ALLOW', `${what} :: token "${note}"${match ? ` (match "${match}")` : ''} (${Math.round(age / 1000)}s old)`);
      process.exit(0); // normal permission rules still apply after this
    }
    logLine('STALE', `${what} :: token "${note}" was ${Math.round(age / 1000)}s old`);
  }
} catch {}

deny(`SEND GATE: this action reaches a person or moves money (${what}). It was NOT sent.
To proceed: (1) show the owner the exact final content and recipient and get an explicit "yes" to THAT action in this conversation; (2) ask the owner to approve it in their own terminal window, not through you: node ~/.claude/bin/approve-send.mjs --match "<recipient>" "<what>" (it asks them to type a code, which you cannot do); (3) when the owner says it is approved, retry the same call within ${TTL_MS / 1000}s.
Do not run approve-send yourself and do not try to create the approval another way. Unattended or scheduled runs stay draft-only.`);
