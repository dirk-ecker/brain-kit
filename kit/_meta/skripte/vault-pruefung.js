#!/usr/bin/env node
// Deterministische Prüfung des Vaults (kein LLM, ändert keine Notiz). Schreibt nur:
//   _meta/generiert/vault-pruefung.md   Bericht mit allen Befunden
//   _meta/state/vault-pruefung.json     Zahlen des letzten Laufs (für die Veränderung im Bericht und den Start-Hook)
//   _meta/logs/automation.log.jsonl     Ereignis "vault_pruefung" (angehängt)
// Geprüft wird (siehe _meta/konventionen.md):
//   1. defekte und mehrdeutige [[Links]]
//   2. verwaiste Notizen (handgeschrieben, aber nirgends verlinkt)
//   3. Kopf: typ, status, datum (projekt unter projekte/), erlaubte Werte
//   4. Herkunft: Feld `herkunft` (gemessen | entschieden | hypothese | gelesen), Pflicht bei entscheidung, erkenntnis, lauf
//   5. Entscheidungsketten: `ersetzt:` zeigt auf eine Notiz mit status ersetzt, und jede Notiz mit status ersetzt hat einen Nachfolger
//   6. mögliche Doppelungen (ähnliche Titel im selben Ordner)
// Aufruf: node vault-pruefung.js [--vault <Ordner>] [--no-write]
// Fehler brechen den Sync nie ab: Das Skript endet immer mit Exit-Code 0 und protokolliert den Fehler.

const fs = require('fs');
const path = require('path');
const { schreibeAtomar, sperre, findeGeheimnisse } = require('./sitzung-lib');

// Die _index.md eines Projekts wird bei jedem Sessionstart geladen (Token): Richtwert 4 KB.
const INDEX_MAX_BYTES = 4096;

const DEFAULT_VAULT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules']);
const SKIP_PATHS = ['_meta/logs', '_meta/state'];
const TYPEN = ['entscheidung', 'erkenntnis', 'offen', 'lauf', 'sitzung', 'meta'];
const STATUS = ['gültig', 'offen', 'ersetzt', 'verworfen', 'veraltet', 'erledigt'];
const HERKUENFTE = ['gemessen', 'entschieden', 'hypothese', 'gelesen'];
const HERKUNFT_PFLICHT = new Set(['entscheidung', 'erkenntnis', 'lauf']);
// Die Herkunftspflicht gilt für Notizen ab diesem Datum (Einführung des Felds). Ältere gelten als "Nachtrag möglich".
const HERKUNFT_AB = '2026-10-01';
// Gültige Entscheidungen und Erkenntnisse ab diesem Datum brauchen `kurz` (ein Satz) und `themen` (Suchbegriffe).
const KURZ_AB = (() => { try { return JSON.parse(fs.readFileSync(path.join(DEFAULT_VAULT, '_meta', 'brain.config.json'), 'utf8')).kurzAb || '2000-01-01'; } catch { return '2000-01-01'; } })();
const DUPLIKAT_ORDNER = new Set(['entscheidungen', 'erkenntnisse', 'offen', 'läufe']);
const STOPWORTE = new Set(['eine', 'einer', 'eines', 'einem', 'einen', 'wird', 'werden', 'wurde', 'wurden', 'nicht', 'oder', 'sind', 'dass', 'dies', 'diese', 'dieser', 'dieses', 'sich', 'auch', 'nach', 'beim', 'vom', 'über', 'ohne', 'für', 'mit', 'und', 'der', 'die', 'das', 'den', 'dem', 'des', 'ist', 'zum', 'zur', 'von', 'aus', 'bei', 'auf', 'als', 'wie', 'nur', 'noch', 'mehr']);

const norm = p => p.replace(/\\/g, '/');

// ── Einlesen ─────────────────────────────────────────────────────────────────────
function walk(dir, root, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = norm(path.relative(root, path.join(dir, e.name)));
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_PATHS.includes(rel)) continue;
      walk(path.join(dir, e.name), root, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const data = {};
  if (!m) return { data, body: text, vorhanden: false };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-zäöüÄÖÜ_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: text.slice(m[0].length), vorhanden: true };
}

function ohneCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
}

function links(text) {
  const result = [];
  for (const m of ohneCode(text).matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    const roh = m[1];
    const ziel = roh.split('|')[0].split('#')[0].split('^')[0].trim().replace(/\\/g, '/');
    if (ziel && !/^https?:/i.test(ziel)) result.push(ziel);
  }
  return result;
}

function titel(body, dateiname) {
  const m = body.match(/^#\s+(.+)$/m);
  return (m ? m[1] : dateiname.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')).trim();
}

function klassifiziere(rel) {
  if (rel.startsWith('_meta/vorlagen/')) return 'vorlage';
  if (rel.startsWith('_meta/')) return 'meta';
  // Archiv (Sicherungskopien aus dem alten Home-Verzeichnis): wird nicht gepflegt und taucht nur als Zahl auf.
  if (rel.startsWith('projekte/umzug/') || rel.includes('/archiv/')) return 'archiv';
  if (rel.includes('/generiert/')) return 'generiert';
  if (/^_(index|uebersicht).md$/.test(path.posix.basename(rel))) return 'index';
  return 'notiz';
}

const projektVon = rel => (rel.startsWith('projekte/') ? rel.split('/')[1] : '(projektübergreifend)');

// ── Prüfung ──────────────────────────────────────────────────────────────────────
function pruefe(vaultDir) {
  const dateien = walk(vaultDir, vaultDir, []);
  const alleBasenamen = new Set(dateien.map(d => path.posix.basename(d).toLowerCase()));
  const mdDateien = dateien.filter(d => d.endsWith('.md'));
  const pfadIndex = new Map(); // "projekte/x/y" -> rel
  const nameIndex = new Map(); // "y" -> [rel, ...]
  for (const rel of mdDateien) {
    const ohneEndung = rel.replace(/\.md$/, '').toLowerCase();
    pfadIndex.set(ohneEndung, rel);
    const name = path.posix.basename(ohneEndung);
    if (!nameIndex.has(name)) nameIndex.set(name, []);
    nameIndex.get(name).push(rel);
  }

  const notizen = new Map();
  for (const rel of mdDateien) {
    const text = fs.readFileSync(path.join(vaultDir, rel), 'utf8');
    const fm = frontmatter(text);
    notizen.set(rel, {
      rel,
      art: klassifiziere(rel),
      projekt: projektVon(rel),
      fm,
      titel: titel(fm.body, path.posix.basename(rel)),
      links: links(text),
      bytes: Buffer.byteLength(text),
      // Geheimnisse und personenbezogene Daten: Notizen und Indexdateien (nicht Vorlagen, Generiertes, Archiv, Meta)
      geheimnisse: ['notiz', 'index'].includes(klassifiziere(rel)) ? findeGeheimnisse(text) : [],
    });
  }

  const istArchiv = r => r.startsWith('projekte/umzug/') || r.includes('/archiv/');
  // Mehrere Treffer: bleibt genau ein nicht-archivierter, gilt dieser (Kollision nur mit dem Archiv, harmlos).
  const waehle = treffer => {
    const aktiv = treffer.filter(r => !istArchiv(r));
    if (treffer.length > 1 && aktiv.length === 1) return { rel: aktiv[0], ok: true, archivKollision: true };
    return null;
  };
  const loese = ziel => {
    const lc = ziel.toLowerCase().replace(/\.md$/, '');
    if (/\.[a-z0-9]{2,5}$/i.test(ziel) && !ziel.toLowerCase().endsWith('.md')) {
      return alleBasenamen.has(path.posix.basename(ziel).toLowerCase()) ? { rel: null, ok: true } : { ok: false };
    }
    if (lc.includes('/')) {
      if (pfadIndex.has(lc)) return { rel: pfadIndex.get(lc), ok: true };
      const treffer = [...pfadIndex.keys()].filter(k => k.endsWith('/' + lc));
      if (treffer.length === 1) return { rel: pfadIndex.get(treffer[0]), ok: true };
      if (treffer.length > 1) {
        const w = waehle(treffer.map(k => pfadIndex.get(k)));
        return w ?? { rel: pfadIndex.get(treffer[0]), ok: true, mehrdeutig: true };
      }
      return { ok: false };
    }
    const treffer = nameIndex.get(lc) ?? [];
    if (treffer.length === 1) return { rel: treffer[0], ok: true };
    if (treffer.length > 1) {
      const w = waehle(treffer);
      return w ?? { rel: treffer[0], ok: true, mehrdeutig: lc !== '_index' };
    }
    return { ok: false };
  };

  const eingehend = new Map();
  const defekt = [];
  const mehrdeutig = [];
  for (const n of notizen.values()) {
    for (const ziel of n.links) {
      const r = loese(ziel);
      if (!r.ok) {
        defekt.push({ von: n.rel, ziel, generiert: n.art === 'generiert', archiv: n.art === 'archiv' });
        continue;
      }
      if (r.mehrdeutig && n.art !== 'archiv') mehrdeutig.push({ von: n.rel, ziel });
      if (r.rel && r.rel !== n.rel) {
        if (!eingehend.has(r.rel)) eingehend.set(r.rel, new Set());
        eingehend.get(r.rel).add(n.rel);
      }
    }
  }

  const handgeschrieben = [...notizen.values()].filter(n => n.art === 'notiz');
  // Abgeschlossene offene Punkte (erledigt/veraltet/verworfen) müssen nicht mehr verlinkt sein
  const abgeschlossen = n => n.fm.data && n.fm.data.typ === 'offen' && ['erledigt', 'veraltet', 'verworfen'].includes(n.fm.data.status);
  const verwaist = handgeschrieben.filter(n => !eingehend.has(n.rel) && !(n.fm.data && n.fm.data.kurz) && !abgeschlossen(n)).map(n => n.rel);

  const kopf = [];
  const herkunftFehlt = [];
  const herkunftNachtrag = [];
  const herkunftUngueltig = [];
  const kurzFehlt = [];
  for (const n of handgeschrieben) {
    const d = n.fm.data;
    const fehlt = [];
    if (!n.fm.vorhanden) fehlt.push('Kopf fehlt');
    else {
      for (const k of ['typ', 'status', 'datum']) if (!d[k]) fehlt.push(k);
      if (n.rel.startsWith('projekte/') && !d.projekt && d.typ !== 'meta') fehlt.push('projekt');
      if (d.typ && !TYPEN.includes(d.typ)) fehlt.push(`typ „${d.typ}“ unbekannt`);
      if (d.status && !STATUS.includes(d.status)) fehlt.push(`status „${d.status}“ unbekannt`);
    }
    if (fehlt.length) kopf.push({ rel: n.rel, problem: fehlt.join(', ') });
    if (n.fm.vorhanden && (d.typ === 'entscheidung' || d.typ === 'erkenntnis') && d.status === 'gültig' && (d.datum ?? '') >= KURZ_AB && (!d.kurz || !d.themen)) {
      kurzFehlt.push({ rel: n.rel, problem: [!d.kurz && 'kurz', !d.themen && 'themen'].filter(Boolean).join(', ') });
    }
    if (n.fm.vorhanden && HERKUNFT_PFLICHT.has(d.typ)) {
      if (!d.herkunft) ((d.datum ?? '') >= HERKUNFT_AB ? herkunftFehlt : herkunftNachtrag).push(n.rel);
      else if (!HERKUENFTE.includes(d.herkunft)) herkunftUngueltig.push({ rel: n.rel, wert: d.herkunft });
    } else if (d.herkunft && !HERKUENFTE.includes(d.herkunft)) {
      herkunftUngueltig.push({ rel: n.rel, wert: d.herkunft });
    }
  }

  // Entscheidungsketten
  const ketten = [];
  const nachfolger = new Set();
  for (const n of handgeschrieben) {
    const wert = n.fm.data.ersetzt;
    if (!wert) continue;
    for (const ziel of links(wert)) {
      const r = loese(ziel);
      if (!r.ok || !r.rel) {
        ketten.push({ rel: n.rel, problem: `ersetzt: [[${ziel}]] nicht gefunden` });
        continue;
      }
      nachfolger.add(r.rel);
      const alt = notizen.get(r.rel);
      if (alt && alt.fm.data.status !== 'ersetzt') ketten.push({ rel: r.rel, problem: `wird von ${n.rel} ersetzt, hat aber status „${alt.fm.data.status ?? 'fehlt'}“` });
    }
  }
  for (const n of handgeschrieben) {
    if (n.fm.data.status === 'ersetzt' && !nachfolger.has(n.rel)) ketten.push({ rel: n.rel, problem: 'status ersetzt, aber keine Notiz verweist per ersetzt: darauf' });
  }

  // mögliche Doppelungen
  const doppelt = [];
  const gruppen = new Map();
  for (const n of handgeschrieben) {
    const teile = n.rel.split('/');
    const ordner = n.rel.startsWith('projekte/') ? teile[2] : teile[0];
    if (!(DUPLIKAT_ORDNER.has(ordner) || ['_global', '_cross-project'].includes(teile[0]))) continue;
    const key = teile.slice(0, -1).join('/');
    if (!gruppen.has(key)) gruppen.set(key, []);
    gruppen.get(key).push(n);
  }
  const tokens = t =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^a-zäöüß0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !STOPWORTE.has(w)),
    );
  for (const liste of gruppen.values()) {
    const info = liste.map(n => ({
      n,
      slug: path.posix.basename(n.rel, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, ''),
      tok: tokens(n.titel),
    }));
    for (let i = 0; i < info.length; i += 1) {
      for (let j = i + 1; j < info.length; j += 1) {
        const a = info[i];
        const b = info[j];
        if ([a.n, b.n].some(x => ['ersetzt', 'verworfen', 'veraltet'].includes(x.fm.data.status))) continue; // bewusst aufbewahrt
        const gemeinsam = [...a.tok].filter(w => b.tok.has(w)).length;
        const union = new Set([...a.tok, ...b.tok]).size;
        const jaccard = union ? gemeinsam / union : 0;
        const gleicherSlug = a.slug === b.slug;
        if (gleicherSlug || (gemeinsam >= 3 && jaccard >= 0.6)) {
          doppelt.push({ a: a.n.rel, b: b.n.rel, grund: gleicherSlug ? 'gleicher Dateiname (ohne Datum)' : `ähnliche Titel (${Math.round(jaccard * 100)} % gemeinsame Wörter)` });
        }
      }
    }
  }

  const geheimnisse = [...notizen.values()].filter(n => n.geheimnisse.length).map(n => ({ rel: n.rel, funde: n.geheimnisse }));
  const indexGross = [...notizen.values()].filter(n => /^projekte\/[^/]+\/_index\.md$/.test(n.rel) && n.bytes > INDEX_MAX_BYTES).map(n => ({ rel: n.rel, bytes: n.bytes }));

  const zahlen = {
    notizen: mdDateien.length,
    handgeschrieben: handgeschrieben.length,
    defekteLinks: defekt.filter(x => !x.generiert && !x.archiv).length,
    defekteLinksGeneriert: defekt.filter(x => x.generiert).length,
    defekteLinksArchiv: defekt.filter(x => x.archiv).length,
    mehrdeutigeLinks: mehrdeutig.length,
    verwaist: verwaist.length,
    kopfProbleme: kopf.length,
    herkunftFehlt: herkunftFehlt.length,
    kurzFehlt: kurzFehlt.length,
    herkunftNachtrag: herkunftNachtrag.length,
    herkunftUngueltig: herkunftUngueltig.length,
    kettenProbleme: ketten.length,
    doppelt: doppelt.length,
    geheimnisVerdacht: geheimnisse.length,
    indexZuGross: indexGross.length,
  };

  // Zahlen je Projekt (für den Start-Hook)
  const proProjekt = {};
  const zaehle = (rel, key) => {
    const p = projektVon(rel);
    proProjekt[p] = proProjekt[p] ?? { defektLinks: 0, verwaist: 0, kopf: 0, herkunftFehlt: 0, kurzFehlt: 0, ketten: 0, doppelt: 0, geheimnis: 0, indexGross: 0 };
    proProjekt[p][key] += 1;
  };
  defekt.filter(x => !x.generiert && !x.archiv).forEach(x => zaehle(x.von, 'defektLinks'));
  verwaist.forEach(r => zaehle(r, 'verwaist'));
  kopf.forEach(x => zaehle(x.rel, 'kopf'));
  herkunftFehlt.forEach(r => zaehle(r, 'herkunftFehlt'));
  kurzFehlt.forEach(x => zaehle(x.rel, 'kurzFehlt'));
  ketten.forEach(x => zaehle(x.rel, 'ketten'));
  doppelt.forEach(x => zaehle(x.a, 'doppelt'));
  geheimnisse.forEach(x => zaehle(x.rel, 'geheimnis'));
  indexGross.forEach(x => zaehle(x.rel, 'indexGross'));

  return { zahlen, proProjekt, befunde: { defekt, mehrdeutig, verwaist, kopf, herkunftFehlt, kurzFehlt, herkunftNachtrag, herkunftUngueltig, ketten, doppelt, geheimnisse, indexGross } };
}

