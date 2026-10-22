// Gemeinsame Bausteine der Vault-Hooks für Claude Code (hook-vault.js) und Auggie (hook-vault-auggie.js):
// Logger, Hook-Fehler-Zustand, Wartungsstart und der Kontext beim Sessionstart. Konfiguration: _meta/brain.config.json.
// Bewusst klein: läuft in jeder Session und kostet jedes Mal Tokens.
const fs = require('fs');
const path = require('path');
const { VAULT, PROJECTS, projectOf, schreibeAtomar, unverarbeiteteRoh } = require('./sitzung-lib');

const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const FEHLER_DATEI = path.join(VAULT, '_meta', 'state', 'hook-fehler.json');

// Liefert log(event, data), das tool fest auf toolName setzt ('claude' oder 'auggie').
function createLogger(toolName) {
  return function log(event, data) {
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'hook', tool: toolName, event, ...data }) + '\n');
      if (event === 'hook_fehler') merkeFehler(data);
    } catch { /* Logging darf den Hook nie stören */ }
  };
}

// Hook-Fehler stehen sonst nur im Log. Der Zustand wird beim nächsten Sessionstart einmal gemeldet (gemeldet:false → true).
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
function wartungAnstossen(log) {
  for (const skript of ['vault-pruefung.js', 'sync-projekte.js', 'arbeitsweise-review.js']) {
    try {
      const kind = require('child_process').spawn(process.execPath, [path.join(__dirname, skript)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, BRAIN_AUTOMATION: '1' } });
      kind.unref();
    } catch (err) { log('wartung_anstossen_fehlgeschlagen', { skript, meldung: String(err && err.message || err) }); }
  }
  log('wartung_angestossen', {});
}

// Ordnet einen bearbeiteten Dateipfad als 'vault', 'projekt' oder null (außerhalb/irrelevant) ein.
function classify(filePath, project) {
  const f = norm(filePath);
  const root = norm(path.join(PROJECTS, project.dir)) + '/', vault = norm(VAULT) + '/';
  if (f.startsWith(vault)) return 'vault';
  if (f.startsWith(root) && !/\/(node_modules|dist|\.git)\//.test(f)) return 'projekt';
  return null;
}

// SessionStart-Kontext (gemeinsam für Claude und Auggie): _index.md, offene Punkte, Hinweise.
// Gibt das fertige { hookSpecificOutput: {...} }-Objekt zurück, oder null, wenn kein Projekt erkannt wurde.
function baueStart(cwd, sitzungId, log) {
  const p = projectOf(cwd);
  if (!p) return null;
  const base = path.join(VAULT, 'projekte', p.vault);
  const suche = path.join(VAULT, '_meta', 'skripte', 'vault-suche.js');
  const parts = [`Wissens-Vault (${VAULT}), Projekt "${p.vault}". Vor Entscheidungen gezielt suchen: node ${suche} <begriff> (oder --gueltig). Entscheidungen und Erkenntnisse sofort als Notiz festhalten. generiert/ nicht lesen.`];
  const idx = read(path.join(base, '_index.md'), 60);
  if (idx) parts.push(`--- ${p.vault}/_index.md ---\n${idx}`);
  else parts.push(`Zu diesem Projekt gibt es noch keinen Vault-Ordner. Lege projekte/${p.vault}/ mit _index.md an.`);
  try {
    const offenDir = path.join(base, 'offen');
    const dateien = fs.readdirSync(offenDir).filter(f => f.endsWith('.md') && !f.startsWith('_') && !erledigt(path.join(offenDir, f)));
    // Aufgaben (Kopf: aufgabe: true, naechster-schritt: "...") zuerst und mit nächstem Schritt, der Rest nur als Titel.
    const aufgaben = [], offen = [];
    for (const f of dateien) {
      const name = f.replace(/\.md$/, '');
      let kopf = '';
      try { kopf = fs.readFileSync(path.join(offenDir, f), 'utf8').slice(0, 800); } catch { /* unlesbar: als Punkt listen */ }
      if (/^aufgabe:\s*true\s*$/m.test(kopf)) {
        const schritt = (kopf.match(/^naechster-schritt:\s*"?(.*?)"?\s*$/m) || [])[1];
        aufgaben.push(schritt ? `${name} → ${schritt}` : name);
      } else offen.push(name);
    }
    if (aufgaben.length) parts.push(`Offene Aufgaben (${aufgaben.length}, zum Wiederaufsetzen; Notiz in projekte/${p.vault}/offen/):\n- ${aufgaben.join('\n- ')}`);
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
    if (Date.now() - Date.parse(st.ts) > PRUEFUNG_MAX_ALTER_H * 3600e3) wartungAnstossen(log);
    const z = (st.projekte || {})[p.vault];
    const n = z ? [z.defektLinks, z.verwaist, z.kopf, z.herkunftFehlt, z.ketten, z.doppelt, z.geheimnis, z.indexGross].reduce((x, y) => x + (y || 0), 0) : 0;
    if (n) { pruefung = z; warn.push(`Vault-Prüfung ${n} Befunde (_meta/generiert/vault-pruefung.md; beim Anfassen der Notiz beheben)`); }
  } catch { wartungAnstossen(log); /* noch kein Prüflauf */ }
  // Git-Sicherung des Vaults: fehlendes Repo oder fehlgeschlagene Sicherung melden, damit nicht tagelang still nichts gesichert wird.
  try {
    if (!fs.existsSync(path.join(VAULT, '.git'))) warn.push('Im Vault fehlt .git: die automatische Git-Sicherung läuft nicht (node installieren.js legt das Repo an)');
    else {
      const g = JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'state', 'git-sicherung.json'), 'utf8'));
      if (g.ok === false) warn.push(`Letzte Git-Sicherung fehlgeschlagen (${String(g.meldung || g.fehler || '').slice(0, 120)}; _meta/state/git-sicherung.json)`);
    }
  } catch { /* noch kein Sicherungsstatus */ }
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
  log('sessionstart_kontext', { projekt: p.vault, sitzung: String(sitzungId || '').slice(0, 8), index_gefunden: !!idx, unverarbeitet: unv, vault_pruefung: pruefung });
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } };
}

module.exports = { VAULT, PROJECTS, norm, createLogger, projectOf, classify, read, baueStart };
