#!/usr/bin/env node
// Auggie-Hooks (Augment) für das Wissens-Vault ("Brain"), Pendant zu hook-vault.js. Konfiguration: _meta/brain.config.json.
// Ein Skript für alle Events, dispatcht über das Feld "hook_event_name" im Hook-JSON (stdin). Auggie erlaubt pro Hook nur einen
// Skriptpfad ohne Argumente, deshalb startet hook-vault-auggie.cmd dieses Skript. Eingetragen in ~/.augment/settings.json
// (installieren.js --auggie):
//   SessionStart  -> lädt _index.md (klein), Titel der offenen Punkte und Einzeiler-Hinweise (derselbe Kontext wie bei Claude Code)
//   PostToolUse   -> zählt Datei-Änderungen (save-file, str-replace-editor, remove-files) als Projekt- oder Vault-Schreibvorgang
//   Stop          -> erinnert, wenn seit der letzten Erinnerung neue Projektdateien geändert, aber keine Vault-Notiz geschrieben wurde
//   SessionEnd    -> sichert die über Stop-Events gesammelten Gesprächsrunden (geschwärzt) als Rohdatei unter projekte/<p>/generiert/sitzungen-roh/
// Kein Auggie-Äquivalent zu UserPromptSubmit: Korrektur-Erkennung und Vault-Treffer im Prompt gibt es hier nicht.
// Der Verdichtungslauf verarbeitet die Rohdateien beider Werkzeuge. Bricht nie mit Fehler ab, schreibt Ereignisse nach
// _meta/logs/automation.log.jsonl (tool: 'auggie'). Läufe der Automatisierung (BRAIN_AUTOMATION=1) lösen keine Hooks aus.
if (process.env.BRAIN_AUTOMATION) process.exit(0);

const fs = require('fs');
const path = require('path');
const lib = require('./hook-lib');
const { redact, istAusgenommen, schreibeAtomar } = require('./sitzung-lib');

const { VAULT, projectOf, classify } = lib;
const log = lib.createLogger('auggie');
const STATE_DIR = path.join(VAULT, '_meta', 'state', 'auggie-sessions');
const STOP_MIN_DATEIEN = 3;

const stateFile = cid => path.join(STATE_DIR, `${String(cid || 'unbekannt').replace(/[^\w.-]/g, '_')}.json`);
function loadState(cid) {
  try { return JSON.parse(fs.readFileSync(stateFile(cid), 'utf8')); } catch { return { projektEdits: 0, vaultWrites: 0, remindedAtProjektEdits: null, turns: [] }; }
}
function saveState(cid, st) { schreibeAtomar(stateFile(cid), JSON.stringify(st)); }
function clearState(cid) { try { fs.unlinkSync(stateFile(cid)); } catch { /* schon weg */ } }
const wurzel = input => (input.workspace_roots || [])[0];

function sessionStart(input) {
  clearState(input.conversation_id); // frischer Start, falls Reste einer früheren Session mit derselben ID existieren
  const out = lib.baueStart(wurzel(input), input.conversation_id, log);
  if (out) process.stdout.write(JSON.stringify(out));
}

// Zählt Datei-Änderungen (file_changes, nur bei save-file/str-replace-editor/remove-files vorhanden) je Konversation.
function postToolUse(input) {
  const p = projectOf(wurzel(input));
  if (!p || !Array.isArray(input.file_changes) || !input.file_changes.length) return;
  const st = loadState(input.conversation_id);
  for (const ch of input.file_changes) {
    const kind = ch && ch.path && classify(ch.path, p);
    if (kind === 'vault') st.vaultWrites++;
    else if (kind === 'projekt') st.projektEdits++;
  }
  saveState(input.conversation_id, st);
}

