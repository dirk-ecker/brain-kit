#!/usr/bin/env node
// Claude-Code-Hooks für das Wissens-Vault ("Brain"). Konfiguration: _meta/brain.config.json (neben diesem Ordner).
//   hook-vault.js start -> SessionStart: lädt _index.md (klein), Titel der offenen Punkte und Einzeiler-Hinweise
//   hook-vault.js stop  -> Stop: erinnert höchstens einmal je Sitzung, wenn mehrere Projektdateien geändert, aber keine Vault-Notiz geschrieben wurde
//   hook-vault.js end   -> SessionEnd: sichert den verdichteten Verlauf als Rohdatei unter projekte/<p>/generiert/sitzungen-roh/
//   hook-vault.js prompt -> UserPromptSubmit: erkennt Korrekturen/stehende Vorgaben und erinnert ans sofortige Festhalten
// Liest das Hook-JSON von stdin, schreibt Ereignisse nach _meta/logs/automation.log.jsonl, bricht nie mit Fehler ab.
// Bewusst klein: der Start-Hook läuft in jeder Session und kostet jedes Mal Tokens.
//
// Parallele Sitzungen: jeder Hook arbeitet nur mit der eigenen Sitzungs-ID (Rohdatei, Stop-Marker); gemeinsame Dateien
// werden atomar geschrieben oder per Sperre geschützt. Läufe der Automatisierung (BRAIN_AUTOMATION=1) lösen keine Hooks aus,
// sonst würde der Verdichtungslauf seine eigene Sitzung wieder als Rohsitzung sichern.

if (process.env.BRAIN_AUTOMATION) process.exit(0);

const fs = require('fs');
const path = require('path');

const { VAULT, PROJECTS, projectOf, rohZiel, condense, schreibeAtomar, unverarbeiteteRoh, KORREKTUR } = require('./sitzung-lib');
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'hook', event, ...data }) + '\n');
    if (event === 'hook_fehler') merkeFehler(data);
  } catch { /* Logging darf den Hook nie stören */ }
}

// Hook-Fehler stehen sonst nur im Log. Der Zustand wird beim nächsten Sessionstart einmal gemeldet (gemeldet:false → true).
const FEHLER_DATEI = path.join(VAULT, '_meta', 'state', 'hook-fehler.json');
function merkeFehler(data) {
  let alt = {}; try { alt = JSON.parse(fs.readFileSync(FEHLER_DATEI, 'utf8')); } catch { /* erster Fehler */ }
  schreibeAtomar(FEHLER_DATEI, JSON.stringify({ ts: new Date().toISOString(), meldung: String((data && data.meldung) || '').slice(0, 200), anzahl: (alt.anzahl || 0) + 1, gemeldet: false }, null, 2));
}

function read(p, maxLines) {
  try {
    const l = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return l.slice(0, maxLines).join('\n') + (l.length > maxLines ? '\n[... gekürzt]' : '');
  } catch { return null; }
}

// Offener Punkt mit status erledigt/veraltet/verworfen zählt nicht mehr als offen.
function erledigt(datei) {
  try { return /^status:\s*(erledigt|veraltet|verworfen)\s*$/m.test(fs.readFileSync(datei, 'utf8').slice(0, 400)); } catch { return false; }
}

// Die Wartungsskripte laufen sonst nirgends automatisch: ist der Prüfstand älter als 12 h, startet der Sessionstart sie losgelöst
// (Prüfung, Kurationsfälligkeit, Arbeitsweise-Review; jedes hat eine eigene Sperre gegen Doppelläufe paralleler Sitzungen).
// Die neuen Stände gelten ab der nächsten Sitzung.
const PRUEFUNG_MAX_ALTER_H = 12;
function wartungAnstossen() {
  for (const skript of ['vault-pruefung.js', 'sync-projekte.js', 'arbeitsweise-review.js']) {
    try {
      const kind = require('child_process').spawn(process.execPath, [path.join(__dirname, skript)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, BRAIN_AUTOMATION: '1' } });
      kind.unref();
    } catch (err) { log('wartung_anstossen_fehlgeschlagen', { skript, meldung: String(err && err.message || err) }); }
  }
  log('wartung_angestossen', {});
}

