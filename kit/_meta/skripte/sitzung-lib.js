// Gemeinsame Logik: verdichtet einen Claude-Code-Sitzungsverlauf (JSONL) zu lesbarem Text.
// Verwendet von sitzungen-extrahieren.js (Rückwirkend, alle Sitzungen) und hook-vault.js (SessionEnd, eine Sitzung).
const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..');
const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(VAULT, '_meta', 'brain.config.json'), 'utf8')); } catch { return {}; }
})();
const PROJECTS = cfg.projektOrdner || path.join(require('os').homedir(), 'projects');
const SKIP = new Set((cfg.ausgenommen || ['private', '.claude']).map(s => s.toLowerCase()));
const NAME_MAP = cfg.namen || {};
const vaultName = d => NAME_MAP[d] || d.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// Projekt = erster Ordner unter projektOrdner; Vault-Name = kebab-case. null = kein Projekt oder ausgenommen.
function projectOf(cwd) {
  const c = String(cwd || '').replace(/\\/g, '/'), root = String(PROJECTS).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  if (!c.toLowerCase().startsWith(root.toLowerCase())) return null;
  const dir = c.slice(root.length).split('/')[0];
  if (!dir || SKIP.has(dir.toLowerCase())) return null;
  return { dir, vault: vaultName(dir) };
}

// Ausgenommen: Arbeitsverzeichnis liegt im Projektordner, aber in einem Ordner der Liste "ausgenommen" (Standard private, .claude).
// Von solchen Sitzungen darf nichts im Vault landen, auch keine geschwärzte Rohdatei.
function istAusgenommen(cwd) {
  const c = String(cwd || '').replace(/\\/g, '/'), root = String(PROJECTS).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  if (!c.toLowerCase().startsWith(root.toLowerCase())) return false;
  const dir = c.slice(root.length).split('/')[0];
  return !!dir && SKIP.has(dir.toLowerCase());
}

// Zielordner und Dateiname einer Rohsitzung (ein Schema für Hook und Rückwirkend-Import).
function rohZiel(c, cwd) {
  const p = projectOf(cwd || c.cwd);
  const dir = p ? path.join(VAULT, 'projekte', p.vault, 'generiert', 'sitzungen-roh') : path.join(VAULT, '_meta', 'generiert', 'sitzungen-roh');
  return { projekt: p ? p.vault : null, dir, name: `${(c.first || new Date().toISOString()).slice(0, 10)}-${c.id.slice(0, 8)}.txt` };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' […]' : s);
const stripReminders = t => t
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
  .trim();

