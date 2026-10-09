#!/usr/bin/env node
// Installiert das Brain-Kit: legt den Vault an bzw. aktualisiert das Werkzeug darin, trägt die Claude-Code-Hooks (auf Wunsch auch die
// Auggie-Hooks) ein und ergänzt die globale CLAUDE.md um die Arbeitsanweisung. Läuft nur mit Node, ohne Pakete.
//
//   node installieren.js [--vault <ordner>] [--projekte <ordner>] [Optionen]
//   node installieren.js --pruefen [--vault <ordner>]       Diagnose der Installation
//   node installieren.js --deinstallieren [--vault <ordner>] Hooks und CLAUDE.md-Block entfernen (der Vault bleibt)
//
// Optionen:
//   --vault <ordner>     Ort des Vaults (Standard: ~/brain)
//   --projekte <ordner>  Ordner mit den Projekt-Repos (Standard: ~/Documents/projects, sonst ~/projects)
//   --settings <datei>   Claude-Code-Einstellungen (Standard: ~/.claude/settings.json)
//   --claude-md <datei>  globale CLAUDE.md (Standard: ~/.claude/CLAUDE.md)
//   --auggie             zusätzlich die Hooks für Auggie (Augment) in ~/.augment/settings.json eintragen
//   --ohne-auggie        Auggie nicht einbinden (ohne beide Schalter fragt die Installation nach, wenn sie interaktiv läuft)
//   --auggie-settings <datei>  Auggie-Einstellungen (Standard: ~/.augment/settings.json)
//   --ohne-hooks         Hooks nicht eintragen
//   --ohne-claude-md     CLAUDE.md nicht ändern
//   --aufgabe            zusätzlich die tägliche Windows-Aufgabe für die Verdichtung einrichten (sonst nur als Hinweis)
//   --trocken            nur anzeigen, was passieren würde
//
// Kit und Daten sind getrennt: Skripte, Vorlagen, Konventionen und Auftrag im Vault gehören dem Kit und werden bei einem Update
// überschrieben (die alte Fassung bleibt als .bak daneben). Konfiguration (_meta/brain.config.json) und alle Notizen werden nie angefasst.
// Änderungen an settings.json und CLAUDE.md sind idempotent und werden vorher gesichert (<datei>.brain-sicherung-<zeit>).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT = path.join(__dirname, 'kit');
const VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
const BLOCK_START = '<!-- brain:start (vom Brain-Kit verwaltet, bitte hier nichts ändern) -->';
const BLOCK_END = '<!-- brain:end -->';
const HOOKS = [
  { event: 'SessionStart', modus: 'start', timeout: 10, statusMessage: 'Wissens-Vault laden...' },
  { event: 'SessionEnd', modus: 'end', timeout: 20 },
  { event: 'UserPromptSubmit', modus: 'prompt', timeout: 5 },
  { event: 'Stop', modus: 'stop', timeout: 10 },
];

const args = process.argv.slice(2);
const wert = (k, std) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : std; };
const hat = k => args.includes(k);
const heim = os.homedir();
const vault = path.resolve(wert('--vault', path.join(heim, 'brain')));
const projekte = path.resolve(wert('--projekte', [path.join(heim, 'Documents', 'projects'), path.join(heim, 'projects')].find(p => fs.existsSync(p)) || path.join(heim, 'projects')));
const settingsDatei = path.resolve(wert('--settings', path.join(heim, '.claude', 'settings.json')));
const claudeMd = path.resolve(wert('--claude-md', path.join(heim, '.claude', 'CLAUDE.md')));
const auggieDatei = path.resolve(wert('--auggie-settings', path.join(heim, '.augment', 'settings.json')));
const trocken = hat('--trocken');
const vor = s => s.replace(/\\/g, '/'); // Pfade in Befehlen und Konfiguration mit Schrägstrichen
const zeit = () => new Date().toISOString().replace(/[:.]/g, '-');
const meldungen = [];
const sag = (art, text) => { meldungen.push({ art, text }); console.log(`${art.padEnd(12)} ${text}`); };

function schreibe(datei, inhalt) {
  if (trocken) return;
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  fs.writeFileSync(datei, inhalt, 'utf8');
}
function sichere(datei) {
  if (trocken || !fs.existsSync(datei)) return;
  fs.copyFileSync(datei, `${datei}.brain-sicherung-${zeit()}`);
}
function lies(datei) { try { return fs.readFileSync(datei, 'utf8'); } catch { return null; } }

