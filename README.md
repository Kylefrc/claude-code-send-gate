# claude-code-send-gate

A Claude Code PreToolUse hook that blocks tool calls which send a message, publish a post, or move money, unless you approved that specific action a moment ago.

Dependency-free Node (20 or newer), MIT licensed, 145 regression tests. Independent project, not affiliated with or endorsed by Anthropic.

## The problem

A rule in a prompt or in `CLAUDE.md` ("always ask before sending") is advice. The model usually follows it. Usually is not a control.

The Claude Code permissions docs say it directly: instructions in your prompt or `CLAUDE.md` "shape what Claude tries to do, but they don't change what Claude Code allows." If you run in a mode that skips permission prompts (`bypassPermissions` is documented as one), or you have clicked "always allow" on a mail or chat tool, nothing outside the model's own judgment sits between a draft and a send.

A hook does not depend on the model's judgment. Hooks run before the permission prompt, and a hook that returns a `deny` decision, or exits with code 2, stops the tool call. So the check lives in code that the model cannot talk its way past, and the approval step is something you do on purpose.

This repo is that check, for the narrow case of "this action reaches a person or moves money".

References:

- Hooks: https://code.claude.com/docs/en/hooks (PreToolUse decision control: `"deny"` prevents the tool call; exit code 2 blocks it)
- Permissions: https://code.claude.com/docs/en/permissions (section "Extend permissions with hooks": PreToolUse hooks run before the permission prompt, and a blocking hook applies even when an allow rule would let the call through)

What was checked: on 2026-10-25, Claude Code 2.1.310 was run headless (`claude -p`) with `--dangerously-skip-permissions` and this hook wired in. A gated `sendmail -bp` (it only prints the mail queue) was denied; the approve script, run from Claude's Bash tool with its file name split so the text guard did not match, exited 1 and wrote nothing; and after an approval typed at a terminal, the gated command went through once. The transcript is `LIVE-TEST.txt`. That was headless mode, not the interactive screen, one version, one machine. The test suite runs the hook directly with sample payloads. Run the "Try it" step below in your own setup before you rely on it.

## How it works

Claude Code sends the hook a JSON payload on stdin (`tool_name`, `tool_input`) before every tool call. The gate classifies the call. If it does not look like a send or a payment, the hook exits 0 and prints nothing. If it does, the policy is:

1. If `~/.claude/away.flag` exists, deny. Nothing gets out, approved or not.
2. If a fresh approval token exists, delete it and let the call through. A token is used once. If you minted it with `--match`, it only fits a call that mentions that text.
3. Otherwise deny, with a message telling Claude to show you the exact content and recipient and to ask you to approve it in your own terminal.

Before any of that, a guard denies a call that would approve a send, lift away mode, uninstall the gate, edit the gate's own files or build a pseudo-terminal.

What counts as a send:

- MCP tools. The tool name is split into words (`send_email`, `chatPostMessage`). It is gated when a send, pay or notify word appears (send, reply, forward, publish, tweet, post, submit, pay, charge, refund, transfer, payout, sms, dial, order, broadcast, invoice, finalize, void, cancel, comment, merge, schedule, book, notify, invite, enroll) and no read word (list, get, read, search, find, fetch, query, ...) comes before it. `send_email`, `create_refund`, `finalize_invoice` and `merge_pull_request` are blocked. `create_draft`, `list_sent_messages`, `list_invoices` and `get_order` pass. Drafts save; they do not send.
- Shell commands whose program is a sender: local mailers (`mail`, `sendmail`, `mutt`, `msmtp`), `osascript` scripts that send from Mail, Messages, Outlook or Slack, `gh issue|pr|release` writes and `gh api` writes, `aws ses|sns send/publish`, the `stripe` CLI's create/cancel/refund verbs, and curl, wget, python, node and similar that make a mutating HTTP call (POST, PUT, PATCH, DELETE, `-d`, `--data`, `--post-data`, `requests.post`) to a known mail, chat, SMS, CRM, accounting, scheduling or payment host, or call a send SDK (`smtplib`, Twilio `messages.create`). That includes calls hidden inside a script file the command runs. The program is what counts, so `git commit -m "fix sendmail handling"` and `grep "curl -X POST https://api.stripe.com" docs/` pass.
- Browser-automation JavaScript that clicks a Send, Post, Publish or Pay button.

