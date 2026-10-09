#!/usr/bin/env node
// Verdichtet gesicherte Rohsitzungen (projekte/<p>/generiert/sitzungen-roh/*.txt) ohne Sitzungsnotiz zu Vault-Notizen,
// indem es eine unbeaufsichtigte Claude-Instanz mit _meta/verdichten-auftrag.md startet.
// Standard ist ein Probelauf (zeigt nur den Plan). Mit --ausfuehren wird verdichtet (kostet Tokens).
//
//   node sitzungen-verdichten.js [--projekt X] [--max N] [--batch N] [--modell M] [--budget USD] [--ausfuehren]
//
// Einstellungen (Standard in DEFAULTS, überschreibbar in brain.config.json unter "verdichten"):
//   modell, budgetUsdProBatch, batchGroesse, maxSitzungenProLauf, mindestAlterMin, timeoutMin
//
// Absicherung:
//   - Eine Sperre (_meta/state/verdichten.lock) verhindert zwei gleichzeitige Läufe (z. B. zwei Aufgabenplaner-Starts).
//   - Die Instanz läuft mit BRAIN_AUTOMATION=1: die Hooks tun nichts, ihre Sitzung wird nicht erneut als Rohsitzung gesichert
//     (und --no-session-persistence speichert gar keinen Verlauf).
//   - Rohdateien, die jünger als mindestAlterMin sind, bleiben liegen (eine fortgesetzte Sitzung überschreibt ihre Rohdatei).
//   - Live-Sitzungen schreiben gleichzeitig im Vault: Die Instanz legt nur neue Dateien an und ändert bestehende per Edit
//     (das schlägt fehl, wenn die Datei seit dem Lesen geändert wurde; dann neu lesen). Schreibzugriffe auf _meta/ und generiert/ sind gesperrt.
//   - Nach jedem Batch wird geprüft, ob jede Rohsitzung eine Notiz mit ihrer ID hat, und ob geschützte Dateien unverändert sind.
// Protokoll: _meta/logs/automation.log.jsonl (quelle "verdichten"). Exit-Code 0 auch bei Fehlern, außer bei ungültigen Argumenten.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { VAULT, sperre, unverarbeiteteRoh, schreibeAtomar } = require('./sitzung-lib');

const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const DEFAULTS = { modell: 'sonnet', budgetUsdProBatch: 1.5, batchGroesse: 4, maxSitzungenProLauf: 12, mindestAlterMin: 30, timeoutMin: 25, rohAufbewahrungTage: 90 };
const cfg = (() => {
  try { return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')).verdichten || {}) }; } catch { return { ...DEFAULTS }; }
})();

const args = process.argv.slice(2);
const wert = k => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const ausfuehren = args.includes('--ausfuehren');
const nurProjekt = wert('--projekt');
const maxSitzungen = Number(wert('--max') || cfg.maxSitzungenProLauf);
const batchGroesse = Number(wert('--batch') || cfg.batchGroesse);
const modell = wert('--modell') || cfg.modell;
const budget = Number(wert('--budget') || cfg.budgetUsdProBatch);
if (![maxSitzungen, batchGroesse, budget].every(n => Number.isFinite(n) && n > 0)) { console.error('Ungültige Zahl bei --max/--batch/--budget'); process.exit(1); }

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'verdichten', event, ...data }) + '\n');
  } catch { /* Logging darf nie stören */ }
}

// Dateien, die die Instanz nicht ändern darf: Skripte, Konventionen, Auftrag, Vorlagen, Konfiguration.
function schutzStand() {
  const stand = {};
  const dazu = d => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isFile()) stand[p] = fs.statSync(p).mtimeMs; } } catch { /* Ordner fehlt */ } };
  dazu(path.join(VAULT, '_meta')); dazu(path.join(VAULT, '_meta', 'skripte')); dazu(path.join(VAULT, '_meta', 'vorlagen'));
  return stand;
}
const aenderungen = (vorher, nachher) => Object.keys({ ...vorher, ...nachher }).filter(p => vorher[p] !== nachher[p] && !p.endsWith('.lock'));

