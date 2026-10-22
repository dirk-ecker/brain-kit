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
  const env = { wurzel, vault: path.join(wurzel, 'vault'), projekte: path.join(wurzel, 'projects'), settings: path.join(wurzel, 'settings.json'), auggie: path.join(wurzel, 'augment', 'settings.json'), md: path.join(wurzel, 'CLAUDE.md') };
  fs.mkdirSync(env.projekte, { recursive: true });
  return env;
}
function installieren(env, ...extra) {
  const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--vault', env.vault, '--projekte', env.projekte, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie, ...extra], { encoding: 'utf8' });
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
    const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--deinstallieren', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie], { encoding: 'utf8' });
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

test('Start-Hook: Aufgaben (aufgabe: true) stehen mit nächstem Schritt vor den übrigen offenen Punkten', () => {
  const env = umgebung();
  try {
    installieren(env);
    const projekt = path.join(env.vault, 'projekte', 'demo-app');
    const offen = path.join(projekt, 'offen');
    fs.mkdirSync(offen, { recursive: true });
    fs.writeFileSync(path.join(projekt, '_index.md'), '# demo-app\n\nZweck: Test.\n');
    fs.writeFileSync(path.join(offen, '2026-10-01-umbau.md'), '---\ntyp: offen\nstatus: offen\naufgabe: true\nnaechster-schritt: "Migration 3 ausführen"\n---\n\n# Umbau\n');
    fs.writeFileSync(path.join(offen, '2026-10-01-frage.md'), '---\ntyp: offen\nstatus: offen\n---\n\n# Frage\n');
    fs.writeFileSync(path.join(offen, '2026-10-01-fertig.md'), '---\ntyp: offen\nstatus: erledigt\naufgabe: true\nnaechster-schritt: "nichts"\n---\n\n# Fertig\n');
    const r = hook(env, 'start', { cwd: vor(path.join(env.projekte, 'demo-app')), session_id: 'abcdef12-0000' });
    assert.equal(r.status, 0, r.stderr);
    const kontext = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(kontext, /Offene Aufgaben \(1,[^)]*\):\n- 2026-10-01-umbau → Migration 3 ausführen/);
    assert.match(kontext, /2026-10-01-frage/);
    assert.doesNotMatch(kontext, /2026-10-01-fertig/, 'erledigte Aufgabe wird nicht gezeigt');
    assert.ok(kontext.indexOf('Offene Aufgaben') < kontext.indexOf('2026-10-01-frage'), 'Aufgaben zuerst');
  } finally { aufraeumen(env); }
});

