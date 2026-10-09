#!/usr/bin/env node
// Wertet die Zusammenarbeit der letzten Tage aus (Korrekturen des Nutzers, Hook-Erinnerungen, Fehler) und legt bei Bedarf eine
// Review-Notiz an, die der Start-Hook in der nächsten Sitzung genau einmal meldet. Regelbasiert, ohne KI, ohne Kosten.
//
//   node arbeitsweise-review.js [--tage N] [--force] [--no-write]
//
// Quellen: _meta/logs/automation.log.jsonl (Hook-Ereignisse) und die Rohsitzungen (projekte/*/generiert/sitzungen-roh/*.txt,
// schon geschwärzt). Als Korrektur zählt eine kurze Nutzernachricht (höchstens 600 Zeichen), die das Muster STARK trifft
// („ich hatte gesagt“, „so nicht“, „ab jetzt“, „nicht fragen“ …). Die Treffer sind Kandidaten für stehende Regeln, kein Urteil.
//
// Takt: höchstens ein Review je 7 Tage (--force hebt das auf) und nur ab MIN_TREFFER Treffern. Zeitfenster: seit dem letzten Review, sonst 14 Tage.
// Ergebnis: _global/arbeitsweise-reviews/JJJJ-MM-TT-arbeitsweise-review.md (typ lauf) und _meta/state/arbeitsweise.json
// ({notiz, kurz, gemeldet:false}, vom Hook gelesen). Zustand je Lauf: _meta/state/arbeitsweise-lauf.json.
// Schreibt atomar und unter Sperre. Exit-Code immer 0.
// Modellbasierte Alternative: "reviewModus": "modell" in brain.config.json (siehe arbeitsweise-review-modell.js).

const fs = require('fs');
const path = require('path');
const { VAULT, schreibeAtomar, sperre } = require('./sitzung-lib');

// "reviewModus": "modell" (brain.config.json) ersetzt diese regelbasierte Fassung durch arbeitsweise-review-modell.js (Claude-Aufruf, kostet Token,
// findet auch Muster ohne Schlüsselwort). Alle Aufrufer (Start-Hook, Verdichtungslauf) bleiben unverändert; ohne Argumente gilt --faellig.
const reviewModus = (() => { try { return JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')).reviewModus; } catch { return null; } })();
if (reviewModus === 'modell') {
  const a = process.argv.slice(2);
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'arbeitsweise-review-modell.js'), ...(a.length ? a : ['--faellig'])], { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(r.status === null ? 0 : r.status);
}

// Nur eindeutige Korrekturformeln: das breite Hook-Muster (KORREKTUR) trifft auch Funktionswünsche wie „immer speichern“ und taugt nur als Erinnerung.
const STARK = /ich hatte (doch )?gesagt|ich meinte|ich wollte (das |die |den )?(doch )?nicht|wollte ich nicht|nicht (mehr )?fragen|das habe ich (doch )?(schon )?gesagt|so nicht|(künftig|ab jetzt|ab sofort|niemals|grundsätzlich)|ohne (das )?ich (nochmal |wieder )?gefragt/i;

const MIN_TREFFER = 3, MIN_AUTO_NOTIZEN = 5, MIN_ABSTAND_TAGE = 7, STANDARD_TAGE = 14, MAX_LISTE = 15, MIN_REGEL_TREFFER = 3;
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const LAUF = path.join(VAULT, '_meta', 'state', 'arbeitsweise-lauf.json');
const MELDUNG = path.join(VAULT, '_meta', 'state', 'arbeitsweise.json');
const args = process.argv.slice(2);
const force = args.includes('--force'), schreiben = !args.includes('--no-write');
const tageArg = args.includes('--tage') ? Number(args[args.indexOf('--tage') + 1]) : null;

function log(event, data) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'arbeitsweise-review', event, ...data }) + '\n'); } catch { /* Logging darf nie stören */ }
}
const tag = ts => new Date(ts).toISOString().slice(0, 10);

