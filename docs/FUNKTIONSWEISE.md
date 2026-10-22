# Funktionsweise

Wie das Brain Wissen erfasst, verdichtet und wiederfindet, und wie es dabei gegen parallele Sitzungen und unbeaufsichtigtes Schreiben abgesichert ist. Die Optionen einzelner Skripte stehen im Kopf der jeweiligen Datei unter `<vault>/_meta/skripte/`, die Notizregeln in `<vault>/_meta/konventionen.md` (diese Informationen stehen bewusst nur dort).

## Datenfluss

```
 Claude-Code-Sitzung im Projekt
   │  Prompt-Hook ........ Korrektur-Hinweis, passende Vault-Treffer
   │  Claude schreibt ..... Entscheidungen, Erkenntnisse, offene Punkte  ──►  projekte/<p>/…  (sofort)
   │  Stop-Hook ........... Erinnerung (einmal je Sitzung, ab 3 geänderten Dateien)
   ▼
 SessionEnd-Hook ───────►  projekte/<p>/generiert/sitzungen-roh/JJJJ-MM-TT-<id8>.txt   (verdichtet, geschwärzt)
                                   │
                  täglich, Windows-Aufgabe (oder von Hand)
                                   ▼
 Verdichtungslauf: Claude (headless) liest Rohdateien ohne Sitzungsnotiz
                                   ▼
        Sitzungsnotiz + Entscheidungen/Erkenntnisse/offene Punkte  (erzeugt: automatisch)
                                   ▼
 Nacharbeiten: Übersicht, Prüfung, Repo-Sync, Review, Archiv, Aufräumen  ──►  Git-Commit
```

Was Claude festhält, entscheidet Claude selbst (Anweisung in der globalen `CLAUDE.md`, Block `brain:start`). Der Verdichtungslauf fängt ab, was in der Sitzung durchgerutscht ist.

## Die vier Hooks

Alle laufen über `_meta/skripte/hook-vault.js <modus>`, lesen das Hook-JSON von stdin und schreiben Ereignisse in `_meta/logs/automation.log.jsonl`. Ein Fehler bricht nie die Sitzung ab (Exit-Code 0), wird aber gemerkt und beim nächsten Start gemeldet.

| Hook | Modus | Verhalten |
|---|---|---|
| SessionStart | `start` | Nur in Projektordnern. Liefert `projekte/<p>/_index.md` (höchstens 60 Zeilen), die Titel offener Punkte (nicht `erledigt`, `veraltet`, `verworfen`; Notizen mit `aufgabe: true` im Kopf zuerst, samt `naechster-schritt`) und Hinweise: Kuration fällig, ab 10 unverarbeiteten Rohsitzungen, Verdichtungslauf ausgeblieben (über 3 Tage) oder mit Problemen, Hook-Fehler (einmal), Prüfbefunde, neuer Review (einmal). Stößt Prüfung, Repo-Sync und Review im Hintergrund an, wenn der Prüfstand älter als 12 Stunden ist. |
| UserPromptSubmit | `prompt` | Bei kurzen Nachrichten mit Korrekturformeln („immer“, „ab jetzt“, „ich hatte gesagt“ …) der Hinweis, die Vorgabe sofort festzuhalten. Zusätzlich höchstens zwei sichere Vault-Treffer zum Prompt (siehe unten). |
| Stop | `stop` | Mahnt höchstens einmal je Sitzung, wenn mindestens 3 Projektdateien (Edit/Write, ohne `node_modules`, `dist`, `.git`) geändert, aber nichts im Vault geschrieben wurde. Marker je Sitzung in `_meta/state/stop-erinnert/`. |
| SessionEnd | `end` | Sichert die Sitzung als Rohdatei, wenn sie mindestens 2 Nutzernachrichten hat und nicht in einem ausgenommenen Ordner (`private`, `.claude`, einstellbar) lief. Sitzungen außerhalb des Projektordners landen unter `_meta/generiert/sitzungen-roh/` und werden nie verdichtet. |

Läuft die Umgebungsvariable `BRAIN_AUTOMATION` (setzt der Verdichtungslauf für seine eigene Claude-Instanz), beenden sich alle Hooks sofort. Sonst würde der Lauf seine eigene Sitzung wieder sichern.

### Vault-Treffer im Prompt (`prompt-treffer.js`)

Aus dem Prompt werden Stichwörter gezogen (ohne Füllwörter), `vault-suche.js` fragt im Projekt ab, und nur Treffer, bei denen ein Stichwort im **Titel oder in den Themen** steht (oder zwei in der Kurzfassung) und der Score mindestens 12 beträgt, kommen mit: höchstens 2 je Prompt, 8 je Sitzung, jede Notiz nur einmal. Kurze Prompts, Befehle (`/…`), Shell-Eingaben und Hook-Rückmeldungen lösen nichts aus. Der Aufwand liegt bei etwa 60 ms. Es ist eine Heuristik: gelegentliche Fehltreffer sind möglich, der Hinweis ist ausdrücklich als solcher formuliert.

