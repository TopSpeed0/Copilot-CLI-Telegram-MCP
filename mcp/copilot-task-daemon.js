#!/usr/bin/env node
// copilot-task-daemon.js — Always-on Telegram → GitHub Copilot CLI bridge.
//
// Mirrors the Claude Code daemon (telegram-task-daemon.js) but uses:
//   `copilot -p <task>` instead of `claude -p <task>`
//
// Copilot CLI has no --session-id / --resume — each call is stateless.
// Continuity is handled entirely by our own archive + context-prefix injection
// (same pattern as the Claude daemon's fork-recovery path).
//
// Config (same resolution as Claude daemon):
//   1. Env vars TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   2. JSON file <workspace>/.telegram-config
//
// State: .copilot-daemon-state.json
// Queue: .copilot-queue.json  (Hermes → Copilot tasks)

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { spawn } = require('child_process');

const WORKDIR     = path.resolve(__dirname, '..');
const STATE_FILE  = path.join(WORKDIR, '.copilot-daemon-state.json');
const LOCK_FILE   = path.join(WORKDIR, '.copilot-daemon.lock');
const ARCHIVE_DIR = path.join(WORKDIR, 'archive');
const DAILY_SUMMARIES_FILE = path.join(ARCHIVE_DIR, 'daily-summaries.json');

// ---------- Skills (dynamic loader) ----------
// Skills dir resolution (public-repo-safe — no hardcoded paths):
//   1. config.skills_dir  (set in .telegram-config — gitignored)
//   2. env var SKILLS_DIR
//   3. ~/.claude/skills  (Hermes default)
//   4. disabled (no skills injected)
//
// Each skill is a directory with a SKILL.md file containing YAML frontmatter:
//   ---
//   name: skill-name
//   description: "TRIGGER when user mentions X / Y / Z ..."
//   tags: [tag1, tag2]
//   ---
//
// Dynamic matching: tokenise the user message, then score each skill by how many
// description/tag tokens overlap. Inject the top-N matching skills as context.

const SKILLS_TOP_N = 3; // max skills to inject per message

function resolveSkillsDir(cfg) {
  if (cfg.skills_dir && fs.existsSync(cfg.skills_dir)) return cfg.skills_dir;
  if (process.env.SKILLS_DIR && fs.existsSync(process.env.SKILLS_DIR)) return process.env.SKILLS_DIR;
  const home = process.env.USERPROFILE || process.env.HOME;
  const def  = path.join(home, '.claude', 'skills');
  if (fs.existsSync(def)) return def;
  return null;
}

// Parse YAML frontmatter block (--- ... ---) from a SKILL.md string.
// Returns { name, description, tags } or null.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const block = m[1];
  const get = (key) => {
    const r = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  const tagsLine = block.match(/^tags:\s*\[([^\]]*)\]/m);
  const tags = tagsLine ? tagsLine[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')) : [];
  return { name: get('name'), description: get('description'), tags };
}

