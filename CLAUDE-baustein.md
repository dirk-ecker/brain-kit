# Wissensbasis (Vault als Brain)

Der Vault `{{VAULT}}` ist die maßgebliche Wissensquelle für Entscheidungen und Umsetzung (Konventionen: `{{VAULT}}/_meta/konventionen.md`). **Ob etwas festgehalten werden muss, entscheide ich selbst, ohne zu fragen.** Der Vault hat Vorrang vor Repo-Doku, Memory und Erinnerung; widerspricht er dem Code, benenne ich den Widerspruch, klärt der Nutzer ihn, dann korrigiere ich den Vault. Im Konflikt zählt der Nutzer, nicht die ältere Notiz.

## Nutzen (sparsam)

- Der SessionStart-Hook liefert nur `projekte/<projekt>/_index.md` (klein) und die Titel der offenen Punkte; der Prompt-Hook ergänzt zu einem Prompt die wenigen sicheren Treffer. Nichts weiter vorab lesen, nie den ganzen Vault, nie `generiert/`.
- Vor einer Entscheidung oder Änderung gezielt suchen: `node {{VAULT}}/_meta/skripte/vault-suche.js <begriff> [--alle] [--typ entscheidung|erkenntnis|offen|lauf] [-n 10]`. `--gueltig` listet alle gültigen Entscheidungen mit Kurzfassung, `--themen` das Themenvokabular, `--thema X` alle Notizen zu einem Thema, `--kette <begriff>` die Ersetzungskette, `--auch-ersetzte` und `--archiv` für Ersetztes und Archiviertes. Treffer beachten oder den Widerspruch benennen. Keine Treffer kurz nennen.
- `offen/`-Notizen und Treffer nur lesen, wenn die Aufgabe dazu passt. Offene Aufgaben zum Wiederaufsetzen (Notiz mit `aufgabe: true` und `naechster-schritt:` im Kopf) zeigt der Start-Hook samt nächstem Schritt; bei Fortschritt den Schritt aktualisieren, bei Abschluss `status: erledigt`.

## Festhalten (sofort, im Moment der Entscheidung)

- Festhalten: Entscheidungen samt Begründung, Vorgaben und Korrekturen des Nutzers, Erkenntnisse und Fehlannahmen, offene Fragen, Zusammenhänge zwischen Systemen, Ergebnisse von Läufen. Nicht: Triviales, nur für diese Session Relevantes, was Code oder Git schon zeigen.
- Ablage nach Geltungsbereich: `projekte/<projekt>/{entscheidungen,erkenntnisse,offen,läufe}/`, projektunabhängig `_global/`, projektübergreifend `_cross-project/`. YAML-Kopf und Vorlagen siehe Konventionen und `_meta/vorlagen/`.
- Jede gültige Entscheidung und Erkenntnis bekommt im Kopf `kurz: "ein Satz"` und `themen: [2-5 Begriffe]`; Themen aus `vault-suche.js --themen` wiederverwenden.
- Vorher passende Notiz suchen und ergänzen statt duplizieren. Dateiname `YYYY-MM-DD-thema.md`, Überschrift mit Kernaussage. Gibt es den Notiznamen auch in einem anderen Projekt, mit Pfad verlinken.
- Entscheidungen nie überschreiben: neue anlegen, alte auf `status: ersetzt` setzen und `ersetzt:` verlinken. Falsches direkt berichtigen, keine Korrektur-Anhänge. Widersprüche zu Entscheidungen nicht still auflösen, sondern in `offen/` benennen und dem Nutzer nennen.
- `_index.md` klein halten (Zweck, Stand, Tech, Links, aktuell offen, unter 4 KB), keine Entscheidungslisten darin.
- Keine Geheimnisse, keine personenbezogenen Daten. Ordner `private` (und was in `brain.config.json` unter `ausgenommen` steht): nichts in den Vault schreiben.
- Mehrere Sitzungen und andere Agenten (Auggie, Codex, Antigravity) arbeiten parallel im Vault: neue Dateien nur anlegen, wenn der Name nicht existiert; bestehende mit Edit ändern, nie komplett neu schreiben.
- Notizen mit `erzeugt: automatisch` stammen vom Verdichtungslauf; Herkunft und Einordnung darin sind nicht von Hand geprüft.

## Sitzungen

Der SessionEnd-Hook sichert jede Sitzung verdichtet unter `projekte/<projekt>/generiert/sitzungen-roh/`. Der Nutzer will nichts davon von Hand tun: Was ins Brain gehört, bewerte und entscheide ich selbst und halte es ohne Rückfrage fest, noch in der laufenden Sitzung. Was dabei durchrutscht, verdichtet der tägliche Verdichtungslauf aus den Rohverläufen; unverarbeitete Rohsitzungen sind nie ein Grund, den Nutzer zu fragen.
