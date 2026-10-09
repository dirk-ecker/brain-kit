# Erste Schritte

Von der Installation bis zur ersten verdichteten Sitzung. Dauer: etwa 15 Minuten, plus ein paar Tage Betrieb, bis das Brain sichtbar Wissen gesammelt hat.

## 1. Voraussetzungen prüfen

```powershell
node --version      # v20 oder neuer
git --version
claude --version    # Claude Code, angemeldet
```

Fehlt etwas, sagt die Diagnose (Schritt 3) genau, was.

## 2. Installieren

Im Ordner des Kits (Repo geklont):

```powershell
node installieren.js --trocken                 # nur anzeigen
node installieren.js --vault C:/Users/ich/brain --projekte C:/Users/ich/Documents/projects
```

- `--vault`: wo das Brain liegen soll (Standard `~/brain`). Ein eigener, leerer Ordner, am besten außerhalb der Projekte.
- `--projekte`: der Ordner, unter dem deine Projekt-Repos liegen. Das Brain ordnet eine Sitzung dem **ersten Unterordner** zu, in dem sie läuft (`…/projects/mein-projekt/…` gehört zu `mein-projekt`).

Der Installer ändert zwei Dateien in deinem Benutzerprofil (`~/.claude/settings.json`, `~/.claude/CLAUDE.md`) und sichert sie vorher als `…brain-sicherung-<zeit>`. Genaueres steht in der [README](../README.md).

## 3. Diagnose

```powershell
node installieren.js --pruefen --vault C:/Users/ich/brain
```

Alles, was mit `OK` beginnt, ist in Ordnung. `FEHLT` nennt den Befehl zur Abhilfe. Die Windows-Aufgabe darf zunächst fehlen (Schritt 7).

## 4. Die erste Sitzung

Starte Claude Code **neu** in einem Projektordner unterhalb des Projekte-Ordners (bereits laufende Sitzungen übernehmen neue Hooks eventuell erst nach einem Neustart).

Beim ersten Mal in einem Projekt bekommt Claude vom Start-Hook den Hinweis, dass es noch keinen Vault-Ordner gibt, und legt `projekte/<projekt>/_index.md` an. Danach arbeitest du wie gewohnt. Das Brain wirkt im Hintergrund:

- **Claude hält fest**, was dauerhaft zählt: Entscheidungen mit Begründung, deine Vorgaben und Korrekturen, Erkenntnisse, offene Fragen. Nicht Triviales.
- **Bei einer Korrektur** („ich hatte gesagt …“, „ab jetzt immer …“) erinnert ein Hook Claude, die Vorgabe sofort festzuhalten.
- **Bei einem passenden Thema** liefert ein Hook dem Prompt ein bis zwei Vault-Treffer mit („Vault-Treffer (automatisch …)“).
- **Hast du viel geändert und nichts festgehalten**, erinnert der Stop-Hook einmal je Sitzung.

Du musst nichts von Hand schreiben.

## 5. Das Brain ansehen

Öffne den Vault-Ordner in [Obsidian](https://obsidian.md) („Ordner als Vault öffnen“) oder einem beliebigen Editor. Die wichtigen Orte:

| Pfad | Inhalt |
|---|---|
| `projekte/<projekt>/_index.md` | Einstieg je Projekt, klein gehalten |
| `projekte/<projekt>/entscheidungen/` | getroffene Entscheidungen mit Begründung und verworfenen Alternativen |
| `projekte/<projekt>/erkenntnisse/`, `offen/`, `läufe/` | Erkenntnisse, offene Punkte, Ergebnisse von Läufen |
| `projekte/<projekt>/sitzungen/` | kurze Sitzungsnotizen (vom Verdichtungslauf) |
| `_global/`, `_cross-project/` | projektunabhängiges Wissen, Vergleiche über Projekte |
| `_meta/` | Werkzeug, Konventionen, Zustand: **nicht von Hand ändern** |

Gezielt suchen (das macht Claude auch selbst):

```powershell
node C:/Users/ich/brain/_meta/skripte/vault-suche.js hosting deploy
node C:/Users/ich/brain/_meta/skripte/vault-suche.js --gueltig        # alle gültigen Entscheidungen
node C:/Users/ich/brain/_meta/skripte/vault-suche.js --themen          # Themenvokabular
```

## 6. Sitzungen verdichten

Am Ende jeder Sitzung sichert das Brain den Verlauf (geschwärzt) als Rohdatei. Daraus macht der Verdichtungslauf Notizen. Probelauf (zeigt nur, was offen ist, kostet nichts):

```powershell
node C:/Users/ich/brain/_meta/skripte/sitzungen-verdichten.js
```

Rohdateien jünger als 30 Minuten werden bewusst übergangen. Echter Lauf (startet Claude, **verbraucht Token**; erst einmal klein halten):

```powershell
node C:/Users/ich/brain/_meta/skripte/sitzungen-verdichten.js --ausfuehren --max 4
```

Danach `git -C C:/Users/ich/brain log --oneline` ansehen: vor und nach dem Lauf steht je ein Commit, jede Änderung der Automatik ist nachvollziehbar und umkehrbar. Neue Notizen des Laufs tragen `erzeugt: automatisch` im Kopf; lies ein paar gegen, bevor du dich darauf verlässt.

## 7. Täglich automatisch

```powershell
node installieren.js --aufgabe --vault C:/Users/ich/brain --projekte C:/Users/ich/Documents/projects
```

legt die Windows-Aufgabe `Brain-Sitzungen-verdichten` an (täglich 21:30 Uhr, verpasste Läufe werden nachgeholt, nur bei angemeldetem Benutzer). Kosten und Stellschrauben: [BETRIEB.md](BETRIEB.md).

## 8. Nach einer Woche

- Der **Start-Hook** meldet, wenn der Verdichtungslauf ausblieb oder Probleme hatte.
- Ein **Arbeitsweise-Review** (`_global/arbeitsweise-reviews/`) fasst Korrekturen, Hook-Ereignisse, Kosten und die Vault-Nutzung zusammen und wird einmal gemeldet.
- Der **Prüfbericht** (`_meta/generiert/vault-pruefung.md`) zeigt defekte Links, fehlende Angaben und Verdacht auf Geheimnisse.

Wenn etwas nicht wie beschrieben läuft: [BETRIEB.md](BETRIEB.md), Abschnitt „Probleme“.