// Aufgabenplaner erben den Benutzer-PATH nicht sicher: bekannten Installationsort bevorzugen, sonst PATH.
const CLAUDE = process.env.CLAUDE_BIN || [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find(p => fs.existsSync(p)) || 'claude';

// Mehrdeutige Wikilinks (Notizname existiert in mehreren Projekten) in den vom Batch geänderten Notizen auf den Pfad im eigenen
// Projekt umschreiben. Verlässt sich nicht auf den Prompt: das Modell hält die Pfadlink-Regel nicht zuverlässig ein.
function linksEntmehrdeutigen(projekt, seit) {
  const alle = new Map(); // name -> [relative Pfade ohne .md]
  const sammle = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '.obsidian') sammle(p); } else if (e.name.endsWith('.md')) { const n = e.name.slice(0, -3); (alle.get(n) || alle.set(n, []).get(n)).push(path.relative(VAULT, p).replace(/\\/g, '/').slice(0, -3)); } } };
  sammle(path.join(VAULT, 'projekte'));
  let korrigiert = 0;
  const dir = path.join(VAULT, 'projekte', projekt);
  const bearbeite = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'generiert') bearbeite(p); continue; }
      if (!e.name.endsWith('.md') || fs.statSync(p).mtimeMs < seit) continue;
      const alt = fs.readFileSync(p, 'utf8');
      const neu = alt.replace(/\[\[([^\]|#]+)(\|[^\]]*)?\]\]/g, (m, name, alias) => {
        const ziele = alle.get(name.trim());
        if (!ziele || ziele.length < 2) return m;
        const eigenes = ziele.filter(z => z.startsWith(`projekte/${projekt}/`));
        if (eigenes.length !== 1) return m;
        korrigiert++;
        return `[[${eigenes[0]}|${alias ? alias.slice(1) : name.trim()}]]`;
      });
      if (neu !== alt) fs.writeFileSync(p, neu, 'utf8');
    }
  };
  try { bearbeite(dir); } catch { /* Projektordner fehlt */ }
  return korrigiert;
}

// Notizen eines Projekts (relative Pfade, ohne generiert/ und ohne Dateien mit führendem Unterstrich wie _index.md).
function notizDateien(projekt) {
  const aus = new Set();
  const lauf = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'generiert') lauf(p); }
      else if (e.name.endsWith('.md') && !e.name.startsWith('_')) aus.add(path.relative(VAULT, p).replace(/\\/g, '/'));
    }
  };
  try { lauf(path.join(VAULT, 'projekte', projekt)); } catch { /* Projektordner fehlt */ }
  return aus;
}

// Neu angelegte Notizen der Automatik kennzeichnen, damit sie sich später gezielt gegenlesen lassen (Herkunft und Einordnung
// stammen vom Modell). Das Skript setzt die Zeile selbst, ohne sich auf den Prompt zu verlassen.
function alsAutomatischMarkieren(rel) {
  const datei = path.join(VAULT, rel);
  const alt = fs.readFileSync(datei, 'utf8');
  const kopf = alt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!kopf || /^erzeugt:/m.test(kopf[1])) return false;
  const nl = alt.includes('\r\n') ? '\r\n' : '\n';
  const neu = /^datum:.*$/m.test(kopf[1])
    ? alt.replace(/^(datum:.*)$/m, `$1${nl}erzeugt: automatisch`)
    : alt.replace(/^---\r?\n/, `---${nl}erzeugt: automatisch${nl}`);
  fs.writeFileSync(datei, neu, 'utf8');
  return true;
}