## Aufbau des Vaults

```
<vault>/
  projekte/<projekt>/
    _index.md                 Einstieg, klein (unter 4 KB, wird bei jedem Sessionstart geladen)
    entscheidungen/ erkenntnisse/ offen/ läufe/ sitzungen/    Notizen
    generiert/                von Skripten befüllt: Rohsitzungen, repo-stand.md (nie von Hand ändern, nicht lesen)
    archiv/                   alte Läufe und Sitzungsnotizen
  _global/                    projektunabhängiges Wissen, arbeitsweise-reviews/
  _cross-project/             Vergleiche über Projekte
  _meta/                      skripte/, vorlagen/, konventionen.md, verdichten-auftrag.md, brain.config.json,
                              state/ und logs/ (nicht im Git), generiert/ (Prüfbericht, Kuration)
```

Der Projektname im Vault ist der Ordnername in kebab-case (`MeinProjekt` → `mein-projekt`); abweichende Namen stehen in `brain.config.json` unter `namen`.

## Der Verdichtungslauf (`sitzungen-verdichten.js`)

1. **Plan:** Rohdateien ohne Sitzungsnotiz (die 8-stellige Sitzungs-ID steht im Kopf einer Notiz), älter als `mindestAlterMin`. Ohne `--ausfuehren` nur Anzeige.
2. **Sperre** `_meta/state/verdichten.lock` (zwei Läufe gleichzeitig sind ausgeschlossen; eine Sperre gilt als veraltet, wenn der Prozess tot ist oder sie über 2 Stunden alt ist). **Git-Commit** „Stand vor Verdichtungslauf“.
3. **Je Batch** (Standard 4 Sitzungen eines Projekts, höchstens 12 je Lauf) startet das Skript `claude -p` mit Auftrag `verdichten-auftrag.md`. Die Instanz darf lesen (`Read`, `Glob`, `Grep`), Notizen schreiben und bearbeiten (`Write`, `Edit`) und nur `vault-suche.js` und `vault-pruefung.js` ausführen. `_meta/` und `generiert/` sind für sie gesperrt. Ihre Sitzung wird nicht gespeichert (`--no-session-persistence`), MCP-Server und Skills sind aus, das Budget je Batch ist begrenzt (`--max-budget-usd`), ein Zeitlimit gilt.
4. **Nach jedem Batch prüft das Skript selbst:** neue Notizen bekommen `erzeugt: automatisch`; mehrdeutige Links (Notizname in mehreren Projekten) werden auf den Pfad im eigenen Projekt umgeschrieben; geschützte Dateien (`_meta/…`) müssen unverändert sein; jede Rohsitzung muss eine Notiz mit ihrer ID haben. Bei einem Fehler werden die weiteren Batches dieses Projekts übersprungen.
5. **Nacharbeiten:** Marker älter als 14 Tage löschen, verdichtete Rohdateien älter als `rohAufbewahrungTage` löschen (Git behält sie; Rohdateien ohne Notiz bleiben immer), Log ab 5 MB rotieren, dann `sitzungen-index.js`, `vault-pruefung.js`, `sync-projekte.js`, `arbeitsweise-review.js`, `vault-archiv.js --ausfuehren`.
6. **Zustand** nach `_meta/state/verdichten-letzter.json` (liest der Start-Hook), **Git-Commit** „Verdichtungslauf n/m Sitzungen“.

Auch wenn nichts zu verdichten ist, laufen Nacharbeiten und Commit (mit `--ausfuehren`).

## Skripte im Überblick

