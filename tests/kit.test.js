// Integrationstests des Brain-Kits: Installer, Hooks, Prüfung und Verdichtungs-Probelauf in einem frischen Temp-Vault.
// Rührt weder die echten Claude-Einstellungen noch einen echten Vault an (alle Pfade zeigen in ein Temp-Verzeichnis).
// Aufruf: node --test (im Repo-Hauptordner)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT = path.resolve(__dirname, '..');
const vor = p => p.replace(/\\/g, '/');

// Frische Umgebung: Vault, Projektordner, Einstellungen und CLAUDE.md liegen in einem Temp-Ordner
function umgebung() {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-kit-'));
  const env = { wurzel, vault: path.join(wurzel, 'vault'), projekte: path.join(wurzel, 'projects'), settings: path.join(wurzel, 'settings.json'), md: path.join(wurzel, 'CLAUDE.md') };
  fs.mkdirSync(env.projekte, { recursive: true });
  return env;
}
function installieren(env, ...extra) {
  const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--vault', env.vault, '--projekte', env.projekte, '--settings', env.settings, '--claude-md', env.md, ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
function skript(env, name, args = [], opts = {}) {
  return spawnSync(process.execPath, [path.join(env.vault, '_meta', 'skripte', name), ...args], { encoding: 'utf8', ...opts });
}
function hook(env, modus, eingabe, extraEnv = {}) {
  return skript(env, 'hook-vault.js', [modus], { input: JSON.stringify(eingabe), env: { ...process.env, ...extraEnv } });
}
const aufraeumen = env => fs.rmSync(env.wurzel, { recursive: true, force: true });
const brainHooks = s => Object.values(s.hooks || {}).flat().flatMap(g => g.hooks).filter(h => /hook-vault\.js/.test(h.command));

test('Installer legt Vault-Gerüst, Konfiguration und Git-Repo an', () => {
  const env = umgebung();
  try {
    installieren(env);
    for (const d of ['projekte', '_global', '_cross-project', '_meta/state', '_meta/logs', '_meta/skripte', '_meta/vorlagen']) assert.ok(fs.existsSync(path.join(env.vault, d)), d);
    const cfg = JSON.parse(fs.readFileSync(path.join(env.vault, '_meta', 'brain.config.json'), 'utf8'));
    assert.equal(cfg.projektOrdner, vor(env.projekte));
    assert.ok(fs.existsSync(path.join(env.vault, '.git')), 'Git-Repo');
    assert.ok(fs.existsSync(path.join(env.vault, '.gitignore')));
    assert.match(fs.readFileSync(path.join(env.vault, '_meta', 'kit-version.txt'), 'utf8'), /^\d+\.\d+\.\d+/);
  } finally { aufraeumen(env); }
});

test('Installer ist idempotent und lässt fremde Hooks und Konfiguration unangetastet', () => {
  const env = umgebung();
  try {
    fs.writeFileSync(env.settings, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fremd' }] }] } }));
    fs.writeFileSync(env.md, '# Meine Regeln\n\nSei nett.\n');
    installieren(env);
    const cfgPfad = path.join(env.vault, '_meta', 'brain.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPfad, 'utf8')); cfg.eigeneEinstellung = 42; fs.writeFileSync(cfgPfad, JSON.stringify(cfg));
    installieren(env); // zweiter Lauf
    const s = JSON.parse(fs.readFileSync(env.settings, 'utf8'));
    assert.equal(s.model, 'x');
    assert.equal(brainHooks(s).length, 4, 'genau vier Brain-Hooks');
    assert.ok(s.hooks.Stop.some(g => g.hooks.some(h => h.command === 'echo fremd')), 'fremder Hook bleibt');
    const md = fs.readFileSync(env.md, 'utf8');
    assert.equal(md.split('<!-- brain:start').length - 1, 1, 'CLAUDE.md-Block genau einmal');
    assert.ok(md.includes('Sei nett.'));
    assert.ok(!md.includes('{{VAULT}}'), 'Platzhalter ersetzt');
    assert.equal(JSON.parse(fs.readFileSync(cfgPfad, 'utf8')).eigeneEinstellung, 42, 'Konfiguration bleibt');
    assert.ok(fs.readdirSync(env.wurzel).some(f => f.startsWith('settings.json.brain-sicherung-')), 'Sicherung der Einstellungen');
  } finally { aufraeumen(env); }
});

test('Probelauf schreibt nichts', () => {
  const env = umgebung();
  try {
    installieren(env, '--trocken');
    assert.ok(!fs.existsSync(env.vault));
    assert.ok(!fs.existsSync(env.settings));
    assert.ok(!fs.existsSync(env.md));
  } finally { aufraeumen(env); }
});

test('Deinstallation entfernt Hooks und Block, lässt Vault und fremde Hooks stehen', () => {
  const env = umgebung();
  try {
    fs.writeFileSync(env.settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fremd' }] }] } }));
    fs.writeFileSync(env.md, '# Meine Regeln\n');
    installieren(env);
    const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--deinstallieren', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = JSON.parse(fs.readFileSync(env.settings, 'utf8'));
    assert.equal(brainHooks(s).length, 0);
    assert.ok(s.hooks.Stop.some(g => g.hooks.some(h => h.command === 'echo fremd')));
    const md = fs.readFileSync(env.md, 'utf8');
    assert.ok(!md.includes('brain:start') && md.includes('# Meine Regeln'));
    assert.ok(fs.existsSync(path.join(env.vault, '_meta', 'skripte')), 'Vault bleibt');
  } finally { aufraeumen(env); }
});

test('Vault-Prüfung läuft auf frischem Vault ohne Befunde', () => {
  const env = umgebung();
  try {
    installieren(env);
    const r = skript(env, 'vault-pruefung.js');
    assert.equal(r.status, 0, r.stderr);
    const z = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(z.defekteLinks, 0);
    assert.equal(z.geheimnisVerdacht, 0);
  } finally { aufraeumen(env); }
});

test('Start-Hook: Hinweis für neues Projekt, Stille außerhalb der Projekte und bei BRAIN_AUTOMATION', () => {
  const env = umgebung();
  try {
    installieren(env);
    const cwd = vor(path.join(env.projekte, 'demo-app'));
    const r = hook(env, 'start', { cwd, session_id: 'abcdef12-0000' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /noch keinen Vault-Ordner/);
    assert.equal(hook(env, 'start', { cwd: vor(os.tmpdir()), session_id: 'x' }).stdout, '', 'außerhalb der Projekte nichts');
    assert.equal(hook(env, 'start', { cwd, session_id: 'x' }, { BRAIN_AUTOMATION: '1' }).stdout, '', 'Automatisierung löst keine Hooks aus');
  } finally { aufraeumen(env); }
});

// Hilfsmittel: kleiner Sitzungsverlauf im Format von Claude Code
function verlauf(env, projekt, edits = 0) {
  const cwd = vor(path.join(env.projekte, projekt));
  const z = [
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', cwd, message: { content: 'Bitte baue eine Funktion.' } },
    { type: 'assistant', timestamp: '2026-10-01T10:01:00Z', cwd, message: { content: [{ type: 'text', text: 'Mache ich.' }] } },
    { type: 'user', timestamp: '2026-10-01T10:02:00Z', cwd, message: { content: 'Danke, noch eine Änderung.' } },
  ];
  for (let i = 0; i < edits; i++) z.push({ type: 'assistant', timestamp: '2026-10-01T10:03:00Z', cwd, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/datei${i}.ts` } }] } });
  const datei = path.join(env.wurzel, `verlauf-${projekt}.jsonl`);
  fs.writeFileSync(datei, z.map(x => JSON.stringify(x)).join('\n'));
  return { datei: vor(datei), cwd };
}

test('Stop-Hook mahnt ab drei Projektdateien genau einmal je Sitzung', () => {
  const env = umgebung();
  try {
    installieren(env);
    const v = verlauf(env, 'demo-app', 3);
    const eingabe = { cwd: v.cwd, session_id: 'stoptest-1', transcript_path: v.datei };
    assert.match(JSON.parse(hook(env, 'stop', eingabe).stdout).reason, /3 Projektdatei/);
    assert.equal(hook(env, 'stop', eingabe).stdout, '', 'zweiter Aufruf schweigt');
    const wenig = verlauf(env, 'demo-zwei', 2);
    assert.equal(hook(env, 'stop', { cwd: wenig.cwd, session_id: 'stoptest-2', transcript_path: wenig.datei }).stdout, '', 'unter der Schwelle');
  } finally { aufraeumen(env); }
});

test('SessionEnd sichert den Verlauf; der Verdichtungs-Probelauf findet die offene Rohsitzung', () => {
  const env = umgebung();
  try {
    installieren(env);
    const v = verlauf(env, 'demo-app');
    assert.equal(hook(env, 'end', { cwd: v.cwd, session_id: 'e2e12345-aaaa', transcript_path: v.datei }).status, 0);
    const roh = path.join(env.vault, 'projekte', 'demo-app', 'generiert', 'sitzungen-roh', '2026-10-01-e2e12345.txt');
    assert.ok(fs.existsSync(roh), 'Rohdatei');
    assert.match(fs.readFileSync(roh, 'utf8'), /Bitte baue eine Funktion/);
    // Frisch gesicherte Dateien wartet der Lauf ab (Standard 30 Minuten): erst nach Zurückdatieren sind sie dran
    assert.match(skript(env, 'sitzungen-verdichten.js').stdout, /Nichts zu verdichten/);
    const vor1h = new Date(Date.now() - 3600e3); fs.utimesSync(roh, vor1h, vor1h);
    const r = skript(env, 'sitzungen-verdichten.js');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /demo-app: 1 Rohsitzung/);
    assert.match(r.stdout, /Probelauf/);
  } finally { aufraeumen(env); }
});

test('Schwärzung und Geheimnis-Scan: Treffer ja, Commit-Hashes und Farbwerte nein', () => {
  const env = umgebung();
  try {
    installieren(env);
    const lib = require(path.join(env.vault, '_meta', 'skripte', 'sitzung-lib.js'));
    assert.ok(lib.redact('token=abcdefgh12345678').includes('[geschwärzt]'));
    assert.ok(lib.redact('Mail an max@example.org').includes('[geschwärzt]'));
    assert.equal(lib.findeGeheimnisse('Commit `0654692` und Farbe #047857').length, 0);
    assert.equal(lib.findeGeheimnisse('api_key = abcdef1234567890xyz').length, 1);
  } finally { aufraeumen(env); }
});

test('Sperre: zweiter Halter wird abgewiesen, nach Freigabe klappt es wieder', () => {
  const env = umgebung();
  try {
    installieren(env);
    const hilf = path.join(env.wurzel, 'sperre.js');
    fs.writeFileSync(hilf, `const l = require(${JSON.stringify(path.join(env.vault, '_meta', 'skripte', 'sitzung-lib.js'))});
      const a = l.sperre('t'); const b = l.sperre('t'); a(); const c = l.sperre('t'); c();
      console.log(JSON.stringify([typeof a, b, typeof c]));`);
    const r = spawnSync(process.execPath, [hilf], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '["function",null,"function"]');
  } finally { aufraeumen(env); }
});

test('Diagnose läuft durch', () => {
  const env = umgebung();
  try {
    installieren(env);
    const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--pruefen', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK\s+Hooks in settings\.json \(4 von 4/);
    assert.match(r.stdout, /OK\s+Arbeitsanweisung/);
  } finally { aufraeumen(env); }
});