function logEreignisse(seit) {
  let zeilen = []; try { zeilen = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* kein Log */ }
  const z = { sitzungenGesichert: 0, korrekturHinweise: 0, stopErinnert: 0, stopPruefungen: 0, hookFehler: 0, uebersprungen: {}, verdichtetBatches: 0, verdichtenProbleme: 0, kostenUsd: 0, neueNotizen: [], trefferInjiziert: 0, trefferPrompts: 0 };
  for (const l of zeilen) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (Date.parse(e.ts) < seit) continue;
    if (e.event === 'sessionend_gesichert') z.sitzungenGesichert++;
    else if (e.event === 'korrektur_erkannt') z.korrekturHinweise++;
    else if (e.event === 'vault_treffer_injiziert') { z.trefferPrompts++; z.trefferInjiziert += e.anzahl || 0; }
    else if (e.event === 'stop_pruefung') { z.stopPruefungen++; if (e.erinnert === true || (e.erinnert === undefined && e.projekt_edits > 0 && e.vault_writes === 0)) z.stopErinnert++; }
    else if (e.event === 'hook_fehler') z.hookFehler++;
    else if (e.event === 'sessionend_uebersprungen') z.uebersprungen[e.grund] = (z.uebersprungen[e.grund] || 0) + 1;
    else if (e.event === 'verdichten_batch') { z.verdichtetBatches++; z.kostenUsd += e.kostenUsd || 0; z.neueNotizen.push(...(e.neueNotizen || [])); }
    else if (e.event === 'verdichten_batch_problem') { z.verdichtenProbleme++; z.kostenUsd += e.kostenUsd || 0; z.neueNotizen.push(...(e.neueNotizen || [])); }
  }
  return z;
}

