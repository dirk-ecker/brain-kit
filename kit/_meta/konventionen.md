---
typ: meta
status: gültig
datum: 2026-10-07
---

# Konventionen der Wissensbasis

Zweck: eine wachsende Wissensquelle über alle Projekte. Claude Code liest sie beim Arbeiten gezielt und ergänzt sie laufend; Menschen müssen sie nicht selbst durchsuchen.

## Struktur

```
vault/
  _meta/                       Konventionen, Vorlagen, Skripte, Konfiguration (brain.config.json)
  projekte/<projekt>/
    _index.md                  Einstieg, klein halten (Zweck, Stand, Tech, Links, aktuell offen)
    entscheidungen/            getroffene Entscheidungen samt Begründung
    erkenntnisse/              was herausgefunden wurde, auch Fehlannahmen
    offen/                     offene Fragen, Aufgaben, Ideen
    läufe/                     Ergebnisse von Läufen und Experimenten
    sitzungen/                 optionale Sitzungsnotizen (kurz), _uebersicht.md wird erzeugt
    generiert/                 von Skripten befüllt, nie von Hand ändern, nicht lesen
  _global/                     projektunabhängiges Wissen (Technologien, Methoden, Glossar)
  _cross-project/              Muster und Vergleiche über mehrere Projekte
```

## Wissensbereiche

Der Ordner steht für den **Geltungsbereich**, nicht für den Ort der Entdeckung.
- Nur wegen dieses Projekts wahr → `projekte/<projekt>/`
- Nützlich, auch wenn das Projekt verschwindet → `_global/`
- Wert entsteht durch Vergleich mehrerer Projekte → `_cross-project/`

Eine Entdeckung kann mehrere Wirkungen haben: Allgemeines nach `_global/`, die Folge fürs Projekt als Entscheidung im Projekt, beide verlinken sich (kein doppelter Inhalt).
- **Globale Seiten behalten den Entdeckungskontext**, wo er Wert hat: Abschnitt „Beobachtet in“ mit Links auf die Projekte.
- **Befördern** (Projekt → global/projektübergreifend) nur bei mehr Belegen oder breiterer Gültigkeit, nicht mechanisch. **Zurückstufen:** erweist sich Allgemeines als umgebungsabhängig, die globale Seite korrigieren und einengen, die Projektfolge bleibt.
- **Ohne Projekt** (Recherchen, Artikel, Methoden, Ideen aus projektfreien Gesprächen): nach `_global/` bzw. `_cross-project/`.
- **Ausdrückliche Vorgabe des Nutzers** („gehört zu Projekt X“, „ist allgemein“, „verbinde mit Y“) schlägt die automatische Einordnung.

## Kopf jeder Notiz (YAML)

```yaml
---
typ: entscheidung | erkenntnis | offen | lauf | sitzung | meta
projekt: <projektname>        # bei projektübergreifend weglassen
status: gültig | offen | ersetzt | verworfen | veraltet | erledigt   # erledigt nur bei typ offen
datum: YYYY-MM-DD
herkunft: gemessen | entschieden | hypothese | gelesen   # Pflicht bei entscheidung, erkenntnis, lauf
erzeugt: automatisch          # nur bei Notizen des Verdichtungslaufs; setzt das Skript selbst, nicht von Hand
ersetzt: [[notiz]]            # nur bei Entscheidungen, die eine ältere ablösen
kurz: "ein Satz mit der Kernaussage"   # Pflicht bei gültigen entscheidung und erkenntnis (ab 2026-10-07), in Anführungszeichen
themen: [thema-a, thema-b]    # Pflicht dort ebenfalls: 2 bis 5 Suchbegriffe, klein, kebab-case, bestehendes Vokabular wiederverwenden
---
```

`herkunft` sagt, worauf die Kernaussage beruht: `gemessen` (Lauf, Zahlen, Belege in der Notiz), `entschieden` (Vorgabe oder Entscheidung des Nutzers), `hypothese` (Annahme ohne Datenbeleg), `gelesen` (aus Code oder Doku gelesen, nicht selbst geprüft).

Zweifelsfälle: `entschieden` nur bei belegter Entscheidung oder Vorgabe des Nutzers oder Teams. Zeichnet eine Notiz bestehenden Code oder bestehende Doku nach (auch unter `entscheidungen/`), ist sie `gelesen`. Pläne und Vorschläge ohne Bestätigung sind `hypothese`.

## Regeln