// ── Kit-Dateien ins Vault kopieren ───────────────────────────────────────────────
function kitKopieren() {
  const dateien = [];
  (function lauf(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) lauf(p); else dateien.push(path.relative(KIT, p).replace(/\\/g, '/'));
    }
  })(KIT);
  let neu = 0, aktualisiert = 0, gleich = 0;
  for (const rel of dateien) {
    if (rel === 'vault.gitignore' || rel === '_meta/brain.config.example.json') continue; // werden gesondert behandelt
    const quelle = fs.readFileSync(path.join(KIT, rel));
    const ziel = path.join(vault, rel);
    const alt = fs.existsSync(ziel) ? fs.readFileSync(ziel) : null;
    if (alt && alt.equals(quelle)) { gleich++; continue; }
    if (alt) { if (!trocken) fs.copyFileSync(ziel, ziel + '.bak'); aktualisiert++; } else neu++;
    if (!trocken) { fs.mkdirSync(path.dirname(ziel), { recursive: true }); fs.writeFileSync(ziel, quelle); }
  }
  sag('Kit', `${neu} neu, ${aktualisiert} aktualisiert (alte Fassung als .bak), ${gleich} unverändert`);
  schreibe(path.join(vault, '_meta', 'kit-version.txt'), VERSION + '\n');
}

function geruest() {
  for (const d of ['projekte', '_global', '_cross-project', '_meta/state', '_meta/logs', '_meta/generiert']) {
    if (!trocken) fs.mkdirSync(path.join(vault, d), { recursive: true });
  }
  const cfgZiel = path.join(vault, '_meta', 'brain.config.json');
  if (fs.existsSync(cfgZiel)) sag('Konfiguration', 'vorhanden, bleibt unverändert');
  else {
    const vorlage = fs.readFileSync(path.join(KIT, '_meta', 'brain.config.example.json'), 'utf8')
      .replace('{{PROJEKTE}}', vor(projekte)).replace('{{HEUTE}}', new Date().toISOString().slice(0, 10));
    schreibe(cfgZiel, vorlage);
    sag('Konfiguration', `neu angelegt (projektOrdner ${vor(projekte)})`);
  }
}