function start(input) {
  const p = projectOf(input.cwd);
  if (!p) return;
  const base = path.join(VAULT, 'projekte', p.vault);
  const suche = path.join(VAULT, '_meta', 'skripte', 'vault-suche.js');
  const parts = [`Wissens-Vault (${VAULT}), Projekt "${p.vault}". Vor Entscheidungen gezielt suchen: node ${suche} <begriff> (oder --gueltig). Entscheidungen und Erkenntnisse sofort als Notiz festhalten. generiert/ nicht lesen.`];
  const idx = read(path.join(base, '_index.md'), 60);
  if (idx) parts.push(`--- ${p.vault}/_index.md ---\n${idx}`);
  else parts.push(`Zu diesem Projekt gibt es noch keinen Vault-Ordner. Lege projekte/${p.vault}/ mit _index.md an.`);
  try {
    const offenDir = path.join(base, 'offen');
    const offen = fs.readdirSync(offenDir).filter(f => f.endsWith('.md') && !f.startsWith('_') && !erledigt(path.join(offenDir, f))).map(f => f.replace(/\.md$/, ''));
    if (offen.length) parts.push(`Offene Punkte (${offen.length}, projekte/${p.vault}/offen/, nur bei passender Aufgabe lesen): ${offen.join(', ')}`);
  } catch { /* kein offen/-Ordner */ }
  const warn = [];
  // Optional: nur wenn ein Sync-Skript _meta/generiert/kuration-faellig.md (Tabelle "| projekt |") erzeugt
  try {
    const due = fs.readFileSync(path.join(VAULT, '_meta', 'generiert', 'kuration-faellig.md'), 'utf8');
    if (due.split(/\r?\n/).some(l => l.startsWith('| ' + p.vault + ' |'))) warn.push(`Kuration fällig (nur auf Wunsch auswerten: git log, generiert/repo-stand.md, dann sync-projekte.js --mark ${p.vault})`);
  } catch { /* kein Sync-Skript, kein Hinweis */ }
  const unv = unverarbeiteteRoh(p.vault).length;
  if (unv >= 10) warn.push(`${unv} Rohsitzungen ohne Sitzungsnotiz (nur auf Wunsch verdichten)`);
  // Tägliche Windows-Aufgabe „Brain-Sitzungen-verdichten“: ausgebliebener oder fehlerhafter Lauf wäre sonst unsichtbar.
  try {
    const l = JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'state', 'verdichten-letzter.json'), 'utf8'));
    const tage = (Date.now() - Date.parse(l.ts)) / 86400000;
    if (l.ok === false) warn.push(`Der letzte Verdichtungslauf (${l.ts.slice(0, 10)}) hatte ${l.probleme} Batch(es) mit Problemen (Log: verdichten_batch_problem)`);
    else if (tage > 3) warn.push(`Der Verdichtungslauf lief seit ${Math.floor(tage)} Tagen nicht (Windows-Aufgabe Brain-Sitzungen-verdichten prüfen)`);
  } catch { /* noch kein Lauf mit Zustandsdatei */ }
  try {
    const fe = JSON.parse(fs.readFileSync(FEHLER_DATEI, 'utf8'));
    if (fe.gemeldet === false) {
      warn.push(`Die Vault-Hooks hatten ${fe.anzahl} Fehler (zuletzt ${fe.ts.slice(0, 16).replace('T', ' ')}: ${fe.meldung}); Log: hook_fehler in _meta/logs/automation.log.jsonl`);
      schreibeAtomar(FEHLER_DATEI, JSON.stringify({ ...fe, anzahl: 0, gemeldet: true }, null, 2));
    }
  } catch { /* keine Fehler gemerkt */ }
  let pruefung = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'state', 'vault-pruefung.json'), 'utf8'));
    if (Date.now() - Date.parse(st.ts) > PRUEFUNG_MAX_ALTER_H * 3600e3) wartungAnstossen();
    const z = (st.projekte || {})[p.vault];
    const n = z ? [z.defektLinks, z.verwaist, z.kopf, z.herkunftFehlt, z.ketten, z.doppelt, z.geheimnis, z.indexGross].reduce((x, y) => x + (y || 0), 0) : 0;
    if (n) { pruefung = z; warn.push(`Vault-Prüfung ${n} Befunde (_meta/generiert/vault-pruefung.md; beim Anfassen der Notiz beheben)`); }
  } catch { wartungAnstossen(); /* noch kein Prüflauf */ }
  // Arbeitsweise-Review (arbeitsweise-review.js): neuer Review wird genau einmal gemeldet.
  // Atomar übernommen (Umbenennen gelingt nur einer parallelen Sitzung), damit der Hinweis nicht doppelt kommt.
  try {
    const aw = path.join(VAULT, '_meta', 'state', 'arbeitsweise.json');
    const st = JSON.parse(fs.readFileSync(aw, 'utf8'));
    if (st.notiz && st.gemeldet === false) {
      const mein = `${aw}.${process.pid}.claim`;
      fs.renameSync(aw, mein);
      fs.writeFileSync(mein, JSON.stringify({ ...st, gemeldet: true }, null, 2));
      fs.renameSync(mein, aw);
      warn.push(`Neuer Arbeitsweise-Review (${path.relative(VAULT, st.notiz).replace(/\\/g, '/')}): ${st.kurz || ''} Bei passender Gelegenheit dem Nutzer kurz nennen und Vorschläge zur Entscheidung vorlegen`);
    }
  } catch { /* noch kein Review oder eine parallele Sitzung war schneller */ }
  if (warn.length) parts.push('Hinweise: ' + warn.join('; ') + '.');
  log('sessionstart_kontext', { projekt: p.vault, sitzung: String(input.session_id || '').slice(0, 8), index_gefunden: !!idx, unverarbeitet: unv, vault_pruefung: pruefung });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }));
}

