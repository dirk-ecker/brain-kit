#!/usr/bin/env node
// Hält den Vault gegenüber dem Code aktuell: meldet Projekte mit neuen Repo-Commits seit der letzten Kuration und schreibt je Repo einen Repo-Stand.
//
//   node sync-projekte.js              prüft alle Projekte, schreibt _meta/generiert/kuration-faellig.md
//                                      und projekte/<p>/generiert/repo-stand.md
//   node sync-projekte.js --mark <p>   setzt die Markierung des Projekts auf den aktuellen Commit (Kuration erledigt)
//   node sync-projekte.js --no-write   nur anzeigen
//
// repo-stand.md (je Repo mit Vault-Ordner, bei jedem Lauf neu): Git-Stand, letzte Commits, oberste Ebene, Markdown-Dokumente,
// Abhängigkeiten (package.json, requirements.txt) und, sobald es neue Commits gibt, die Commits seit der Markierung samt Änderungsumfang.
// Optional spiegelt "repoDokuSpiegeln": true (brain.config.json) alle Markdown-Dokumente des Repos nach generiert/repo-docs/ (mit Banner;
// "repoDokuAusgenommen": [...] nimmt weitere Ordnernamen aus, "repoDokuOhneProjekte": [...] ganze Projekte, z. B. mit eigenem Spiegel). Standard ist aus: das Spiegeln kopiert Repo-Inhalte in den Vault.
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

const FAELLIG_COMMITS = 5, FAELLIG_TAGE = 14, MAX_ZEILEN = 60, STAND_COMMITS = 30;
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const STATE = path.join(VAULT, '_meta', 'state', 'kuration.json');
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')); } catch { return {}; } })();
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.venv', '.nx', '.angular', 'coverage', '.idea', '.pytest_cache', '__pycache__', 'runs', 'tmp']);
const DOC_SKIP_DIRS = new Set([...IGNORE_DIRS, '.claude', 'data', 'results', 'logs', 'testdaten', ...(config.repoDokuAusgenommen || [])].map(x => x.toLowerCase()));
const DOC_MAX_BYTES = 1024 * 1024, DOC_MAX_FILES = 500;
const args = process.argv.slice(2);
const schreiben = !args.includes('--no-write');
const markieren = args.includes('--mark') ? args[args.indexOf('--mark') + 1] : null;
const heute = () => new Date().toISOString().slice(0, 10);

function log(event, data) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'sync-projekte', event, ...data }) + '\n'); } catch { /* Logging darf nie stören */ }
}
const git = (repo, ...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };

function repoVon(projekt) {
  try {
    const d = fs.readdirSync(PROJECTS, { withFileTypes: true }).find(e => e.isDirectory() && vaultName(e.name) === projekt && fs.existsSync(path.join(PROJECTS, e.name, '.git')));
    return d ? { pfad: path.join(PROJECTS, d.name), ordner: d.name } : null;
  } catch { return null; }
}

// Markdown-Dokumente des Repos (relative Pfade, ohne Build-, Daten- und Laufordner) und Dateizahl bis Tiefe 4.
function durchsuche(wurzel) {
  const docs = [];
  let dateien = 0, uebersprungen = 0;
  (function scan(dir, tiefe) {
    let eintraege; try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { if (tiefe > 0 && !IGNORE_DIRS.has(e.name)) scan(voll, tiefe - 1); continue; }
      if (!e.isFile()) continue;
      dateien++;
      if (!/\.(md|mdx)$/i.test(e.name)) continue;
      docs.push(voll);
    }
  })(wurzel, 4);
  return { dateien, docs: docs.map(d => path.relative(wurzel, d).replace(/\\/g, '/')), uebersprungen };
}

function abhaengigkeiten(wurzel) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(wurzel, 'package.json'), 'utf8'));
    return { art: 'package.json', skripte: Object.keys(j.scripts || {}), pakete: Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) }) };
  } catch { /* keine oder ungültige package.json */ }
  try {
    const namen = fs.readFileSync(path.join(wurzel, 'requirements.txt'), 'utf8').split(/\r?\n/).map(l => l.split(/[=<>~\[ ;]/)[0].trim()).filter(l => l && !l.startsWith('#'));
    return { art: 'requirements.txt', skripte: [], pakete: namen };
  } catch { return null; }
}

