# Entwicklung

Für alle, die am Kit selbst arbeiten. Wer das Brain nur benutzt, braucht dieses Dokument nicht.

## Zwei Orte, eine Quelle

```
Entwicklungs-Vault  _meta/skripte, _meta/vorlagen, konventionen.md, verdichten-auftrag.md   ← hier wird geändert und im Betrieb erprobt
        │  node _meta/skripte/kit-exportieren.js
        ▼
brain-kit/kit/      Schnappschuss (nicht von Hand ändern)  ──►  installieren.js kopiert ihn in jeden Vault
```

`kit-exportieren.js` liegt nur im Entwicklungs-Vault und gehört nicht zum Kit. Es kopiert eine feste Positivliste (Skripte `*.js` und `*.ps1`, Vorlagen, Konventionen, Auftrag, `.gitignore` als `vault.gitignore`) und erzeugt aus der Konfiguration des Entwicklungs-Vaults die Vorlage `brain.config.example.json` mit den Platzhaltern `{{PROJEKTE}}` und `{{HEUTE}}`. Danach scannt es das Ergebnis auf Benutzername, Home- und Vault-Pfad, Projektnamen des Entwicklungs-Vaults und Geheimnis-/Kontaktmuster und beendet sich bei einem Fund mit Exit-Code 1. Die beiden Dateien, in denen die Schwärzmuster selbst stehen, sind vom Geheimnis-Scan ausgenommen (Fehlalarme); der Namens- und Pfad-Scan gilt für sie weiter.

**Ablauf einer Änderung:**

1. Im Entwicklungs-Vault ändern und im Betrieb erproben.
2. `node _meta/skripte/kit-exportieren.js` (Ziel standardmäßig `<projektOrdner>/brain-kit/kit`).
3. Im Repo `node --test`, dann committen und pushen. Ändert sich das Verhalten, `VERSION` und die README anpassen.

## Tests

```powershell
node --test
```

Integrationstests in `tests/kit.test.js`. Jeder Test baut sich in einem Temp-Ordner eine eigene Umgebung (Vault, Projektordner, `settings.json`, `CLAUDE.md`) und ruft die echten Skripte als Prozess auf; weder das Benutzerprofil noch ein echter Vault werden angefasst. Abgedeckt sind: Installer (Gerüst, Idempotenz, fremde Hooks bleiben, Probelauf, Deinstallation, Diagnose), Vault-Prüfung, die vier Hooks (Start, Stop, SessionEnd, Automatisierungssperre), ausgenommene Ordner, Schwärzung und Geheimnis-Scan, Sperre und der Probelauf der Verdichtung.

**Nicht abgedeckt:** der echte Verdichtungslauf (ein Claude-Aufruf kostet Token und ist nicht deterministisch) und die Windows-Aufgabe. Beides prüft man von Hand: `node _meta/skripte/sitzungen-verdichten.js --ausfuehren --max 2` in einem Test-Vault.

Hinweis zu Fallen beim Schreiben von Skripten per Shell: Regex mit Backslashes und Backticks gehen in Heredocs und `node -e` leicht verloren. Skripte als Datei schreiben und danach `node --check` ausführen.

## CI

`.github/workflows/ci.yml` führt `node --test` auf `windows-latest` mit Node 22 aus (bei jedem Push auf `main` und bei Pull Requests).

## Typische Änderungen

- **Neuer Hook oder anderer Timeout:** Liste `HOOKS` in `installieren.js` und Modus in `hook-vault.js` anpassen; der Installer ersetzt vorhandene Brain-Hooks bei der nächsten Installation (Erkennung am Dateinamen `hook-vault.js`).
- **Neue Konfigurationsoption:** im Skript mit Standardwert lesen, im Entwicklungs-Vault in `brain.config.json` eintragen (der Export übernimmt den Abschnitt `verdichten` und die übrigen Schlüssel), in `docs/BETRIEB.md` in die Tabelle aufnehmen.
- **Neue Notizregel:** `konventionen.md` und, falls Claude sie befolgen soll, `CLAUDE-baustein.md` (Block in der globalen `CLAUDE.md`) und `verdichten-auftrag.md` (für den Lauf) anpassen. Skripte, die eine Regel mechanisch durchsetzen (zum Beispiel `erzeugt: automatisch`, Pfadlinks), tun das im Skript statt im Prompt: das Modell hält Prompt-Regeln nicht zuverlässig ein.
- **Andere Plattform oder Sprache:** betroffen sind die Aufgabenplanung (`aufgabe-einrichten.ps1`, Diagnose in `installieren.js`), der Claude-Pfad in `sitzungen-verdichten.js` und die deutschen Muster (Korrekturformeln und Füllwörter in `sitzung-lib.js` und `prompt-treffer.js`, Telefon-/Anschriftsmuster, Vorlagen, Konventionen, Auftrag).
