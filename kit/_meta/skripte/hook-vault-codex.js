#!/usr/bin/env node
'use strict';
// Codex lifecycle adapter. No LLM calls; reuses the Brain's naming, redaction,
// atomic writes, locks and prompt search. See hook-vault-codex.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

function createAdapter(vault, options = {}) {
  const lib = options.lib || require(path.join(vault, '_meta/skripte/sitzung-lib.js'));
  const search = options.search || require(path.join(vault, '_meta/skripte/prompt-treffer.js')).treffer;
  const stateDir = path.join(vault, '_meta/state/codex-sessions');
  const key = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
  const stateFile = id => path.join(stateDir, `${key(id)}.json`);
  const read = (file, fallback = '') => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };
  const load = id => { try { return JSON.parse(read(stateFile(id))); } catch { return { edits: 0, vaultWrites: 0, reminded: 0, shown: [], seenTools: [] }; } };
  const log = (event, data = {}) => {
    fs.mkdirSync(path.join(vault, '_meta/logs'), { recursive: true });
    fs.appendFileSync(path.join(vault, '_meta/logs/automation.log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), quelle: 'hook', tool: 'codex', event, ...data }) + '\n');
  };
  const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const inside = (file, root) => norm(file).startsWith(norm(root) + '/');
  const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

  function start(input) {
    const project = lib.projectOf(input.cwd);
    const parts = [`Wissens-Vault: ${vault}. Lies _meta/konventionen.md und beachte insbesondere parallele Sitzungen. Vor Entscheidungen gezielt mit _meta/skripte/vault-suche.js suchen; relevantes neues Wissen zeitnah festhalten. Die globale AGENTS.md enthaelt die dauerhafte Pflegeerlaubnis.`];
    const gitStateFile = path.join(vault, '_meta/state/git-sicherung.json');
    if (!fs.existsSync(path.join(vault, '.git'))) parts.push('ACHTUNG: Im Vault fehlt .git; die automatische Git-Sicherung ist nicht eingerichtet.');
    else {
      try {
        const gitState = JSON.parse(read(gitStateFile));
        if (!gitState.ok) parts.push('ACHTUNG: Letzte Git-Sicherung fehlgeschlagen; _meta/state/git-sicherung.json gezielt pruefen.');
        else if (Date.now() - Date.parse(gitState.ts) > 3 * 86400000) parts.push('Hinweis: Die letzte erfolgreiche Git-Sicherung liegt ueber drei Tage zurueck.');
      } catch { parts.push('Hinweis: Noch kein pruefbarer Status der automatischen Git-Sicherung vorhanden.'); }
    }
    if (project) {
      const base = path.join(vault, 'projekte', project.vault);
      parts.push(`Projekt: ${project.vault}.`);
      const index = read(path.join(base, '_index.md'));
      parts.push(index ? index.slice(0, 4096) : 'Noch kein Projektindex vorhanden; nur bei Bedarf anlegen.');
      let entries = [];
      try { entries = fs.readdirSync(path.join(base, 'offen')).filter(f => f.endsWith('.md') && !f.startsWith('_')); } catch {}
      const open = entries.filter(f => !/^status:\s*(erledigt|veraltet|verworfen)\s*$/m.test(read(path.join(base, 'offen', f)).slice(0, 1200)));
      if (open.length) parts.push(`Offene Punkte (nur bei Bezug lesen): ${open.slice(0, 20).join(', ')}${open.length > 20 ? `; weitere ${open.length - 20}` : ''}`);
    }
    log('sessionstart_kontext', { sitzung: key(input.session_id), projekt: project?.vault || null });
    return context(input.hook_event_name, parts.join('\n\n').slice(0, 8500));
  }

  function prompt(input, state) {
    if (!lib.projectOf(input.cwd)) return {};
    const hits = search(String(input.prompt || ''), input.cwd).filter(h => !state.shown.includes(h.pfad)).slice(0, Math.max(0, 8 - state.shown.length));
    state.shown.push(...hits.map(h => h.pfad));
    if (!hits.length) return {};
    return context('UserPromptSubmit', 'Moeglicherweise relevantes Vault-Wissen (bei Bezug gezielt lesen):\n' + hits.map(h => `- ${h.titel}: ${h.hinweis || ''} (${h.pfad})`).join('\n').slice(0, 1800));
  }

  function postTool(input, state) {
    // Explicit file edits only: shell text is not reliable evidence of a write.
    // Code-mode nested apply_patch calls also arrive through this event.
    if (input.tool_use_id && state.seenTools.includes(input.tool_use_id)) return {};
    const response = input.tool_response;
    if (response?.isError || (typeof response?.exit_code === 'number' && response.exit_code !== 0)) return {};
    const arg = input.tool_input || {};
    const files = [];
    if (/apply_patch|^(Edit|Write)$/.test(input.tool_name || '')) {
      const patch = String(arg.command || arg.patch || arg.input || '');
      for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) files.push(m[1].trim());
    }
    if (typeof arg.file_path === 'string') files.push(arg.file_path);
    const project = lib.projectOf(input.cwd);
    for (const file of new Set(files)) {
      const abs = path.resolve(input.cwd, file);
      if (inside(abs, vault) && abs.endsWith('.md') && !/[\\/](?:generiert|_meta)[\\/]/i.test(abs)) state.vaultWrites++;
      else if (project && inside(abs, path.join(lib.PROJECTS, project.dir))) state.edits++;
    }
    if (input.tool_use_id) state.seenTools = [...state.seenTools.slice(-99), input.tool_use_id];
    return {};
  }

  async function saveTranscript(input, state) {
    if (!input.transcript_path) return;
    // Codex's transcript format is not stable. Only known visible message
    // records are accepted. No tool outputs, system prompts or reasoning.
    const stat = fs.statSync(input.transcript_path);
    if (state.transcriptSize === stat.size && state.transcriptMtime === stat.mtimeMs) return;
    let first, last, users = 0, supported = 0;
    const blocks = [];
    const lines = readline.createInterface({ input: fs.createReadStream(input.transcript_path), crlfDelay: Infinity });
    for await (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const msg = row.payload;
      if (row.type !== 'response_item' || msg?.type !== 'message' || !['user', 'assistant'].includes(msg.role) || msg.phase === 'analysis' || msg.channel === 'analysis') continue;
      const text = (msg.content || []).filter(c => ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text || '').join('\n').trim();
      if (!text || /^<(?:environment_context|permissions instructions|INSTRUCTIONS)>/i.test(text) || /^# AGENTS\.md instructions/i.test(text)) continue;
      supported++;
      if (msg.role === 'user') users++;
      first ||= row.timestamp || new Date(stat.birthtimeMs).toISOString();
      last = row.timestamp || new Date(stat.mtimeMs).toISOString();
      blocks.push(`\n### ${msg.role === 'user' ? 'NUTZER' : 'CODEX'}\n${text}`);
    }
    if (users < 2) {
      if (!supported) log('transkript_unbekannt', { sitzung: key(input.session_id) });
      return;
    }
    const project = lib.projectOf(input.cwd);
    const base = project ? path.join(vault, 'projekte', project.vault) : path.join(vault, '_meta');
    // Prefix + hashed full ID avoids collisions with Claude/Auggie id8 names.
    const file = path.join(base, 'generiert/sitzungen-roh', `${first.slice(0, 10)}-codex${key(input.session_id)}.txt`);
    const text = lib.redact(`# Sitzung codex${key(input.session_id)}\nArbeitsverzeichnis: ${input.cwd}\nZeitraum: ${first} – ${last}\n` + blocks.join('\n'));
    lib.schreibeAtomar(file, text);
    state.transcriptSize = stat.size; state.transcriptMtime = stat.mtimeMs;
    log('sitzung_gesichert', { sitzung: key(input.session_id), projekt: project?.vault || null, nutzernachrichten: users, bytes: Buffer.byteLength(text) });
  }

  async function handle(input) {
    if (process.env.BRAIN_AUTOMATION || !input.session_id || !input.cwd || lib.istAusgenommen(input.cwd)) return {};
    const event = input.hook_event_name;
    if (event === 'SessionStart' || event === 'SubagentStart') return start(input);
    const release = lib.sperre(`codex-${key(input.session_id)}`, 5);
    if (!release) return {}; // another event owns this session; never steal it
    try {
      const state = load(input.session_id);
      let output = {};
      if (event === 'UserPromptSubmit') output = prompt(input, state);
      else if (event === 'PostToolUse') output = postTool(input, state);
      else if (event === 'Stop' || event === 'SessionEnd') {
        try { await saveTranscript(input, state); } catch (error) { log('transkript_fehler', { sitzung: key(input.session_id), code: error.code || 'PARSE' }); }
        if (event === 'Stop' && !input.stop_hook_active && state.edits >= 3 && state.vaultWrites === 0 && state.edits > state.reminded) {
          state.reminded = state.edits;
          output = { decision: 'block', reason: `Vault-Abschlusspruefung: ${state.edits} explizite Projektdatei-Aenderungen, bisher keine Vault-Notiz erkannt. Pruefe Entscheidungen, Erkenntnisse, Korrekturen und offene Punkte; halte nur dauerhaft nuetzliches neues Wissen fest. Falls nichts anfaellt, ohne Notiz abschliessen. Keine Rueckfrage zur bereits erlaubten Pflege.` };
        }
      }
      if (event !== 'SessionEnd') lib.schreibeAtomar(stateFile(input.session_id), JSON.stringify(state));
      else { try { fs.unlinkSync(stateFile(input.session_id)); } catch {} }
      return output;
    } finally { release(); }
  }
  return { handle };
}

if (require.main === module) {
  (async () => {
    if (process.env.BRAIN_AUTOMATION) return;
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const vault = path.resolve(__dirname, '..', '..');
    const result = await createAdapter(vault).handle(input);
    process.stdout.write(JSON.stringify(result));
  })().catch(error => {
    // Infrastructure errors must not block work or expose input contents.
    process.stderr.write(`Vault-Codex-Hook: ${error.code || error.name || 'Fehler'}\n`);
    process.stdout.write('{}');
  });
}
module.exports = { createAdapter };
