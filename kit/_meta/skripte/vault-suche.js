#!/usr/bin/env node
// Gezielte Suche im Vault für Claude: liefert nur Treffer mit Typ, Status, Datum, Titel, Kurzfassung und Fundstelle,
// ohne generiert/, archiv/ und Sitzungsnotizen (Standard). Spart Lesevorgänge gegenüber Grep über den ganzen Vault.
//
//   node vault-suche.js <begriff> [<begriff> ...] [Optionen]
//   node vault-suche.js --gueltig [--projekt X]        alle gültigen Entscheidungen (Datum, Titel, Kurzfassung, Pfad)
//   node vault-suche.js --themen                       Themenvokabular mit Häufigkeit
//   node vault-suche.js --thema X [<begriff> ...]      Notizen zu einem Themenbegriff
//   node vault-suche.js --kette <begriff>              Ersetzungskette der am besten passenden Notiz (alt → neu)
//   node vault-suche.js --verweise <notizname|begriff> Rückverweise: welche Notizen verlinken (oder lösen ab) diese Notiz (--alle für alle Projekte)
//
// Jeder Aufruf wird nach _meta/logs/vault-suche.log.jsonl protokolliert (Begriffe, Treffer, Dauer); der Arbeitsweise-Review wertet das aus.
//
// Optionen:
//   --projekt X        Projektordner unter projekte/ (Standard: aus dem aktuellen Ordner abgeleitet)
//   --alle             alle Projekte durchsuchen
//   --typ T            nur entscheidung | erkenntnis | offen | lauf | sitzung (sitzung wird sonst übersprungen)
//   --auch-ersetzte    auch Notizen mit Status ersetzt/verworfen/veraltet (mit Hinweis auf den gültigen Nachfolger)
//   --archiv           auch archivierte Notizen (projekte/<p>/archiv/) durchsuchen
//   -n N               höchstens N Treffer (Standard 10)
// Alle Begriffe müssen vorkommen (UND); gibt es so keinen Treffer, wird mit ODER gesucht.
// Vault-Ort: Umgebungsvariable WISSEN_VAULT, sonst zwei Ordner über diesem Skript.

const fs = require('fs');
const path = require('path');

const VAULT = process.env.WISSEN_VAULT || path.resolve(__dirname, '..', '..');
const ORDNER = { entscheidung: 'entscheidungen', erkenntnis: 'erkenntnisse', offen: 'offen', lauf: 'läufe', sitzung: 'sitzungen' };

const args = process.argv.slice(2);
const opt = { n: 10, begriffe: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--projekt') opt.projekt = args[++i];
  else if (a === '--alle') opt.alle = true;
  else if (a === '--typ') opt.typ = args[++i];
  else if (a === '--auch-ersetzte') opt.ersetzte = true;
  else if (a === '--archiv') opt.archiv = true;
  else if (a === '--gueltig') opt.gueltig = true;
  else if (a === '--kette') opt.kette = true;
  else if (a === '--verweise') opt.verweise = true;
  else if (a === '--themen') opt.themenListe = true;
  else if (a === '--thema') opt.thema = (args[++i] || '').toLowerCase();
  else if (a === '-n') opt.n = Number(args[++i]) || 10;
  else opt.begriffe.push(a.toLowerCase());
}

const kebab = d => d.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
function projektAusCwd() {
  const m = process.cwd().replace(/\\/g, '/').match(/\/projects\/([^/]+)/i);
  const name = m && kebab(m[1]);
  return name && fs.existsSync(path.join(VAULT, 'projekte', name)) ? name : null;
}

function dateien(dir, out = []) {
  let eintraege; try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of eintraege) {
    if (e.name === 'generiert' || (e.name === 'archiv' && !opt.archiv) || e.name.startsWith('.')) continue;
    const voll = path.join(dir, e.name);
    if (e.isDirectory()) dateien(voll, out);
    else if (e.name.endsWith('.md') && !e.name.startsWith('_')) out.push(voll);
  }
  return out;
}

