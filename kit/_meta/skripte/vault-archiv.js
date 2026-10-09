#!/usr/bin/env node
// Archiviert alte Läufe und Sitzungsnotizen: projekte/<p>/{läufe,sitzungen}/x.md -> projekte/<p>/archiv/{läufe,sitzungen}/x.md
// Standard ist ein Probelauf (zeigt nur, was passieren würde). Mit --ausfuehren wird verschoben (nichts wird gelöscht).
//
//   node vault-archiv.js [--tage N] [--projekt X] [--ausfuehren]
//
// Regeln:
//   - Nur Notizen in läufe/ und sitzungen/, deren Datum (Kopf oder Dateiname) älter als N Tage ist (Standard 60,
//     änderbar über "archivTage" in _meta/brain.config.json).
//   - Eine Notiz bleibt aktiv, solange eine aktive Entscheidung/Erkenntnis (Status gültig) oder ein offener Punkt auf sie verweist
//     (sie dient dann als Beleg). Verweise aus Index- und Übersichtsdateien zählen nicht.
//   - Entscheidungen, Erkenntnisse und offene Punkte werden nie archiviert (Entscheidungsketten bleiben vollständig).
//   - Verlinkungen per [[Name]] bleiben gültig, Obsidian und die Prüfung lösen Namen vaultweit auf. Die Suche überspringt archiv/
//     (außer mit --archiv). Rohverläufe unter generiert/ bleiben unberührt.
// Protokoll: _meta/logs/automation.log.jsonl (Ereignis "archiviert"). Bricht nie mit Fehler ab (Exit-Code 0).

const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..');
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')); } catch { return {}; } })();

const args = process.argv.slice(2);
const wert = k => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const tage = Number(wert('--tage')) || cfg.archivTage || 60;
const nurProjekt = wert('--projekt');
const ausfuehren = args.includes('--ausfuehren');
const ARCHIVIERBAR = ['läufe', 'sitzungen'];

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'archiv', event, ...data }) + '\n');
  } catch { /* Logging darf nie stören */ }
}

function kopfUndText(f) {
  const text = fs.readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const kopf = {};
  if (m) for (const z of m[1].split(/\r?\n/)) { const k = z.match(/^([\wäöüß]+):\s*(.*)$/); if (k) kopf[k[1]] = k[2].trim(); }
  return { kopf, text };
}

function md(dir, out = []) {
  let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    const p = path.join(dir, x.name);
    if (x.isDirectory()) { if (x.name !== 'generiert' && x.name !== 'archiv' && !x.name.startsWith('.')) md(p, out); }
    else if (x.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function linkNamen(text) {
  const s = new Set();
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) s.add(m[1].split('/').pop().trim().toLowerCase().replace(/\.md$/, ''));
  return s;
}

try {
  const grenze = new Date(Date.now() - tage * 86400000).toISOString().slice(0, 10);
  const projektDir = path.join(VAULT, 'projekte');
  const projekte = fs.readdirSync(projektDir, { withFileTypes: true }).filter(e => e.isDirectory() && (!nurProjekt || e.name === nurProjekt)).map(e => e.name);
  let verschoben = 0, behalten = 0, kandidaten = 0;

  console.log(`${ausfuehren ? 'Archivierung' : 'Probelauf'}: Notizen in läufe/ und sitzungen/ älter als ${tage} Tage (Datum vor ${grenze}).`);
  for (const p of projekte) {
    const basis = path.join(projektDir, p);
    // Verweise aus aktiven Entscheidungen, Erkenntnissen und offenen Punkten sammeln: Name der Ziele -> Quellen
    const belegt = new Map();
    for (const f of md(basis)) {
      const rel = path.relative(basis, f).replace(/\\/g, '/');
      if (!/^(entscheidungen|erkenntnisse|offen)\//.test(rel) || path.basename(f).startsWith('_')) continue;
      const { kopf, text } = kopfUndText(f);
      if (!/gültig|offen/.test(kopf.status || '')) continue;
      for (const n of linkNamen(text)) { if (!belegt.has(n)) belegt.set(n, []); belegt.get(n).push(path.basename(f, '.md')); }
    }
    for (const ordner of ARCHIVIERBAR) {
      const dir = path.join(basis, ordner);
      let namen; try { namen = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')); } catch { continue; }
      for (const name of namen) {
        const f = path.join(dir, name);
        const { kopf } = kopfUndText(f);
        const datum = (kopf.datum || name.slice(0, 10) || '').replace(/"/g, '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || datum >= grenze) continue;
        kandidaten++;
        const von = belegt.get(name.replace(/\.md$/, '').toLowerCase());
        if (von) { behalten++; console.log(`  bleibt (Beleg für ${von[0]}${von.length > 1 ? ' +' + (von.length - 1) : ''}): ${p}/${ordner}/${name}`); continue; }
        const ziel = path.join(basis, 'archiv', ordner, name);
        console.log(`  ${ausfuehren ? 'verschoben' : 'würde verschieben'}: ${p}/${ordner}/${name} -> archiv/${ordner}/`);
        if (ausfuehren) {
          fs.mkdirSync(path.dirname(ziel), { recursive: true });
          if (fs.existsSync(ziel)) { console.log('  übersprungen (Ziel existiert): ' + ziel); continue; }
          fs.renameSync(f, ziel);
          log('archiviert', { projekt: p, datei: `${ordner}/${name}`, datum, tage });
        }
        verschoben++;
      }
    }
  }
  console.log(`${kandidaten} Kandidaten, ${verschoben} ${ausfuehren ? 'verschoben' : 'zu verschieben'}, ${behalten} als Beleg behalten.`);
  if (ausfuehren) log('archivierung_beendet', { kandidaten, verschoben, behalten, tage });
} catch (err) {
  log('archiv_fehler', { meldung: String(err && err.message || err) });
  console.error('Fehler: ' + (err && err.message || err));
}