function gitAnlegen() {
  if (fs.existsSync(path.join(vault, '.git'))) { sag('Git', 'Vault ist bereits ein Repo'); return; }
  const ign = path.join(vault, '.gitignore');
  if (!fs.existsSync(ign)) schreibe(ign, fs.readFileSync(path.join(KIT, 'vault.gitignore'), 'utf8'));
  if (trocken) { sag('Git', 'würde ein lokales Repo anlegen'); return; }
  const g = (...a) => spawnSync('git', ['-C', vault, ...a], { encoding: 'utf8', windowsHide: true });
  if (g('--version').status !== 0) { sag('Git', 'git nicht gefunden: Vault bleibt ohne Versionierung (der Verdichtungslauf sichert dann nichts)'); return; }
  g('init', '-q', '-b', 'main');
  // Nur lokal: der unbeaufsichtigte Lauf darf nie an einer Signatur- oder Passwortabfrage hängen und soll Zeilenenden nicht umwandeln
  for (const [k, v] of [['user.name', 'Brain-Automation'], ['user.email', 'brain@localhost'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) g('config', k, v);
  g('add', '-A');
  g('commit', '-q', '-m', 'Brain: Ausgangsstand (Brain-Kit ' + VERSION + ')');
  sag('Git', 'lokales Repo ohne Remote angelegt, Ausgangsstand committet');
}

// ── Hooks in settings.json ───────────────────────────────────────────────────────
// Auggie: ein Skript für alle Events (hook-vault-auggie.cmd), Ereignis kommt im Hook-JSON. Kein UserPromptSubmit-Pendant.
const AUGGIE_HOOKS = [
  { event: 'SessionStart', timeout: 10000 },
  { event: 'PostToolUse', timeout: 5000, matcher: 'save-file|str-replace-editor|remove-files' },
  { event: 'Stop', timeout: 10000, metadata: { includeConversationData: true } },
  { event: 'SessionEnd', timeout: 20000 },
];
const auggieBefehl = () => path.join(vault, '_meta', 'skripte', 'hook-vault-auggie.cmd');
const istAuggieHook = h => /hook-vault-auggie\.cmd/.test(String(h && h.command));
const befehl = modus => `node "${vor(path.join(vault, '_meta', 'skripte', 'hook-vault.js'))}" ${modus}`;
const istBrainHook = h => /hook-vault\.js/.test(String(h && h.command));

function settingsEntfernen(s, ist = istBrainHook) {
  let entfernt = 0;
  for (const ev of Object.keys(s.hooks || {})) {
    s.hooks[ev] = (s.hooks[ev] || []).map(gruppe => {
      const rest = (gruppe.hooks || []).filter(h => !(ist(h) && ++entfernt));
      return { ...gruppe, hooks: rest };
    }).filter(g => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return entfernt;
}

function hooksEintragen() {
  const roh = lies(settingsDatei);
  let s = {};
  if (roh !== null) { try { s = JSON.parse(roh); } catch { sag('FEHLER', `${settingsDatei} ist kein gültiges JSON: nichts geändert`); process.exitCode = 1; return; } }
  settingsEntfernen(s); // vorhandene Brain-Hooks (auch mit altem Pfad) ersetzen, fremde Hooks bleiben
  s.hooks = s.hooks || {};
  for (const h of HOOKS) {
    const eintrag = { type: 'command', command: befehl(h.modus), timeout: h.timeout, ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}) };
    s.hooks[h.event] = [...(s.hooks[h.event] || []), { hooks: [eintrag] }];
  }
  const neu = JSON.stringify(s, null, 2) + '\n';
  if (roh !== null && JSON.stringify(JSON.parse(roh)) === JSON.stringify(s)) { sag('Hooks', 'bereits eingetragen'); return; }
  sichere(settingsDatei);
  schreibe(settingsDatei, neu);
  sag('Hooks', `4 Hooks in ${vor(settingsDatei)} eingetragen (Sicherung der alten Datei daneben)`);
}

function auggieEintragen() {
  const roh = lies(auggieDatei);
  let s = {};
  if (roh !== null) { try { s = JSON.parse(roh); } catch { sag('FEHLER', `${auggieDatei} ist kein gültiges JSON: Auggie nicht eingebunden`); process.exitCode = 1; return; } }
  settingsEntfernen(s, istAuggieHook); // vorhandene Brain-Hooks (auch mit altem Pfad) ersetzen, fremde Hooks bleiben
  s.hooks = s.hooks || {};
  for (const h of AUGGIE_HOOKS) {
    const gruppe = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: auggieBefehl(), timeout: h.timeout }], ...(h.metadata ? { metadata: h.metadata } : {}) };
    s.hooks[h.event] = [...(s.hooks[h.event] || []), gruppe];
  }
  if (roh !== null && JSON.stringify(JSON.parse(roh)) === JSON.stringify(s)) { sag('Auggie', 'Hooks bereits eingetragen'); return; }
  if (roh !== null) sichere(auggieDatei);
  schreibe(auggieDatei, JSON.stringify(s, null, 2) + '\n');
  sag('Auggie', `${AUGGIE_HOOKS.length} Hooks in ${vor(auggieDatei)} eingetragen (Korrektur-Erkennung beim Prompt gibt es bei Auggie nicht)`);
}

// Frage bei interaktiver Installation; ohne Terminal gilt der Standardwert.
function frage(text, std) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return std;
  process.stdout.write(`${text} [${std ? 'J/n' : 'j/N'}] `);
  const puffer = Buffer.alloc(256);
  let n = 0;
  try { n = fs.readSync(0, puffer, 0, 256, null); } catch { return std; }
  const antwort = puffer.toString('utf8', 0, n).trim().toLowerCase();
  return antwort === '' ? std : /^(j|ja|y|yes)$/.test(antwort);
}
function mitAuggie() {
  if (hat('--auggie')) return true;
  if (hat('--ohne-auggie') || hat('--ohne-hooks')) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false; // ohne Terminal nie raten
  const erkannt = fs.existsSync(path.dirname(auggieDatei));
  return frage(`Auggie (Augment) erkannt${erkannt ? '' : ' nicht'}. Hooks auch dafür eintragen (${vor(auggieDatei)})?`, erkannt);
}