- **Entscheidungen werden nie überschrieben.** Eine neue setzt die alte auf `status: ersetzt`, verweist mit `ersetzt:` auf sie und begründet die Änderung.
- Dateiname `YYYY-MM-DD-thema.md`, die Überschrift (H1) nennt die Kernaussage statt des Themas. Die H1 ist zugleich, was die Suche anzeigt.
- Inhalt: Kernaussage, Begründung, Belege (Pfade, Zahlen), offene Punkte am Ende, Verweise mit `[[Notizname]]`. Nichts festhalten, was Code oder Git schon zeigen.
- Neue Notiz nur, wenn es keine passende gibt, sonst ergänzen. Falsches direkt berichtigen, keine Korrektur-Anhänge.
- Keine Geheimnisse, keine personenbezogenen Daten.
- Sitzungsnotizen sind optional und kurz; Entscheidungen und Erkenntnisse haben Vorrang.

## Werkzeuge (`_meta/skripte/`)

| Skript | Zweck |
|---|---|
| `hook-vault.js` | Claude-Code-Hooks: Start (kleiner Kontext, stößt bei Prüfstand über 12 h die Prüfung an), Stop (einmal je Sitzung ab 3 geänderten Projektdateien), Ende (Rohverlauf sichern), Prompt (Korrekturen erkennen) |
| `sitzungen-verdichten.js` | verdichtet Rohsitzungen ohne Notiz per unbeaufsichtigter Claude-Instanz (`_meta/verdichten-auftrag.md`); Probelauf ohne `--ausfuehren`; Einstellungen unter `verdichten` in `brain.config.json`; täglich per Windows-Aufgabe `Brain-Sitzungen-verdichten` (einrichten mit `aufgabe-einrichten.ps1`) |
| `vault-suche.js` | gezielte Suche mit Typ, Status, Titel, Fundstelle; `--gueltig` listet gültige Entscheidungen |
| `vault-pruefung.js` | Qualitätsprüfung: defekte Links, Verwaiste, Kopf, Herkunft, Ketten; Ergebnis in `_meta/generiert/` |
| `vault-archiv.js` | verschiebt alte Läufe und Sitzungen nach `archiv/` (Probelauf ohne `--ausfuehren`) |
| `sitzungen-index.js` | erzeugt `projekte/<p>/sitzungen/_uebersicht.md` |
| `sitzungen-extrahieren.js` | sichert rückwirkend alle Sitzungen aus `~/.claude/projects/` als Rohverlauf (wie der Ende-Hook; Probelauf ohne `--ausfuehren`, vorhandene bleiben ohne `--ueberschreiben`) |
| `prompt-treffer.js` | Baustein des Prompt-Hooks: zieht Stichwörter aus dem Prompt, ruft `vault-suche.js` auf und liefert höchstens 2 sichere Treffer (Stichwort im Titel/Thema, Score ab 12), je Sitzung höchstens 8 und jede Notiz nur einmal |
| `sync-projekte.js` | meldet Projekte mit neuen Repo-Commits seit der letzten Kuration (`generiert/kuration-faellig.md`, `projekte/<p>/generiert/repo-stand.md`); `--mark <projekt>` nach erledigter Kuration |
| `arbeitsweise-review.js` | wertet Korrekturen und Hook-Ereignisse aus (regelbasiert, kostenlos), legt höchstens wöchentlich eine Review-Notiz unter `_global/arbeitsweise-reviews/` an, die der Start-Hook einmal meldet |
| `kit-exportieren.js` | exportiert das Werkzeug ohne Inhalte nach `brain-kit/kit` (Positivliste, Scan auf persönliche Spuren); danach im Repo brain-kit committen. Nicht Teil des Kits |
| `sitzung-lib.js` | gemeinsame Bibliothek: Verlauf verdichten, Geheimnisse und Kontaktdaten schwärzen (`redact`), Projektzuordnung, Ablageort, `schreibeAtomar`, `sperre`, `unverarbeiteteRoh` |

Die Skripte finden den Vault relativ zu ihrem Ort (`_meta/skripte` → zwei Ebenen höher) und brauchen nur Node.js.

## Versionierung