| Skript | Zweck |
|---|---|
| `hook-vault.js` | die vier Hooks für Claude Code |
| `hook-vault-auggie.js` (+ `.cmd`) | Auggie-Hooks (SessionStart, PostToolUse, Stop, SessionEnd); ein Skript für alle Ereignisse, Auggie erlaubt je Hook nur einen Pfad ohne Argumente, daher der `.cmd`-Starter. Gleicher Start-Kontext, gleiche Stop-Erinnerung (ab 3 Projektdateien), Rohsitzung geschwärzt in denselben Ordner. Kein Pendant zu UserPromptSubmit: keine Korrektur-Erkennung und keine Vault-Treffer im Prompt |
| `hook-lib.js` | gemeinsame Bausteine beider Hook-Skripte: Logger (`tool: claude` bzw. `auggie` im Log), Hook-Fehler-Zustand, Wartungsstart, Start-Kontext |
| `hook-vault-codex.js` | Codex-Adapter (SessionStart, SubagentStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) aus `~/.codex/hooks.json`: begrenzter Startkontext, Suchtreffer je Prompt (höchstens 2, 8 je Sitzung), Pflege-Erinnerung ab 3 erkannten Projekt-Änderungen (nur explizite Dateipfade und `apply_patch`), geschwärzte Sichtnachrichten als Rohsitzung `JJJJ-MM-TT-codex<hash>.txt` (ab 2 Nutzerbeiträgen). Zustand je gehashter Sitzungs-ID in `_meta/state/codex-sessions/`, Sperre je Sitzung. Kein Modellaufruf; das Transkriptformat von Codex gilt als instabil, unbekannte Formate werden protokolliert statt geraten |
| `prompt-treffer.js` | Baustein des Prompt-Hooks (Treffer zu einem Prompt) |
| `vault-suche.js` | gezielte Suche: Begriffe, `--gueltig`, `--themen`, `--thema`, `--kette`, `--verweise`, `--typ`, `--alle`, `--archiv` |
| `sitzungen-verdichten.js` | der Verdichtungslauf |
| `vault-pruefung.js` | Qualitätsprüfung, schreibt `_meta/generiert/vault-pruefung.md` |
| `sitzungen-index.js` | `projekte/<p>/sitzungen/_uebersicht.md` |
| `sitzungen-extrahieren.js` | sichert rückwirkend alle bisherigen Claude-Sitzungen des Rechners als Rohdateien (Probelauf ohne `--ausfuehren`) |
| `vault-archiv.js` | verschiebt Läufe und Sitzungsnotizen älter als `archivTage` nach `archiv/` (nichts wird gelöscht) |
| `sync-projekte.js` | meldet Projekte mit neuen Repo-Commits seit der letzten Kuration (`--mark <projekt>` nach erledigter Kuration) und schreibt je Repo `generiert/repo-stand.md` (Git-Stand, Commits, Struktur, Markdown-Dokumente, Abhängigkeiten); optional Spiegel der Repo-Doku (`repoDokuSpiegeln`) |
| `arbeitsweise-review.js` | wöchentlicher Review aus Korrekturen, Hook-Ereignissen, Kosten und Vault-Nutzung (regelbasiert, kostenlos); mit `"reviewModus": "modell"` übernimmt `arbeitsweise-review-modell.js` |
| `arbeitsweise-review-modell.js` | Review-Alternative mit Claude-Aufruf: wertet die (geschwärzten) Nutzernachrichten aller Sitzungen seit dem letzten Review aus und findet auch Muster ohne Schlüsselwort; alle `reviewTage` (14), Budget `reviewBudgetUsd`, Notiz unter `reviewNotizOrdner`; ausgenommene Ordner und der Vault selbst werden nie gelesen |
| `aufgabe-einrichten.ps1` | legt die Windows-Aufgabe an |
| `vault-sicherung.js` | lokale Git-Sicherung des Vaults (Sperre, Fehlerstatus in `_meta/state/git-sicherung.json`, Log); der Verdichtungslauf ruft sie vor und nach dem Lauf, `--einrichten` initialisiert ein Repo |
| `sitzung-lib.js` | gemeinsame Bibliothek: Verdichten und Schwärzen, Projektzuordnung, Sperre, atomares Schreiben |

## Die Vault-Prüfung

`vault-pruefung.js` meldet: defekte und mehrdeutige Links, verwaiste Notizen, unvollständige Köpfe, fehlende `kurz`/`themen` bei gültigen Entscheidungen und Erkenntnissen, fehlende `herkunft`, Probleme in Ersetzungsketten, mögliche Doppelungen, **Verdacht auf Geheimnisse oder personenbezogene Daten** in Notizen und `_index.md` über 4096 Byte. Der Bericht nennt die Fundstellen, bei Geheimnissen nur gekürzt.

## Sicherheit und Parallelität

- **Schwärzung** (`sitzung-lib.js`, `redact`): Tokens und Schlüssel gängiger Formate, JWT, lange Zufallszeichenketten, Werte nach `token=`, `password:` u. ä., E-Mail-Adressen, Telefonnummern, Anschriften. Regelbasiert, deshalb keine Garantie.
- **Ausgenommene Ordner** (`ausgenommen`, Standard `private` und `.claude`): von dort wird nichts gesichert.
- **Mehrere Sitzungen parallel:** Rohdatei und Stop-Marker tragen die Sitzungs-ID; gemeinsame Dateien (Prüfstand, Zustand) werden atomar geschrieben (Temp-Datei, Umbenennen); `vault-pruefung`, `sync-projekte`, `arbeitsweise-review` und der Verdichtungslauf nehmen je eine Sperre; Claude legt Notizen nur neu an oder ändert sie per Edit (Edit schlägt fehl, wenn die Datei sich seit dem Lesen geändert hat).
- **Rückgängig:** Der Vault ist ein lokales Git-Repo. Der Verdichtungslauf committet vor und nach sich selbst, sodass seine Änderungen von denen laufender Sitzungen getrennt bleiben. `.gitignore` schließt `_meta/state/`, `_meta/logs/` und Lockdateien aus.