// Load all skills from the skills dir: [{ name, description, tags, content, skillPath }]
function loadAllSkills(skillsDir) {
  if (!skillsDir) return [];
  const skills = [];
  let entries;
  try { entries = fs.readdirSync(skillsDir); } catch { return []; }
  for (const entry of entries) {
    const skillMd = path.join(skillsDir, entry, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    try {
      const content = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      skills.push({ ...fm, content, skillPath: skillMd });
    } catch { /* skip unreadable */ }
  }
  log(`skills: loaded ${skills.length} skills from ${skillsDir}`);
  return skills;
}

// Score a skill against a user message. Returns a number (0 = no match).
function scoreSkill(skill, message) {
  const haystack = (skill.description + ' ' + skill.tags.join(' ')).toLowerCase();
  // Extract meaningful tokens from the message (≥3 chars, ignore common words)
  const STOPWORDS = new Set(['the','and','for','with','this','that','have','from','not','are','was','but','can','all']);
  const tokens = message.toLowerCase()
    .split(/[\s/,.()\[\]{}'"!?;:]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  let score = 0;
  for (const tok of tokens) {
    if (haystack.includes(tok)) score += tok.length; // longer tokens = stronger signal
  }
  return score;
}

// Find the top-N most relevant skills for a given message.
function matchSkills(skills, message, topN) {
  const scored = skills
    .map(s => ({ skill: s, score: scoreSkill(s, message) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return scored.map(x => x.skill);
}

// Build a context block from matched skills to prepend to the Copilot prompt.
function buildSkillsContext(matchedSkills) {
  if (!matchedSkills.length) return null;
  const blocks = matchedSkills.map(s =>
    `### Skill: ${s.name}\n${s.content}`
  ).join('\n\n---\n\n');
  return `[Relevant skills/procedures for this task — follow these instructions]\n\n${blocks}`;
}

const RECENT_TURNS   = 10;   // verbatim turns kept in context window
const RECALL_DAYS_MAX = 365;

// ---------- Logging ----------
function log(msg) {
  process.stderr.write(`[copilot-daemon ${new Date().toISOString()}] ${msg}\n`);
}

// ---------- Config ----------
function loadConfig() {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat  = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) return { bot_token: envToken, chat_id: envChat };
  const cfgPath = path.join(WORKDIR, '.telegram-config');
  if (!fs.existsSync(cfgPath)) throw new Error(`No Telegram config (env vars or ${cfgPath}).`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  if (!cfg.bot_token || !cfg.chat_id) throw new Error(`${cfgPath} missing bot_token/chat_id.`);
  return cfg;
}
const config = loadConfig();

// ---------- Skills boot ----------
const SKILLS_DIR = resolveSkillsDir(config);
const ALL_SKILLS = loadAllSkills(SKILLS_DIR);

// ---------- State ----------
let state = { updateOffset: 0, day: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) }; } catch (_) {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log(`saveState: ${e.message}`); }
}

// ---------- Single-instance lock ----------
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock() {
  try {
    const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (prev && prev !== process.pid && pidAlive(prev)) {
      log(`another daemon is already running (PID=${prev}); exiting`);
      process.exit(0);
    }
  } catch (_) {}
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { log(`acquireLock: ${e.message}`); }
}
function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

// ---------- Archive helpers ----------
function localDayKey(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ensureArchiveDir() { try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch (_) {} }
function archiveFile(day)   { return path.join(ARCHIVE_DIR, `${day}.jsonl`); }
function appendArchive(turn) {
  ensureArchiveDir();
  try { fs.appendFileSync(archiveFile(turn.day), JSON.stringify(turn) + '\n'); } catch (e) { log(`appendArchive: ${e.message}`); }
}
function readDayTurns(day) {
  try {
    return fs.readFileSync(archiveFile(day), 'utf-8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function loadDailySummaries() { try { return JSON.parse(fs.readFileSync(DAILY_SUMMARIES_FILE, 'utf-8')); } catch { return {}; } }
function saveDailySummaries(obj) {
  ensureArchiveDir();
  try { fs.writeFileSync(DAILY_SUMMARIES_FILE, JSON.stringify(obj, null, 2)); } catch (e) { log(`saveDailySummaries: ${e.message}`); }
}
function turnsToText(turns) {
  return turns.map(t => `User: ${t.user}\nAssistant: ${t.assistant}`).join('\n\n');
}

// ---------- Telegram API ----------
function tgApi(method, params, { httpTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req  = https.request({
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${config.bot_token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) reject(new Error(`${method}: ${parsed.description || data}`));
          else resolve(parsed.result);
        } catch (e) { reject(new Error(`${method} parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (httpTimeoutMs) req.setTimeout(httpTimeoutMs, () => req.destroy(new Error(`${method} timeout`)));
    req.write(body); req.end();
  });
}

// ---------- Output formatting ----------
function stripAnsi(s) { return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); }
function htmlEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function markdownToTelegramHTML(text) {
  const codeBlocks = [];
  let html = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, body) => {
    codeBlocks.push(body.replace(/\n+$/, ''));
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });
  const inlineCodes = [];
  html = html.replace(/`([^`\n]+?)`/g, (_m, body) => {
    inlineCodes.push(body);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^\n_]+?)__/g, '<b>$1</b>');
  html = html.replace(/(^|[^\w*])\*([^\n*]+?)\*(?!\w)/g, '$1<i>$2</i>');
  html = html.replace(/(^|[^\w_])_([^\n_]+?)_(?!\w)/g, '$1<i>$2</i>');
  html = html.replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>');
  html = html.replace(/^[ \t]*[-*] +(.+)$/gm, '• $1');
  html = html.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => {
    const body = inlineCodes[Number(i)];
    return `<code>${body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>`;
  });
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => {
    const body = codeBlocks[Number(i)];
    return `<pre>${body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
  });
  return html.trim();
}

function looksTabular(text) {
  const lines = text.split('\n'); let hits = 0;
  for (const line of lines) {
    if ((line.match(/ {2,}/g) || []).length >= 2) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

async function sendChunked(text, { mode = 'rich' } = {}) {
  const MAX = 3800;
  let remaining = stripAnsi(text || '(no output)');
  let effectiveMode = (mode === 'rich' && looksTabular(remaining)) ? 'mono' : mode;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX);
    if (remaining.length > MAX) {
      const lb = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' '));
      if (lb > MAX * 0.5) chunk = chunk.slice(0, lb);
    }
    let body, parse_mode;
    if (effectiveMode === 'mono')  { body = `<pre>${htmlEscape(chunk)}</pre>`; parse_mode = 'HTML'; }
    else if (effectiveMode === 'rich') { body = markdownToTelegramHTML(chunk); parse_mode = 'HTML'; }
    else { body = chunk; parse_mode = undefined; }
    try {
      await tgApi('sendMessage', { chat_id: config.chat_id, text: body, parse_mode, disable_web_page_preview: true });
    } catch (e) {
      log(`sendMessage HTML failed (${e.message}) — retrying plain`);
      await tgApi('sendMessage', { chat_id: config.chat_id, text: chunk, disable_web_page_preview: true });
    }
    remaining = remaining.slice(chunk.length);
  }
}

// ---------- Typing indicator ----------
function startTyping() {
  const send = () => tgApi('sendChatAction', { chat_id: config.chat_id, action: 'typing' }).catch(e => log(`typing: ${e.message}`));
  send();
  const iv = setInterval(send, 4000);
  return () => clearInterval(iv);
}

// ---------- Copilot CLI runner ----------
// Copilot CLI is stateless — no --resume. Continuity is via contextPrefix injection.
const COPILOT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

function quoteForCmd(arg) {
  if (typeof arg !== 'string') arg = String(arg);
  if (!/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\"*)\"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

// Write prompt to a temp file in WORKDIR and pass @filename to copilot.
// This avoids Windows command-line length limits (ENAMETOOLONG) when
// skills + conversation context makes the prompt very large.
const PROMPT_TMP = path.join(WORKDIR, '.copilot-prompt.tmp');

function copilotRaw(prompt) {
  return new Promise((resolve) => {
    try { fs.writeFileSync(PROMPT_TMP, prompt, 'utf-8'); } catch (e) {
      return resolve({ code: -1, out: '', errOut: `writePrompt: ${e.message}`, killed: false });
    }
    const cmdLine = `copilot -p "@${PROMPT_TMP}"`;
    log(`spawn: copilot -p @prompt.tmp (${prompt.length} chars)`);
    const proc = spawn(process.env.COMSPEC || 'cmd.exe',
      ['/d', '/s', '/c', cmdLine],
      { cwd: WORKDIR, windowsVerbatimArguments: true, env: { ...process.env } });
    let out = '', errOut = '', killed = false;
    proc.stdout.on('data', d => out    += d.toString());
    proc.stderr.on('data', d => errOut += d.toString());
    proc.on('error', e => resolve({ code: -1, out: '', errOut: `spawn error: ${e.message}`, killed: false }));
    const timer = setTimeout(() => {
      killed = true;
      log(`timeout: killing copilot after ${COPILOT_TIMEOUT_MS / 1000}s`);
      try { proc.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
    }, COPILOT_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(timer);
      try { fs.unlinkSync(PROMPT_TMP); } catch (_) {}
      resolve({ code, out, errOut, killed });
    });
  });
}

async function runCopilot(task, { contextPrefix } = {}) {
  const prompt = contextPrefix ? `${contextPrefix}\n\n---\nUser message:\n${task}` : task;
  const { code, out, errOut, killed } = await copilotRaw(prompt);
  if (killed) return { ok: false, text: `Task timed out after ${COPILOT_TIMEOUT_MS / 1000}s.\n${out.trim()}` };
  // Strip Copilot's trailing credits/stats line  ("AI Credits X.XX (Ys)\nTokens ...")
  const cleaned = stripAnsi(out)
    .replace(/^Read [^\n]+\n\s+└[^\n]+\n?/gm, '')  // strip "Read <file>\n  └ N lines read"
    .replace(/\n?Changes\s+\+\d+ -\d+.*$/ms, '')
    .replace(/\n?AI Credits.*$/ms, '')
    .trim();
  const text = cleaned || (errOut.trim() ? `(stderr) ${errOut.trim()}` : `(no output, exit=${code})`);
  return { ok: code === 0, text };
}

// ---------- Summarization (one-off, no session) ----------
async function summarize(label, body) {
  const prompt = `Summarize the following ${label} concisely in 4-8 short bullet points. `
    + `Capture facts, decisions, names, numbers, and open threads that future context would need. `
    + `Output ONLY the summary, no preamble.\n\n${body}`;
  const { ok, text } = await runCopilot(prompt);
  return ok ? text : null;
}

// ---------- Archive / recall ----------
async function rolloverIfNewDay() {
  const today = localDayKey();
  if (state.day && state.day !== today) {
    const prev  = state.day;
    const turns = readDayTurns(prev);
    if (turns.length) {
      const summary = await summarize(`conversation from ${prev}`, turnsToText(turns));
      if (summary) {
        const all = loadDailySummaries();
        all[prev] = summary;
        saveDailySummaries(all);
        log(`daily rollover: summarized ${prev} (${turns.length} turns)`);
      }
    }
  }
  if (state.day !== today) { state.day = today; saveState(); }
}

function parseRecall(text) {
  const m = text.trim().match(/^recall(?:\s+(\d+))?$/i);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  return Math.min(Math.max(n, 1), RECALL_DAYS_MAX);
}

function buildRecallContext(days) {
  const all   = loadDailySummaries();
  const dates = Object.keys(all).sort().slice(-days);
  if (!dates.length) return null;
  const block = dates.map(d => `### ${d}\n${all[d]}`).join('\n\n');
  return `[Memory recall — summaries of conversations over the last ${days} day(s)]\n\n${block}`;
}

async function buildRestoreContext() {
  const parts = [];
  const all   = loadDailySummaries();
  const pastDates = Object.keys(all).sort();
  if (pastDates.length) {
    const last = pastDates[pastDates.length - 1];
    parts.push(`[Summary of previous day (${last})]\n${all[last]}`);
  }
  const turns = readDayTurns(state.day);
  if (turns.length > RECENT_TURNS) {
    const sum = await summarize("earlier part of today's conversation", turnsToText(turns.slice(0, turns.length - RECENT_TURNS)));
    if (sum) parts.push(`[Summary of earlier today]\n${sum}`);
  }
  const recent = turns.slice(-RECENT_TURNS);
  if (recent.length) parts.push(`[Most recent ${recent.length} turn(s), verbatim]\n${turnsToText(recent)}`);
  if (!parts.length) return null;
  return `[Context restore — here is our conversation so far]\n\n${parts.join('\n\n')}`;
}

// ---------- Message handler ----------
async function handleMessage(rawText) {
  await rolloverIfNewDay();
  const stopTyping = startTyping();
  const t0 = Date.now();

  const recallDays = parseRecall(rawText);
  let taskText = rawText, contextPrefix;

  if (recallDays) {
    contextPrefix = buildRecallContext(recallDays);
    if (!contextPrefix) {
      stopTyping();
      await sendChunked('No archived daily summaries yet to recall.', { mode: 'rich' });
      return;
    }
    taskText = `Using the recalled summaries above, briefly tell me what you remember from the last ${recallDays} day(s).`;
  } else {
    // Build context: [skills] + [conversation history]
    const parts = [];
    const matched = matchSkills(ALL_SKILLS, rawText, SKILLS_TOP_N);
    if (matched.length) {
      log(`skills matched: ${matched.map(s => s.name).join(', ')}`);
      const sc = buildSkillsContext(matched);
      if (sc) parts.push(sc);
    }
    const convCtx = await buildRestoreContext();
    if (convCtx) parts.push(convCtx);
    contextPrefix = parts.length ? parts.join('\n\n===\n\n') : undefined;
  }

  let result, ok;
  try {
    ({ ok, text: result } = await runCopilot(taskText, { contextPrefix }));
  } finally { stopTyping(); }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (!ok) {
    await sendChunked(`**Failed** (${dt}s):\n${result || '(no output)'}`, { mode: 'rich' });
    return;
  }

  appendArchive({ day: state.day, ts: new Date().toISOString(), user: rawText, assistant: result });
  await sendChunked(result, { mode: 'rich' });
  log(`replied in ${dt}s`);
}

// ---------- Poll loop ----------
let busy = false;
async function pollLoop() {
  log(`ready — workdir=${WORKDIR} chat_id=${config.chat_id}`);
  while (true) {
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: state.updateOffset, timeout: 60, allowed_updates: ['message'],
      }, { httpTimeoutMs: 75 * 1000 });
    } catch (e) {
      log(`getUpdates: ${e.message} — backoff 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      state.updateOffset = u.update_id + 1; saveState();
      const m = u.message;
      if (!m || !m.text) continue;
      if (String(m.chat.id) !== String(config.chat_id)) { log(`ignored msg from chat ${m.chat.id}`); continue; }
      if (busy) {
        await tgApi('sendMessage', { chat_id: config.chat_id, text: 'Busy — finish current task first.' });
        continue;
      }
      busy = true;
      try { await handleMessage(m.text); }
      catch (e) { log(`handle: ${e.stack || e.message}`); try { await sendChunked(`Daemon error: ${e.message}`, { mode: 'plain' }); } catch (_) {} }
      busy = false;
    }
  }
}

// ---------- Hermes queue poller ----------
// Allows Hermes (Overmind) to delegate tasks to Copilot via .copilot-queue.json
const HERMES_QUEUE = path.join(WORKDIR, '.copilot-queue.json');
function readHermesQueue()    { try { return JSON.parse(fs.readFileSync(HERMES_QUEUE, 'utf-8')); } catch { return null; } }
function writeHermesQueue(obj){ try { fs.writeFileSync(HERMES_QUEUE, JSON.stringify(obj, null, 2)); } catch (e) { log(`writeHermesQueue: ${e.message}`); } }

async function hermesQueuePoll() {
  setInterval(async () => {
    if (busy) return;
    const q = readHermesQueue();
    if (!q || q.status !== 'pending') return;
    log(`hermes-queue: picked up task ${q.id}`);
    writeHermesQueue({ ...q, status: 'working', updated: new Date().toISOString() });
    busy = true;
    try {
      const { ok, text: result } = await runCopilot(q.task);
      writeHermesQueue({ ...q, status: ok ? 'done' : 'error', [ok ? 'result' : 'error']: result, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} ${ok ? 'done' : 'error'}`);
    } catch (e) {
      writeHermesQueue({ ...q, status: 'error', error: e.message, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} threw: ${e.message}`);
    }
    busy = false;
  }, 5000);
}

// ---------- Boot ----------
process.on('SIGINT',  () => { log('SIGINT, exiting');  releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); releaseLock(); process.exit(0); });
process.on('exit', releaseLock);

acquireLock();
hermesQueuePoll();
pollLoop().catch(e => { log(`fatal: ${e.stack || e.message}`); releaseLock(); process.exit(1); });