// Schwärzt Geheimnisse und Kontaktdaten, bevor etwas im Vault landet. Lieber zu viel als zu wenig:
// ein geschwärzter Bezeichner kostet nichts, ein Key im Vault schon.
const GESCHWAERZT = '[geschwärzt]';
const REDACT = [
  /\bcfut_[A-Za-z0-9_-]{20,}/g,                                   // Cloudflare-Nutzertoken
  /\bAIza[0-9A-Za-z_-]{30,}/g, /\bAQ\.[A-Za-z0-9_.-]{20,}/g,      // Google-/Gemini-Keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, // JWT
  /\b[a-f0-9]{32}\b/g,                                            // 32-Hex (API-Keys, Account-IDs)
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}\b/g, // lange Zufallszeichenketten
  /[A-Za-z0-9._%+-]+@(?!anthropic\.com\b)[A-Za-z0-9.-]+\.[a-z]{2,}/g, // E-Mail (außer Co-Authored-By)
  /(?:\+49|\b0)[1-9]\d{1,4}[ \/-]?\d{3,}[ -]?\d{0,6}\b/g,         // Telefonnummern
  /[A-ZÄÖÜ][\wäöüß.-]*(?:\s[A-ZÄÖÜ]?[\wäöüß.-]+)?\s\d{1,4}[a-z]?,?\s+\d{5}\s+[A-ZÄÖÜ][\wäöüß-]+/g, // Postanschrift „Straße 1, 12345 Ort“
];
function redact(t) {
  let s = t;
  // Werte nach Parametern/Schaltern, die Geheimnisse tragen
  s = s.replace(/([?&](?:token|access_token|auth_key|key|code)=)[^\s&"'`)\]]+/gi, `$1${GESCHWAERZT}`);
  s = s.replace(/(\b(?:token|secret|password|passwort|api[_-]?key)\b["']?\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi, `$1${GESCHWAERZT}`);
  s = s.replace(/(secret (?:put|set) [A-Z0-9_]+(?: --[a-z-]+[ =]\S+)*\s+(?:--body\s+)?["']?)[^\s"']{8,}/g, `$1${GESCHWAERZT}`);
  s = s.replace(/(Unknown argument:\s*)\S{8,}/g, `$1${GESCHWAERZT}`);
  for (const re of REDACT) s = s.replace(re, GESCHWAERZT);
  return s;
}

// Findet, was redact() schwärzen würde (Geheimnisse, E-Mail, Telefon, Anschrift), ohne den Text zu ändern.
// Liefert die Fundstellen gekürzt (Anfang + Länge), damit der Prüfbericht selbst kein Geheimnis wiederholt.
function findeGeheimnisse(text) {
  const funde = [];
  const kuerzen = s => `${s.slice(0, 4)}… (${s.length} Zeichen)`;
  for (const re of REDACT) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      // Kurze Ziffernfolgen sind meist Commit-Hashes, Farbwerte oder Beträge, keine Telefonnummern.
      if (/^[\d\s\/+-]+$/.test(m[0]) && m[0].replace(/\D/g, '').length < 9) continue;
      funde.push(kuerzen(m[0]));
    }
  }
  for (const re of [/[?&](?:token|access_token|auth_key|key|code)=([^\s&"'`)\]]+)/gi, /\b(?:token|secret|password|passwort|api[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi]) {
    for (const m of text.matchAll(re)) if (m[1].length >= 8 && !/^\[?geschwärzt/.test(m[1])) funde.push(kuerzen(m[1]));
  }
  return [...new Set(funde)];
}

function actionLine(b) {
  const i = b.input || {};
  const arg = i.file_path || i.path || i.command || i.pattern || i.description || i.prompt || i.query || i.url || '';
  return `  [Aktion] ${b.name}${arg ? ': ' + clip(String(arg).replace(/\s+/g, ' '), 160) : ''}`;
}

// Liefert { id, text, users, first, last, cwd } oder null, wenn der Verlauf nicht lesbar ist.
function condense(file, id) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return null; }
  const buf = [];
  let first = null, last = null, cwd = null, users = 0;
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.timestamp) { first = first || e.timestamp; last = e.timestamp; }
    if (e.cwd) cwd = e.cwd;
    const msg = e.message; if (!msg) continue;
    const ts = (e.timestamp || '').slice(11, 16);
    if (e.type === 'user') {
      const text = typeof msg.content === 'string' ? msg.content
        : (Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
      const t = stripReminders(text);
      if (t) { buf.push(`\n### NUTZER ${ts}\n${clip(t, 4000)}`); users++; }
    } else if (e.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'text' && b.text && b.text.trim()) buf.push(`\n### CLAUDE ${ts}\n${clip(b.text.trim(), 3500)}`);
        else if (b.type === 'tool_use') buf.push(actionLine(b));
      }
    }
  }
  const text = `# Sitzung ${id}\nArbeitsverzeichnis: ${cwd}\nZeitraum: ${first} – ${last}\n` + redact(buf.join('\n'));
  return { id, text, users, first, last, cwd };
}

// ---- Absicherung gegen parallele Sitzungen und Skriptläufe ----

// Schreibt über eine Temp-Datei und benennt um: ein paralleler Leser sieht nie eine halbe Datei.
function schreibeAtomar(ziel, inhalt) {
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  const tmp = `${ziel}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, inhalt, 'utf8');
  try { fs.renameSync(tmp, ziel); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* schon weg */ } throw e; }
}

const lebt = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Exklusive Sperre per Lockdatei (wx = atomar). Veraltete Sperre (Prozess tot oder älter als maxAlterMin) wird übernommen.
// Liefert eine Freigabefunktion oder null, wenn ein anderer Lauf die Sperre hält.
function sperre(name, maxAlterMin = 60) {
  const datei = path.join(VAULT, '_meta', 'state', `${name}.lock`);
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      const fd = fs.openSync(datei, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(datei); } catch { /* schon weg */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let alt = null; try { alt = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { /* halb geschrieben: als frisch behandeln */ }
      const alterMin = alt ? (Date.now() - Date.parse(alt.ts)) / 60000 : 0;
      if (alt && (!lebt(alt.pid) || alterMin > maxAlterMin)) { try { fs.unlinkSync(datei); } catch { /* ein anderer war schneller */ } continue; }
      return null;
    }
  }
  return null;
}

// Rohsitzungen (Dateiname JJJJ-MM-TT-<id8>.txt) ohne Sitzungsnotiz: die id8 steht im Kopf (erste 600 Zeichen) einer Notiz.
function unverarbeiteteRoh(projektVault) {
  const base = path.join(VAULT, 'projekte', projektVault);
  const rohDir = path.join(base, 'generiert', 'sitzungen-roh');
  let roh; try { roh = fs.readdirSync(rohDir).filter(f => f.endsWith('.txt')).sort(); } catch { return []; }
  let bekannt = '';
  for (const d of [path.join(base, 'sitzungen'), path.join(base, 'archiv', 'sitzungen')]) {
    try { for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) bekannt += fs.readFileSync(path.join(d, f), 'utf8').slice(0, 600) + '\n'; } catch { /* kein Ordner */ }
  }
  return roh.filter(f => !bekannt.includes(f.replace(/\.txt$/, '').split('-').pop())).map(f => path.join(rohDir, f));
}

// Erkennt Korrekturen und stehende Vorgaben in Nutzernachrichten (Hook "prompt" und arbeitsweise-review.js).
const KORREKTUR = /\b(immer|nie|niemals|künftig|ab jetzt|ab sofort|grundsätzlich)\b|ich hatte (doch )?gesagt|ich meinte|ich wollte (das |die |den )?(doch )?nicht|wollte ich nicht|nicht (mehr )?fragen|das habe ich (doch )?(schon )?gesagt|so nicht/i;

module.exports = { condense, redact, findeGeheimnisse, projectOf, istAusgenommen, rohZiel, schreibeAtomar, sperre, unverarbeiteteRoh, vaultName, KORREKTUR, PROJECTS, VAULT };
