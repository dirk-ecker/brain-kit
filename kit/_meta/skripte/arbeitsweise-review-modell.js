#!/usr/bin/env node
// Arbeitsweise-Review, modellbasierte Fassung: wertet die Nutzernachrichten aller Claude-Code-Sitzungen seit dem letzten Review aus
// (Reibungspunkte, Kennzahlen, Vault-Suche) und legt das Ergebnis als Notiz ab. Findet auch Muster ohne Schlüsselwort, kostet aber
// einen Claude-Aufruf je Review. Aktiv mit "reviewModus": "modell" in brain.config.json; dann ruft arbeitsweise-review.js diese Datei auf
// (Start-Hook und Verdichtungslauf bleiben unverändert). Standard ist die kostenlose, regelbasierte Fassung.
//
//   node arbeitsweise-review-modell.js --faellig          nur wenn mindestens reviewTage seit dem letzten Review vergangen sind
//   node arbeitsweise-review-modell.js --force            sofort, Zeitraum ab letztem Review
//   node arbeitsweise-review-modell.js --force --seit 2026-10-01
//   node arbeitsweise-review-modell.js --nur-extraktion   nur Nachrichten und Kennzahlen schreiben, kein Modellaufruf
//
// Einstellungen (brain.config.json): reviewTage (14), reviewModell ("sonnet"), reviewBudgetUsd (1.5), reviewNotizOrdner ("_global/arbeitsweise-reviews").
// Ablauf: Extraktion (deterministisch, geschwärzt) -> unbeaufsichtigte Claude-Instanz (Read, Write, Grep; BRAIN_AUTOMATION=1) -> Zustand + Hinweis für den Start-Hook.
// Ausgenommene Ordner (brain.config.json "ausgenommen") und der Vault selbst werden nie gelesen. Zwischenstand: _meta/generiert/arbeitsweise/.
// Zustand: _meta/state/arbeitsweise.json {letzter, notiz, kurz, gemeldet}. Protokoll: _meta/logs/automation.log.jsonl (quelle "arbeitsweise-modell").
// Sperre gegen Doppelläufe, Exit-Code 0, außer wenn das Modell die Notiz nicht schreibt (1).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { VAULT, redact, schreibeAtomar, sperre } = require('./sitzung-lib');

const STATE = path.join(VAULT, '_meta', 'state', 'arbeitsweise.json');
const LOG = path.join(VAULT, '_meta', 'logs', 'automation.log.jsonl');
const OUT = path.join(VAULT, '_meta', 'generiert', 'arbeitsweise');
const TRANSKRIPTE = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE = process.env.CLAUDE_BIN || [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find(p => fs.existsSync(p)) || 'claude';
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')); } catch { return {}; } })();
const REVIEW_TAGE = config.reviewTage || 14;
const MODELL = config.reviewModell || 'sonnet';
const BUDGET = config.reviewBudgetUsd || 1.5;
const NOTIZ_ORDNER = (config.reviewNotizOrdner || '_global/arbeitsweise-reviews').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const MIN_NACHRICHTEN = 20;
// Claude benennt Transkript-Ordner nach dem Arbeitsverzeichnis, alle Zeichen außer Buchstaben und Ziffern werden zu "-".
const kodiert = p => String(p).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
const VAULT_KODIERT = kodiert(VAULT);
const PROJEKTE_KODIERT = kodiert(config.projektOrdner || path.join(os.homedir(), 'projects'));
const lauf = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '-' + process.pid;

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const wert = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), quelle: 'arbeitsweise-modell', lauf, event, ...data }) + '\n');
  } catch { /* Logging darf den Lauf nie stoppen */ }
}
const lesen = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const speichern = s => schreibeAtomar(STATE, JSON.stringify(s, null, 2));

// Transkript-Ordner, die nie gelesen werden: ausgenommene Projekte (private, .claude, ...) und der Vault selbst (Verdichtungs- und Review-Läufe).
function ausgenommen(ordner) {
  const n = ordner.toLowerCase();
  if (n.startsWith(VAULT_KODIERT)) return true;
  return (config.ausgenommen || ['private', '.claude']).some(a => { const k = kodiert(a).replace(/^-+/, ''); return n.endsWith('-' + k) || n.includes(`${PROJEKTE_KODIERT}-${k}`); });
}
const projektName = ordner => (ordner.toLowerCase().startsWith(PROJEKTE_KODIERT + '-') ? ordner.slice(PROJEKTE_KODIERT.length + 1) : ordner);

function userText(o) {
  const c = o.message && o.message.content;
  let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<local-command-[\s\S]*?<\/local-command-[a-z]+>/g, '').trim();
  return t.startsWith('<command-') ? '' : t;
}