// ── Bericht ──────────────────────────────────────────────────────────────────────
const LIMIT = 40;
function liste(titelText, erklaerung, zeilen) {
  const out = [`## ${titelText} (${zeilen.length})`, '', erklaerung, ''];
  if (!zeilen.length) return out.concat(['Keine Befunde.', '']);
  for (const z of zeilen.slice(0, LIMIT)) out.push(`- ${z}`);
  if (zeilen.length > LIMIT) out.push(`- … und ${zeilen.length - LIMIT} weitere`);
  out.push('');
  return out;
}

function bericht(erg, vorher) {
  const z = erg.zahlen;
  const delta = k => {
    if (!vorher || typeof vorher[k] !== 'number') return '';
    const d = z[k] - vorher[k];
    return d === 0 ? ' (±0)' : ` (${d > 0 ? '+' : ''}${d})`;
  };
  const b = erg.befunde;
  const zeilen = [
    '---',
    'typ: meta',
    'status: gültig',
    `datum: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
    '# Vault-Prüfung',
    '',
    'Automatisch erzeugt von `_meta/skripte/vault-pruefung.js` (beim Sessionstart angestoßen, wenn der Stand älter als 12 h ist). Nicht von Hand bearbeiten. Regeln: [[_meta/konventionen]].',
    '',
    '| Prüfung | Anzahl |',
    '|---|---|',
    `| Notizen gesamt / handgeschrieben | ${z.notizen} / ${z.handgeschrieben} |`,
    `| defekte Links (handgeschrieben) | ${z.defekteLinks}${delta('defekteLinks')} |`,
    `| defekte Links in generierten Dateien / im Archiv \`umzug\` | ${z.defekteLinksGeneriert} / ${z.defekteLinksArchiv} |`,
    `| mehrdeutige Links | ${z.mehrdeutigeLinks}${delta('mehrdeutigeLinks')} |`,
    `| verwaiste Notizen | ${z.verwaist}${delta('verwaist')} |`,
    `| Kopf unvollständig oder unbekannte Werte | ${z.kopfProbleme}${delta('kopfProbleme')} |`,
    `| kurz/themen fehlt (gültige Entscheidung/Erkenntnis ab ${KURZ_AB}) | ${z.kurzFehlt}${delta('kurzFehlt')} |`,
    `| Herkunft fehlt (Entscheidung, Erkenntnis, Lauf ab ${HERKUNFT_AB}) | ${z.herkunftFehlt}${delta('herkunftFehlt')} |`,
    `| Herkunft nachtragen möglich (ältere Notizen) | ${z.herkunftNachtrag}${delta('herkunftNachtrag')} |`,
    `| Herkunft ungültig | ${z.herkunftUngueltig}${delta('herkunftUngueltig')} |`,
    `| Probleme in Entscheidungsketten | ${z.kettenProbleme}${delta('kettenProbleme')} |`,
    `| mögliche Doppelungen | ${z.doppelt}${delta('doppelt')} |`,
    `| Verdacht auf Geheimnis oder personenbezogene Daten | ${z.geheimnisVerdacht}${delta('geheimnisVerdacht')} |`,
    `| _index.md über ${INDEX_MAX_BYTES} Byte | ${z.indexZuGross}${delta('indexZuGross')} |`,
    '',
  ];
  zeilen.push(...liste('Defekte Links', 'Das Ziel von `[[...]]` existiert nicht. Notiz anlegen oder Link korrigieren.', b.defekt.filter(x => !x.generiert && !x.archiv).map(x => `\`${x.von}\` → \`[[${x.ziel}]]\``)));
  zeilen.push(...liste('Mehrdeutige Links', 'Der Name ist im Vault mehrfach vorhanden. Mit Pfad verlinken (`[[ordner/name]]`).', b.mehrdeutig.map(x => `\`${x.von}\` → \`[[${x.ziel}]]\``)));
  zeilen.push(...liste('Verwaiste Notizen', 'Handgeschriebene Notiz ohne eingehenden Link und ohne `kurz` (Notizen mit Kurzfassung sind über die Suche auffindbar). Aus der `_index.md` oder einer verwandten Notiz verlinken oder prüfen, ob sie überholt ist.', b.verwaist.map(r => `\`${r}\``)));
  zeilen.push(...liste('Kopf', 'Pflicht: `typ`, `status`, `datum` (unter `projekte/` auch `projekt`), erlaubte Werte siehe Konventionen.', b.kopf.map(x => `\`${x.rel}\`: ${x.problem}`)));
  zeilen.push(...liste('kurz und themen fehlen', `Gültige Entscheidungen und Erkenntnisse ab ${KURZ_AB} brauchen \`kurz: "ein Satz"\` und \`themen: [begriff, ...]\` (Vokabular: \`vault-suche.js --themen\`).`, b.kurzFehlt.map(x => `\`${x.rel}\`: ${x.problem}`)));
  zeilen.push(...liste('Herkunft fehlt', `Entscheidungen, Erkenntnisse und Läufe ab ${HERKUNFT_AB} brauchen \`herkunft: gemessen | entschieden | hypothese | gelesen\`.`, b.herkunftFehlt.map(r => `\`${r}\``)));
  zeilen.push(...liste('Herkunft nachtragen (ältere Notizen)', 'Kein Fehler, nur eine Möglichkeit: Wer eine ältere Notiz ohnehin anfasst, trägt `herkunft` mit nach.', b.herkunftNachtrag.map(r => `\`${r}\``)));
  zeilen.push(...liste('Herkunft ungültig', 'Erlaubt: gemessen, entschieden, hypothese, gelesen.', b.herkunftUngueltig.map(x => `\`${x.rel}\`: „${x.wert}“`)));
  zeilen.push(...liste('Entscheidungsketten', 'Eine ersetzende Notiz verweist per `ersetzt:` auf die alte, die alte hat `status: ersetzt`.', b.ketten.map(x => `\`${x.rel}\`: ${x.problem}`)));
  zeilen.push(...liste('Mögliche Doppelungen', 'Ähnliche Titel im selben Ordner. Prüfen, ob eine Notiz die andere ergänzen sollte (Regel: vorhandene Notiz ergänzen statt neu anlegen).', b.doppelt.map(x => `\`${x.a}\` ≈ \`${x.b}\` (${x.grund})`)));
  zeilen.push(...liste('Verdacht auf Geheimnis oder personenbezogene Daten', 'Muster wie Tokens, Schlüssel, E-Mail-Adressen, Telefonnummern oder Anschriften (dieselben wie bei der Schwärzung der Rohsitzungen). Fundstellen sind gekürzt. Prüfen und schwärzen oder entfernen, bevor der Vault irgendwohin kopiert wird; Fehlalarme sind möglich.', b.geheimnisse.map(x => `\`${x.rel}\`: ${x.funde.slice(0, 5).join('; ')}`)));
  zeilen.push(...liste('Zu große Projekt-Indexdateien', `Die _index.md wird bei jedem Sessionstart geladen und kostet jedes Mal Token. Richtwert ${INDEX_MAX_BYTES} Byte: Entscheidungslisten und Details in eigene Notizen auslagern.`, b.indexGross.map(x => `\`${x.rel}\`: ${x.bytes} Byte`)));
  const projekte = Object.entries(erg.proProjekt).filter(([, v]) => Object.values(v).some(Boolean));
  if (projekte.length) {
    zeilen.push('## Je Projekt', '', '| Projekt | defekte Links | verwaist | Kopf | Herkunft fehlt | Ketten | Doppelungen |', '|---|---|---|---|---|---|---|');
    for (const [p, v] of projekte.sort((a, b) => a[0].localeCompare(b[0]))) zeilen.push(`| ${p} | ${v.defektLinks} | ${v.verwaist} | ${v.kopf} | ${v.herkunftFehlt} | ${v.ketten} | ${v.doppelt} |`);
    zeilen.push('');
  }
  return zeilen.join('\n');
}