// Spiegelt alle Markdown-Dokumente eines Repos nach generiert/repo-docs/ (nur mit "repoDokuSpiegeln": true).
function spiegleDoku(wurzel, genDir, p) {
  const ziel = path.join(genDir, 'repo-docs');
  const gefunden = [];
  let uebersprungen = 0;
  (function scan(dir) {
    let eintraege; try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { if (!DOC_SKIP_DIRS.has(e.name.toLowerCase())) scan(voll); continue; }
      if (!e.isFile() || !/\.(md|mdx)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(voll); } catch { continue; }
      if (st.size > DOC_MAX_BYTES || gefunden.length >= DOC_MAX_FILES) { uebersprungen++; continue; }
      gefunden.push(voll);
    }
  })(wurzel);
  const behalten = new Set();
  for (const f of gefunden) {
    const rel = path.relative(wurzel, f).replace(/\\/g, '/');
    const out = path.join(ziel, rel);
    behalten.add(path.resolve(out));
    schreibeAtomar(out, `---\nquelle: ${rel}\nprojekt: ${p}\nsynced: ${heute()}\ngeneriert: true\n---\n\n> [!info] Gespiegelt aus dem Repo\n> Quelle: \`${rel}\`. Änderungen im Repo machen, diese Datei wird beim nächsten Sync überschrieben.\n\n`+ fs.readFileSync(f, 'utf8'));
  }
  let entfernt = 0;
  (function raeume(dir) {
    let eintraege; try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { raeume(voll); try { if (!fs.readdirSync(voll).length) fs.rmdirSync(voll); } catch { /* nicht leer */ } }
      else if (!behalten.has(path.resolve(voll))) { try { fs.unlinkSync(voll); entfernt++; } catch { /* schon weg */ } }
    }
  })(ziel);
  return { kopiert: gefunden.length, entfernt, uebersprungen };
}

function renderStand(p, repo, seit) {
  const wurzel = repo.pfad;
  const branch = git(wurzel, 'rev-parse', '--abbrev-ref', 'HEAD');
  const anzahl = git(wurzel, 'rev-list', '--count', 'HEAD');
  const offen = (git(wurzel, 'status', '--porcelain') || '').split('\n').filter(Boolean).length;
  const commits = (git(wurzel, 'log', `-${STAND_COMMITS}`, '--date=short', '--pretty=format:%h %ad %s') || '').split('\n').filter(Boolean);
  const oben = fs.readdirSync(wurzel, { withFileTypes: true }).filter(e => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.env')).map(e => e.name + (e.isDirectory() ? '/' : '')).sort();
  const { dateien, docs } = durchsuche(wurzel);
  const abh = abhaengigkeiten(wurzel);
  const z = ['---', 'typ: meta', `projekt: ${p}`, 'status: gültig', `datum: ${heute()}`, 'generiert: true', '---', '',
    `# Repo-Stand ${p} (automatisch erzeugt)`, '',
    '> [!info] Von `_meta/skripte/sync-projekte.js` erzeugt und bei jedem Lauf überschrieben. Nicht von Hand bearbeiten.', '',
    `- Pfad: \`<projektOrdner>/${repo.ordner}\``,
    `- Git: Branch \`${branch}\`, ${anzahl} Commits, ${offen} ungesicherte Änderungen`,
    `- Dateien (Tiefe 4, ohne Build-/Abhängigkeitsordner): ${dateien}`, ''];
  if (seit) {
    z.push('## Seit der letzten Kuration', '',
      `${seit.neu} Commit(s) seit der Markierung vom ${seit.ts.slice(0, 10)} (${seit.basis.slice(0, 8)}).${seit.stat ? ` Änderungsumfang: ${seit.stat}.` : ''}`, '',
      ...seit.zeilen, seit.neu > MAX_ZEILEN ? `- … ${seit.neu - MAX_ZEILEN} weitere` : '', '',
      `Nach der Kuration: \`node _meta/skripte/sync-projekte.js --mark ${p}\``, '');
  }
  if (commits.length) z.push(`## Letzte ${STAND_COMMITS} Commits`, '', ...commits.map(c => `- ${c}`), '');
  z.push('## Oberste Ebene', '', ...oben.map(x => `- \`${x}\``), '');
  if (docs.length) z.push('## Markdown-Dokumente im Repo', '', ...docs.slice(0, 60).map(x => `- \`${x}\``), docs.length > 60 ? `- … ${docs.length - 60} weitere` : '', '');
  if (abh) {
    z.push(`## Abhängigkeiten (${abh.art})`, '');
    if (abh.skripte.length) z.push(`Skripte: ${abh.skripte.map(s => `\`${s}\``).join(', ')}`, '');
    z.push(abh.pakete.map(d => `\`${d}\``).join(', ') || '(keine)', '');
  }
  return z.filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