// Nutzernachrichten der Rohsitzungen: Abschnitte "### NUTZER hh:mm" bis zur nächsten Überschrift oder Aktionszeile.
function korrekturen(seit) {
  const treffer = [];
  const projekteDir = path.join(VAULT, 'projekte');
  for (const p of fs.readdirSync(projekteDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const dir = path.join(projekteDir, p.name, 'generiert', 'sitzungen-roh');
    let dateien = []; try { dateien = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-\w+\.txt$/.test(f)); } catch { continue; }
    for (const f of dateien) {
      const datum = f.slice(0, 10);
      if (Date.parse(datum) < seit - 86400000) continue;
      const zeilen = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
      let aktuell = null;
      const abschliessen = () => {
        if (!aktuell) return;
        const text = aktuell.zeilen.join(' ').replace(/\s+/g, ' ').trim();
        const m = text.length <= 600 && text.match(STARK);
        if (m) treffer.push({ datum, projekt: p.name, sitzung: f.slice(11, 19), uhr: aktuell.uhr, schluessel: m[0].toLowerCase(), auszug: text.length > 200 ? text.slice(0, 200) + ' …' : text });
        aktuell = null;
      };
      for (const z of zeilen) {
        const h = z.match(/^### (NUTZER|CLAUDE) (\S*)/);
        if (h) { abschliessen(); if (h[1] === 'NUTZER') aktuell = { uhr: h[2], zeilen: [] }; }
        else if (/^ {2}\[Aktion\]/.test(z)) abschliessen();
        else if (aktuell) aktuell.zeilen.push(z);
      }
      abschliessen();
    }
  }
  return treffer.sort((a, b) => (b.datum + b.uhr).localeCompare(a.datum + a.uhr));
}

// Nutzt die Zusammenarbeit den Vault? Anteil der Rohsitzungen im Zeitraum mit mindestens einem Aufruf von vault-suche.js.
// Grobe Kennzahl: nicht jede Sitzung braucht eine Suche (reine Fehlersuche, Texte), aber ein dauerhaft niedriger Anteil heißt, dass die Vorgabe „vor Entscheidungen suchen“ nicht greift.
function vaultNutzung(seit) {
  const je = {}; let gesamt = 0, mit = 0;
  const projekteDir = path.join(VAULT, 'projekte');
  for (const p of fs.readdirSync(projekteDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const dir = path.join(projekteDir, p.name, 'generiert', 'sitzungen-roh');
    let dateien = []; try { dateien = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-\w+\.txt$/.test(f)); } catch { continue; }
    for (const f of dateien) {
      if (Date.parse(f.slice(0, 10)) < seit - 86400000) continue;
      const nutzt = /\[Aktion\] Bash: .*vault-suche\.js/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
      je[p.name] = je[p.name] || { gesamt: 0, mit: 0 };
      je[p.name].gesamt++; gesamt++;
      if (nutzt) { je[p.name].mit++; mit++; }
    }
  }
  return { gesamt, mit, je };
}

function main() {
  let letzter = null; try { letzter = JSON.parse(fs.readFileSync(LAUF, 'utf8')).ts; } catch { /* erster Lauf */ }
  const jetzt = Date.now();
  if (!force && letzter && (jetzt - Date.parse(letzter)) / 86400000 < MIN_ABSTAND_TAGE) { console.log(`Letzter Review ${tag(letzter)}, Abstand unter ${MIN_ABSTAND_TAGE} Tagen. Mit --force trotzdem.`); return; }
  const seit = tageArg ? jetzt - tageArg * 86400000 : (letzter ? Date.parse(letzter) : jetzt - STANDARD_TAGE * 86400000);
  const z = logEreignisse(seit);
  const hits = korrekturen(seit);
  const nutzung = vaultNutzung(seit);
  const quote = nutzung.gesamt ? nutzung.mit / nutzung.gesamt : null;
  const gruppen = {}; for (const h of hits) gruppen[h.schluessel] = (gruppen[h.schluessel] || 0) + 1;
  const sortiert = Object.entries(gruppen).sort((a, b) => b[1] - a[1]);
  console.log(`Zeitraum ${tag(seit)} bis ${tag(jetzt)}: ${hits.length} Korrektur-Kandidaten, ${z.stopErinnert}/${z.stopPruefungen} Stop-Erinnerungen, ${z.hookFehler} Hook-Fehler, Vault-Suche in ${nutzung.mit}/${nutzung.gesamt} Sitzungen, ${z.neueNotizen.length} automatische Notizen.`);
  if (!force && hits.length < MIN_TREFFER && z.neueNotizen.length < MIN_AUTO_NOTIZEN) { log('review_uebersprungen', { grund: 'zu wenig Anlass', treffer: hits.length, automatisch: z.neueNotizen.length }); console.log(`Unter ${MIN_TREFFER} Treffern und unter ${MIN_AUTO_NOTIZEN} automatischen Notizen, kein Review.`); return; }
  if (!schreiben) { sortiert.forEach(([k, n]) => console.log(`  ${n}× „${k}“`)); return; }

  const freigeben = sperre('arbeitsweise', 10);
  if (!freigeben) { console.log('Anderer Lauf aktiv, übersprungen.'); return; }
  try {
    const heute = tag(jetzt);
    const rel = `_global/arbeitsweise-reviews/${heute}-arbeitsweise-review.md`;
    const ziel = path.join(VAULT, rel);
    const regeln = sortiert.filter(([, n]) => n >= MIN_REGEL_TREFFER).map(([k, n]) => `- „${k}“ kam ${n}× vor: prüfen, ob die dahinterstehende Vorgabe als stehende Regel in der globalen oder Projekt-\`CLAUDE.md\` steht, und wenn nicht, aufnehmen.`);
    const vorschlaege = [...regeln];
    if (z.stopPruefungen && z.stopErinnert / z.stopPruefungen > 0.3) vorschlaege.push(`- Der Stop-Hook mahnte bei ${z.stopErinnert} von ${z.stopPruefungen} Prüfungen: Schwelle (\`STOP_MIN_DATEIEN\` in \`hook-vault.js\`) prüfen.`);
    if (z.hookFehler) vorschlaege.push(`- ${z.hookFehler} Hook-Fehler im Zeitraum: \`automation.log.jsonl\` nach \`hook_fehler\` durchsehen.`);
    if (z.verdichtenProbleme) vorschlaege.push(`- ${z.verdichtenProbleme} Verdichtungs-Batch(es) mit Problemen: \`verdichten_batch_problem\` im Log ansehen.`);
    if (quote !== null && nutzung.gesamt >= 5 && quote < 0.5) vorschlaege.push(`- Nur ${Math.round(quote * 100)} % der Sitzungen (${nutzung.mit} von ${nutzung.gesamt}) riefen ${BT}vault-suche.js${BT} auf: Hinweis im Start-Hook oder in der ${BT}CLAUDE.md${BT} verstärken oder prüfen, ob die Suche zu umständlich ist.`);
    if (z.neueNotizen.length) vorschlaege.push(`- ${z.neueNotizen.length} Notizen stammen von der Automatik (${BT}erzeugt: automatisch${BT}): bei Gelegenheit stichprobenartig gegenlesen, besonders ${BT}herkunft${BT} und Einordnung.`);
    if (!vorschlaege.length) vorschlaege.push('- Keine auffällige Häufung; die Treffer unten bei Gelegenheit ansehen.');
    const kurz = `Arbeitsweise-Review ${heute}: ${hits.length} Korrektur-Kandidaten in ${tag(seit)} bis ${heute}${sortiert[0] ? `, am häufigsten „${sortiert[0][0]}“ (${sortiert[0][1]}×)` : ''}.`;
    const text = [
      '---', 'typ: lauf', 'status: gültig', `datum: ${heute}`, 'herkunft: gemessen', `kurz: "${kurz.replace(/"/g, "'")}"`, 'themen: [claude-code, tooling]', '---', '',
      `# Arbeitsweise-Review ${heute}: ${hits.length} Korrektur-Kandidaten`, '',
      `Automatisch erzeugt von \`_meta/skripte/arbeitsweise-review.js\` (regelbasiert, Schlüsselwörter; Treffer sind Kandidaten, kein Urteil). Zeitraum ${tag(seit)} bis ${heute}.`, '',
      '## Kennzahlen',
      `- Automatische Vault-Treffer im Prompt-Hook: ${z.trefferInjiziert} Notizen in ${z.trefferPrompts} Prompts (ob sie nützten, zeigt sich nur an Rückmeldungen des Nutzers; bei vielen irrelevanten Treffern \`MIN_SCORE\` in \`prompt-treffer.js\` anheben)`,
      `- Gesicherte Sitzungen: ${z.sitzungenGesichert}; Korrektur-Hinweise des Prompt-Hooks: ${z.korrekturHinweise}`,
      `- Stop-Hook: ${z.stopErinnert} Erinnerungen bei ${z.stopPruefungen} Prüfungen`,
      `- Hook-Fehler: ${z.hookFehler}; übersprungene Sitzungssicherungen: ${Object.entries(z.uebersprungen).map(([g, n]) => `${g} ${n}×`).join(', ') || 'keine'}`,
      `- Verdichtungsläufe: ${z.verdichtetBatches + z.verdichtenProbleme} Batch(es), ${z.kostenUsd.toFixed(2)} USD`, '',
      '## Vault-Nutzung', nutzung.gesamt ? `- Sitzungen mit Vault-Suche: ${nutzung.mit} von ${nutzung.gesamt} (${Math.round(quote * 100)} %); je Projekt: ${Object.entries(nutzung.je).map(([p, v]) => `${p} ${v.mit}/${v.gesamt}`).join(', ')}` : '- keine Rohsitzungen im Zeitraum', '',
      `## Automatisch erzeugte Notizen zum Gegenlesen (${z.neueNotizen.length})`, ...(z.neueNotizen.length ? z.neueNotizen.slice(0, 40).map(n => `- [[${n.replace(/\.md$/, '')}]]`) : ['- keine']), '',
      '## Häufigste Auslöser', ...(sortiert.length ? sortiert.map(([k, n]) => `- „${k}“: ${n}×`) : ['- keine']), '',
      '## Vorschläge zur Entscheidung', ...vorschlaege, '',
      `## Treffer (die ${Math.min(MAX_LISTE, hits.length)} neuesten von ${hits.length})`,
      ...hits.slice(0, MAX_LISTE).map(h => `- ${h.datum} ${h.projekt} (${h.sitzung}): ${h.auszug}`), '',
    ].join('\n');
    if (fs.existsSync(ziel)) { console.log(`${rel} existiert schon, nichts geschrieben.`); return; }
    schreibeAtomar(ziel, text);
    schreibeAtomar(LAUF, JSON.stringify({ ts: new Date(jetzt).toISOString() }, null, 2));
    schreibeAtomar(MELDUNG, JSON.stringify({ notiz: ziel, kurz, gemeldet: false, ts: new Date(jetzt).toISOString() }, null, 2));
    log('review_geschrieben', { notiz: rel, treffer: hits.length, ...z });
    console.log(`Review geschrieben: ${rel}`);
  } finally { freigeben(); }
}

try { main(); } catch (err) { log('review_fehler', { meldung: String(err && err.stack || err) }); console.error(String(err)); }