function extrahieren(seit) {
  const projekte = {};
  const msgs = [];
  let ordnerListe = []; try { ordnerListe = fs.readdirSync(TRANSKRIPTE); } catch { /* keine Transkripte */ }
  for (const ordner of ordnerListe) {
    if (ausgenommen(ordner)) continue;
    const dir = path.join(TRANSKRIPTE, ordner);
    let dateien; try { dateien = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of dateien) {
      const file = path.join(dir, f);
      try { if (fs.statSync(file).mtime < seit) continue; } catch { continue; }
      const sid = f.slice(0, 8);
      let n = 0;
      const name = projektName(ordner);
      const k = projekte[name] || (projekte[name] = { sitzungen: 0, nachrichten: 0, abbrueche: 0, ablehnungen: 0, kurzfreigaben: 0, tools: {} });
      let zaehlt = false;
      for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (!o.timestamp || new Date(o.timestamp) < seit || o.isSidechain) continue;
        zaehlt = true;
        const c = o.message && o.message.content;
        if (o.type === 'assistant' && Array.isArray(c)) for (const x of c) if (x.type === 'tool_use') k.tools[x.name] = (k.tools[x.name] || 0) + 1;
        if (o.type !== 'user' || o.isMeta) continue;
        const roh = JSON.stringify(c || '').slice(0, 4000);
        if (/tool_use_id/.test(roh) && /The user doesn't want to proceed|rejected|denied/i.test(roh)) k.ablehnungen++;
        const t = userText(o);
        if (!t) continue;
        if (/Request interrupted/.test(t)) k.abbrueche++;
        if (t.length <= 40 && /^(ja|jo|ok|okay|mach|genau|passt|1|2|3|ja[ ,.!].*)/i.test(t)) k.kurzfreigaben++;
        k.nachrichten++;
        msgs.push({ projekt: name, sid, ts: o.timestamp, n: ++n, t: redact(t) });
      }
      if (zaehlt) k.sitzungen++;
    }
  }
  msgs.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return { projekte, msgs };
}

// Auswertung des Suchprotokolls (vault-suche.js): wie oft gesucht, wie oft ohne Treffer oder nur per ODER-Fallback.
function sucheStatistik(seit) {
  const s = { aufrufe: 0, ohneTreffer: 0, nurOderFallback: 0, verweise: 0, nullTrefferBegriffe: [] };
  let zeilen = [];
  try { zeilen = fs.readFileSync(path.join(VAULT, '_meta', 'logs', 'vault-suche.log.jsonl'), 'utf8').split('\n'); } catch { return s; }
  for (const z of zeilen) {
    let o; try { o = JSON.parse(z); } catch { continue; }
    if (new Date(o.ts) < seit) continue;
    s.aufrufe++;
    if (o.modus === 'verweise') s.verweise++;
    if (o.modus !== 'suche' && o.modus !== 'verweise') continue;
    if (o.treffer === 0) { s.ohneTreffer++; if (s.nullTrefferBegriffe.length < 20) s.nullTrefferBegriffe.push((o.begriffe || []).join(' ')); }
    else if (o.verknuepfung === 'ODER') s.nurOderFallback++;
  }
  return s;
}

function promptFuer({ datum, nachrichten, kennzahlen, vorherige, notiz, seit }) {
  return `Du erstellst den regelmäßigen Arbeitsweise-Review für die Zusammenarbeit des Nutzers mit Claude Code.
Zeitraum: ${seit} bis ${datum}.

1. Lies ${nachrichten} (Nutzernachrichten, Format "## <projekt> <sitzung> <zeit> #<nr>") vollständig in Abschnitten und ${kennzahlen}.
2. ${vorherige ? `Lies den vorherigen Review ${vorherige} und vergleiche: Was ist besser, gleich oder neu schlechter geworden? Wurden vorgeschlagene Maßnahmen umgesetzt und wirken sie?` : 'Es gibt noch keinen früheren Review (Ausgangsmessung).'}
3. Suche Reibungspunkte der Zusammenarbeit (nicht Fachinhalte): Korrekturen und Frust, Scope-Missverständnisse, wiederholte Vorgaben, ungefragte Regeln oder Werkzeuge, nicht mitgezogene Randbereiche, unnötige oder fehlende Rückfragen, Prozess-Overhead.
3b. Vault-Suche: Unter "vaultSuche" in den Kennzahlen stehen Aufrufe, Suchen ohne Treffer (mit Begriffen) und Suchen, die nur per ODER-Fallback trafen. Prüfe mit Grep im Vault bei höchstens 5 Nulltreffer-Suchen, ob eine passende Notiz existiert, die die Suche hätte finden müssen (fehlende themen oder kurz), oder ob das Wissen schlicht fehlt.
4. Schlage Maßnahmen NUR vor, wenn vorhandene Mittel (CLAUDE.md, Hooks, Skills, Memory, Berechtigungen) nicht reichen, und nenne zuerst, was schon existiert. Keine neuen Regeln um ihrer selbst willen: der Nutzer will den Prozess vereinfachen, nicht ausbauen.
5. Schreibe GENAU EINE Datei: ${notiz}. Sonst nichts anlegen oder ändern.

Aufbau der Datei (Deutsch, mit Umlauten, höchstens 450 Wörter):
---
typ: erkenntnis
status: gültig
datum: ${datum}
herkunft: gelesen
kurz: "ein Satz mit dem wichtigsten Befund, höchstens 160 Zeichen"
themen: [prozess, brain]
---
# Arbeitsweise-Review ${datum}: <Kernaussage>
## Kennzahlen (Zeitraum, Sitzungen, Nachrichten, Abbrüche, Ablehnungen, Kurzfreigaben, Vergleich zum Vorgänger)
## Reibungspunkte (höchstens 5, je Titel, Häufigkeit, 1-2 Kurzbelege mit Projekt/Sitzung/Zeit, vermutete Ursache, Vorschlag oder "vorhandene Mittel genügen")
## Was gut funktioniert (höchstens 3 Punkte)
## Vorschläge zur Entscheidung durch den Nutzer (nummeriert, höchstens 3, nur echte Änderungen)

Keine Geheimnisse, Zugangsdaten oder personenbezogenen Daten übernehmen; Zitate kurz halten.`;
}

