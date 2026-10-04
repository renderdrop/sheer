# REDESIGN BRIEF — Milestone v1.2 „sheer. Design System"

> **Einsatz:** Diese Datei als `docs/REDESIGN_BRIEF.md` ins Repo legen, das Design-System-Dokument als `docs/BRAND.md`, das Moodboard als `docs/brand/moodboard.png`. Dann in Claude Code (Auto-Modus):
> `Lies ORCHESTRATOR_PROMPT.md und führe sie aus. Milestone v1.2 nach docs/REDESIGN_BRIEF.md. F11 und F12 sind bereits erledigt (v1.0.1, v1.1.0): Hub, Menüleiste, Formular-Automatik, Word-Kommentare und Signaturschriften existieren und werden nur umgestylt, nicht neu gebaut. Offene Punkte aus docs/FEEDBACK.md (F13) haben Vorrang.`

---

## 0. Rang und Geltung

Dieses Brief definiert Milestone **v1.2** und hat Vorrang vor allem, was ihm widerspricht: ORCHESTRATOR_PROMPT §3 (Design-Leitplanken), `docs/DESIGN.md`, `docs/MOTION.md`, ADR-011, ADR-012, ADR-020, ADR-022, ADR-029, ADR-042, ADR-051 und alle weiteren Design-ADRs. Für Tokens, Farben, Typografie, Formen und Markenregeln ist **`docs/BRAND.md` die einzige Wahrheit**; das Moodboard `docs/brand/moodboard.png` ist die visuelle Referenz für Layouts. Alles andere (Autonomie, Loop, Agents, Security, Tests, Versionierung) bleibt wie im Orchestrator-Prompt.

Der Milestone beginnt mit **ADR-100 „Rebrand auf sheer."**, das die ersetzten Entscheidungen aufzählt und diese Datei als Quelle nennt. Die Phasen R0–R7 werden als Pakete in `ROADMAP.md` unter „v1.2 Redesign" eingetragen, in der angegebenen Reihenfolge.

### Was sich grundsätzlich ändert
| Bisher | Ab v1.2 |
|---|---|
| Akzent „Iris" #5B5BD6, Verlauf hell/dunkel | **Solar Yellow #FFF84D** als einziger Akzent, Hintergründe Canvas/Sand/Mist |
| Liquid Glass, Blur, Transluzenz | **Flach.** Kein `backdrop-filter`, keine Transluzenz, keine Glas-Innenkanten |
| Light + Dark Mode | **Nur Light.** Dark-Tokens, Dark-Screenshots und Dark-Tests werden entfernt; `prefers-color-scheme` wird ignoriert |
| Spring-Easing, Bounce (MOTION.md) | **ease-out, 120–180 ms**, kein Overshoot, kein Bounce |
| Logo „Glasblatt auf Iris", Name „Sheer" | **Wortmarke „sheer."** (lowercase, mit Punkt), App-Icon „s." |
| System-Font | **Inter** (gebündelt, SIL OFL), Fallback Helvetica Neue / Arial |
| Glas-Toolbar schwebend, rechtes Eigenschaften-Panel | **Top Bar + linke Seiten-Sidebar + rechte Werkzeug-Sidebar** (BRAND §15–19) |
| Highlight-Farbpalette Okabe-Ito | Highlight-Default **Solar Yellow**; restliche Palette reduziert (siehe R4) |

`prefers-reduced-motion` wird weiterhin vollständig respektiert. `prefers-reduced-transparency` ist obsolet (es gibt keine Transparenz mehr).

---

## 1. Lizenz-Ergänzung (vor R0)
`SIL Open Font License 1.1` in die Allowlist (`deny.toml`, `docs/LICENSES.md`, Regel 2 des Orchestrator-Prompts) aufnehmen, ausschließlich für Font-Dateien. Inter (OFL) als Variable Font `woff2`, Subset Latin + Latin Extended, lokal gebündelt, `font-src 'self'`. Keine Google-Fonts-URL, nie.

---

## 2. Phasen