// ── Ablauf ───────────────────────────────────────────────────────────────────────
function log(vaultDir, event, data) {
  try {
    const f = path.join(vaultDir, '_meta', 'logs', 'automation.log.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), quelle: 'vault-pruefung', event, ...data }) + '\n');
  } catch { /* Logging darf nie stören */ }
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--vault');
  const vaultDir = i >= 0 ? args[i + 1] : DEFAULT_VAULT;
  const schreiben = !args.includes('--no-write');
  const start = Date.now();
  // Parallele Läufe (mehrere Sitzungsstarts, Verdichtungslauf): nur einer schreibt, die anderen beenden sich still.
  const freigeben = schreiben ? sperre('vault-pruefung', 10) : () => {};
  if (!freigeben) { log(vaultDir, 'vault_pruefung_uebersprungen', { grund: 'anderer Lauf aktiv' }); console.log('Anderer Prüflauf aktiv, übersprungen.'); process.exit(0); }
  try {
    const stateFile = path.join(vaultDir, '_meta', 'state', 'vault-pruefung.json');
    let vorher = null;
    try { vorher = JSON.parse(fs.readFileSync(stateFile, 'utf8')).zahlen; } catch { /* erster Lauf */ }
    const erg = pruefe(vaultDir);
    if (schreiben) {
      const out = path.join(vaultDir, '_meta', 'generiert', 'vault-pruefung.md');
      schreibeAtomar(out, bericht(erg, vorher));
      schreibeAtomar(stateFile, JSON.stringify({ ts: new Date().toISOString(), zahlen: erg.zahlen, projekte: erg.proProjekt }, null, 2));
      log(vaultDir, 'vault_pruefung', { ...erg.zahlen, dauerMs: Date.now() - start });
    }
    console.log(JSON.stringify(erg.zahlen));
  } catch (error) {
    log(vaultDir, 'vault_pruefung_fehler', { fehler: String(error && error.stack ? error.stack : error) });
    console.error('vault-pruefung fehlgeschlagen:', error && error.message ? error.message : error);
  }
  freigeben();
  process.exit(0);
}

module.exports = { pruefe, bericht, frontmatter, links };
if (require.main === module) main();