// ── CLAUDE.md ────────────────────────────────────────────────────────────────────
function blockEntfernen(text) {
  const a = text.indexOf(BLOCK_START), b = text.indexOf(BLOCK_END);
  if (a < 0 || b < a) return null;
  return (text.slice(0, a).replace(/\s+$/, '') + '\n' + text.slice(b + BLOCK_END.length).replace(/^\s+/, '\n')).replace(/^\n+/, '');
}

function claudeMdSchreiben() {
  const baustein = fs.readFileSync(path.join(__dirname, 'CLAUDE-baustein.md'), 'utf8').replace(/\{\{VAULT\}\}/g, vor(vault)).trim();
  const block = `${BLOCK_START}\n${baustein}\n${BLOCK_END}\n`;
  const alt = lies(claudeMd) || '';
  const a = alt.indexOf(BLOCK_START), b = alt.indexOf(BLOCK_END);
  const neu = a > -1 && b > a ? alt.slice(0, a) + block + alt.slice(b + BLOCK_END.length).replace(/^\r?\n/, '') : (alt ? alt.replace(/\s+$/, '') + '\n\n' : '') + block;
  if (neu === alt) { sag('CLAUDE.md', 'Block bereits aktuell'); return; }
  sichere(claudeMd);
  schreibe(claudeMd, neu);
  sag('CLAUDE.md', `Arbeitsanweisung ${a > -1 ? 'aktualisiert' : 'ergänzt'} in ${vor(claudeMd)}`);
}

