// Liefert zu einem Nutzer-Prompt die wenigen Vault-Notizen, die ihn mit hoher Sicherheit betreffen (für den Prompt-Hook).
// Schiebt Treffer in den Kontext, statt dass jede Sitzung daran denken muss, vault-suche.js aufzurufen.
//
//   const { treffer } = require('./prompt-treffer');
//   treffer(promptText, cwd) -> [{ typ, titel, pfad, hinweis, score }]   (leer, wenn nichts sicher passt)
//
// Vorgehen: Stichwörter aus dem Prompt (ohne Füllwörter) → vault-suche.js im Projektordner → nur Treffer ab MIN_SCORE
// und höchstens MAX_TREFFER. Bewusst zurückhaltend: lieber nichts als Rauschen (jeder Treffer kostet Token in jeder Antwort).
// Auswertung: vault-suche.js protokolliert die Aufrufe mit quelle "hook" (VAULT_SUCHE_QUELLE).

const path = require('path');
const { spawnSync } = require('child_process');

const MIN_SCORE = 12, MAX_TREFFER = 2, MAX_BEGRIFFE = 6, MIN_PROMPT_ZEICHEN = 30;
const SUCHE = path.join(__dirname, 'vault-suche.js');

const FUELLWOERTER = new Set(('aber alle allem allen aller alles also andere anderen auch dass dann dazu denn dieser diese diesen dieses doch dort durch eine einen einem einer eines einfach etwas gibt haben habe hatte heute immer jetzt kann können könnte machen mach macht mehr muss müssen nach nicht noch nochmal oben oder sein sind sollen sollte soll über unter viel wann warum wenn werden wieder will wird wollen wurde würde zwischen bitte danke mal ganz gleich schon sehr neue neuen neues nein ja okay '
  + 'dass das den dem der die ein ist sind für mit von und wie was wir ich du es im in am an zu zum zur auf aus bei bis ob so um '
  + 'möchte würde würden gerne kannst nimm überall sowas jeden jede jedes beiden ersten erste letzte weitere weiter bereits direkt sollten sollen gemacht machst mache '
  + 'einträge eintrag nutzen nutzt nutze verwenden verwende').split(/\s+/).filter(Boolean));

function stichwoerter(text) {
  const gesehen = new Set(), liste = [];
  for (const w of text.toLowerCase().replace(/`[^`]*`/g, ' ').match(/[a-zäöüß][a-zäöüß0-9-]{3,}/g) || []) {
    if (FUELLWOERTER.has(w) || gesehen.has(w)) continue;
    gesehen.add(w); liste.push(w);
  }
  // Längere Wörter sind meist aussagekräftiger als kurze
  return liste.sort((a, b) => b.length - a.length).slice(0, MAX_BEGRIFFE);
}

// Ein Treffer gilt nur, wenn ein Stichwort im Titel oder in den Themen vorkommt (nicht nur irgendwo im Text, das war die
// Hauptquelle von Fehltreffern), oder zwei verschiedene Stichwörter in der Kurzfassung. Verglichen wird am Wortanfang
// (Mehrzahl, Endungen), damit „fragen“ nicht „Anfragen“ trifft.
const stamm = w => w.slice(0, Math.max(4, w.length - 2));
const wortanfang = (heu, st) => new RegExp(`(^|[^a-zäöüß0-9])${st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(heu);
function passt(begriffe, titel, themen, hinweis) {
  const kopf = `${titel} ${themen.replace(/,/g, ' ')}`.toLowerCase(), kurz = hinweis.toLowerCase();
  if (begriffe.some(b => b.length >= 5 && wortanfang(kopf, stamm(b)))) return true;
  return new Set(begriffe.filter(b => wortanfang(kurz, stamm(b))).map(stamm)).size >= 2;
}

function treffer(promptText, cwd) {
  const text = String(promptText || '').trim();
  // Befehle, Shell-Eingaben und Hook-Rückmeldungen sind keine Fragestellungen
  if (text.length < MIN_PROMPT_ZEICHEN || /^(\/|<|Stop hook feedback)/.test(text)) return [];
  const begriffe = stichwoerter(text);
  if (begriffe.length < 2) return [];
  const r = spawnSync(process.execPath, [SUCHE, ...begriffe, '-n', '4'], {
    cwd, encoding: 'utf8', timeout: 4000, windowsHide: true, env: { ...process.env, VAULT_SUCHE_QUELLE: 'hook' },
  });
  if (r.status !== 0 || !r.stdout) return [];
  const aus = [];
  const zeilen = r.stdout.split(/\r?\n/);
  for (let i = 0; i < zeilen.length; i++) {
    const m = zeilen[i].match(/^- \[(\w+)(?:\/[^\]]*)?\] \d{4}-\d{2}-\d{2} (.+) \((\d+)\)$/);
    if (!m) continue;
    const score = Number(m[3]);
    if (score < MIN_SCORE || !['entscheidung', 'erkenntnis', 'global', 'offen'].includes(m[1])) continue;
    const pfadZeile = (zeilen[i + 1] || '').trim();
    const pfad = pfadZeile.replace(/ \{.*\}$/, '');
    const themen = (pfadZeile.match(/\{(.*)\}$/) || [])[1] || '';
    const hinweis = ((zeilen[i + 2] || '').trim().match(/^> (.*)$/) || [])[1] || '';
    if (!passt(begriffe, m[2], themen, hinweis)) continue;
    aus.push({ typ: m[1], titel: m[2], pfad, hinweis, score });
    if (aus.length >= MAX_TREFFER) break;
  }
  return aus;
}

module.exports = { treffer, stichwoerter };
