# Wissens-Vault (Brain)

Der gemeinsame Wissens-Vault liegt unter `{{VAULT}}`. Der Nutzer hat erlaubt, ihn bei der Arbeit zu lesen, zu pflegen und die vorhandenen Skripte zu nutzen. Die Erlaubnis gilt auch für künftige Sitzungen; technische Sandbox-Freigaben bleiben erforderlich, soweit die Umgebung sie verlangt. Nicht routinemäßig erneut um inhaltliche Zustimmung zur Vault-Pflege bitten.

## Sitzungsstart und Recherche

- Zu Beginn jeder neuen Arbeitssitzung `{{VAULT}}/_meta/konventionen.md` lesen. Sie ist die maßgebliche, aktuelle Quelle für Ablage, Metadaten, Pflege und parallele Zugriffe.
- Bei Projektarbeit `_meta/brain.config.json` zur Projektzuordnung und `projekte/<projekt>/_index.md` als kleinen Einstieg lesen. Ausnahmen in der Konfiguration beachten. Nicht den ganzen Vault laden.
- Vor Entscheidungen und bei Fragen zu früheren Erkenntnissen gezielt suchen: `node {{VAULT}}/_meta/skripte/vault-suche.js <begriffe>`; projektübergreifend `--alle`. Weitere Optionen stehen im Skriptkopf (`--gueltig`, `--themen`, `--thema`, `--verweise`, `--kette`). Nur relevante Treffer lesen.
- `generiert/` und Rohsitzungen nicht als normalen Wissenskontext lesen oder von Hand pflegen.

## Wissen laufend pflegen

- Relevante Entscheidungen, Erkenntnisse, Nutzerkorrekturen und offene Punkte zeitnah nach den Vault-Konventionen festhalten. Vor einer neuen Notiz nach einer passenden bestehenden suchen. Keine bloßen Code- oder Git-Zusammenfassungen.
- Geltungsbereich beachten: Projektwissen nach `projekte/<projekt>/`, allgemeines Wissen nach `_global/`, Vergleiche nach `_cross-project/`. Vorlagen unter `_meta/vorlagen/`.
- Herkunft und Status korrekt kennzeichnen; Vorschläge nicht als Nutzerentscheidungen darstellen. Entscheidungen nie überschreiben, sondern ersetzen (Ersetzungskette). Keine Geheimnisse oder personenbezogenen Daten.
- Vor Abschluss prüfen, ob neues dauerhaft nützliches Wissen oder ein konkreter Wiederaufnahme-Schritt festzuhalten ist.

## Parallele Zugriffe

- Mehrere Sitzungen und verschiedene Agenten (Claude Code, Auggie, Codex, Antigravity) schreiben gleichzeitig in denselben Vault; es gelten für alle die Regeln der Konventionen („Parallele Sitzungen“).
- Neue Notizen exklusiv anlegen (Dateisystemmodus `wx` bzw. CreateNew), bestehende frisch lesen und gezielt ändern, nie veraltete Dateikopien zurückschreiben.
- Für gemeinsame Skriptläufe die vorhandenen Sperren nutzen (`_meta/skripte/sitzung-lib.js`: `sperre`, `schreibeAtomar`). Fremde aktive Sperren und Sitzungsmarker nicht entfernen. Automatisierungsläufe setzen `BRAIN_AUTOMATION=1`.
- Ohne Hooks (Startkontext, Erinnerung, Sitzungssicherung) selbst den Einstieg lesen (Projektindex, gezielte Suche) und vor Abschluss prüfen, ob etwas festzuhalten ist. Shell-Änderungen werden nicht automatisch erkannt.
