#!/usr/bin/env node
// Sichert Antigravity-Chats als Rohverlauf im Vault (gleiches Format und gleicher Ablageort wie sitzungen-extrahieren.js:
// projekte/<p>/generiert/sitzungen-roh/JJJJ-MM-TT-<id8>.txt). Die Verdichtung (sitzungen-verdichten.js) nimmt sie dann mit auf.
// Standard ist ein Probelauf. Mit --ausfuehren wird geschrieben.
//
//   node antigravity-extrahieren.js [--projekt X] [--ueberschreiben] [--ausfuehren]
//
// Quelle: ~/.gemini/antigravity-ide/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
//         (Fallback transcript.jsonl, wenn es keine _full-Datei gibt).
// Regeln wie bei Claude-Sitzungen: Schwärzung über sitzung-lib.redact, private/.claude ausgenommen,
// weniger als 2 Nutzernachrichten werden übersprungen, vorhandene Rohdateien bleiben (außer --ueberschreiben).
// Projekt: Cwd der Werkzeugaufrufe, sonst das aktive Dokument aus den Metadaten der Nutzernachricht.
// Protokoll: _meta/logs/automation.log.jsonl (quelle "antigravity"). Bricht nie mit Fehler ab (Exit-Code 0).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { VAULT, redact, rohZiel, istAusgenommen, schreibeAtomar } = require('./sitzung-lib');

const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const QUELLE = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');

const args = process.argv.slice(2);
const wert = k => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const nurProjekt = wert('--projekt');
const ausfuehren = args.includes('--ausfuehren');
const ueberschreiben = args.includes('--ueberschreiben');

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'antigravity', event, ...data }) + '\n');
  } catch { /* Logging darf nie stören */ }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' […]' : s);
// In transcript.jsonl sind Argumente als JSON-Text abgelegt ("\"git status\""), in transcript_full.jsonl direkt.
const argWert = v => { if (typeof v !== 'string') return v == null ? '' : String(v); try { const j = JSON.parse(v); return typeof j === 'string' ? j : v; } catch { return v; } };

function nutzerText(content) {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content || '');
  return (m ? m[1] : String(content || '').replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/, '')).trim();
}

function aktion(tc) {
  const a = tc.args || {};
  const v = argWert(a.CommandLine || a.AbsolutePath || a.TargetFile || a.SearchPath || a.Query || a.Url || a.DirectoryPath || a.toolSummary);
  return `  [Aktion] ${tc.name}${v ? ': ' + clip(v.replace(/\s+/g, ' '), 160) : ''}`;
}

// Liefert { id, text, users, first, last, cwd } oder null, wenn der Verlauf nicht lesbar ist.
function verdichte(file, id) {
  let zeilen;
  try { zeilen = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return null; }
  const buf = [];
  let first = null, last = null, cwd = null, dok = null, users = 0;
  for (const z of zeilen) {
    let e; try { e = JSON.parse(z); } catch { continue; }
    if (e.created_at) { first = first || e.created_at; last = e.created_at; }
    const ts = (e.created_at || '').slice(11, 16);
    if (e.type === 'USER_INPUT') {
      const d = /Active Document: (\S+)/.exec(e.content || '');
      if (d) dok = d[1];
      const t = nutzerText(e.content);
      if (t) { buf.push(`\n### NUTZER ${ts}\n${clip(t, 4000)}`); users++; }
    } else if (e.type === 'PLANNER_RESPONSE') {
      if (e.content && e.content.trim()) buf.push(`\n### ANTIGRAVITY ${ts}\n${clip(e.content.trim(), 3500)}`);
      for (const tc of e.tool_calls || []) {
        const c = argWert((tc.args || {}).Cwd);
        if (c) cwd = c;
        buf.push(aktion(tc));
      }
    }
  }
  cwd = cwd || (dok ? path.dirname(dok.replace(/\\/g, '/')) : null);
  const text = `# Sitzung ${id}\nQuelle: Antigravity\nArbeitsverzeichnis: ${cwd}\nZeitraum: ${first} – ${last}\n` + redact(buf.join('\n'));
  return { id, text, users, first, last, cwd };
}

function main() {
  let ordner;
  try { ordner = fs.readdirSync(QUELLE, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { console.log(`Kein Antigravity-Ordner gefunden: ${QUELLE}`); return; }

  const lauf = new Date().toISOString();
  const stat = { geschrieben: 0, vorhanden: 0, zuKurz: 0, unlesbar: 0, ausgenommen: 0 };
  const jeProjekt = {};
  for (const id of ordner) {
    const dir = path.join(QUELLE, id, '.system_generated', 'logs');
    const datei = ['transcript_full.jsonl', 'transcript.jsonl'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (!datei) { stat.unlesbar++; continue; }
    const c = verdichte(datei, id);
    if (!c) { stat.unlesbar++; continue; }
    if (istAusgenommen(c.cwd)) { stat.ausgenommen++; continue; }
    if (c.users < 2) { stat.zuKurz++; continue; }
    const { projekt, dir: zielDir, name } = rohZiel(c);
    if (nurProjekt && projekt !== nurProjekt) continue;
    const ziel = path.join(zielDir, name);
    const key = projekt || '(ohne Projekt)';
    jeProjekt[key] = jeProjekt[key] || { neu: 0, vorhanden: 0 };
    if (fs.existsSync(ziel) && !ueberschreiben) { stat.vorhanden++; jeProjekt[key].vorhanden++; continue; }
    jeProjekt[key].neu++;
    stat.geschrieben++;
    if (!ausfuehren) continue;
    schreibeAtomar(ziel, c.text);
    log('sitzung_gesichert', { lauf, projekt, sitzung: id.slice(0, 8), nutzernachrichten: c.users, bytes: Buffer.byteLength(c.text) });
  }

  console.log(ausfuehren ? 'Geschrieben:' : 'Probelauf (mit --ausfuehren schreiben):');
  for (const [p, z] of Object.entries(jeProjekt).sort()) console.log(`  ${p}: ${z.neu} neu, ${z.vorhanden} schon vorhanden`);
  console.log(`Summe: ${stat.geschrieben} neu, ${stat.vorhanden} vorhanden, ${stat.zuKurz} zu kurz, ${stat.unlesbar} unlesbar, ${stat.ausgenommen} ausgenommen`);
  log('extrahieren_lauf', { lauf, ausgefuehrt: ausfuehren, projekt: nurProjekt, ...stat });
}

try { main(); } catch (err) { log('extrahieren_fehler', { meldung: String(err && err.message || err) }); console.error(String(err)); }