### R0 — Fundament (Backend-/Frontend-Welle 1)
1. `src/styles/tokens.css` komplett ersetzen durch die Tokens aus BRAND §24, ergänzt um semantische Tokens: `--surface-canvas`, `--surface-panel`, `--surface-page-area` (#EFEFEC), `--surface-page` (#FFFFFF), `--text-primary`, `--text-secondary`, `--border-subtle`, `--accent`, `--accent-bright`, `--shadow-standard`, `--shadow-floating`, `--radius-*`, `--space-*`, `--motion-fast` (120 ms), `--motion-base` (160 ms), `--motion-slow` (180 ms), `--ease-out: cubic-bezier(0.2, 0, 0, 1)`.
2. Lint-Regel verschärfen: **kein** Hex-, rgb- oder hsl-Wert außerhalb von `tokens.css`; **kein** `backdrop-filter`; **kein** `@media (prefers-color-scheme)`. Verstöße = Check rot.
3. Dark Mode entfernen: Tokens, Theme-Switch im Settings-Panel, `data-theme`, Dark-Varianten in Tests und Screenshot-Skripten. Gespeicherte Theme-Einstellung wird beim ersten Start migriert und gelöscht.
4. Inter einbinden (siehe §1), Typografie-Skala aus BRAND §6 als Utility-Klassen (`.t-display`, `.t-h1` … `.t-caption`), `font-feature-settings: "cv11", "ss01"` optional, `tabular-nums` für Seitenzahlen und Zoom.
5. Icon-Audit: Lucide, Stroke 1.75, Größen 16/18/20, nie farbig. Alle eigenen Icons entfernen oder nach Lucide-Regeln neu zeichnen.
6. Zwei Oberflächen-Modi als Primitive: `<BrandSurface>` (erlaubt Glow-Gradients) und `<WorkSurface>` (verbietet sie). Der Editor liegt immer in `WorkSurface`.
7. Glow-Primitive `<SolarGlow>`: 1–3 überlagerte `radial-gradient`s nach BRAND §5, GPU-freundlich (eigene Ebene, `will-change: transform`), optional langsame Drift (siehe R5). Wird nur in `BrandSurface` gerendert.

**DoD R0:** Check grün, Lint-Regeln aktiv, keine Hardcoded Colors, keine Dark-Reste (`grep` auf `dark`, `theme`, `backdrop`), Inter sichtbar im Tauri-Fenster, Screenshot.

### R1 — Markenassets
1. **Wortmarke** `assets/brand/wordmark.svg`: „sheer." in Inter 500, Tracking −0.045em, Punkt in derselben Größe, als Pfade konvertiert (keine Textabhängigkeit). Varianten: primär (mit Claim „PDFS MADE SIMPLE" in Kapitälchen, Tracking +0.28em), sekundär (ohne Claim), monochrom Ink.
2. **App-Icon** `assets/brand/icon.svg` in drei Varianten nach BRAND §8 (Standard mit Mist-Sand-Hintergrund und Solar-Glow unten rechts, Light, Simple auf Solar Yellow). **Optische Zentrierung:** „s" und Punkt werden als eine Gruppe über ihre tatsächlichen Glyph-Bounds zentriert, nicht über die Textbox; der Punkt sitzt auf der Grundlinie des „s". Nachweis: Skript misst die Bounding-Box und protokolliert die Abweichung (< 1 % der Kantenlänge). Daraus mit `tauri icon` alle Plattform-Icons generieren.
3. Installer-Grafiken (NSIS Header/Sidebar) im Brand Mode: Sand-Hintergrund, Solar-Glow, Wortmarke, keine Screenshots.
4. Welcome-PDF („Welcome to sheer."): Neues Layout nach BRAND – große, leichte Typografie, viel Weißraum, Glow nur auf der Titelseite, Aufgaben-Seiten neutral.
5. About-Dialog, README-Kopf, Release-Notes-Vorlage auf neue Marke.
6. `APP_NAME`-Token zeigt „sheer." in UI-Texten (lowercase, mit Punkt); Bundle-Name, Dateinamen und Installer-Name bleiben `Sheer` (Dateisystem-Konventionen). ADR dazu.

**DoD R1:** Icons in allen Größen gerendert und im Explorer/Dock-Screenshot geprüft, Wortmarke in Home sichtbar, Installer-Build mit neuer Grafik lokal gebaut.

### R2 — Home (Brand Mode)
Layout nach Moodboard „UI Beispiele" links:
- **Linke Navigation** (200 px, Canvas-Hintergrund): Wortmarke oben; Einträge **Home, Zuletzt, Markiert, Werkzeuge**. „Geteilt" und „Papierkorb" aus dem Moodboard werden **nicht** gebaut – es gibt weder Cloud noch Dateiverwaltung (ADR festhalten). „Markiert" = lokal gespeicherte Favoriten (neue, kleine Funktion: Stern am Dokument, Liste in Home).
- **Hero** (Sand-Fläche mit einem großen Solar-Glow unten rechts, Radius `--radius-xl`): Display-Typografie „PDFs made simple.", darunter Suchfeld „Dokumente durchsuchen …" mit `/`-Kürzel; Suche durchsucht Dateinamen der zuletzt geöffneten Dokumente. Rechts oben runder „+"-Button in Solar Yellow = Öffnen.
- **Zuletzt**: reduzierte Dokument-Cards (weiß, 1 px Border, Radius md): Mini-Thumbnail mit dezentem Glow-Rest, Dateiname, relative Zeit, Kontextmenü (Öffnen, Markieren, Im Explorer zeigen, Aus Liste entfernen). Maximal 12, dann „Alle anzeigen".
- **Werkzeuge** (eigene Ansicht, erreichbar über Navigation und als Sektion unter Zuletzt): ruhige Rows, nicht Cards-in-Cards: *Dateien zusammenführen, Teilen, Komprimieren, Bilder zu PDF, Signieren, Schwärzen, Formular ausfüllen, Als Bilder exportieren.* Klick → Dateiauswahl → Editor öffnet direkt im passenden Modus mit vorbereiteter Seitenleiste.
- **Leerzustand** (noch nie etwas geöffnet): großer diffuser Glow, Display-Text „Drop a PDF here." (de: „PDF hier ablegen."), darunter Ghost-Button „Oder öffnen". Drag-&-Drop auf die gesamte Fläche.
- Keine Statistiken, kein Dashboard-Charakter.