// Erinnert, wenn seit der letzten Erinnerung neue Projekt-Edits ohne Vault-Schreibvorgang dazugekommen sind
// (ersetzt Claudes stop_hook_active, da Auggie kein äquivalentes Feld liefert). Ab STOP_MIN_DATEIEN geänderten Dateien, wie bei Claude Code.
function stop(input) {
  const p = projectOf(wurzel(input));
  const st = loadState(input.conversation_id);
  if (input.conversation) {
    const conv = input.conversation;
    st.turns.push({
      ts: conv.timestamp || new Date().toISOString(),
      userPrompt: conv.userPrompt || '',
      agentTextResponse: conv.agentTextResponse || '',
      aktionen: (conv.agentCodeResponse || []).map(c => `  [Aktion] ${c.changeType}: ${c.path}`),
    });
  }
  let erinnert = false;
  if (p && st.projektEdits >= STOP_MIN_DATEIEN && st.vaultWrites === 0 && st.projektEdits !== st.remindedAtProjektEdits) {
    st.remindedAtProjektEdits = st.projektEdits;
    erinnert = true;
  }
  saveState(input.conversation_id, st);
  log('stop_pruefung', { projekt: p ? p.vault : null, projekt_edits: st.projektEdits, vault_writes: st.vaultWrites, erinnert });
  if (erinnert) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', decision: 'block',
      reason: `In dieser Session wurden ${st.projektEdits} Projektdatei(en) geändert, aber nichts im Vault festgehalten. Prüfe kurz: Gab es Entscheidungen, Korrekturen, Erkenntnisse oder offene Punkte? Wenn ja, jetzt als Notiz unter projekte/${p.vault}/ festhalten, sonst nichts tun.` } }));
  }
}

// Baut aus den über Stop-Events gesammelten Gesprächsrunden (conversation, metadata.includeConversationData) eine Rohdatei
// im Format von sitzung-lib.js. Übersprungen bei weniger als 2 Nutzerbeiträgen und in ausgenommenen Ordnern.
function sessionEnd(input) {
  const cid = input.conversation_id;
  const st = loadState(cid);
  const users = st.turns.filter(t => t.userPrompt).length;
  const idKurz = String(cid).replace(/^conv-/, '').slice(0, 8);
  if (istAusgenommen(wurzel(input))) { log('sessionend_uebersprungen', { sitzung: idKurz, grund: 'ausgenommen' }); clearState(cid); return; }
  if (users < 2) { log('sessionend_uebersprungen', { sitzung: idKurz, grund: st.turns.length ? 'zu kurz' : 'keine Konversationsdaten' }); clearState(cid); return; }
  const p = projectOf(wurzel(input));
  const dir = p ? path.join(VAULT, 'projekte', p.vault, 'generiert', 'sitzungen-roh') : path.join(VAULT, '_meta', 'generiert', 'sitzungen-roh');
  const first = (st.turns[0] || {}).ts || new Date().toISOString();
  const last = (st.turns[st.turns.length - 1] || {}).ts || first;
  const buf = st.turns.map(t => {
    const ts = String(t.ts || '').slice(11, 16);
    let block = `\n### NUTZER ${ts}\n${t.userPrompt}`;
    if (t.agentTextResponse) block += `\n### AUGGIE ${ts}\n${t.agentTextResponse}`;
    if (t.aktionen.length) block += '\n' + t.aktionen.join('\n');
    return block;
  });
  const text = redact(`# Sitzung ${cid}\nArbeitsverzeichnis: ${wurzel(input)}\nZeitraum: ${first} – ${last}\n` + buf.join('\n'));
  schreibeAtomar(path.join(dir, `${String(first).slice(0, 10)}-${idKurz}.txt`), text);
  log('sessionend_gesichert', { projekt: p ? p.vault : null, sitzung: idKurz, nutzernachrichten: users, bytes: Buffer.byteLength(text) });
  clearState(cid);
}

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    let input = {};
    // Windows-Pfade kommen teils mit unmaskierten Backslashes im Hook-JSON an: dann Backslashes verdoppeln.
    if (raw) { try { input = JSON.parse(raw); } catch { input = JSON.parse(raw.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')); log('hook_json_repariert', {}); } }
    const ev = input.hook_event_name;
    if (ev === 'SessionStart') sessionStart(input);
    else if (ev === 'PostToolUse') postToolUse(input);
    else if (ev === 'Stop') stop(input);
    else if (ev === 'SessionEnd') sessionEnd(input);
  } catch (err) {
    log('hook_fehler', { meldung: String(err && err.message || err) });
  }
});