function main() {
  const state = lesen();
  const jetzt = new Date();
  const datum = jetzt.toISOString().slice(0, 10);
  const letzter = state.letzter ? new Date(state.letzter) : null;

  if (flag('--faellig')) {
    if (!letzter) { speichern({ ...state, letzter: jetzt.toISOString() }); log('ausgangspunkt_gesetzt', { letzter: jetzt.toISOString() }); return; }
    const tage = (jetzt - letzter) / 864e5;
    if (tage < REVIEW_TAGE) { log('nicht_faellig', { tage: +tage.toFixed(1), reviewTage: REVIEW_TAGE }); return; }
  } else if (!flag('--force') && !flag('--nur-extraktion')) {
    console.log('Aufruf mit --faellig, --force oder --nur-extraktion.'); return;
  }

  const seit = wert('--seit') ? new Date(wert('--seit')) : (letzter || new Date(jetzt - REVIEW_TAGE * 864e5));
  const t0 = Date.now();
  const { projekte, msgs } = extrahieren(seit);
  const nachrichten = path.join(OUT, `${datum}-nachrichten.md`);
  const kennzahlen = path.join(OUT, `${datum}-kennzahlen.json`);
  schreibeAtomar(nachrichten, msgs.map(m => `## ${m.projekt} ${m.sid} ${m.ts.slice(0, 16)} #${m.n}\n${m.t}\n`).join('\n'));
  const summe = { seit: seit.toISOString(), bis: jetzt.toISOString(), nachrichten: msgs.length, projekte, vaultSuche: sucheStatistik(seit) };
  schreibeAtomar(kennzahlen, JSON.stringify(summe, null, 2));
  log('extraktion', { seit: summe.seit, nachrichten: msgs.length, projekte: Object.keys(projekte).length, dauer_ms: Date.now() - t0 });
  if (flag('--nur-extraktion')) { console.log(`${msgs.length} Nachrichten -> ${nachrichten}`); return; }
  if (msgs.length < MIN_NACHRICHTEN) { log('zu_wenig_daten', { nachrichten: msgs.length, mindestens: MIN_NACHRICHTEN }); return; }

  const vorherige = state.notiz && fs.existsSync(state.notiz) ? state.notiz : null;
  const notiz = path.join(VAULT, NOTIZ_ORDNER, `${datum}-arbeitsweise-review.md`);
  fs.mkdirSync(path.dirname(notiz), { recursive: true });
  const prompt = promptFuer({ datum, nachrichten, kennzahlen, vorherige, notiz, seit: seit.toISOString().slice(0, 10) });
  const t1 = Date.now();
  const r = spawnSync(CLAUDE, ['-p', '--model', MODELL, '--no-session-persistence', '--permission-mode', 'acceptEdits', '--max-budget-usd', String(BUDGET),
    '--strict-mcp-config', '--disable-slash-commands', '--allowedTools', 'Read', 'Write', 'Grep', '--add-dir', VAULT, '--add-dir', OUT],
  { input: prompt, cwd: VAULT, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BRAIN_AUTOMATION: '1' }, windowsHide: true });
  const ok = fs.existsSync(notiz);
  log('modelllauf', { modell: MODELL, status: r.status, ok, dauer_ms: Date.now() - t1, stderr: (r.stderr || '').slice(0, 300) });
  if (!ok) { console.error('Review-Notiz wurde nicht geschrieben; Zustand bleibt, nächster Versuch beim nächsten Aufruf.'); process.exitCode = 1; return; }

  const kurz = ((fs.readFileSync(notiz, 'utf8').match(/^kurz:\s*"(.*)"\s*$/m)) || [])[1] || '';
  speichern({ ...lesen(), letzter: jetzt.toISOString(), notiz, kurz, gemeldet: false });
  log('abgeschlossen', { notiz: path.relative(VAULT, notiz).replace(/\\/g, '/'), kurz, nachrichten: msgs.length });
  console.log(`Review: ${notiz}`);
}

const freigeben = sperre('arbeitsweise-modell', 30);
if (!freigeben) { console.log('Anderer Lauf aktiv, übersprungen.'); }
else {
  try { main(); } catch (e) { log('fehler', { meldung: String(e && e.message || e) }); console.error(e); process.exitCode = 1; } finally { freigeben(); }
}
