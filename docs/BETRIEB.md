# Betrieb

Konfiguration, Kosten, Wartung und Fehlersuche. Alle Pfade relativ zum Vault, falls nicht anders angegeben.

## Konfiguration (`_meta/brain.config.json`)

Der Installer legt die Datei an und überschreibt sie nie. Fehlt ein Schlüssel, gilt der Standard.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `projektOrdner` | `~/projects` | Ordner mit den Projekt-Repos; der erste Unterordner bestimmt das Projekt einer Sitzung |
| `ausgenommen` | `["private", ".claude"]` | Ordner unter `projektOrdner`, von denen nichts im Vault landet |
| `namen` | `{}` | abweichende Vault-Namen: `{"MeinProjekt": "mein-projekt"}` (sonst kebab-case des Ordnernamens) |
| `kurzAb` | Installationsdatum | ab diesem Datum verlangt die Prüfung `kurz` und `themen` bei gültigen Entscheidungen und Erkenntnissen |
| `archivTage` | `60` | Läufe und Sitzungsnotizen älter als so viele Tage gehen nach `archiv/` (Belege gültiger Notizen bleiben) |
| `reviewModus` | `regel` | `modell`: Arbeitsweise-Review per Claude-Aufruf statt regelbasiert (kostet Token, findet mehr) |
| `reviewTage` | `14` | Abstand der Reviews im Modus `modell` |
| `reviewModell` | `sonnet` | Modell des Reviews im Modus `modell` |
| `reviewBudgetUsd` | `1.5` | Kostengrenze je Review im Modus `modell` |
| `reviewNotizOrdner` | `_global/arbeitsweise-reviews` | Ablageort der Review-Notizen im Modus `modell` |
| `repoDokuSpiegeln` | `false` | `true` spiegelt alle Markdown-Dokumente der Repos nach `projekte/<p>/generiert/repo-docs/` (kopiert Repo-Inhalte in den Vault) |
| `repoDokuAusgenommen` | `[]` | zusätzliche Ordnernamen, die der Doku-Spiegel überspringt |
| `repoDokuOhneProjekte` | `[]` | Projekte (Vault-Namen) ohne Doku-Spiegel, z. B. mit eigenem Spiegel |
| `verdichten.modell` | `sonnet` | Modell der Verdichtungs-Instanz |
| `verdichten.budgetUsdProBatch` | `1.5` | Kostengrenze je Batch (`--max-budget-usd`) |
| `verdichten.batchGroesse` | `4` | Sitzungen je Claude-Aufruf |
| `verdichten.maxSitzungenProLauf` | `12` | Obergrenze je Lauf |
| `verdichten.mindestAlterMin` | `30` | Rohdateien jünger als so viele Minuten werden übergangen |
| `verdichten.timeoutMin` | `25` | Zeitlimit je Batch |
| `verdichten.rohAufbewahrungTage` | `90` | verdichtete Rohdateien älter als so viele Tage werden gelöscht (Git behält sie) |

Weitere Schwellen stehen als Konstanten am Anfang der jeweiligen Skripte (Stop-Hook ab 3 Dateien, Treffer-Score 12, Prüfstand 12 Stunden, Log-Rotation 5 MB, Kuration ab 5 Commits oder 14 Tagen). Änderungen daran gehen bei einem Kit-Update verloren: im Kit ändern.

Die Umgebungsvariable `CLAUDE_BIN` überschreibt den Pfad zur Claude-CLI für den Verdichtungslauf (Standard `~/.local/bin/claude.exe`, sonst `claude` aus dem PATH).

## Kosten

Der Verdichtungslauf ist die einzige Komponente, die Token verbraucht (die Hooks sind lokal und kosten nichts). Erfahrungswerte aus dem Entwicklungsbetrieb: ein leerer Claude-Aufruf etwa 0,12 USD (rund 29.000 Token Grundkontext), ein Batch mit 2 bis 4 Sitzungen etwa 0,2 bis 0,8 USD, ein Rückstand von 15 Sitzungen zusammen etwa 2,20 USD. Bei laufendem Betrieb entstehen ein bis drei Sitzungen pro Tag. Das sind Richtwerte, kein Versprechen: der tatsächliche Verbrauch steht je Lauf im Log (`verdichten_batch`, Feld `kostenUsd`) und im wöchentlichen Review.

Stellschrauben: `maxSitzungenProLauf` und `budgetUsdProBatch` senken, `modell` wählen, den Lauf von Hand statt täglich starten. Aufgabe pausieren: `Disable-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten'`. Wird über „Extra Usage“ abgerechnet, ist jeder Lauf echtes Geld.

## Zustand und Logs

| Datei | Inhalt |
|---|---|
| `_meta/logs/automation.log.jsonl` | alle Ereignisse als JSON-Zeilen mit Zeitstempel, Quelle und Ereignis (ab 5 MB rotiert nach `automation.<datum>.log.jsonl`) |
| `_meta/logs/vault-suche.log.jsonl` | jede Suche (Begriffe, Trefferzahl, Dauer, `quelle`: `claude` oder `hook`) |
| `_meta/state/verdichten-letzter.json` | Ergebnis des letzten Verdichtungslaufs |
| `_meta/state/vault-pruefung.json` | letzter Prüfstand (Zahlen je Projekt) |
| `_meta/state/kuration.json` | je Projekt der Commit der letzten Kuration |
| `_meta/state/hook-fehler.json`, `arbeitsweise.json`, `arbeitsweise-lauf.json` | Meldezustand für den Start-Hook |
| `_meta/state/stop-erinnert/`, `prompt-treffer/` | Marker je Sitzung (nach 14 Tagen aufgeräumt) |
| `_meta/state/*.lock` | Sperren laufender Skripte |