The token is a file, `~/.claude/state/send-gate/send-approved`. You mint it, in your own terminal window, not through Claude:

```
node ~/.claude/bin/approve-send.mjs --match jane@example.com "invoice reminder"
```

The script prints what you are approving, shows a random 4-digit code, and writes the token only if you type that code. It reads the code from `/dev/tty`, the terminal a person is sitting at. Claude's Bash tool has no terminal, so there the script prints an error, exits 1 and writes nothing, and piping a code into it does not help. `--match` is optional; with it, the token only fits a call whose tool name or input contains that text (case-insensitive), and a different call is denied without using the token up.

The token is valid for 180 seconds by default (`tokenTtlSeconds` in `send-gate.json` changes that). A stale token is deleted and the call is denied. The note you pass is written to the log so you can audit what each approval was for.

Away mode is one flag file. Turning it on works anywhere; turning it off also asks for a code at your own terminal:

```
node ~/.claude/bin/away-mode.mjs on      # block every gated action, token or not
node ~/.claude/bin/away-mode.mjs off     # needs a person at a terminal
node ~/.claude/bin/away-mode.mjs status
```

Every decision is appended to `~/.claude/state/send-gate/send-gate.log`.

### What a session looks like

This is real output from the shipped files, run against a throwaway HOME the same way the tests run them (the terminal step was driven through a pseudo-terminal, standing in for you). The deny message is one JSON line in practice; it is wrapped here to read it.

```
1. send with no token
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SEND GATE: this action reaches a person or moves money (mcp__gmail__send_email). It was NOT sent.
   To proceed: (1) show the owner the exact final content and recipient and get an explicit \"yes\" to THAT action in this conversation; (2) ask the owner to approve it in their own terminal window, not through you: node ~/.claude/bin/approve-send.mjs --match \"<recipient>\" \"<what>\" (it asks them to type a code, which you cannot do); (3) when the owner says it is approved, retry the same call within 180s.
   Do not run approve-send yourself and do not try to create the approval another way. Unattended or scheduled runs stay draft-only."}}

2. you, in your own terminal: node bin/approve-send.mjs --match jane@example.com "invoice reminder"
   SEND GATE approval. This lets ONE gated action through, once, in the next few minutes.
     Action: invoice reminder
     Only for a call that mentions: jane@example.com

   Type 5601 and press Return to approve (anything else cancels): 5601
   Approved the next gated action (invoice reminder; only calls mentioning "jane@example.com"). Tell Claude it is approved; it expires soon.

3. same send again          -> no output, exit 0 (allowed, token consumed)
4. same send a second time  -> deny
5. mcp__gmail__create_draft -> no output, exit 0 (allowed)
6. away mode on, new token, same send -> deny ("away mode is ON ...")
```

and the log from that run (message text shortened):

```
DENY	mcp__gmail__send_email :: SEND GATE: this action reaches a person or moves money ...
ALLOW	mcp__gmail__send_email :: token "invoice reminder" (match "jane@example.com") (0s old)
DENY	mcp__gmail__send_email :: SEND GATE: this action reaches a person or moves money ...
DENY	mcp__gmail__send_email :: SEND GATE: away mode is ON, so nothing that reaches a person or moves money can run. ...
```

## Install

Needs Node 20 or newer (`node -v`) and Claude Code on macOS or Linux. On Windows, use WSL: the hook command in `settings.json` is a POSIX shell line.

```
git clone https://github.com/Kylefrc/claude-code-send-gate && cd claude-code-send-gate
node install-gate.mjs --dry-run
node install-gate.mjs && node tests/test-send-gate.mjs
```