**DoD R2:** Screenshot Home gegen Moodboard, Designer-Abnahme (eine Runde), Drag-&-Drop per Maus geprüft, Tastatur-Navigation komplett.

### R3 — Editor (Work Mode)
Layout nach BRAND §15–19 und Moodboard rechts:
- **Top Bar** (56 px, weiß, 1 px Border unten): links „Zurück zu Home"-Chevron, Dateiname (editierbar per Doppelklick = Speichern unter), Tab-Leiste bei mehreren Dokumenten (schlanke Tabs, aktiver Tab mit gelbem 2-px-Unterstrich); Mitte: Zoom-Dropdown mit Fit-Optionen, Seitenfeld „3 / 12"; rechts: Undo/Redo, Suche, Export-Menü, Primärbutton **„Fertig"** (Solar Yellow) = speichern + zurück zu Home, bei ungespeicherten Änderungen mit Punkt-Indikator. Rarely used actions in „Mehr" (⋯): Dokumenteigenschaften, Schützen, Formular reduzieren, Drucken. Alles aus dem bisherigen ⋯-Menü, das zu einem Werkzeug gehört, wandert in die Werkzeug-Sidebar.
- **Linke Sidebar „Seiten"** (200 px, Canvas): Tabs als Icon-Row oben: Seiten, Gliederung, Kommentare, Suche. Thumbnail-Cards weiß mit 1 px Border, ausgewählte Seite mit 2 px Solar-Yellow-Border und Seitenzahl. Einklappbar, Zustand merken.
- **Canvas**: Fläche #EFEFEC, Seiten weiß mit `--shadow-floating`, Abstand 24 px. Keine Glows, keine Verläufe.
- **Rechte Sidebar „Werkzeuge"** (280 px, weiß): Sektionen als ruhige Rows mit Icon + Label: *Markieren, Text, Zeichnen, Kommentar, Signatur, Formen, Bilder, Seiten organisieren, PDF exportieren, Mehr.* Ausgewähltes Werkzeug: Row mit Solar-Yellow-Hintergrund (Ink-Text). **Progressive Disclosure:** Die Eigenschaften des aktiven Werkzeugs (Farbe, Stärke, Schriftgröße, Deckkraft) klappen direkt unter seiner Row auf; das bisherige separate Eigenschaften-Panel entfällt. Werkzeug bleibt aktiv bis Esc oder Auswahlwerkzeug (F11-6 bleibt).
- **Formulare**: Kein Formular-Werkzeug. Enthält die Datei Felder, sind sie sofort ausfüllbar; ein schmales Sand-Banner oben im Canvas sagt „Formular erkannt – 12 Felder · Zum ersten Feld" mit Schließen. Marken (✓ ✗ •) und Textfelder für PDFs ohne Felder leben unter *Signatur* als Untergruppe „Ausfüllen".
- **Kommentare wie in Word**: Textauswahl → kleines Popover „Markieren · Kommentieren · Kopieren". „Kommentieren" legt Markierung + Kommentar an. Kommentar-Tab in der linken Sidebar: Row mit markiertem Textauszug (max. zwei Zeilen), Kommentar, Autor, Zeit; Antworten, Erledigen (Row wird ausgegraut, einklappbar), Löschen; Klick springt zur Stelle und pulsiert die Markierung einmal (siehe R5). Alle Annotationstypen im Tab mit Icon erkennbar; Filter nach Typ und „Nur offene".
- **Schwärzen**: eigener Modus mit rotem Hinweisband „Schwärzen ist endgültig" (Rot nur hier, als Semantikfarbe), Vorschau als rote Umrandung, „Anwenden"-Primärbutton; nach dem Anwenden schwarz.
- **Menüs**: macOS-Menüleiste bleibt vollständig. Windows: keine klassische Menüleiste; Top Bar + Sidebar + „Mehr" decken alles ab, Tastenkürzel in Tooltips.