function main() {
  const freigeben = schreiben || markieren ? sperre('sync-projekte', 10) : () => {};
  if (!freigeben) { console.log('Anderer Lauf aktiv, übersprungen.'); return; }
  try {
    let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* erster Lauf */ }
    const projekte = fs.readdirSync(path.join(VAULT, 'projekte'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const jetzt = Date.now(), faellig = [];

    if (markieren) {
      const repo = repoVon(markieren), head = repo && git(repo.pfad, 'rev-parse', 'HEAD');
      if (!head) { console.log(`Kein Repo für Projekt „${markieren}“ gefunden.`); return; }
      state[markieren] = { commit: head, ts: new Date().toISOString() };
      schreibeAtomar(STATE, JSON.stringify(state, null, 2));
      log('kuration_markiert', { projekt: markieren, commit: head.slice(0, 8) });
      console.log(`${markieren}: Markierung auf ${head.slice(0, 8)} gesetzt.`);
    }

    for (const p of projekte) {
      const t0 = Date.now();
      const repo = repoVon(p);
      const head = repo && git(repo.pfad, 'rev-parse', 'HEAD');
      if (!head) continue;
      let seit = null, istFaellig = false;
      if (!state[p]) { state[p] = { commit: head, ts: new Date().toISOString() }; log('kuration_ausgangsstand', { projekt: p, commit: head.slice(0, 8) }); }
      else {
        const basis = state[p].commit;
        const anzahl = git(repo.pfad, 'rev-list', '--count', `${basis}..HEAD`);
        if (anzahl === null) log('kuration_basis_unbekannt', { projekt: p, commit: basis.slice(0, 8) }); // z. B. nach Rebase
        else if (Number(anzahl)) {
          const neu = Number(anzahl);
          const tage = Math.floor((jetzt - Date.parse(state[p].ts)) / 86400000);
          seit = { neu, basis, ts: state[p].ts, tage,
            stat: (git(repo.pfad, 'diff', '--shortstat', `${basis}..HEAD`) || '').trim(),
            zeilen: (git(repo.pfad, 'log', `${basis}..HEAD`, '--format=- %cs %h %s', `-n${MAX_ZEILEN}`) || '').split('\n').filter(Boolean) };
          if (neu >= FAELLIG_COMMITS || tage >= FAELLIG_TAGE) { istFaellig = true; faellig.push({ projekt: p, neu, letzter: git(repo.pfad, 'log', '-1', '--format=%cs') || '', tage }); }
        }
      }
      if (!schreiben) continue;
      const gen = path.join(VAULT, 'projekte', p, 'generiert');
      let doku = null;
      try {
        schreibeAtomar(path.join(gen, 'repo-stand.md'), renderStand(p, repo, seit));
        if (config.repoDokuSpiegeln === true && !(config.repoDokuOhneProjekte || []).includes(p)) doku = spiegleDoku(repo.pfad, gen, p);
      } catch (err) { log('repo_stand_fehler', { projekt: p, meldung: String(err && err.message || err) }); }
      log('projekt_synchronisiert', { projekt: p, neue_commits: seit ? seit.neu : 0, faellig: istFaellig, doku_gespiegelt: doku ? doku.kopiert : null, doku_entfernt: doku ? doku.entfernt : null, dauer_ms: Date.now() - t0 });
    }

    if (schreiben) {
      schreibeAtomar(STATE, JSON.stringify(state, null, 2));
      schreibeAtomar(path.join(VAULT, '_meta', 'generiert', 'kuration-faellig.md'), [
        '---', 'typ: meta', 'status: gültig', `datum: ${heute()}`, '---', '',
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