test('Git-Sicherung: kein Repo, Initialisierung, Commit, unveränderter Stand, Sperre, Ignore-Regeln', () => {
  const env = umgebung();
  try {
    const skripte = path.join(env.vault, '_meta', 'skripte');
    fs.mkdirSync(skripte, { recursive: true });
    fs.copyFileSync(path.join(KIT, 'kit', '_meta', 'skripte', 'sitzung-lib.js'), path.join(skripte, 'sitzung-lib.js'));
    const lib = require(path.join(skripte, 'sitzung-lib.js'));
    const { createBackup } = require(path.join(KIT, 'kit', '_meta', 'skripte', 'vault-sicherung.js'));
    const sichern = createBackup(env.vault, lib);
    assert.equal(sichern().fehler, 'KEIN_REPOSITORY');
    fs.writeFileSync(path.join(env.vault, 'notiz.md'), 'Erster Stand');
    const r = sichern('Brain: Test', true);
    assert.equal(r.ok, true, r.meldung);
    assert.ok(r.commit);
    assert.ok(fs.existsSync(path.join(env.vault, '.gitignore')));
    assert.equal(sichern().unveraendert, true);
    fs.writeFileSync(path.join(env.vault, 'notiz.md'), 'Zweiter Stand');
    assert.ok(sichern().commit, 'Folgecommit');
    const frei = lib.sperre('git-sicherung', 10);
    assert.ok(frei);
    assert.equal(sichern().uebersprungen, 'Sperre belegt');
    frei();
    const dateien = spawnSync('git', ['-C', env.vault, 'ls-files'], { encoding: 'utf8', windowsHide: true });
    assert.equal(dateien.status, 0);
    assert.doesNotMatch(dateien.stdout, /_meta\/(state|logs)\//);
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

test('Sitzungen in ausgenommenen Ordnern (private, .claude) landen nie im Vault', () => {
  const env = umgebung();
  try {
    installieren(env);
    for (const ordner of ['private', '.claude']) {
      const v = verlauf(env, ordner);
      const r = hook(env, 'end', { cwd: v.cwd, session_id: `ausgenom-${ordner.length}`, transcript_path: v.datei });
      assert.equal(r.status, 0, r.stderr);
    }
    const alleDateien = [];
    (function lauf(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '.git') lauf(p); } else alleDateien.push(p); } })(env.vault);
    assert.deepEqual(alleDateien.filter(f => /sitzungen-roh/.test(f)), [], 'keine Rohdatei');
    const log = fs.readFileSync(path.join(env.vault, '_meta', 'logs', 'automation.log.jsonl'), 'utf8');
    assert.equal((log.match(/"grund":"ausgenommen"/g) || []).length, 2);
  } finally { aufraeumen(env); }
});

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

test('Repo-Stand: Struktur, Doku, Abhängigkeiten; fällig erst ab 5 neuen Commits; Doku-Spiegel nur mit Schalter', () => {
  const env = umgebung();
  try {
    installieren(env);
    const repo = path.join(env.projekte, 'demo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'x' }, dependencies: { express: '1' } }));
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo');
    const g = (...a) => assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).status, 0);
    spawnSync('git', ['init', '-q', repo]);
    g('add', '-A'); g('commit', '-qm', 'start');
    fs.mkdirSync(path.join(env.vault, 'projekte', 'demo'), { recursive: true });
    const stand = path.join(env.vault, 'projekte', 'demo', 'generiert', 'repo-stand.md');
    const faellig = path.join(env.vault, '_meta', 'generiert', 'kuration-faellig.md');

    let r = skript(env, 'sync-projekte.js');
    assert.equal(r.status, 0, r.stderr);
    let t = fs.readFileSync(stand, 'utf8');
    assert.match(t, /Abhängigkeiten \(package\.json\)/);
    assert.match(t, /`express`/);
    assert.match(t, /`README\.md`/);
    assert.match(t, /`src\/`/);
    assert.ok(!t.includes(env.wurzel) && !t.includes(env.wurzel.split(path.sep).join('/')), 'kein absoluter Pfad im Repo-Stand');
    assert.ok(!fs.existsSync(path.join(env.vault, 'projekte', 'demo', 'generiert', 'repo-docs')), 'Spiegel ist standardmäßig aus');
    assert.ok(!/\| demo \|/.test(fs.readFileSync(faellig, 'utf8')), 'Ausgangsstand: nichts fällig');

    for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(repo, 'src', 'f' + i + '.txt'), String(i)); g('add', '-A'); g('commit', '-qm', 'c' + i); }
    r = skript(env, 'sync-projekte.js');
    assert.match(fs.readFileSync(faellig, 'utf8'), /\| demo \| 5 \|/);
    assert.match(fs.readFileSync(stand, 'utf8'), /Seit der letzten Kuration/);

    r = skript(env, 'sync-projekte.js', ['--mark', 'demo']);
    assert.match(r.stdout, /Markierung/);
    skript(env, 'sync-projekte.js');
    assert.ok(!/\| demo \|/.test(fs.readFileSync(faellig, 'utf8')), 'nach --mark nicht mehr fällig');

    const cfgDatei = path.join(env.vault, '_meta', 'brain.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgDatei, 'utf8'));
    fs.writeFileSync(cfgDatei, JSON.stringify({ ...cfg, repoDokuSpiegeln: true }));
    skript(env, 'sync-projekte.js');
    const spiegel = path.join(env.vault, 'projekte', 'demo', 'generiert', 'repo-docs', 'README.md');
    assert.match(fs.readFileSync(spiegel, 'utf8'), /generiert: true[\s\S]*# Demo/);
    fs.writeFileSync(cfgDatei, JSON.stringify({ ...cfg, repoDokuSpiegeln: true, repoDokuOhneProjekte: ['demo'] }));
    fs.rmSync(path.join(env.vault, 'projekte', 'demo', 'generiert', 'repo-docs'), { recursive: true, force: true });
    skript(env, 'sync-projekte.js');
    assert.ok(!fs.existsSync(spiegel), 'repoDokuOhneProjekte schließt das Projekt aus');
  } finally { aufraeumen(env); }
});