// Verdichtete Rohsitzungen nach rohAufbewahrungTage löschen (Git behält sie). Nie löschen, was noch keine Sitzungsnotiz hat.
function alteRohLoeschen(tage, probe = false) {
  const grenze = new Date(Date.now() - tage * 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const p of projekte()) {
    const offenListe = new Set(unverarbeiteteRoh(p));
    const dir = path.join(VAULT, 'projekte', p, 'generiert', 'sitzungen-roh');
    let dateien = []; try { dateien = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-\w+\.txt$/.test(f)); } catch { continue; }
    for (const f of dateien) {
      const voll = path.join(dir, f);
      if (f.slice(0, 10) >= grenze || offenListe.has(voll)) continue;
      if (!probe) fs.unlinkSync(voll);
      n++;
    }
  }
  if (n && !probe) log('roh_geloescht', { anzahl: n, aelterAls: grenze });
  return n;
}

function projekte() {
  return fs.readdirSync(path.join(VAULT, 'projekte'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    .filter(p => !nurProjekt || p === nurProjekt);
}

function offen() {
  const grenze = Date.now() - cfg.mindestAlterMin * 60000;
  const plan = [];
  for (const p of projekte()) {
    const dateien = unverarbeiteteRoh(p).filter(f => fs.statSync(f).mtimeMs < grenze);
    if (dateien.length) plan.push({ projekt: p, dateien });
  }
  return plan;
}

function prompt(projekt, dateien) {
  const rel = dateien.map(f => path.relative(VAULT, f).replace(/\\/g, '/'));
  return [
    `Du bist der unbeaufsichtigte Verdichtungslauf des Wissens-Vaults. Arbeitsverzeichnis ist der Vault (${VAULT.replace(/\\/g, '/')}).`,
    'Lies zuerst `_meta/verdichten-auftrag.md` und `_meta/konventionen.md` und führe den Auftrag vollständig aus. Rückfragen sind nicht möglich.',
    `Projekt: ${projekt}`,
    'Rohverläufe (chronologisch), jeder braucht am Ende eine Sitzungsnotiz mit `sitzung: <id8>` im Kopf:',
    ...rel.map(f => `- ${f}`),
    'Hinweis: Parallel arbeiten andere Sitzungen im selben Vault. Neue Dateien nur anlegen, wenn der Name noch nicht existiert; bestehende nur mit Edit ändern, nie komplett überschreiben.',
  ].join('\n');
}

function batchLaufen(projekt, dateien) {
  const vorher = schutzStand();
  const notizenVorher = notizDateien(projekt);
  const start = Date.now();
  const r = spawnSync(CLAUDE, [
    '-p', '--model', modell, '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--max-budget-usd', String(budget),
    '--strict-mcp-config', '--disable-slash-commands',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Write', 'Edit',
    'Bash(node _meta/skripte/vault-suche.js:*)', 'Bash(node _meta/skripte/vault-pruefung.js:*)',
    '--disallowedTools', 'Write(_meta/**)', 'Edit(_meta/**)', 'Write(**/generiert/**)', 'Edit(**/generiert/**)',
  ], {
    cwd: VAULT, input: prompt(projekt, dateien), encoding: 'utf8', timeout: cfg.timeoutMin * 60000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, BRAIN_AUTOMATION: '1' }, windowsHide: true,
  });
  let ausgabe = null; try { ausgabe = JSON.parse(r.stdout); } catch { /* keine JSON-Ausgabe */ }
  const neueNotizen = [...notizDateien(projekt)].filter(rel => !notizenVorher.has(rel));
  neueNotizen.forEach(alsAutomatischMarkieren);
  const linksKorrigiert = linksEntmehrdeutigen(projekt, start);
  const geschuetzt = aenderungen(vorher, schutzStand()).map(p => path.relative(VAULT, p).replace(/\\/g, '/'));
  const fehlend = unverarbeiteteRoh(projekt).filter(f => dateien.includes(f)).map(f => path.basename(f));
  const info = {
    projekt, sitzungen: dateien.length, verarbeitet: dateien.length - fehlend.length, fehlend, dauerS: Math.round((Date.now() - start) / 1000),
    kostenUsd: ausgabe && ausgabe.total_cost_usd, fehler: r.error ? String(r.error.message) : (r.status !== 0 ? `Exit ${r.status}` : (ausgabe && ausgabe.is_error ? String(ausgabe.result).slice(0, 300) : null)),
    geschuetzteGeaendert: geschuetzt, linksKorrigiert, neueNotizen,
  };
  log(info.fehler || geschuetzt.length ? 'verdichten_batch_problem' : 'verdichten_batch', info);
  return info;
}

// Der Vault ist ein lokales Git-Repo (ohne Remote): Vor und nach dem Lauf je ein Commit, damit jede Änderung der Automatik
// nachvollziehbar und umkehrbar ist und von Änderungen laufender Sitzungen getrennt bleibt. Fehlt .git, passiert nichts.
function gitSicherung(nachricht) {
  if (!fs.existsSync(path.join(VAULT, '.git'))) return;
  const g = (...a) => spawnSync('git', ['-C', VAULT, '-c', 'user.name=Brain-Automation', '-c', 'user.email=brain@localhost', ...a], { encoding: 'utf8', windowsHide: true });
  const add = g('add', '-A');
  if (add.status !== 0) { log('git_fehler', { schritt: 'add', meldung: String(add.stderr).slice(0, 200) }); return; }
  if (g('diff', '--cached', '--quiet').status === 0) return; // nichts zu sichern
  const c = g('commit', '-q', '-m', nachricht);
  log(c.status === 0 ? 'git_commit' : 'git_fehler', { nachricht, meldung: c.status === 0 ? undefined : String(c.stderr).slice(0, 200) });
}

// Log über 5 MB: in eine datierte Datei verschieben (Schreiber öffnen die Datei je Eintrag neu, ein Fehlschlag ist harmlos).
function logRotieren() {
  try {
    if (fs.statSync(LOG).size < 5 * 1024 * 1024) return;
    fs.renameSync(LOG, path.join(path.dirname(LOG), `automation.${new Date().toISOString().slice(0, 10)}.log.jsonl`));
  } catch { /* nichts zu rotieren oder gerade in Benutzung */ }
}

// Der Start-Hook liest diesen Stand und meldet einen ausgebliebenen oder fehlerhaften Lauf.
function laufStand(daten) {
  try { schreibeAtomar(path.join(VAULT, '_meta', 'state', 'verdichten-letzter.json'), JSON.stringify({ ts: new Date().toISOString(), ...daten }, null, 2)); } catch { /* Zustand ist nur Hinweis */ }
}

// Nacharbeiten: Sitzungsübersichten, Prüfung, Kurationsfälligkeit, Arbeitsweise-Review und Archivierung (jedes mit eigener Sperre bzw. Takt).
// Je Sitzung entstehen kleine Marker (Stop-Erinnerung, gelieferte Prompt-Treffer). Nach 14 Tagen sind sie wertlos.
function markerAufraeumen(tage = 14) {
  const grenze = Date.now() - tage * 86400000;
  for (const d of ['stop-erinnert', 'prompt-treffer']) {
    const dir = path.join(VAULT, '_meta', 'state', d);
    let dateien = []; try { dateien = fs.readdirSync(dir); } catch { continue; }
    for (const f of dateien) { try { const p = path.join(dir, f); if (fs.statSync(p).mtimeMs < grenze) fs.unlinkSync(p); } catch { /* gerade in Benutzung */ } }
  }
}

function nacharbeiten() {
  logRotieren();
  markerAufraeumen();
  try { alteRohLoeschen(cfg.rohAufbewahrungTage); } catch (e) { log('roh_loeschen_fehler', { meldung: String(e && e.message || e) }); }
  const skripte = [['sitzungen-index.js'], ['vault-pruefung.js'], ['sync-projekte.js'], ['arbeitsweise-review.js'], ['vault-archiv.js', '--ausfuehren']];
  for (const [s, ...a] of skripte) spawnSync(process.execPath, [path.join(__dirname, s), ...a], { stdio: 'ignore', windowsHide: true });
}

function main() {
  const plan = offen();
  const gesamt = plan.reduce((n, p) => n + p.dateien.length, 0);
  console.log(`Modell ${modell}, Budget ${budget} USD je Batch, Batchgröße ${batchGroesse}, höchstens ${maxSitzungen} Sitzungen je Lauf.`);
  if (!gesamt) {
    console.log('Nichts zu verdichten.'); log('verdichten_nichts', {});
    if (ausfuehren) { laufStand({ ok: true, nichts: true }); nacharbeiten(); gitSicherung('Brain: Wartungslauf'); }
    return;
  }
  for (const p of plan) console.log(`  ${p.projekt}: ${p.dateien.length} Rohsitzung(en) ohne Notiz`);
  if (!ausfuehren) { console.log(`Probelauf: ${gesamt} offen. Mit --ausfuehren verdichten (je Batch eine Claude-Instanz, kostet Tokens).`); return; }

  const freigeben = sperre('verdichten', 120);
  if (!freigeben) { console.log('Ein anderer Verdichtungslauf ist aktiv, abgebrochen.'); log('verdichten_uebersprungen', { grund: 'Sperre belegt' }); return; }
  const lauf = new Date().toISOString();
  log('verdichten_start', { lauf, modell, budget, batchGroesse, offen: gesamt, projekte: plan.map(p => `${p.projekt}:${p.dateien.length}`) });
  const summe = { batches: 0, sitzungen: 0, verarbeitet: 0, kostenUsd: 0, probleme: 0 };
  gitSicherung('Brain: Stand vor Verdichtungslauf');
  try {
    let rest = maxSitzungen;
    for (const p of plan) {
      for (let i = 0; i < p.dateien.length && rest > 0; i += batchGroesse) {
        const dateien = p.dateien.slice(i, i + Math.min(batchGroesse, rest));
        rest -= dateien.length;
        console.log(`Batch ${p.projekt}: ${dateien.length} Sitzung(en) …`);
        const b = batchLaufen(p.projekt, dateien);
        summe.batches++; summe.sitzungen += b.sitzungen; summe.verarbeitet += b.verarbeitet; summe.kostenUsd += b.kostenUsd || 0;
        if (b.fehler || b.geschuetzteGeaendert.length || b.fehlend.length) summe.probleme++;
        console.log(`  ${b.verarbeitet}/${b.sitzungen} verarbeitet, ${b.dauerS}s${b.kostenUsd ? `, ${b.kostenUsd.toFixed(2)} USD` : ''}${b.fehler ? `, FEHLER: ${b.fehler}` : ''}${b.geschuetzteGeaendert.length ? `, GESCHÜTZT GEÄNDERT: ${b.geschuetzteGeaendert.join(', ')}` : ''}`);
        if (b.fehler) { console.log('  Fehler: weitere Batches dieses Projekts übersprungen.'); break; }
      }
    }
    nacharbeiten();
  } finally {
    freigeben();
    log('verdichten_ende', { lauf, ...summe });
    laufStand({ ok: summe.probleme === 0, ...summe });
    gitSicherung(`Brain: Verdichtungslauf ${summe.verarbeitet}/${summe.sitzungen} Sitzungen`);
  }
  console.log(`Fertig: ${summe.verarbeitet}/${summe.sitzungen} Sitzungen in ${summe.batches} Batch(es), ${summe.kostenUsd.toFixed(2)} USD, ${summe.probleme} Batch(es) mit Problemen.`);
}

try { main(); } catch (err) { log('verdichten_fehler', { meldung: String(err && err.stack || err) }); console.error(String(err)); }
