#!/usr/bin/env node
// Hält je Projekt die Datei projekte/<p>/sitzungen/_uebersicht.md aktuell (Links auf sitzungen/*.md, neueste zuerst).
// Der Start-Hook lädt sie nicht, damit der Sessionstart klein bleibt. Ein früherer Marker-Abschnitt in der _index.md wird entfernt.
const fs = require('fs');
const path = require('path');

const PROJEKTE = path.resolve(__dirname, '..', '..', 'projekte');
const START = '<!-- sitzungen:start (automatisch, nicht von Hand ändern) -->';
const END = '<!-- sitzungen:end -->';
let geaendert = 0;

for (const p of fs.readdirSync(PROJEKTE, { withFileTypes: true }).filter(e => e.isDirectory())) {
  const dir = path.join(PROJEKTE, p.name, 'sitzungen');
  if (!fs.existsSync(dir)) continue;
  const notes = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '_uebersicht.md').sort().reverse();
  if (!notes.length) { try { fs.unlinkSync(path.join(dir, '_uebersicht.md')); geaendert++; } catch { /* keine Übersicht vorhanden */ } continue; }
  const lines = notes.map(f => {
    const name = f.replace(/\.md$/, '');
    let titel = name;
    try {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m);
      if (m) titel = m[1].trim();
    } catch { /* Titel bleibt der Dateiname */ }
    return `- [[projekte/${p.name}/sitzungen/${name}|${name.slice(0, 10)}: ${titel.replace(/[\[\]|]/g, '')}]]`;
  });
  const datei = `---\ntyp: meta\nprojekt: ${p.name}\nstatus: gültig\ndatum: ${new Date().toISOString().slice(0, 10)}\n---\n\n# Sitzungsnotizen\n\n${START}\n## Sitzungen\n\n${lines.join('\n')}\n${END}\n`;
  const ziel = path.join(dir, '_uebersicht.md');
  const alt = fs.existsSync(ziel) ? fs.readFileSync(ziel, 'utf8') : '';
  // Datum im Kopf nur ändern, wenn sich die Liste ändert
  const gleich = alt.slice(alt.indexOf(START)) === datei.slice(datei.indexOf(START));
  if (!gleich) { fs.writeFileSync(ziel, datei, 'utf8'); geaendert++; }
  const idx = path.join(PROJEKTE, p.name, '_index.md');
  if (fs.existsSync(idx)) {
    const s = fs.readFileSync(idx, 'utf8');
    const a = s.indexOf(START), b = s.indexOf(END);
    if (a > -1 && b > a) fs.writeFileSync(idx, (s.slice(0, a) + s.slice(b + END.length)).replace(/\s*$/, '\n'), 'utf8');
  }
}
console.log(`Sitzungsübersicht in ${geaendert} Projekten aktualisiert.`);