test('Auggie: ohne Terminal keine Rückfrage, --auggie trägt ein (idempotent, Fremdes bleibt), Diagnose, Deinstallation', () => {
  const env = umgebung();
  try {
    installieren(env);
    assert.ok(!fs.existsSync(env.auggie), 'ohne --auggie und ohne Terminal wird Auggie nicht angefasst');
    fs.mkdirSync(path.dirname(env.auggie), { recursive: true });
    fs.writeFileSync(env.auggie, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fremd.cmd', timeout: 1 }] }] } }));
    installieren(env, '--auggie');
    const lesen = () => JSON.parse(fs.readFileSync(env.auggie, 'utf8'));
    let a = lesen();
    assert.equal(a.model, 'x');
    assert.deepEqual(Object.keys(a.hooks).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop']);
    assert.equal(a.hooks.Stop.length, 2, 'fremder Stop-Hook bleibt neben dem Brain-Hook');
    const stopBrain = a.hooks.Stop.find(g => g.hooks.some(h => /hook-vault-auggie\.cmd/.test(h.command)));
    assert.equal(stopBrain.metadata.includeConversationData, true);
    assert.match(a.hooks.PostToolUse[0].matcher, /save-file/);
    const vorher = fs.readFileSync(env.auggie, 'utf8');
    installieren(env, '--auggie');
    assert.equal(fs.readFileSync(env.auggie, 'utf8'), vorher, 'zweite Installation ändert nichts');
    const d = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--pruefen', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie], { encoding: 'utf8' });
    assert.match(d.stdout, /OK\s+Auggie-Hooks \(4 von 4/);
    const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--deinstallieren', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    a = lesen();
    assert.equal(a.model, 'x');
    assert.deepEqual(Object.keys(a.hooks), ['Stop']);
    assert.equal(a.hooks.Stop[0].hooks[0].command, 'fremd.cmd');
  } finally { aufraeumen(env); }
});

test('Auggie-Hooks: Start liefert den Kontext, Sitzungsende sichert geschwärzt, Automatisierung bleibt stumm', () => {
  const env = umgebung();
  try {
    installieren(env);
    const repo = path.join(env.projekte, 'demo');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(env.vault, 'projekte', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(env.vault, 'projekte', 'demo', '_index.md'), '# Demo-Index Kennwort-Test');
    const auggie = (eingabe, extraEnv = {}) => skript(env, 'hook-vault-auggie.js', [], { input: JSON.stringify(eingabe), env: { ...process.env, ...extraEnv } });
    const cid = 'conv-abc12345-xyz';
    const start = auggie({ hook_event_name: 'SessionStart', conversation_id: cid, workspace_roots: [repo] });
    assert.equal(start.status, 0, start.stderr);
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /Demo-Index Kennwort-Test/);
    assert.equal(auggie({ hook_event_name: 'SessionStart', conversation_id: cid, workspace_roots: [repo] }, { BRAIN_AUTOMATION: '1' }).stdout, '');
    for (const n of [1, 2]) {
      auggie({ hook_event_name: 'Stop', conversation_id: cid, workspace_roots: [repo], conversation: { timestamp: `2026-10-09T10:0${n}:00Z`, userPrompt: `Frage ${n} password: hunter2hunter2`, agentTextResponse: `Antwort ${n}`, agentCodeResponse: [] } });
    }
    auggie({ hook_event_name: 'SessionEnd', conversation_id: cid, workspace_roots: [repo] });
    const roh = path.join(env.vault, 'projekte', 'demo', 'generiert', 'sitzungen-roh', '2026-10-09-abc12345.txt');
    assert.ok(fs.existsSync(roh), 'Rohdatei wurde geschrieben');
    const t = fs.readFileSync(roh, 'utf8');
    assert.match(t, /NUTZER[\s\S]*Frage 2[\s\S]*AUGGIE[\s\S]*Antwort 2/);
    assert.ok(!t.includes('hunter2hunter2'), 'Geheimnis ist geschwärzt');
    // Ausgenommener Ordner: nichts sichern
    const privat = path.join(env.projekte, 'private', 'x');
    fs.mkdirSync(privat, { recursive: true });
    for (const n of [1, 2]) auggie({ hook_event_name: 'Stop', conversation_id: 'conv-priv0000', workspace_roots: [privat], conversation: { timestamp: `2026-10-09T11:0${n}:00Z`, userPrompt: `geheim ${n}`, agentTextResponse: 'ok', agentCodeResponse: [] } });
    auggie({ hook_event_name: 'SessionEnd', conversation_id: 'conv-priv0000', workspace_roots: [privat] });
    assert.ok(!fs.existsSync(path.join(env.vault, 'projekte', 'private')), 'ausgenommene Ordner landen nicht im Vault');
  } finally { aufraeumen(env); }
});

test('Arbeitsweise-Review: modellbasierte Fassung über reviewModus, geschwärzt, ausgenommene Ordner bleiben draußen', () => {
  const env = umgebung();
  try {
    installieren(env);
    const cfgDatei = path.join(env.vault, '_meta', 'brain.config.json');
    fs.writeFileSync(cfgDatei, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgDatei, 'utf8')), reviewModus: 'modell' }));
    const kodiert = p => p.replace(/[^A-Za-z0-9]/g, '-');
    const transkripte = path.join(env.wurzel, '.claude', 'projects');
    const sitzung = (ordner, texte) => {
      fs.mkdirSync(path.join(transkripte, ordner), { recursive: true });
      fs.writeFileSync(path.join(transkripte, ordner, 'abcdef12-0000.jsonl'), texte.map(t => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: t } })).join('\n'));
    };
    sitzung(kodiert(env.projekte) + '-demo', ['ich hatte gesagt, nicht fragen', 'token: abcdefghijk12345 bitte nutzen']);
    sitzung(kodiert(env.projekte) + '-private', ['darf nie im Review auftauchen']);
    const lauf = (...a) => skript(env, 'arbeitsweise-review.js', a, { env: { ...process.env, USERPROFILE: env.wurzel, HOME: env.wurzel } });
    let r = lauf('--nur-extraktion');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 Nachrichten/);
    const nachrichten = fs.readdirSync(path.join(env.vault, '_meta', 'generiert', 'arbeitsweise')).find(f => f.endsWith('-nachrichten.md'));
    const t = fs.readFileSync(path.join(env.vault, '_meta', 'generiert', 'arbeitsweise', nachrichten), 'utf8');
    assert.match(t, /## demo abcdef12/);
    assert.match(t, /nicht fragen/);
    assert.ok(!t.includes('darf nie im Review'), 'private Sitzung wird nicht gelesen');
    assert.ok(!t.includes('abcdefghijk12345'), 'Geheimnis ist geschwärzt');
    // Ohne Argumente (so ruft der Start-Hook auf) gilt --faellig: erster Lauf setzt nur den Ausgangspunkt
    r = lauf();
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(fs.readFileSync(path.join(env.vault, '_meta', 'state', 'arbeitsweise.json'), 'utf8'));
    assert.ok(st.letzter, 'Ausgangspunkt gesetzt');
    assert.equal(st.notiz, undefined, 'noch kein Review erzeugt');
  } finally { aufraeumen(env); }
});

