# Brain-Kit

Ein Wissens-Vault („Brain“) für Claude Code: Claude hält Entscheidungen, Erkenntnisse und offene Punkte aus allen deinen Projekten als Markdown-Notizen fest, findet sie bei der nächsten Aufgabe wieder und verdichtet ältere Sitzungen automatisch. Der Vault ist ein normaler Ordner (auch in Obsidian lesbar). Dieses Repo enthält nur das **Werkzeug**, keine Inhalte.

> Stand: Version 0.1.0, **nur Windows**, **deutsch** (Konventionen, Vorlagen, Prompts und Erkennungsmuster). Privates Repo, keine Lizenz hinterlegt.

## Was es tut

| Baustein | Wirkung |
|---|---|
| **SessionStart-Hook** | lädt je Projekt die kleine `_index.md` und die Titel offener Punkte; meldet ausgebliebene Verdichtung, Hook-Fehler und Prüfbefunde |
| **Prompt-Hook** | liefert zu einem Prompt die ein bis zwei sicheren Vault-Treffer mit; erinnert bei Korrekturen („immer“, „ich hatte gesagt“) ans sofortige Festhalten |
| **Stop-Hook** | mahnt höchstens einmal je Sitzung, wenn mehrere Projektdateien geändert, aber nichts im Vault festgehalten wurde |
| **SessionEnd-Hook** | sichert jede Sitzung verdichtet und geschwärzt als Rohdatei unter `projekte/<projekt>/generiert/sitzungen-roh/` |
| **Verdichtungslauf** | täglich (Windows-Aufgabe): eine unbeaufsichtigte Claude-Instanz macht aus Rohsitzungen Sitzungsnotizen, Entscheidungen und Erkenntnisse |
| **Wartung** | Vault-Prüfung (Links, Kopf, Herkunft, Geheimnis-Verdacht, Indexgröße), Sync der Repo-Commits, Archivierung, wöchentlicher Arbeitsweise-Review |
| **`vault-suche.js`** | gezielte Suche mit Typ, Status, Themen, Ersetzungsketten |

Welche Regeln Claude beim Festhalten befolgt, steht in `CLAUDE-baustein.md` (landet in deiner globalen `CLAUDE.md`) und im Vault unter `_meta/konventionen.md`.

## Voraussetzungen