Häufige Ereignisse im Log: `sessionstart_kontext`, `sessionend_gesichert`, `sessionend_uebersprungen` (mit `grund`: zu kurz, ausgenommen, Verlaufsdatei fehlt, nicht lesbar), `stop_pruefung`, `korrektur_erkannt`, `vault_treffer_injiziert`, `verdichten_start`, `verdichten_batch`, `verdichten_batch_problem`, `verdichten_ende`, `verdichten_nichts`, `vault_pruefung`, `kuration_geprueft`, `review_geschrieben`, `hook_fehler`. Ein Blick ins Log ist der schnellste Weg, ein Verhalten nachzuvollziehen.

## Probleme

| Symptom | Ursache und Abhilfe |
|---|---|
| Kein Brain-Kontext zu Beginn einer Sitzung | `node installieren.js --pruefen`. Hooks fehlen oder zeigen auf einen anderen Vault: Installer erneut ausführen und Claude Code neu starten. Außerdem greift der Start-Hook nur in Ordnern **unter** `projektOrdner` und nicht in `ausgenommen`. |
| Claude schreibt keine Notizen | Der Block `brain:start` in `~/.claude/CLAUDE.md` fehlt (`--pruefen`). Ohne ihn gibt es nur die Hooks, aber keine Anweisung. |
| „Der Verdichtungslauf lief seit N Tagen nicht“ | Aufgabe prüfen: `schtasks /Query /TN Brain-Sitzungen-verdichten /V /FO LIST`. Typische Ursachen: nicht angemeldet, `node` im Task nicht auffindbar (bei Versionsmanagern wie Volta den direkten Pfad zur `node.exe` in der Aufgabe eintragen), Claude nicht angemeldet. Von Hand starten und die Ausgabe ansehen: `node _meta/skripte/sitzungen-verdichten.js --ausfuehren`. |
| „Ein anderer Verdichtungslauf ist aktiv“ | Ein Lauf hält `_meta/state/verdichten.lock`. Die Sperre verfällt bei totem Prozess oder nach 2 Stunden. Läuft nachweislich nichts, die Datei löschen. |
| Hinweis „Verdichtungslauf mit Problemen“ | Im Log nach `verdichten_batch_problem` suchen: `fehler`, `fehlend` (Rohdateien ohne Notiz), `geschuetzteGeaendert` (Instanz hat geschützte Dateien angefasst). Änderungen ansehen oder zurückdrehen: `git -C <vault> log --oneline`, `git -C <vault> show <commit>`, `git -C <vault> restore <datei>`. |
| Prüfbefunde im Start-Hook | `_meta/generiert/vault-pruefung.md` nennt Datei und Grund. Beim nächsten Anfassen der Notiz beheben. |
| Verdacht auf Geheimnis | Fundstelle prüfen (Fehlalarme sind möglich); echte Geheimnisse in der Notiz entfernen und im Dienst **widerrufen**. Der Git-Verlauf enthält frühere Fassungen. |
| Ein Hook-Fehler wird gemeldet | Im Log nach `hook_fehler` suchen (Meldung und Zeit). `hook_json_repariert` ist harmlos (Windows-Pfade im Hook-JSON). |
| Zu viele unpassende Vault-Treffer im Prompt | `MIN_SCORE` in `prompt-treffer.js` anheben; der Review weist die Zahl der gelieferten Treffer aus. |
| Der Stop-Hook mahnt zu oft oder nie | Schwelle `STOP_MIN_DATEIEN` in `hook-vault.js` (Standard 3). |
| Rohdateien ohne Projekt | Sitzungen außerhalb von `projektOrdner` liegen unter `_meta/generiert/sitzungen-roh/` und werden nicht verdichtet; sie lassen sich gefahrlos löschen. |

## Wartung

- **Backup:** Der Vault ist ein lokales Git-Repo **ohne Remote**. Gegen Datenträgerverlust hilft nur eine Kopie außerhalb des Rechners (zum Beispiel ein privates Remote: `git -C <vault> remote add origin <url>` und `git push`). Vorher den Prüfbericht auf Geheimnis-Verdacht ansehen.
- **Update des Kits:** neue Fassung holen, `node installieren.js` mit denselben Parametern. Kit-Dateien im Vault werden ersetzt (alte Fassung als `.bak`), Konfiguration und Notizen nie.
- **Rückwirkend erfassen:** `node _meta/skripte/sitzungen-extrahieren.js` (Probelauf) und `--ausfuehren` sichern alle bisherigen Claude-Sitzungen des Rechners als Rohdateien; danach verdichtet der Lauf sie schrittweise (`maxSitzungenProLauf`).
- **Archivieren:** passiert nach jedem Verdichtungslauf; von Hand: `node _meta/skripte/vault-archiv.js` (Probelauf), `--ausfuehren`.
- **Deinstallieren:** `node installieren.js --deinstallieren --vault <vault>` entfernt Hooks und CLAUDE.md-Block, der Vault bleibt. Aufgabe: `Unregister-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' -Confirm:$false`.