Der Vault ist ein lokales Git-Repo ohne Remote (`.gitignore`: `_meta/state/`, `_meta/logs/`, Lockdateien). `sitzungen-verdichten.js` committet vor und nach jedem Lauf („Brain: …“), damit Änderungen der Automatik von denen laufender Sitzungen getrennt und umkehrbar sind (`git log`, `git diff`, `git restore`). Interaktive Sitzungen committen nicht von Hand; der nächste Lauf sichert ihren Stand mit. Nach dem Lauf räumt er auf: Archivierung (`vault-archiv.js --ausfuehren`), Log-Rotation ab 5 MB, Auffrischen von Prüfung, Sync und Review. Der Start-Hook meldet, wenn der Lauf seit 3 Tagen ausblieb oder Probleme hatte (`_meta/state/verdichten-letzter.json`) und einmal nach jedem Hook-Fehler (`_meta/state/hook-fehler.json`). Verdichtete Rohsitzungen löscht der Lauf nach 90 Tagen (`rohAufbewahrungTage`; Git behält sie, Sitzungen ohne Notiz bleiben immer). Neue Notizen des Laufs bekommen `erzeugt: automatisch`; der wöchentliche Review listet sie zum Gegenlesen und weist aus, in wie vielen Sitzungen `vault-suche.js` aufgerufen wurde.

## Prüfungen gegen unbeaufsichtigtes Schreiben

`vault-pruefung.js` meldet zusätzlich Verdacht auf Geheimnisse oder personenbezogene Daten in Notizen (dieselben Muster wie `redact`, Fundstellen gekürzt; Fehlalarme möglich) und `_index.md` über 4096 Byte (wird bei jedem Sessionstart geladen).

## Parallele Sitzungen

Mehrere Claude-Sitzungen und Skriptläufe arbeiten gleichzeitig im Vault. Regeln:
- Hooks arbeiten nur mit der eigenen Sitzungs-ID (Rohdatei `JJJJ-MM-TT-<id8>.txt`, Stop-Marker je Sitzung); Skriptdateien und Zustandsdateien werden atomar geschrieben (`schreibeAtomar`).
- Skripte mit Schreibzugriff auf gemeinsame Dateien nehmen eine Sperre (`sperre`, Lockdatei in `_meta/state/`; veraltet, wenn der Prozess tot oder älter als das Limit ist): `vault-pruefung` und `sitzungen-verdichten`.
- Notizen: neue Datei nur anlegen, wenn der Name nicht existiert; bestehende mit Edit ändern, nie komplett neu schreiben (Edit schlägt fehl, wenn die Datei seit dem Lesen geändert wurde: neu lesen, wiederholen). Gilt auch für `_index.md` („Aktuell offen“).
- Läufe der Automatisierung setzen `BRAIN_AUTOMATION=1`; die Hooks beenden sich dann sofort.

## Kurzfassung und Themen

`kurz` (ein Satz, höchstens 160 Zeichen) und `themen` (2 bis 5 Begriffe) stehen im Kopf jeder gültigen Entscheidung und Erkenntnis. `vault-suche.js` zeigt `kurz` statt eines Textausschnitts, gewichtet `themen` und `kurz` bei der Suche und kennt `--themen` (Vokabular mit Häufigkeit) und `--thema X` (alle Notizen zu einem Thema). Vor dem Vergeben neuer Themenbegriffe `--themen` ansehen und vorhandene wiederverwenden. Die Prüfung meldet fehlende Felder für alle Notizen (Stichtag `kurzAb` in `brain.config.json`).

## Ersetzungsketten und Archiv

- **Ketten:** Eine neue Entscheidung setzt die alte auf `status: ersetzt` und verweist mit `ersetzt:` auf sie. `vault-suche.js` findet standardmäßig nur gültige Notizen; mit `--auch-ersetzte` erscheinen ersetzte Notizen mit Hinweis auf den gültigen Nachfolger, `--kette <begriff>` zeigt die ganze Kette von alt nach neu. In Übersichten und Indexdateien stehen keine Entscheidungslisten, nur die erzeugten Auswertungen der Suche (`--gueltig`).
- **Archiv:** `vault-archiv.js` verschiebt Läufe und Sitzungsnotizen, die älter als `archivTage` (`brain.config.json`, Standard 60) sind, nach `projekte/<p>/archiv/{läufe,sitzungen}/`. Eine Notiz bleibt aktiv, solange eine gültige Entscheidung, Erkenntnis oder ein offener Punkt auf sie verweist (Beleg). Entscheidungen, Erkenntnisse und offene Punkte werden nie archiviert, damit Ketten vollständig bleiben. Nichts wird gelöscht, `[[Name]]`-Links bleiben gültig, die Suche überspringt `archiv/` außer mit `--archiv`. Aufruf: `node vault-archiv.js` (Probelauf), `--ausfuehren` (verschieben), `--tage N`.
- Notizen mit `kurz` gelten in der Prüfung nicht als verwaist, weil die Suche sie findet.