- Windows 10/11, **Node.js ≥ 20**, **Git** im PATH
- **Claude Code** (CLI, angemeldet). Der Verdichtungslauf startet `claude -p` und verbraucht Token bzw. Kontingent
- optional [Obsidian](https://obsidian.md) zum Lesen

## Installation

```powershell
git clone https://github.com/<konto>/brain-kit
cd brain-kit
node installieren.js --trocken                 # zeigt nur, was passieren würde
node installieren.js --vault C:/Users/ich/brain --projekte C:/Users/ich/Documents/projects
node installieren.js --pruefen --vault C:/Users/ich/brain   # Diagnose
```

Der Installer

1. kopiert Skripte, Vorlagen, Konventionen und Auftrag in `<vault>/_meta/` und legt Ordner, `brain.config.json` und ein lokales Git-Repo an,
2. trägt die vier Hooks in `~/.claude/settings.json` ein (fremde Hooks bleiben, die alte Datei wird als `.brain-sicherung-<zeit>` gesichert),
3. ergänzt `~/.claude/CLAUDE.md` um die Arbeitsanweisung (zwischen `<!-- brain:start -->` und `<!-- brain:end -->`),
4. richtet **auf Wunsch** (`--aufgabe`) die tägliche Windows-Aufgabe ein. Ohne die Aufgabe sammelt das Brain nur Rohsitzungen, verdichtet wird dann von Hand: `node <vault>/_meta/skripte/sitzungen-verdichten.js --ausfuehren`.

Er ist idempotent: ein zweiter Lauf ändert nichts Bestehendes. Ab der nächsten Claude-Code-Sitzung ist das Brain aktiv. `--ohne-hooks` und `--ohne-claude-md` lassen die jeweiligen Dateien unangetastet.

**Update:** Kit neu holen, `node installieren.js` mit denselben Parametern. Skripte, Vorlagen, Konventionen und Auftrag werden ersetzt (die alte Fassung bleibt als `.bak`). `brain.config.json` und alle Notizen werden nie angefasst. Eigene Änderungen an Kit-Dateien gehen sonst verloren: besser im Kit ändern.

**Deinstallation:** `node installieren.js --deinstallieren --vault <vault>` entfernt Hooks und CLAUDE.md-Block. Der Vault bleibt. Aufgabe: `Unregister-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' -Confirm:$false`.

## Wichtig zu wissen

**Datenschutz.** Die Rohsitzungen enthalten den Gesprächsverlauf (Nutzereingaben, Antworten, Befehlszeilen). Vor dem Speichern werden Geheimnisse (Tokens, Schlüssel), E-Mail-Adressen, Telefonnummern und Anschriften regelbasiert geschwärzt. **Das ist keine Garantie.** Der Vault gehört nicht unbesehen in ein öffentliches Repo; die Prüfung meldet Verdacht auf Geheimnisse in Notizen (`_meta/generiert/vault-pruefung.md`). Ordner, die nie erfasst werden sollen, stehen in `brain.config.json` unter `ausgenommen` (Standard: `private`, `.claude`).

**Kosten.** Jeder Verdichtungs-Batch (4 Sitzungen) startet eine Claude-Instanz. Erfahrungswerte: etwa 0,2 bis 0,8 USD je Batch, ein leerer Aufruf allein etwa 0,12 USD. Standard: Modell `sonnet`, höchstens 12 Sitzungen je Lauf, 1,50 USD Limit je Batch (`brain.config.json`, Abschnitt `verdichten`). Bei Abrechnung über Extra Usage ist das echtes Geld.

**Unbeaufsichtigtes Schreiben.** Die Instanz darf lesen, Notizen anlegen und bearbeiten und nur `vault-suche.js` und `vault-pruefung.js` ausführen; `_meta/` und `generiert/` sind für sie gesperrt. Das Skript prüft nach jedem Batch, ob jede Sitzung eine Notiz hat und geschützte Dateien unverändert sind, und kennzeichnet neue Notizen mit `erzeugt: automatisch`. Der Vault ist ein lokales Git-Repo; der Lauf committet vor und nach sich selbst, jede Änderung ist mit `git log`/`git restore` umkehrbar. **Ein Remote ist nicht eingerichtet:** ohne Backup außerhalb des Rechners ist der Vault bei Datenträgerverlust weg.

**Parallele Sitzungen** sind unterstützt: Sperren und atomares Schreiben für gemeinsame Dateien, Sitzungs-ID in Rohdatei und Stop-Marker, Notizen nur neu anlegen oder per Edit ändern. Läufe der Automatisierung setzen `BRAIN_AUTOMATION=1`; die Hooks tun dann nichts.

**Grenzen.** Nur Windows (Aufgabenplanung, Claude-Pfad `~/.local/bin/claude.exe`). Deutsch. Die Treffer im Prompt-Hook sind eine Heuristik (Stichwörter im Titel/Thema), sie irren sich gelegentlich: bei zu viel Rauschen `MIN_SCORE` in `prompt-treffer.js` anheben.

## Betrieb

- Logs und Zustand: `<vault>/_meta/logs/automation.log.jsonl`, `<vault>/_meta/state/` (nicht im Git)
- Prüfbericht: `<vault>/_meta/generiert/vault-pruefung.md`
- Start-Hook meldet: Verdichtung seit 3 Tagen ausgeblieben oder fehlerhaft, Hook-Fehler, Prüfbefunde, neuer Review
- Skripte und ihre Optionen: Kopf der jeweiligen Datei und `<vault>/_meta/konventionen.md`

## Aufbau dieses Repos

```
installieren.js       Installer, Diagnose, Deinstallation
CLAUDE-baustein.md    Arbeitsanweisung für die globale CLAUDE.md (Platzhalter {{VAULT}})
kit/                  was in den Vault kopiert wird (_meta/skripte, vorlagen, konventionen, auftrag, Konfigurationsvorlage)
tests/                Integrationstests im Temp-Vault (node --test)
VERSION               Kit-Version
```

`kit/` ist ein Schnappschuss des Entwicklungs-Vaults und wird von dort per `kit-exportieren.js` erzeugt (feste Positivliste, Scan auf persönliche Spuren). Nicht von Hand ändern, sondern im Entwicklungs-Vault ändern und neu exportieren.

## Tests

```powershell
node --test
```

Die Tests installieren in einen Temp-Ordner (eigene Einstellungen, eigener Vault) und rühren nichts Echtes an. Der Verdichtungslauf selbst (echter Claude-Aufruf) ist nicht Teil der Tests, nur sein Probelauf.
