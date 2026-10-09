# Brain-Kit

Ein Wissens-Vault („Brain“) für Claude Code. Claude hält Entscheidungen, Erkenntnisse und offene Punkte aus allen deinen Projekten als Markdown-Notizen fest, findet sie bei der nächsten Aufgabe wieder und verdichtet ältere Sitzungen automatisch. Der Vault ist ein normaler Ordner und lässt sich auch in Obsidian lesen. Dieses Repo enthält nur das **Werkzeug**, keine Inhalte.

> Version 0.1.0 · **nur Windows** · **deutsch** (Konventionen, Vorlagen, Prompts und Erkennungsmuster) · privates Repo, keine Lizenz hinterlegt

## Wozu

Ohne Brain beginnt jede Claude-Sitzung ohne Gedächtnis: Entscheidungen müssen neu erklärt, Vorgaben wiederholt, Fehlannahmen neu entdeckt werden. Mit dem Brain

- erfährt Claude zu Beginn einer Sitzung den Stand des Projekts und bekommt zu einem Thema die passenden früheren Entscheidungen mitgeliefert,
- werden Entscheidungen samt Begründung und verworfenen Alternativen sofort festgehalten, ohne dass du etwas von Hand pflegst,
- wird alles, was in einer Sitzung durchrutscht, nachträglich aus dem Verlauf verdichtet,
- bleibt jede Änderung nachvollziehbar (Git) und der Vault geprüft (Links, Pflichtangaben, Verdacht auf Geheimnisse).

## Schnellstart

```powershell
git clone https://github.com/<konto>/brain-kit
cd brain-kit
node installieren.js --trocken                 # nur anzeigen, was passieren würde
node installieren.js --vault C:/Users/ich/brain --projekte C:/Users/ich/Documents/projects
node installieren.js --pruefen --vault C:/Users/ich/brain
```

Dann Claude Code neu starten, in einem Projekt unter dem Projekte-Ordner arbeiten, und nach einigen Sitzungen den Verdichtungslauf einrichten (`--aufgabe`). Der Weg im Detail: [Erste Schritte](docs/ERSTE-SCHRITTE.md).

**Voraussetzungen:** Windows 10/11, Node.js ≥ 20, Git im PATH, Claude Code (CLI, angemeldet). Optional Obsidian zum Lesen.

## Was der Installer tut

1. kopiert Skripte, Vorlagen, Konventionen und Auftrag nach `<vault>/_meta/` und legt Ordner, `brain.config.json` und ein lokales Git-Repo an,
2. trägt die vier Hooks in `~/.claude/settings.json` ein (fremde Hooks bleiben),
3. ergänzt `~/.claude/CLAUDE.md` um die Arbeitsanweisung (Block zwischen `<!-- brain:start … -->` und `<!-- brain:end -->`),
4. richtet **nur auf Wunsch** (`--aufgabe`) die tägliche Windows-Aufgabe ein.

Er ist idempotent und sichert beide Dateien vorher (`.brain-sicherung-<zeit>`). `--ohne-hooks`, `--ohne-claude-md`, `--trocken`, `--pruefen` und `--deinstallieren` gibt es auch. **Update:** Kit neu holen, `node installieren.js` mit denselben Parametern: Kit-Dateien im Vault werden ersetzt (alte Fassung als `.bak`), Konfiguration und Notizen nie.

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [Erste Schritte](docs/ERSTE-SCHRITTE.md) | Installation bis zur ersten verdichteten Sitzung, Schritt für Schritt |
| [Funktionsweise](docs/FUNKTIONSWEISE.md) | Datenfluss, Hooks, Vault-Aufbau, Verdichtungslauf, Skripte, Sicherheits- und Parallelitätsmodell |
| [Betrieb](docs/BETRIEB.md) | Konfiguration, Kosten, Zustand und Logs, Fehlersuche, Wartung |
| [Entwicklung](docs/ENTWICKLUNG.md) | Arbeitsweise am Kit: Export aus dem Vault, Tests, CI, typische Änderungen |
| `CLAUDE-baustein.md` | die Arbeitsanweisung, die in die globale `CLAUDE.md` übernommen wird |

Die Regeln für Notizen (Kopf, Typen, Entscheidungsketten, Archiv) stehen nach der Installation in `<vault>/_meta/konventionen.md`.

## Wichtig zu wissen

**Datenschutz.** Die Rohsitzungen enthalten den Gesprächsverlauf (Nutzereingaben, Antworten, Befehlszeilen). Vor dem Speichern werden Geheimnisse, E-Mail-Adressen, Telefonnummern und Anschriften regelbasiert geschwärzt, **das ist keine Garantie**. Ordner, von denen nie etwas erfasst werden soll, stehen in `brain.config.json` unter `ausgenommen` (Standard `private` und `.claude`). Der Vault gehört nicht unbesehen in ein öffentliches Repo; die Prüfung meldet Verdacht auf Geheimnisse in Notizen.

**Kosten.** Nur der Verdichtungslauf verbraucht Token: je Batch (4 Sitzungen) eine Claude-Instanz, nach Erfahrung etwa 0,2 bis 0,8 USD, ein leerer Aufruf allein etwa 0,12 USD. Standard: Modell `sonnet`, höchstens 12 Sitzungen je Lauf, 1,50 USD Limit je Batch. Bei Abrechnung über Extra Usage ist das echtes Geld. Stellschrauben: [Betrieb](docs/BETRIEB.md).

**Unbeaufsichtigtes Schreiben.** Die Instanz darf Notizen lesen, anlegen und bearbeiten und nur `vault-suche.js` und `vault-pruefung.js` ausführen; `_meta/` und `generiert/` sind für sie gesperrt. Nach jedem Batch prüft das Skript das Ergebnis, kennzeichnet neue Notizen mit `erzeugt: automatisch` und committet vor und nach dem Lauf: jede Änderung ist mit `git log` und `git restore` umkehrbar. **Ein Remote für den Vault ist nicht eingerichtet:** ohne Kopie außerhalb des Rechners ist er bei Datenträgerverlust weg.

**Parallele Sitzungen** sind unterstützt (Sperren, atomares Schreiben, Sitzungs-ID in Rohdatei und Marker). Läufe der Automatisierung setzen `BRAIN_AUTOMATION=1`, dann tun die Hooks nichts.

**Grenzen.** Nur Windows (Aufgabenplanung, Claude-Pfad), nur deutsch. Die Vault-Treffer im Prompt sind eine Heuristik und irren sich gelegentlich. Der echte Verdichtungslauf ist nicht Teil der automatischen Tests.

## Inhalt dieses Repos

```
installieren.js     Installer, Diagnose, Deinstallation
CLAUDE-baustein.md  Arbeitsanweisung für die globale CLAUDE.md (Platzhalter {{VAULT}})
kit/                was in den Vault kopiert wird (Schnappschuss, nicht von Hand ändern)
docs/               Dokumentation
tests/              Integrationstests (node --test)
VERSION             Kit-Version
```