// ── Aufgabe ──────────────────────────────────────────────────────────────────────
function aufgabe() {
  const skript = path.join(vault, '_meta', 'skripte', 'aufgabe-einrichten.ps1');
  if (!hat('--aufgabe')) { sag('Aufgabe', `nicht eingerichtet. Täglicher Verdichtungslauf (21:30 Uhr): powershell -ExecutionPolicy Bypass -File ${vor(skript)}`); return; }
  if (trocken) { sag('Aufgabe', 'würde die Windows-Aufgabe einrichten'); return; }
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', skript], { encoding: 'utf8', windowsHide: true });
  sag(r.status === 0 ? 'Aufgabe' : 'FEHLER', r.status === 0 ? 'Windows-Aufgabe „Brain-Sitzungen-verdichten“ eingerichtet' : `Einrichtung fehlgeschlagen: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
}

// ── Diagnose ─────────────────────────────────────────────────────────────────────
function pruefen() {
  const ok = (b, text, hinweis) => console.log(`${b ? 'OK     ' : 'FEHLT  '} ${text}${!b && hinweis ? '  → ' + hinweis : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 20, `Node ${process.versions.node}`, 'Node 20 oder neuer installieren');
  const c = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  ok(c.status === 0, `Claude-Code-CLI ${c.status === 0 ? c.stdout.trim() : ''}`, 'Claude Code installieren und anmelden (für den Verdichtungslauf)');
  ok(spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0, 'git', 'git installieren (Versionierung des Vaults)');
  ok(fs.existsSync(path.join(vault, '_meta', 'skripte', 'hook-vault.js')), `Kit im Vault (${vor(vault)}), Version ${(lies(path.join(vault, '_meta', 'kit-version.txt')) || '?').trim()}`, 'node installieren.js ausführen');
  ok(fs.existsSync(path.join(vault, '_meta', 'brain.config.json')), 'Konfiguration brain.config.json', 'node installieren.js ausführen');
  ok(fs.existsSync(path.join(vault, '.git')), 'Vault ist ein Git-Repo', 'node installieren.js ausführen');
  let s = {}; try { s = JSON.parse(lies(settingsDatei) || '{}'); } catch { /* ungültig */ }
  const eingetragen = HOOKS.filter(h => (s.hooks && s.hooks[h.event] || []).some(g => (g.hooks || []).some(x => x.command === befehl(h.modus))));
  ok(eingetragen.length === HOOKS.length, `Hooks in settings.json (${eingetragen.length} von ${HOOKS.length}, Pfad passt zum Vault)`, 'node installieren.js ausführen');
  let a = null; try { a = JSON.parse(lies(auggieDatei) || 'null'); } catch { /* ungültig */ }
  if (a || hat('--auggie')) {
    const n = AUGGIE_HOOKS.filter(h => ((a && a.hooks && a.hooks[h.event]) || []).some(g => (g.hooks || []).some(x => x.command === auggieBefehl()))).length;
    ok(n === AUGGIE_HOOKS.length, `Auggie-Hooks (${n} von ${AUGGIE_HOOKS.length}, Pfad passt zum Vault)`, 'node installieren.js --auggie ausführen');
  }
  // Auggie liest die globale CLAUDE.md nicht: dort zählt eine Regeldatei neben seiner settings.json (rules/brain.md)
  const imClaudeMd = (lies(claudeMd) || '').includes(BLOCK_START);
  const auggieRegel = path.join(path.dirname(auggieDatei), 'rules', 'brain.md');
  const inAuggieRegel = (lies(auggieRegel) || '').includes(vor(vault));
  ok(imClaudeMd || inAuggieRegel, `Arbeitsanweisung in ${[imClaudeMd && 'der globalen CLAUDE.md', inAuggieRegel && 'den Auggie-Regeln (rules/brain.md)'].filter(Boolean).join(' und ') || 'der globalen CLAUDE.md'}`, 'node installieren.js ausführen');
  const st = spawnSync('schtasks', ['/Query', '/TN', 'Brain-Sitzungen-verdichten'], { encoding: 'utf8', windowsHide: true });
  ok(st.status === 0, 'Windows-Aufgabe Brain-Sitzungen-verdichten', 'optional: node installieren.js --aufgabe');
  const letzter = lies(path.join(vault, '_meta', 'state', 'verdichten-letzter.json'));
  console.log(letzter ? `Letzter Verdichtungslauf: ${JSON.parse(letzter).ts}` : 'Noch kein Verdichtungslauf.');
}

// ── Deinstallation ───────────────────────────────────────────────────────────────
function deinstallieren() {
  const roh = lies(settingsDatei);
  if (roh !== null) {
    let s; try { s = JSON.parse(roh); } catch { sag('FEHLER', 'settings.json ungültig, nichts geändert'); return; }
    const n = settingsEntfernen(s);
    if (n) { sichere(settingsDatei); schreibe(settingsDatei, JSON.stringify(s, null, 2) + '\n'); }
    sag('Hooks', `${n} Brain-Hook(s) entfernt`);
  }
  const aroh = lies(auggieDatei);
  if (aroh !== null) {
    let a; try { a = JSON.parse(aroh); } catch { a = null; }
    const n = a ? settingsEntfernen(a, istAuggieHook) : 0;
    if (n) { sichere(auggieDatei); schreibe(auggieDatei, JSON.stringify(a, null, 2) + '\n'); sag('Auggie', `${n} Brain-Hook(s) entfernt`); }
  }
  const md = lies(claudeMd);
  const ohne = md === null ? null : blockEntfernen(md);
  if (ohne !== null) { sichere(claudeMd); schreibe(claudeMd, ohne); sag('CLAUDE.md', 'Block entfernt'); } else sag('CLAUDE.md', 'kein Block vorhanden');
  sag('Hinweis', `Der Vault (${vor(vault)}) bleibt unverändert. Aufgabe entfernen: Unregister-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' -Confirm:$false`);
}

// ── Ablauf ───────────────────────────────────────────────────────────────────────
function main() {
  if (process.platform !== 'win32') console.log('Hinweis: Das Kit ist nur unter Windows getestet (Aufgabenplanung, Claude-Pfad).');
  if (hat('--pruefen')) return pruefen();
  console.log(`Brain-Kit ${VERSION}${trocken ? ' (Probelauf, es wird nichts geschrieben)' : ''}\n  Vault:     ${vor(vault)}\n  Projekte:  ${vor(projekte)}\n  Settings:  ${vor(settingsDatei)}\n  CLAUDE.md: ${vor(claudeMd)}\n`);
  if (hat('--deinstallieren')) return deinstallieren();
  kitKopieren();
  geruest();
  gitAnlegen();
  if (!hat('--ohne-hooks')) hooksEintragen(); else sag('Hooks', 'übersprungen (--ohne-hooks)');
  if (mitAuggie()) auggieEintragen(); else sag('Auggie', 'nicht eingebunden (nachholen: node installieren.js --auggie)');
  if (!hat('--ohne-claude-md')) claudeMdSchreiben(); else sag('CLAUDE.md', 'übersprungen (--ohne-claude-md)');
  aufgabe();
  console.log('\nFertig. Neue Claude-Code-Sitzungen laden den Vault automatisch. Kontrolle: node installieren.js --pruefen');
}

try { main(); } catch (err) { console.error('Installation fehlgeschlagen:', err && err.message || err); process.exitCode = 1; }
