#!/usr/bin/env node
// Meldet, für welche Projekte neue Repo-Commits seit der letzten Kuration vorliegen, damit der Vault nicht hinter dem Code zurückbleibt.
//
//   node sync-projekte.js              prüft alle Projekte, schreibt _meta/generiert/kuration-faellig.md
//                                      und projekte/<p>/generiert/repo-stand.md (Commits seit der Markierung)
//   node sync-projekte.js --mark <p>   setzt die Markierung des Projekts auf den aktuellen Commit (Kuration erledigt)
//   node sync-projekte.js --no-write   nur anzeigen
//
// Regeln:
//   - Repo eines Vault-Projekts: Ordner unter projektOrdner (brain.config.json), dessen Vault-Name dem Projekt entspricht und der ein .git hat.
//   - Zustand: _meta/state/kuration.json {projekt: {commit, ts}}. Ohne Eintrag gilt der aktuelle Commit als Ausgangsstand (nichts fällig).
//   - Fällig: mindestens FAELLIG_COMMITS neue Commits, oder mindestens ein neuer Commit und die Markierung ist älter als FAELLIG_TAGE.
//   - Der Start-Hook liest kuration-faellig.md (Zeilen "| <projekt> |") und weist hin; ausgewertet wird nur auf Wunsch
//     (git log, repo-stand.md lesen, Vault-Notizen pflegen, danach --mark).
// Schreibt nur unter _meta/generiert, _meta/state und projekte/<p>/generiert, atomar und unter Sperre. Exit-Code immer 0.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { VAULT, PROJECTS, vaultName, schreibeAtomar, sperre } = require('./sitzung-lib');

const FAELLIG_COMMITS = 5, FAELLIG_TAGE = 14, MAX_ZEILEN = 60;
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const STATE = path.join(VAULT, '_meta', 'state', 'kuration.json');
const args = process.argv.slice(2);
const schreiben = !args.includes('--no-write');
const markieren = args.includes('--mark') ? args[args.indexOf('--mark') + 1] : null;

function log(event, data) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'sync-projekte', event, ...data }) + '\n'); } catch { /* Logging darf nie stören */ }
}
const git = (repo, ...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };

function repoVon(projekt) {
  try {
    const d = fs.readdirSync(PROJECTS, { withFileTypes: true }).find(e => e.isDirectory() && vaultName(e.name) === projekt && fs.existsSync(path.join(PROJECTS, e.name, '.git')));
    return d ? path.join(PROJECTS, d.name) : null;
  } catch { return null; }
}

function main() {
  const freigeben = schreiben || markieren ? sperre('sync-projekte', 10) : () => {};
  if (!freigeben) { console.log('Anderer Lauf aktiv, übersprungen.'); return; }
  try {
    let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* erster Lauf */ }
    const projekte = fs.readdirSync(path.join(VAULT, 'projekte'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const jetzt = Date.now(), faellig = [];

    if (markieren) {
      const repo = repoVon(markieren), head = repo && git(repo, 'rev-parse', 'HEAD');
      if (!head) { console.log(`Kein Repo für Projekt „${markieren}“ gefunden.`); return; }
      state[markieren] = { commit: head, ts: new Date().toISOString() };
      schreibeAtomar(STATE, JSON.stringify(state, null, 2));
      log('kuration_markiert', { projekt: markieren, commit: head.slice(0, 8) });
      console.log(`${markieren}: Markierung auf ${head.slice(0, 8)} gesetzt.`);
    }

    for (const p of projekte) {
      const repo = repoVon(p);
      const head = repo && git(repo, 'rev-parse', 'HEAD');
      if (!head) continue;
      if (!state[p]) { state[p] = { commit: head, ts: new Date().toISOString() }; log('kuration_ausgangsstand', { projekt: p, commit: head.slice(0, 8) }); continue; }
      const basis = state[p].commit;
      const anzahl = git(repo, 'rev-list', '--count', `${basis}..HEAD`);
      if (anzahl === null) { log('kuration_basis_unbekannt', { projekt: p, commit: basis.slice(0, 8) }); continue; } // z. B. nach Rebase
      const neu = Number(anzahl);
      if (!neu) continue;
      const tage = Math.floor((jetzt - Date.parse(state[p].ts)) / 86400000);
      if (neu < FAELLIG_COMMITS && tage < FAELLIG_TAGE) continue;
      const letzter = git(repo, 'log', '-1', '--format=%cs') || '';
      const zeilen = (git(repo, 'log', `${basis}..HEAD`, '--format=- %cs %h %s', `-n${MAX_ZEILEN}`) || '').split('\n');
      const stat = (git(repo, 'diff', '--shortstat', `${basis}..HEAD`) || '').trim();
      faellig.push({ projekt: p, neu, letzter, tage });
      if (schreiben) {
        schreibeAtomar(path.join(VAULT, 'projekte', p, 'generiert', 'repo-stand.md'), [
          '---', 'typ: meta', `projekt: ${p}`, 'status: gültig', `datum: ${new Date().toISOString().slice(0, 10)}`, '---', '',
          `# Repo-Stand ${p}`, '', `Automatisch erzeugt von \`_meta/skripte/sync-projekte.js\`. ${neu} Commit(s) seit der Markierung vom ${state[p].ts.slice(0, 10)} (${basis.slice(0, 8)}).`,
          stat ? `Änderungsumfang: ${stat}` : '', '', ...zeilen, neu > MAX_ZEILEN ? `- … ${neu - MAX_ZEILEN} weitere` : '', '',
          `Nach der Kuration: \`node _meta/skripte/sync-projekte.js --mark ${p}\``, '',
        ].filter((z, i, a) => z !== '' || a[i - 1] !== '').join('\n'));
      }
    }

    if (schreiben) {
      schreibeAtomar(STATE, JSON.stringify(state, null, 2));
      schreibeAtomar(path.join(VAULT, '_meta', 'generiert', 'kuration-faellig.md'), [
        '---', 'typ: meta', 'status: gültig', `datum: ${new Date().toISOString().slice(0, 10)}`, '---', '',
        '# Kuration fällig', '',
        `Automatisch erzeugt von \`_meta/skripte/sync-projekte.js\`. Fällig ab ${FAELLIG_COMMITS} neuen Commits oder einem neuen Commit nach ${FAELLIG_TAGE} Tagen. Erledigt: \`--mark <projekt>\`.`, '',
        '| projekt | neue Commits | letzter Commit | Markierung vor Tagen |', '|---|---|---|---|',
        ...faellig.map(f => `| ${f.projekt} | ${f.neu} | ${f.letzter} | ${f.tage} |`), '',
      ].join('\n'));
    }
    log('kuration_geprueft', { projekte: projekte.length, faellig: faellig.map(f => f.projekt) });
    console.log(faellig.length ? faellig.map(f => `${f.projekt}: ${f.neu} neue Commits (letzter ${f.letzter}, Markierung ${f.tage} Tage alt)`).join('\n') : 'Keine Kuration fällig.');
  } finally { freigeben(); }
}

try { main(); } catch (err) { log('sync_fehler', { meldung: String(err && err.stack || err) }); console.error(String(err)); }