The installer:

- copies `hooks/send-gate.mjs` to `~/.claude/hooks/`, and `bin/approve-send.mjs` and `bin/away-mode.mjs` to `~/.claude/bin/`
- never overwrites a file that already exists and differs, unless you pass `--force`
- backs up `~/.claude/settings.json` to `settings.json.bak-send-gate` before changing it, adds one `PreToolUse` entry (no matcher, so it sees every tool call, 5 second timeout), and leaves your other hooks and settings alone
- can be run twice without adding the hook twice
- stops without changing anything if `settings.json` is not valid JSON

The wired command fails closed on one specific thing: if `node` cannot be found, the call is blocked with a message instead of passing silently.

Then run `/hooks` in Claude Code to confirm the hook is listed (start a new session if it is not).

Try it: ask Claude to send a test message through any connected mail or chat tool. It should be blocked and told how to ask you for approval. Approve it the proper way (a second terminal window of your own, `node ~/.claude/bin/approve-send.mjs --match "<recipient>" "<what>"`, type the code), tell Claude it is approved, and watch it go through once.

## Tests

```
$ node tests/test-send-gate.mjs
145 passed, 0 failed
```

Run on macOS (Darwin 24.1.0) with Node v20.11.0 and v22.23.1. The 145 cases are 83 classification checks (what is gated and what passes, including commands that only mention a sender), 6 token checks (one use, consumed, untouched by ungated calls, stale tokens denied and removed), 6 recipient-match checks, 3 away-mode checks, 26 self-approval guard checks, 8 config checks and 13 terminal checks (the approval scripts refuse without a terminal and work with one). Each case runs in a temporary HOME, so the suite never touches your real `~/.claude`. The terminal checks use `python3` to drive a pseudo-terminal; without it they are reported as skipped.

What the tests are: the hook run directly with sample JSON payloads. What they are not: a Claude Code session, or proof that every tool in your setup is covered. Passing means those named cases behave as written. After you install, ask Claude to attempt a send with each of your own tools and watch what happens.

`TEST-TRANSCRIPT.txt` has the transcript of the installer checks (dry run, install, repeat install, uninstall, existing hooks preserved, no overwrite without `--force`, invalid settings left alone). `LIVE-TEST.txt` has the headless Claude Code run described above.

## What it catches, and what it cannot see

Catches, out of the box:

- MCP tools with a send, pay or notify word in the name and no read word before it (including invoice, finalize, void, cancel, comment, merge, schedule)
- shell commands whose program is a sender: local mailers, `osascript` sends, `gh` issue, PR and release writes, `aws ses` and `aws sns`, the `stripe` CLI, and curl, wget, python or node calls that POST, PUT, PATCH or DELETE to Gmail, Microsoft Graph, SendGrid, Mailgun, Postmark, Resend, Twilio, Slack, Discord, Telegram, Stripe, Square, PayPal, Mailchimp, OpenPhone, Dialpad, HubSpot, Salesforce, Pipedrive, QuickBooks, Xero, Calendly and several more (the full list is `HOSTS` in the hook)
- browser-automation scripts that click a Send, Post, Publish or Pay button

Cannot see, so cover these in your `CLAUDE.md` and your own review:

- A plain mouse click on a Send button through a computer-use or click-by-element tool. The gate only reads script text.
- APIs on hosts that are not in the list. Add them to `extraHosts`.
- MCP tools whose names do not contain a listed word (for example `notify_customer` is listed, but `alert_customer` is not). Add them to `extraGatedTools`.
- `git push`, `npm publish` and deploys. Off by default; add `"extraShellPatterns": ["\\bgit\\s+push\\b"]` to turn on the one you want. GitHub `create_issue` and similar MCP writes are not gated either; add them to `extraGatedTools`.
- A URL that is built from pieces at run time, so the host never appears as text in the command or in a script the command names. The script reader follows at most 6 referenced files, each under 512 KB.
- Any action that is not a send or a payment, such as deleting files. This is not a general permission system.
- It matches names and strings, so it can also block things you wanted (a tool called `submit_review` or a spreadsheet's `merge_cells`, for example). Use `allowTools` for those.

Limits of the design:

- Without `--match`, the approval is not tied to a particular call: the next gated call within the time window uses the token, whatever its recipient. With `--match`, the call must mention the text you gave.
- The approval step relies on `/dev/tty`. Claude's Bash tool has no terminal, so Claude cannot type the code. But any process that can run Python can open its own pseudo-terminal and type it (the test suite does exactly that to test the script). The hook therefore also denies commands, and scripts they run, that name `approve-send`, the token file, `away.flag` or the gate's own files, or that build a pseudo-terminal. That is text matching, and it can be dodged: in the headless run a split file name got past it (the terminal requirement still stopped the script). I did not try anything cleverer than that. This is a safeguard against mistakes, drift and over-eager automation, not a sandbox.
- If the hook cannot read its own input (bad JSON on stdin), it exits 0 and lets the call through, so a broken payload does not stop your session.
- Per the hooks docs, on PreToolUse a hook that times out does not block the call. The hook is a few file reads and finishes in milliseconds, but do not treat a stalled hook as a gate.
- Settings that turn hooks off (`disableAllHooks`, or starting Claude Code with `--bare`) turn this off too, and so does anything that can edit your `settings.json`. A `permissions.ask` rule on `Bash(*approve-send*)` adds a second layer; the permission-modes docs say ask rules still prompt in bypass mode, and a deny rule and an ask rule held in a headless bypass run (see `LIVE-TEST.txt`).

## Configuration

Everything is optional. Create `~/.claude/send-gate.json`; it is merged over the defaults, and a file that does not parse is ignored.

```json
{
  "extraGatedTools": ["^mcp__mycrm__update_deal$"],
  "allowTools": ["^mcp__slack__send_message_to_self$"],
  "extraHosts": ["api.mycrm.com"],
  "extraShellPatterns": ["\\bgit\\s+push\\b"],
  "tokenTtlSeconds": 180
}
```

- `extraGatedTools`: regexes (case-insensitive) matched against the full tool name. A match is always gated.
- `allowTools`: regexes for MCP tools to exempt from the name rule. Checked first. It does not exempt shell commands or browser scripts, which have their own checks.
- `extraHosts`: hostnames added to the list of mail, chat, CRM and payment hosts for shell commands.
- `extraShellPatterns`: regexes tested against each part of a shell command with its quoted text removed. A match is always gated.
- `tokenTtlSeconds`: how long an approval stays valid.

## Uninstall

```
node install-gate.mjs --uninstall
```

This removes the `PreToolUse` entry that references `send-gate.mjs` (other hooks stay) and the three runtime files. A file that differs from the copy in this repo is left alone unless you add `--force`. It leaves `~/.claude/send-gate.json`, the log in `~/.claude/state/send-gate/`, and the settings backup in place. Or restore `settings.json.bak-send-gate` by hand.

## Layout

```
hooks/send-gate.mjs         the hook
bin/approve-send.mjs        mints a single-use approval token (needs a code typed at a terminal)
bin/away-mode.mjs           on / off / status for the away flag (off needs a terminal)
tests/test-send-gate.mjs    145 cases, runs in a temporary HOME
install-gate.mjs            installer / uninstaller
TEST-TRANSCRIPT.txt         installer test transcript
LIVE-TEST.txt               headless Claude Code run, bypass mode
```

## More

I also wrote a fuller Claude Code setup (a CLAUDE.md template, a memory system, two skills, rules for sub-agents, seven rule packs for common business tools and a written playbook) that is sold separately as The Operator Kit for Claude Code, USD 19 at https://operatorkit-cc.netlify.app. The gate here is complete without it.

## License

MIT. See `LICENSE`.
