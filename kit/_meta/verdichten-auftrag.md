---
typ: meta
status: gültig
datum: 2026-10-07
---

# Auftrag für den automatischen Verdichtungslauf

Wird von `_meta/skripte/sitzungen-verdichten.js` an eine unbeaufsichtigte Claude-Instanz übergeben. Der Nutzer liest nicht mit und will nichts von Hand tun: **Du entscheidest selbst, was festhaltenswert ist, und fragst nie nach.** Lies vorher `_meta/konventionen.md` und die Vorlagen in `_meta/vorlagen/`.

## Eingabe
Ein Projekt und eine Liste von Rohverläufen `projekte/<projekt>/generiert/sitzungen-roh/JJJJ-MM-TT-<id8>.txt` (chronologisch). Rohverläufe nur lesen, nie ändern.

## Ergebnis je Rohsitzung
1. **Sitzungsnotiz** `projekte/<projekt>/sitzungen/JJJJ-MM-TT-<thema-kebab>.md` nach Vorlage `sitzung.md`, Kopf mit `sitzung: <id8>` (Pflicht, daran erkennt der Lauf, dass die Sitzung erledigt ist). 5–25 Zeilen, H1 = Kernaussage; triviale oder abgebrochene Sitzungen 2–3 Zeilen. Nie eine bestehende Datei überschreiben.
2. **Entscheidungen, Erkenntnisse, offene Punkte** nur, wenn festhaltenswert (Konventionen: nichts Triviales, nichts was Code/Git schon zeigen). Lieber wenige gute als viele dünne.
   - Vorher gezielt suchen: `node _meta/skripte/vault-suche.js <begriff> --alle`, `--gueltig`, `--themen`. Passende Notiz ergänzen statt neu anlegen.
   - Ändert die Sitzung eine bestehende Entscheidung: neue Notiz, alte auf `status: ersetzt`, neue mit `ersetzt: [[alt]]`. Widerspruch, der sich nicht klar auflösen lässt: Notiz unter `offen/` statt still entscheiden.
   - `kurz` (≤160 Zeichen) und `themen` (2–5, vorhandenes Vokabular) Pflicht bei gültigen Entscheidungen/Erkenntnissen. `herkunft` streng nach Konventionen. `datum` = Sitzungsdatum.
   - Offene Punkte, die eine spätere Sitzung erledigt: auf `status: erledigt` setzen (überholt oder gegenstandslos: `veraltet`) und aus `_index.md` „Aktuell offen“ entfernen.
   - Projektunabhängiges Wissen nach `_global/`, Vergleiche über Projekte nach `_cross-project/` (Typ `erkenntnis`, ohne `projekt:`), mit Rückverweis aus der Projektnotiz.
3. Sitzungsnotiz verlinkt die abgeleiteten Notizen unter „Entscheidungen und Ergebnisse“. Gibt es den Notiznamen auch in einem anderen Projekt (die Prüfung meldet sonst „mehrdeutiger Link“), mit Pfad verlinken: `[[projekte/<projekt>/entscheidungen/<name>|<name>]]`.
4. `projekte/<projekt>/_index.md`: anlegen, falls fehlend (Vorlage `projekt-index.md`, Zweck/Tech aus Repo-README), sonst nur „Aktuell offen“ pflegen. Unter 4 KB, keine Entscheidungslisten.

## Kennzeichnung
Das Skript setzt `erzeugt: automatisch` in den Kopf jeder von dir neu angelegten Notiz. Setze es nicht selbst und entferne es nicht.

## Parallelbetrieb
Während du arbeitest, schreiben andere Sitzungen im selben Vault. Neue Dateien nur anlegen, wenn der Name nicht existiert; bestehende nur mit Edit ändern (nie komplett neu schreiben). Schlägt ein Edit fehl, weil die Datei sich geändert hat: neu lesen und die Änderung erneut anwenden. `_meta/` und `generiert/` sind für dich schreibgeschützt.

## Verbote
- Keine Geheimnisse (Tokens, Keys, Passwörter; in Rohverläufen steht `[geschwärzt]`, nie raten oder rekonstruieren) und keine personenbezogenen Daten.
- Nichts außerhalb des Vaults ändern; Repos nur lesen. Nichts unter `generiert/` oder `_meta/` schreiben.
- Keine Rückfragen, keine Zusammenfassung an den Nutzer nötig.

## Abschluss
`node _meta/skripte/vault-pruefung.js` ausführen und Befunde in den eigenen Notizen beheben. Letzte Zeile der Antwort: `ERGEBNIS sitzungen=<n> entscheidungen=<n> erkenntnisse=<n> offen=<n>`.