function end(input) {
  if (!input.transcript_path) return;
  const id = String(input.session_id || path.basename(input.transcript_path, '.jsonl'));
  const c = condense(input.transcript_path, id);
  if (!c || c.users < 2) {
    const grund = c ? 'zu kurz' : (fs.existsSync(input.transcript_path) ? 'nicht lesbar' : 'Verlaufsdatei fehlt');
    log('sessionend_uebersprungen', { sitzung: id.slice(0, 8), grund });
    return;
  }
  const { projekt, dir, name } = rohZiel(c, input.cwd);
  schreibeAtomar(path.join(dir, name), c.text); // Name enthält die Sitzungs-ID: parallele Sitzungen kollidieren nie
  log('sessionend_gesichert', { projekt, sitzung: id.slice(0, 8), nutzernachrichten: c.users, bytes: Buffer.byteLength(c.text) });
}

// Der Stop-Hook mahnt höchstens einmal je Sitzung (Marker per wx, atomar) und erst ab STOP_MIN_DATEIEN geänderten Projektdateien.
const STOP_MIN_DATEIEN = 3;
function stopMarker(id) {
  const datei = path.join(VAULT, '_meta', 'state', 'stop-erinnert', id.slice(0, 36) + '.json');
  try {
    fs.mkdirSync(path.dirname(datei), { recursive: true });
    fs.writeFileSync(datei, JSON.stringify({ ts: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (e) { return e.code !== 'EEXIST'; } // Marker nicht anlegbar: lieber erinnern als schweigen
}

function stop(input) {
  if (input.stop_hook_active) return; // Schleifen verhindern
  const p = projectOf(input.cwd);
  if (!p || !input.transcript_path) return;
  let lines;
  try { lines = fs.readFileSync(input.transcript_path, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return; }
  const root = norm(path.join(PROJECTS, p.dir)) + '/', vault = norm(VAULT) + '/';
  let projektEdits = 0, vaultWrites = 0;
  const dateien = new Set();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (c.type !== 'tool_use' || !/^(Edit|Write|NotebookEdit)$/.test(c.name)) continue;
      const f = norm(c.input && (c.input.file_path || c.input.notebook_path));
      if (f.startsWith(vault)) vaultWrites++;
      else if (f.startsWith(root) && !/\/(node_modules|dist|\.git)\//.test(f)) { projektEdits++; dateien.add(f); }
    }
  }
  const id = String(input.session_id || path.basename(input.transcript_path, '.jsonl'));
  const mahnen = dateien.size >= STOP_MIN_DATEIEN && vaultWrites === 0 && stopMarker(id);
  log('stop_pruefung', { projekt: p.vault, sitzung: id.slice(0, 8), projekt_edits: projektEdits, dateien: dateien.size, vault_writes: vaultWrites, erinnert: mahnen });
  if (mahnen) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `In dieser Session wurden ${dateien.size} Projektdatei(en) geändert, aber nichts im Vault festgehalten. Prüfe kurz: Gab es Entscheidungen, Korrekturen, Erkenntnisse oder offene Punkte? Wenn ja, jetzt als Notiz unter projekte/${p.vault}/ ablegen und _index.md aktualisieren. Wenn nichts festhaltenswert ist, kurz "Nichts festzuhalten" sagen und beenden.`,
    }));
  }
}