**DoD R3:** Smoke-Test 16/16 im neuen Layout; jede Funktion des alten ⋯-Menüs ist an einem Ort erreichbar (Tabelle alt→neu in ADR); Screenshot Dokumentansicht gegen Moodboard; Designer-Abnahme.

### R4 — Komponenten
Alle Komponenten nach BRAND §9–13 neu: Primary (Solar Yellow / Ink), Secondary (Sand), Ghost, Icon-Button 36/40, Inputs (weiß, 1 px Border, Fokus: 2 px Solar-Yellow-Ring außen, kein Blau), Dropdowns, Popover (Radius md, `--shadow-floating`), Dialoge (Radius 16, Sand-Hintergrund, maximal ein Primärbutton), Toasts (unten mittig, Ink-Text auf Weiß, 1 px Border, keine Icons in Farbe), Tooltips mit `<kbd>`-Styling, Tabs, Segmented Control, Toggle (gelb bei an), Checkbox, Slider (gelbe Spur), Skeletons (Sand-Shimmer), Banner (Sand), Dropzone (gestrichelte Border #E5E5E1, bei Hover Solar-Glow).
- **Highlight-Farben**: Default Solar Yellow (BRAND §20) mit 45 % Deckkraft im Multiply-Blend; dazu vier dezente Alternativen (Mint, Sky, Rose, Lavender), alle gleiche Helligkeit, keine Okabe-Ito-Palette mehr. Tinten-/Formenfarben: Ink, Solar, dieselben vier.
- **Signatur-Sheet**: weiß, Zeichenfläche mit Sand-Hintergrund und einer Grundlinie, die **nicht** Teil des Pfads ist; Tabs Zeichnen / Tippen / Bild; beim Tippen **drei Schriften zur Auswahl** (OFL): *Dancing Script, Great Vibes, Alex Brush* – „Homemade Apple" entfernen. Tinte Ink oder Blau (#1F3A93, einzige Blau-Ausnahme, Semantik „Tinte").
- **Kontrast:** Solar Yellow ist nie Textfarbe; Text auf Gelb immer Ink. Jeder Text ≥ 4.5:1, UI-Elemente ≥ 3:1, mit Testskript.

**DoD R4:** Storybook-ähnliche Komponenten-Seite (`/dev/components`, nur in Dev-Builds) mit jedem Zustand; Kontrast-Skript grün; Designer-Abnahme.

### R5 — Motion & Details („Spells")
`docs/MOTION.md` wird ersetzt. Grundregeln: **ease-out**, 120/160/180 ms, Exits 40 ms kürzer, keine Spring-Overshoots, keine Scale-Animationen > 2 %, nichts bewegt sich ohne Nutzeraktion außer dem ambienten Glow. Alles unter `prefers-reduced-motion` auf reine Fades reduziert. Budget: 60 fps im Tauri-Fenster, gemessen wie bisher. Ein Spell gilt als Bestand, wenn er unauffällig ist – wer ihn bemerkt, ohne ihn zu suchen, hat zu viel.

