#!/usr/bin/env node
// Sichert rückwirkend alle Claude-Code-Sitzungen dieses Rechners als Rohverlauf im Vault
// (gleiches Format und gleicher Ablageort wie der SessionEnd-Hook: projekte/<p>/generiert/sitzungen-roh/JJJJ-MM-TT-<id8>.txt).
// Standard ist ein Probelauf (zeigt nur, was passieren würde). Mit --ausfuehren wird geschrieben.
//
//   node sitzungen-extrahieren.js [--projekt X] [--ueberschreiben] [--ausfuehren]
//
// Regeln:
//   - Quelle: ~/.claude/projects/<ordner>/<sitzung>.jsonl (nur Hauptverläufe, keine Subagenten).
//   - Projektzuordnung über das Arbeitsverzeichnis der Sitzung wie beim Hook; ohne Projekt nach _meta/generiert/sitzungen-roh/.
//   - Sitzungen mit weniger als 2 Nutzernachrichten werden übersprungen (wie beim Hook).
//   - Vorhandene Rohdateien bleiben unverändert, außer mit --ueberschreiben.
// Protokoll: _meta/logs/automation.log.jsonl (quelle "extrahieren"). Bricht nie mit Fehler ab (Exit-Code 0).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { VAULT, condense, rohZiel, istAusgenommen } = require('./sitzung-lib');

const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const QUELLE = path.join(os.homedir(), '.claude', 'projects');

const args = process.argv.slice(2);
const wert = k => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const nurProjekt = wert('--projekt');
const ausfuehren = args.includes('--ausfuehren');
const ueberschreiben = args.includes('--ueberschreiben');

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'extrahieren', event, ...data }) + '\n');
  } catch { /* Logging darf nie stören */ }
}

function main() {
  let ordner;
  try { ordner = fs.readdirSync(QUELLE, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { console.log(`Kein Sitzungsordner gefunden: ${QUELLE}`); return; }

  const lauf = new Date().toISOString();
  const stat = { geschrieben: 0, vorhanden: 0, zuKurz: 0, unlesbar: 0, ausgenommen: 0 };
  const jeProjekt = {};
  for (const o of ordner) {
    const dateien = fs.readdirSync(path.join(QUELLE, o)).filter(f => f.endsWith('.jsonl'));
    for (const f of dateien) {
      const id = f.replace(/\.jsonl$/, '');
      const c = condense(path.join(QUELLE, o, f), id);
      if (!c) { stat.unlesbar++; continue; }
      if (istAusgenommen(c.cwd)) { stat.ausgenommen++; continue; } // private/.claude: nichts im Vault ablegen
      if (c.users < 2) { stat.zuKurz++; continue; }
      const { projekt, dir, name } = rohZiel(c);
      if (nurProjekt && projekt !== nurProjekt) continue;
      const ziel = path.join(dir, name);
      const key = projekt || '(ohne Projekt)';
      jeProjekt[key] = jeProjekt[key] || { neu: 0, vorhanden: 0 };
      if (fs.existsSync(ziel) && !ueberschreiben) { stat.vorhanden++; jeProjekt[key].vorhanden++; continue; }
      jeProjekt[key].neu++;
      stat.geschrieben++;
      if (!ausfuehren) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ziel, c.text, 'utf8');
      log('sitzung_gesichert', { lauf, projekt, sitzung: id.slice(0, 8), nutzernachrichten: c.users, bytes: Buffer.byteLength(c.text) });
    }
  }

  console.log(ausfuehren ? 'Geschrieben:' : 'Probelauf (mit --ausfuehren schreiben):');
  for (const [p, z] of Object.entries(jeProjekt).sort()) console.log(`  ${p}: ${z.neu} neu, ${z.vorhanden} schon vorhanden`);
  console.log(`Summe: ${stat.geschrieben} neu, ${stat.vorhanden} vorhanden, ${stat.zuKurz} zu kurz, ${stat.unlesbar} unlesbar, ${stat.ausgenommen} ausgenommen`);
  log('extrahieren_lauf', { lauf, ausgefuehrt: ausfuehren, projekt: nurProjekt, ...stat });
}

try { main(); } catch (err) { log('extrahieren_fehler', { meldung: String(err && err.message || err) }); console.error(String(err)); }