// UserPromptSubmit: erkennt Korrekturen und stehende Vorgaben ("immer", "ich hatte gesagt", ...) und erinnert,
// sie sofort dauerhaft festzuhalten (Auswertung 2026-10-07: Vorgaben mussten oft wiederholt werden).
//
// Zusätzlich liefert der Hook die wenigen Vault-Notizen mit, die den Prompt sicher betreffen (prompt-treffer.js), damit die
// Suche nicht vom Gedächtnis der Sitzung abhängt. Je Sitzung höchstens MAX_TREFFER_JE_SITZUNG Notizen, jede nur einmal.
const MAX_TREFFER_JE_SITZUNG = 8;
function neueTreffer(input) {
  const p = projectOf(input.cwd);
  if (!p) return [];
  const t = String(input.prompt || '');
  let gefunden;
  try { gefunden = require('./prompt-treffer').treffer(t.slice(0, 500), input.cwd); } catch { return []; }
  if (!gefunden.length) return [];
  const id = String(input.session_id || 'ohne-id').slice(0, 36);
  const datei = path.join(VAULT, '_meta', 'state', 'prompt-treffer', id + '.json');
  let gesehen = []; try { gesehen = JSON.parse(fs.readFileSync(datei, 'utf8')).pfade || []; } catch { /* erster Prompt der Sitzung */ }
  const neu = gefunden.filter(x => !gesehen.includes(x.pfad)).slice(0, Math.max(0, MAX_TREFFER_JE_SITZUNG - gesehen.length));
  if (!neu.length) return [];
  schreibeAtomar(datei, JSON.stringify({ pfade: [...gesehen, ...neu.map(x => x.pfad)] }));
  log('vault_treffer_injiziert', { projekt: p.vault, sitzung: id.slice(0, 8), anzahl: neu.length, pfade: neu.map(x => x.pfad) });
  return neu;
}

function prompt(input) {
  const t = String(input.prompt || '');
  const teile = [];
  if (t.length <= 600 && KORREKTUR.test(t)) {
    log('korrektur_erkannt', { projekt: (projectOf(input.cwd) || {}).vault || null, treffer: (t.match(KORREKTUR) || [])[0], laenge: t.length });
    teile.push('Hinweis (Hook): Diese Nachricht enthält vermutlich eine Korrektur oder stehende Vorgabe. Falls ja: sofort ohne Rückfrage dauerhaft festhalten (Arbeitsweise → passende CLAUDE.md oder Memory, Fachliches → Vault) und den Auftrag vollständig ausführen (alle abhängigen Stellen, nicht nur den genannten Ort).');
  }
  const treffer = neueTreffer(input);
  if (treffer.length) {
    teile.push('Vault-Treffer (automatisch aus dem Prompt, nur ein Hinweis; bei Bezug beachten oder Widerspruch benennen, sonst ignorieren):\n'
      + treffer.map(x => `- [${x.typ}] ${x.titel}${x.hinweis ? ' — ' + x.hinweis.slice(0, 200) : ''} (${x.pfad})`).join('\n'));
  }
  if (!teile.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: teile.join('\n\n') } }));
}

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    // Windows-Pfade kommen teils mit unmaskierten Backslashes im Hook-JSON an ("Bad escaped character"): dann Backslashes verdoppeln.
    let input = {};
    if (raw) { try { input = JSON.parse(raw); } catch { input = JSON.parse(raw.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')); log('hook_json_repariert', { modus: process.argv[2] }); } }
    if (process.argv[2] === 'start') start(input);
    else if (process.argv[2] === 'stop') stop(input);
    else if (process.argv[2] === 'end') end(input);
    else if (process.argv[2] === 'prompt') prompt(input);
  } catch (err) {
    log('hook_fehler', { meldung: String(err && err.message || err) });
  }
});