test('Diagnose läuft durch', () => {
  const env = umgebung();
  try {
    installieren(env);
    const r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), '--pruefen', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK\s+Hooks in settings\.json \(4 von 4/);
    assert.match(r.stdout, /OK\s+Arbeitsanweisung/);
  } finally { aufraeumen(env); }
});

test('Diagnose akzeptiert die Arbeitsanweisung in den Auggie-Regeln', () => {
  const env = umgebung();
  try {
    installieren(env, '--ohne-claude-md');
    const args = ['--pruefen', '--vault', env.vault, '--settings', env.settings, '--claude-md', env.md, '--auggie-settings', env.auggie];
    let r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), ...args], { encoding: 'utf8' });
    assert.match(r.stdout, /FEHLT\s+Arbeitsanweisung/);
    const regel = path.join(path.dirname(env.auggie), 'rules', 'brain.md');
    fs.mkdirSync(path.dirname(regel), { recursive: true });
    fs.writeFileSync(regel, `Vault ${env.vault.replace(/\\/g, '/')}\n`);
    r = spawnSync(process.execPath, [path.join(KIT, 'installieren.js'), ...args], { encoding: 'utf8' });
    assert.match(r.stdout, /OK\s+Arbeitsanweisung in den Auggie-Regeln/);
  } finally { aufraeumen(env); }
});