Kuratierte Liste (alle umsetzen, keine weiteren erfinden):
1. **Werkzeug-Pill**: Der gelbe Hintergrund der aktiven Werkzeug-Row gleitet zur neuen Row (Shared-Layout-Transition, 160 ms) statt zu springen.
2. **Seiten-Indikator**: Die gelbe Border wandert zwischen Thumbnails mit, Seitenzahl tickt mit `tabular-nums`.
3. **Dokument öffnen**: Erste Seite blendet mit 8 px Aufwärtsbewegung ein (180 ms), Thumbnails erscheinen gestaffelt mit 20 ms Versatz, maximal 10 gestaffelt.
4. **Drop-Zone**: Beim Ziehen einer Datei über das Fenster verstärkt sich der Solar-Glow mit der Nähe des Cursors zur Mitte (Proximity, ohne Layout-Shift); beim Ablegen „landet" eine Dateikarte (Fade + 4 px Settle) und wird zur Seite.
5. **Marker-Spur**: Beim Markieren folgt ein halbtransparenter gelber Marker-Streifen der Textauswahl in Echtzeit (das behebt F11-3 sichtbar); beim Loslassen ein kurzes Nachdunkeln der Markierung (120 ms), wie trocknende Tinte.
6. **Gespeichert**: Kein Toast. Im „Fertig"-Button zeichnet sich ein Haken als Stroke-Animation (240 ms, einzige Ausnahme über 180 ms), der Punkt-Indikator verschwindet.
7. **Undo**: Das rückgängig gemachte Element blendet mit 2 % Verkleinerung aus; bei Redo umgekehrt.
8. **Kommentar-Sprung**: Klick auf einen Kommentar scrollt sanft zur Stelle (ease-out, max. 300 ms) und die Markierung pulsiert einmal in Deckkraft.
9. **Löschen-Bestätigung**: Beim Löschen einer Seite kippt das Thumbnail 6° und blendet aus, die Nachbarn rücken mit Layout-Animation nach; Undo-Toast erscheint.
10. **App-Start**: Wortmarke auf Canvas, dahinter atmet ein Solar-Glow (Deckkraft 0.6→0.9→0.6, 2 s Loop), bis das Fenster bereit ist; dann Cross-Fade in Home. Maximal 1,5 s sichtbar, nie künstlich verlängert.
11. **Ambienter Glow**: Glows in Brand-Mode driften sehr langsam (60-s-Loop, ±3 % Position), pausieren bei Fenster im Hintergrund und unter reduced-motion.
12. **Cursor**: Pro Werkzeug eigener Cursor als SVG (Marker, Stift, Fadenkreuz mit gelbem Punkt, Textcursor), 2× DPR, Hotspot exakt; Standardcursor überall sonst. Keine Cursor-Follower, keine Partikel.
13. **Interaktive Lupe**: Taste `Z` gedrückt halten zeigt eine kreisrunde 2×-Lupe unter dem Cursor (vgl. „Interactive magnifier in Preview" auf designspells.com), 1 px Ink-Rand, folgt dem Cursor ohne Lag; loslassen blendet aus.
14. **Sidebar-Icons**: Beim Öffnen/Schließen der Sidebars animiert das Chevron-Icon seine Richtung (Pfad-Morph, 160 ms).
15. **Skeletons**: Beim Rendern von Seiten erscheint statt Weiß ein Sand-Shimmer in Seitenform; der Shimmer läuft schräg, 1,2 s Loop.
16. **Tooltips**: Erscheinen nach 400 ms, bei Bewegung zwischen Nachbar-Buttons sofort (Tooltip-Gruppen), mit Tastenkürzel als `<kbd>`.
17. **Zoom-Snap**: Beim Zoomen rasten 100 % und Fit-Stufen leicht ein (±3 %), Zoomwert tickt.
18. **Fokus**: Tastaturfokus zeichnet einen 2-px-Solar-Ring, der von der vorherigen Position zur neuen gleitet (nur bei Tastaturnavigation).

Easter Egg (ein einziges, optional, nur wenn Budget übrig): Auf der Home-Seite 10× auf den Punkt der Wortmarke klicken lässt den Glow kurz zum Punkt wandern und zurück. Mehr nicht.

**DoD R5:** Jeder Spell als Screen-Recording im Tauri-Fenster, fps p95 ≤ 16,8 ms in allen Szenarien, reduced-motion-Variante je Spell nachgewiesen, Designer-Abnahme der Recordings (eine Runde).

### R6 — Onboarding, Tour, Settings
- Tour-Coach-Marks im neuen Stil (weiß, Border, Solar-Yellow-Fortschrittsbalken), Tour-Pill in der Top Bar.
- Tour öffnet das Welcome-Dokument **in einem neuen Tab** und verlässt nie ungespeicherte Arbeit (F11-7 bleibt).
- Settings-Panel reduziert: Sprache, Autorname, Updates (opt-in), Tour neu starten, Über. Kein Theme, keine Glas-Option.
- Werkzeug-Tipps (M7) im neuen Stil, maximal drei pro Sitzung.

### R7 — Abnahme und Release
1. Vollständige Screenshot-Serie (Home leer, Home mit Dokumenten, Werkzeuge, Editor leer, Editor mit Dokument, jeder Sidebar-Tab, jedes Werkzeug aktiv, Signatur-Sheet, Schwärzen-Modus, Dialog, Toast) als `docs/review/v1.2/*.png`, jeweils neben dem passenden Moodboard-Ausschnitt.
2. Designer-Abnahme der gesamten Serie gegen BRAND §2 (die Vermeiden-Liste wird Punkt für Punkt abgehakt).
3. Smoke-Test 16/16, CSP-Gate, Druck-Gate, Kontrast-Skript, fps, Security-Audit (CSP: `font-src 'self'`, keine neuen Netzwerkpfade), CI grün auf beiden Plattformen.
4. CHANGELOG „v1.2.0 – Neues Design", Tag, Release.

---

## 3. Agent-Zuordnung und Loop für diesen Milestone
- **designer (Opus, medium)** schreibt zuerst `docs/DESIGN.md` **v2** aus `BRAND.md` + Moodboard + diesem Brief: Tokens, jede Komponente mit Zuständen, beide Layouts mit Maßen, Motion-Katalog R5 mit Timings. Das ist Paket 0 und blockiert alles andere. Max. 3 000 Wörter.
- Danach pro Phase Pakete nach den Tempo-Regeln (vier Implementer parallel, Backend zuerst, wo nötig: Favoriten-Speicher, Welcome-PDF-Generator, Font-Bundling, Icon-Generierung).
- **Abweichung von Tempo-Stufe 2, nur für diesen Milestone:** Designer-Abnahme **pro Phase** (eine Runde, anhand von Tauri-Screenshots neben Moodboard-Ausschnitten), nicht erst am Ende. Begründung: Design ist hier der Inhalt des Milestones; ein Fehler in R0 vervielfacht sich in R2–R6.
- Ein Implementer darf **nie** eine Farbe, einen Radius oder eine Dauer erfinden. Fehlt ein Token, meldet er es; der Dirigent ergänzt es in `tokens.css` und `DESIGN.md`.

---

## 4. Harte Regeln (aus BRAND, maschinell prüfbar)
- Kein Hex außerhalb `tokens.css` · kein `backdrop-filter` · kein `box-shadow` außer den zwei Token-Schatten · keine Border-Radien außer Tokens · keine Dauer außer Tokens · kein Blau außer Tinte und Fokus-Ausnahmen in R4 · keine farbigen Icons · kein Bold über 600 · keine Glows innerhalb `WorkSurface` · keine Scale-Animation > 2 % · kein Dark Mode · kein Text in Solar Yellow.
- Vor Abschluss jedes Screens die Frage aus BRAND §26 im Reviewer-Prompt: „Was kann entfernt werden?" – der Reviewer nennt mindestens einen Kandidaten oder begründet, warum keiner.

---

## 5. Entscheidungen, die ich (Dirigent) ohne Rückfrage treffe
- Navigation ohne „Geteilt"/„Papierkorb" (keine entsprechenden Funktionen).
- Windows ohne klassische Menüleiste; macOS behält die native.
- Rot ausschließlich für Schwärzen-Warnung und Fehler.
- Reihenfolge bei Konflikt zwischen Moodboard und BRAND-Text: BRAND-Text gewinnt bei Tokens, Moodboard gewinnt bei Layout-Proportionen.
- Die alte Marke verschwindet vollständig aus Repo, Docs und Assets, außer in CHANGELOG und ADR-Historie.

---

## 6. Definition of Done v1.2.0
Alle Phasen R0–R7 abgehakt · `docs/DESIGN.md` v2 und `docs/MOTION.md` v2 sind Quelle für die Implementierung · kein Vorkommen von „Iris", „glass", „dark" im Code außer Changelog/ADRs · alle 18 Spells nachgewiesen · Vermeiden-Liste aus BRAND §2 abgehakt · Smoke-Test, Gates, Audits, CI grün · Release v1.2.0 mit neuen Installer-Grafiken auf beiden Plattformen.