function lies(f) {
  const text = fs.readFileSync(f, 'utf8');
  const kopf = {};
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = text.slice(m[0].length);
    for (const z of m[1].split(/\r?\n/)) { const k = z.match(/^([\wäöüß]+):\s*(.*)$/); if (k) kopf[k[1]] = k[2].trim().replace(/^"(.*)"$/, '$1'); }
  }
  const titel = (body.match(/^#\s+(.+)$/m) || [])[1] || path.basename(f, '.md');
  return { kopf, body, titel };
}

const rel = f => path.relative(VAULT, f).replace(/\\/g, '/');
const projekt = opt.alle ? null : (opt.projekt || projektAusCwd());

// Protokoll jedes Aufrufs (angehängt, ohne Notizinhalte), damit sich verfehlte Suchen später auswerten lassen.
const T0 = Date.now();
function logge(modus, treffer, extra) {
  try {
    const dir = path.join(VAULT, '_meta', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'vault-suche.log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), quelle: process.env.VAULT_SUCHE_QUELLE || 'claude', projekt: projekt || 'alle', modus, begriffe: opt.begriffe, thema: opt.thema, typ: opt.typ, treffer, dauerMs: Date.now() - T0, ...extra }) + '\n');
  } catch { /* Logging darf die Suche nie stören */ }
}

// Suchwurzeln: Projekt (oder alle Projekte), global, projektübergreifend
const wurzeln = [];
if (opt.alle || !projekt) wurzeln.push(path.join(VAULT, 'projekte'));
else wurzeln.push(path.join(VAULT, 'projekte', projekt));
wurzeln.push(path.join(VAULT, '_global'), path.join(VAULT, '_cross-project'));

function typVon(r) {
  const t = Object.keys(ORDNER).find(k => r.includes('/' + ORDNER[k] + '/'));
  if (t === 'sitzung' && opt.typ !== 'sitzung') return null;
  if (opt.typ && t !== opt.typ && !(t === undefined && opt.typ === 'global')) return null;
  return t || 'global';
}

// alle Notizen laden (auch ersetzte, für die Ersetzungsketten)
const linkName = s => (String(s || '').match(/\[\[([^\]|#]+)/) || [])[1]?.split('/').pop().trim().toLowerCase() || '';
const alle = [];
for (const w of wurzeln) {
  for (const f of dateien(w)) {
    const r = rel(f);
    const typ = typVon(r);
    if (!typ) continue;
    let n; try { n = lies(f); } catch { continue; }
    const themen = (n.kopf.themen || '').replace(/^\[|\]$/g, '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    alle.push({ r, typ, status: n.kopf.status || '', kurz: n.kopf.kurz || '', themen, vorgaenger: linkName(n.kopf.ersetzt), datum: n.kopf.datum || r.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '', titel: n.titel, body: n.body, links: [...n.body.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].split('/').pop().trim().toLowerCase()), name: path.basename(f, '.md').toLowerCase() });
  }
}
const nachName = new Map(alle.map(e => [e.name, e]));
const nachfolger = new Map(); // name der alten Notiz -> neue Notiz (die sie per ersetzt: ablöst)
for (const e of alle) if (e.vorgaenger && nachName.has(e.vorgaenger)) nachfolger.set(e.vorgaenger, e);
function endstand(e) { // folgt der Kette bis zur neuesten Notiz (mit Schutz vor Zyklen)
  const gesehen = new Set([e.name]);
  let x = e;
  while (nachfolger.has(x.name) && !gesehen.has(nachfolger.get(x.name).name)) { x = nachfolger.get(x.name); gesehen.add(x.name); }
  return x;
}
const eintraege = alle.filter(e => opt.ersetzte || !/ersetzt|verworfen|veraltet/.test(e.status));

if (opt.themenListe) {
  logge('themen', null);
  const z = {};
  for (const e of eintraege) for (const t of e.themen) z[t] = (z[t] || 0) + 1;
  const l = Object.entries(z).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`${l.length} Themen${projekt ? ' in ' + projekt + ' (und global)' : ''}: ` + l.map(([t, n]) => `${t} (${n})`).join(', '));
  process.exit(0);
}
if (opt.thema) {
  logge('thema', null);
  const l =eintraege.filter(e => e.themen.includes(opt.thema)).sort((a, b) => b.datum.localeCompare(a.datum));
  if (!opt.begriffe.length) {
    console.log(`${l.length} Notizen zum Thema ${opt.thema}:`);
    for (const e of l) console.log(`- [${e.typ}] ${e.datum} ${e.titel.slice(0, 120)}${e.kurz ? ' — ' + e.kurz : ''}\n  ${e.r}`);
    process.exit(0);
  }
  eintraege.splice(0, eintraege.length, ...l);
}
if (opt.gueltig) {
  logge('gueltig', null);
  const liste = eintraege.filter(e => e.typ === 'entscheidung' && /gültig/.test(e.status)).sort((a, b) => b.datum.localeCompare(a.datum));
  console.log(`${liste.length} gültige Entscheidungen${projekt ? ' in ' + projekt : ''}:`);
  for (const e of liste) console.log(`${e.datum}  ${e.titel.slice(0, 150)}${e.kurz ? ' — ' + e.kurz : ''}${e.vorgaenger ? ' (löst ab: ' + e.vorgaenger + ')' : ''}  [${e.r}]`);
  process.exit(0);
}
if (!opt.begriffe.length) { console.error('Aufruf: vault-suche.js <begriff> [...] [--projekt X] [--alle] [--typ T] [--thema T] [-n N] | --gueltig | --themen | --kette <begriff>'); process.exit(2); }

function bewerte(e, begriffe) {
  const titel = e.titel.toLowerCase(), body = e.body.toLowerCase();
  const ueberschriften = (body.match(/^#{2,4} .*$/gm) || []).join('\n');
  let score = 0, gefunden = 0;
  for (const b of begriffe) {
    let s = 0;
    if (titel.includes(b)) s += 5;
    if (e.themen.some(t => t.includes(b))) s += 4;
    if (e.kurz && e.kurz.toLowerCase().includes(b)) s += 2;
    if (e.name.includes(b)) s += 3;
    if (ueberschriften.includes(b)) s += 2;
    const m = body.split(b).length - 1;
    s += Math.min(m, 5);
    if (s) gefunden++;
    score += s;
  }
  return { score, gefunden };
}

function suche(menge, modus) {
  return menge.map(e => ({ e, ...bewerte(e, opt.begriffe) }))
    .filter(x => (modus === 'und' ? x.gefunden === opt.begriffe.length : x.gefunden > 0))
    .sort((a, b) => b.score - a.score || b.e.datum.localeCompare(a.e.datum));
}

// --kette: beste Notiz unter allen (auch ersetzten), dann Kette rückwärts und vorwärts ausgeben
if (opt.kette) {
  const menge = alle.filter(e => e.typ === 'entscheidung' || e.typ === 'erkenntnis' || e.typ === 'global');
  let res = suche(menge, 'und'); if (!res.length) res = suche(menge, 'oder');
  logge('kette', res.length);
  if (!res.length) { console.log('Keine Notiz gefunden.'); process.exit(0); }
  let start = res[0].e;
  const gesehen = new Set([start.name]);
  while (start.vorgaenger && nachName.has(start.vorgaenger) && !gesehen.has(start.vorgaenger)) { start = nachName.get(start.vorgaenger); gesehen.add(start.name); }
  const kette = [start];
  const g2 = new Set([start.name]);
  while (nachfolger.has(kette[kette.length - 1].name) && !g2.has(nachfolger.get(kette[kette.length - 1].name).name)) { const n = nachfolger.get(kette[kette.length - 1].name); kette.push(n); g2.add(n.name); }
  console.log(`Kette (${kette.length}), alt → neu:`);
  for (const e of kette) console.log(`- ${e.datum} [${e.status || '?'}] ${e.titel.slice(0, 120)}${e.kurz ? ' — ' + e.kurz : ''}\n  ${e.r}`);
  process.exit(0);
}

// --verweise: Rückverweise auf die Notiz (Dateiname ohne .md oder bester Treffer): wer verlinkt sie per [[...]] oder löst sie per ersetzt: ab
if (opt.verweise) {
  let treffer = suche(alle, 'und'); if (!treffer.length) treffer = suche(alle, 'oder');
  const ziel = alle.find(e => e.name === opt.begriffe.join('-')) || alle.find(e => e.name === opt.begriffe[0]) || (treffer[0] && treffer[0].e);
  if (!ziel) { logge('verweise', 0); console.log('Keine Notiz gefunden.'); process.exit(0); }
  const von = alle.filter(e => e !== ziel && (e.links.includes(ziel.name) || e.vorgaenger === ziel.name)).sort((a, b) => b.datum.localeCompare(a.datum));
  logge('verweise', von.length, { ziel: ziel.r });
  console.log(`${von.length} Rückverweise auf ${ziel.r}${projekt ? ' (Projekt ' + projekt + '; --alle für alle Projekte)' : ''}:`);
  for (const e of von.slice(0, opt.n * 3)) console.log(`- [${e.typ}${e.status ? '/' + e.status : ''}] ${e.datum} ${e.titel.slice(0, 120)}\n  ${e.r}`);
  process.exit(0);
}

let res = suche(eintraege, 'und'), modus = 'UND';
if (!res.length) { res = suche(eintraege, 'oder'); modus = 'ODER'; }

logge('suche', res.length, { verknuepfung: modus, top: res.slice(0, 3).map(x => x.e.r) });
console.log(`${res.length} Treffer (${modus}${projekt ? ', Projekt ' + projekt : ', alle Projekte'}), zeige ${Math.min(opt.n, res.length)}:`);
for (const { e, score } of res.slice(0, opt.n)) {
  const zeile = e.body.split(/\r?\n/).find(z => opt.begriffe.some(b => z.toLowerCase().includes(b)) && !z.startsWith('#')) || '';
  const hinweis = e.kurz || zeile.trim().slice(0, 160);
  const ende = /ersetzt/.test(e.status) ? endstand(e) : null;
  const zusatz = ende && ende !== e ? `\n  → ersetzt durch: ${ende.r}` : (e.vorgaenger ? ` (löst ab: ${e.vorgaenger})` : '');
  console.log(`- [${e.typ}${e.status ? '/' + e.status : ''}] ${e.datum} ${e.titel.slice(0, 120)} (${score})\n  ${e.r}${e.themen.length ? ' {' + e.themen.join(', ') + '}' : ''}${hinweis ? '\n  > ' + hinweis : ''}${zusatz}`);
}
