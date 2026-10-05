# ORCHESTRATOR PROMPT — „Sheer“ (Open-Source-Desktop-PDF-App für macOS + Windows)

> **So startest du (einmalig, manuell):**
> 1. Leeres Repo anlegen, diese Datei als `ORCHESTRATOR_PROMPT.md` ins Repo-Root legen.
> 2. Claude Code im Repo starten, Hauptmodell Opus 5.5, Permission-Modus auf vollautomatisch (z. B. `claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions`; Flags ggf. gegen deine Version prüfen).
> 3. Einzige Eingabe: `Lies ORCHESTRATOR_PROMPT.md vollständig und führe sie aus.`
> 4. Jede weitere Session: dieselbe Eingabe. Die Datei ist idempotent — sie liest `STATE.md` und macht dort weiter, wo sie aufgehört hat.
> 5. Not-Aus: Datei `.claude/state/STOP` anlegen. Loop-Obergrenze pro Session: Umgebungsvariable `CC_MAX_LOOPS` (Default 60).

---

## 0. Deine Rolle

Du bist der **Dirigent** (Orchestrator). Du läufst auf Opus 5.5. Du planst, delegierst, integrierst, entscheidest und hältst den Zustand des Projekts in Dateien fest. Du schreibst selbst nur: Konfiguration, kleinen Glue-Code (< 30 Zeilen), Merges, Synthese-Dokumente. Alles andere delegierst du an die Subagents in `.claude/agents/`.

Du arbeitest **vollständig autonom**. Es gibt keinen Menschen, der Fragen beantwortet. Bei Unklarheit: entscheide nach bestem Urteil, trage die Entscheidung mit Begründung in `docs/DECISIONS.md` ein, mach weiter. Die einzigen erlaubten Stop-Bedingungen stehen in Abschnitt 12.

---

## 1. Mission

Baue **Sheer**: eine einfache, sehr schöne, schnelle, **quelloffene und lokal laufende** Desktop-PDF-App für macOS und Windows, die den Alltags-Funktionsumfang von Adobe Acrobat und der gängigen Online-PDF-Tools abdeckt (anzeigen, kommentieren, markieren, bearbeiten, durchsuchen, organisieren, Formulare, Signaturen, konvertieren) und am Ende als Produkt vertrieben werden kann. Kein Login, kein Account, kein Server — die App funktioniert vollständig offline.

Produktname: **Sheer** (Tagline-Richtung: „Sheer clarity for your documents“). Repo-/Paket-/Bundle-Name `sheer`, Bundle-Identifier `app.sheer.desktop`. Der Name ist unter Markenvorbehalt — halte ihn in **einem** zentralen `APP_NAME`-Token, damit ein Mensch ihn später in fünf Minuten tauschen kann. Logo-Quelle: Anhang A (`assets/brand/logo.svg`).

Erfolgsmaßstab: Ein Nutzer öffnet die App, versteht sie ohne Anleitung, erledigt die zehn häufigsten PDF-Aufgaben in unter einer Minute und denkt „das sieht aus wie 2026, nicht wie 2006“.

---

## 2. Unverhandelbare Regeln

1. **Keine Rückfragen.** Nie. Entscheiden, dokumentieren, weiter.
2. **Lizenzen:** Nur permissive Lizenzen (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Zlib). **Kein GPL, kein AGPL, kein LGPL** (das schließt MuPDF, Ghostscript, iText/OpenPDF-AGPL, Tesseract-Abhängigkeiten mit GPL-Teilen aus). Jede neue Dependency wird vor dem Hinzufügen geprüft und in `docs/LICENSES.md` eingetragen.
3. **Kein Adobe-Branding.** Keine Acrobat-Icons, -Namen, -Screenshots, keine Nachbildung von Acrobat-Layouts. Feature-Parität ja, Kopie nein.
4. **Lokal only, immer:** kein Backend, kein Login, keine Accounts, keine Telemetrie, keine Cloud-KI, keine Netzwerkverbindung außer dem opt-in Updater. Alles läuft offline auf dem Gerät. Ein Test in `npm run check` schlägt fehl, wenn ein Netzwerk-Crate außerhalb des Updater-Moduls auftaucht.
5. **Signaturen** = visuelle Signaturen (zeichnen, tippen, Bild) + optionale selbstsignierte digitale Signatur in einem späteren Milestone. Keine qualifizierten eIDAS-Signaturen.
6. **Sprache:** Code, Commits, Repo-Doku, Tests: Englisch. UI-Strings über i18n (en, de).
7. **Token-Disziplin** (Abschnitt 7) hat Vorrang vor Perfektion. Ein gutes, fertiges Feature schlägt ein perfektes, halbfertiges.
8. **Nichts Überlappendes im UI.** Jedes Panel, jede Toolbar, jedes Popover hat einen definierten Platz im Layout-Grid. Kein z-index-Chaos.
9. **Keine Mods, keine zusätzlichen Plugins, keine MCP-Server** für Claude Code installieren. Settings-Hooks (Abschnitt 7) reichen. Mods verändern Claude Code selbst, nicht das Produkt — das ist hier Token-Verschwendung.
10. **Eigener Code ist Open Source:** Lizenz `AGPL-3.0-or-later` (Datei `LICENSE`), Name und Logo bleiben Marke (`TRADEMARK.md`). Beiträge Dritter nur mit DCO-Sign-off. Das ist mit permissiven Dependencies kompatibel; Regel 2 bleibt für Dependencies unverändert.
11. **Security ist Teil der Definition of Done.** Kein Milestone-Tag ohne bestandenen `security-reviewer`-Durchlauf (Abschnitt 13). Jede PDF-Datei ist feindlicher Input.
12. **CI zuerst (ADR-120).** Am Anfang jedes Loops liest du den letzten abgeschlossenen CI-Lauf auf `main` (`bash scripts/ci-status.sh`, nie warten). Rot = zuerst Fix, kein neues Paket. CI grün ist Teil der Definition of Done jedes Pakets, nicht nur des Milestones.

---

## 3. Produkt- und Design-Leitplanken

**Design-Sprache:** „Liquid Glass“-inspiriert (aktuelle iOS/macOS-Ästhetik), zurückhaltend, auf beiden Plattformen tragfähig. Referenzrichtung (vom Produktverantwortlichen vorgegeben): weicher, heller Farbverlauf als Hintergrund, darauf weiße, leicht transluzente Karten mit großen Radien, dünner heller Innenkante, Icons in kleinen abgerundeten Kacheln, Pill-Badges, sehr viel Weißraum, dünne Trennlinien statt Rahmen. Die Referenz nutzt mehrere Pastelltöne — **wir nicht**: eine einzige Hue-Familie.

- **Eine Farbe: „Iris“** (Periwinkle-Indigo). Tokens in `docs/DESIGN.md` und `src/styles/tokens.css`:
  - `--iris-500: #5B5BD6` (Akzent: aktive Werkzeuge, Primär-Buttons, Links, Selektion)
  - `--iris-400: #7B7CF0`, `--iris-300: #8E8EF2` (Dark-Mode-Akzent), `--iris-200: #C9CAFF`, `--iris-100: #E1E2FF` (Tints, Hover, Kacheln), `--iris-50: #F4F5FF` (Hintergrund-Verlauf hell)
  - `--iris-700: #3A3AAB` (Text auf Tint, Pressed)
  - Neutral: `--ink: #1C1C2E`, `--ink-60: #5F6072`, `--ink-30: #B4B5C4`, `--surface: rgba(255,255,255,.72)` (Glas), `--surface-solid: #FFFFFF`
  - Semantik nur dort, wo unvermeidbar: Erfolg `#2E9E6B`, Warnung `#D98A1F`, Fehler `#D64B4B`. Nie als Dekoration.
  - Hintergrund Light: Verlauf `#F4F5FF → #FAFAFF` (kaum sichtbar, 135°). Dark: `#0F1020 → #15162B`, Glas `rgba(28,28,46,.62)`.
- Transluzente Panels: `backdrop-filter: blur(24px) saturate(140%)`, 1-px-Innenkante `rgba(255,255,255,.6)`, Radien 16–20 px (Karten 20, Buttons 12, Pills 999), Schatten `0 8px 32px rgba(28,28,46,.08)`.
- **Jeder Glas-Effekt hat einen Fallback**: ohne `backdrop-filter`-Support oder bei `prefers-reduced-transparency` → `--surface-solid` mit identischem Layout.
- Typografie: System-Font (SF auf macOS, Segoe UI Variable auf Windows), Fallback `system-ui`. Überschriften 600, Fließtext 400, Tracking −0.01em bei ≥ 20 px. 8-pt-Raster.
- Icons: Lucide (ISC) oder Phosphor (MIT). Keine proprietären Icon-Sets.
- Motion: 150–250 ms, Spring-Easing, nur zweckmäßig (Panels, Hover, Zustandswechsel, Seitenübergänge). `prefers-reduced-motion` wird respektiert.

**Layout (ein Fenster):**
- Oben: schwebende Glas-Toolbar mit Werkzeuggruppen (Auswahl, Markieren, Kommentar, Zeichnen, Formular, Signatur, Seiten). Aktives Werkzeug sichtbar markiert, Tooltips mit Shortcut.
- Links: einklappbares Panel (Thumbnails / Gliederung / Kommentare / Suche als Tabs).
- Mitte: Dokument-Canvas mit sanftem Scroll, Zoom (Pinch, Strg/Cmd+Scroll), Seitenübergängen.
- Rechts: kontextuelles Eigenschaften-Panel (nur sichtbar, wenn etwas ausgewählt ist).
- Unten: schlanke Statusleiste (Seite x/y, Zoom, Dateiname).
- Leerzustand: Drag-&-Drop-Zone + zuletzt geöffnete Dateien, schön gestaltet.
- Tastaturkürzel für alle Hauptaktionen; vollständige Bedienung ohne Maus möglich.

**Qualitätsanspruch UI:** Kein Element wirkt „Standard-Webapp“. Jede Komponente wird gegen `docs/DESIGN.md` geprüft, bevor sie als fertig gilt.

---

## 4. Tech-Stack (Vorgabe — Verifikationspflicht in Phase 2)

| Schicht | Wahl | Begründung |
|---|---|---|
| Desktop-Shell | **Tauri 2** (Rust) | Kleine Binaries, native WebViews (WKWebView / WebView2), gute Signatur- und Updater-Story, MIT/Apache |
| Frontend | **React 19 + TypeScript + Vite** | Ökosystem, Tooling, Subagents sind darin am produktivsten |
| Styling | **Tailwind 4** + CSS-Variablen als Design-Tokens | Tokens zentral, Glas-Effekte sauber abbildbar |
| Animation | **Motion** (ehem. Framer Motion, MIT) | Spring-Animationen, Layout-Transitions |
| State | **Zustand** | Klein, testbar |
| PDF-Engine | **PDFium** über das Rust-Crate `pdfium-render` (Binaries aus `bblanchon/pdfium-binaries`, pro Plattform gebündelt) | BSD-Lizenz, rendert + Textlayer + Suche + Annotationen + Formulare + Seitenoperationen in einer Engine; **PDFium ist nicht thread-safe → alle Aufrufe über einen serialisierten Worker** |
| Fallback-Renderer | PDF.js (Apache-2.0) nur, falls der Spike zeigt, dass der PDFium-Textlayer für Auswahl/Suche nicht reicht | Keine zwei Engines parallel ohne ADR |
| Tests | Vitest (Unit/Component), `cargo test` (Rust), leichte E2E über Tauri-WebDriver für 3–5 Kernflows | Nicht mehr E2E als nötig |
| CI | GitHub Actions, Matrix macOS + Windows, Build + Tests | Nur Build-Artefakte, kein Signing in CI (Zertifikate fehlen) |

Abweichung erlaubt, wenn der Spike in Phase 2 scheitert oder die Lizenzprüfung ein Problem findet — dann ADR schreiben und die nächstbeste Option nehmen. Bekannte PDFium-Grenze: Markup-Annotationen (Highlight etc.) brauchen selbst erzeugte Appearance-Streams, damit andere Viewer sie korrekt anzeigen — einplanen.

---

## 5. Repo-Struktur (Phase 0 legt sie an)

```
.
├── ORCHESTRATOR_PROMPT.md      # diese Datei
├── CLAUDE.md                   # kurz! wird in jeden Turn/Subagent geladen
├── STATE.md                    # Wiederaufnahme-Zustand (Abschnitt 11)
├── ROADMAP.md                  # Milestones + Checkboxen (Quelle des Stop-Hooks)
├── CHANGELOG.md                # Keep-a-Changelog
├── README.md
├── LICENSE                     # AGPL-3.0-or-later (Volltext)
├── TRADEMARK.md                # Name + Logo sind nicht Teil der Lizenz
├── SECURITY.md                 # Responsible-Disclosure-Policy (kurz, Kontakt = Platzhalter)
├── .gitignore
├── .nvmrc / rust-toolchain.toml / deny.toml   # gepinnte Toolchains, cargo-deny-Regeln
├── .claude/
│   ├── settings.json           # Hooks (Abschnitt 7)
│   ├── agents/                 # Subagents (Abschnitt 6)
│   ├── hooks/                  # Hook-Skripte
│   └── state/                  # loop_count, DONE, STOP (gitignored)
├── assets/brand/               # logo.svg (Anhang A), daraus generierte Icons
├── docs/
│   ├── research/               # Phase-1-Ausgaben
│   ├── FEATURES.md             # Feature-Katalog, MoSCoW, Komplexität, Milestone
│   ├── ARCHITECTURE.md
│   ├── DESIGN.md               # Tokens, Komponenten, Motion-Regeln
│   ├── SECURITY.md             # Threat Model + Maßnahmen (Abschnitt 13), fortgeschrieben
│   ├── DECISIONS.md            # ADRs, fortlaufend
│   ├── LICENSES.md             # jede Dependency + Lizenz
│   └── BLOCKERS.md             # was nur ein Mensch lösen kann
├── src/                        # React/TS
├── src-tauri/                  # Rust (+ capabilities/*.json, minimal)
├── tests/fixtures/malformed/   # kaputte/bösartige Test-PDFs
├── scripts/                    # bump-version.sh, check.sh, fetch-pdfium.sh (mit SHA256-Prüfung)
└── .github/workflows/ci.yml
```

`CLAUDE.md` bleibt unter 60 Zeilen: Projekt in 3 Sätzen, die Befehle (`npm run check`, `npm run tauri dev`, `cargo test`), die 12 Regeln aus Abschnitt 2 in Kurzform, Verweis auf `docs/DESIGN.md`, `docs/ARCHITECTURE.md` und `docs/SECURITY.md`. Nichts anderes — jede Zeile dort kostet in jedem Turn Tokens.

---

## 6. Subagents — Dateien exakt so anlegen

Modellpolitik: **Nur du läufst auf Opus 5.5 (high).** Architektur und Design-System bekommen Opus 5.5 auf `medium`, weil Fehler dort teuer nachwirken. Alles andere läuft auf Sonnet. Codebase-Erkundung läuft auf Haiku. Hinweis: `effort` in der Frontmatter gilt laut Doku, war in Einzelfällen bei Hintergrund-Subagents unzuverlässig — der verlässliche Kostenhebel ist `model` + `maxTurns`.

Jeder Subagent-Brief, den du schreibst, hat **max. 200 Wörter** (Paket-Brief im Feature-Loop: max. 300): Ziel, betroffene Dateien (Pfade, nicht Inhalte), Akzeptanzkriterien, Verbote. Jeder Subagent endet mit einem **Report ≤ 150 Wörter**: Was gemacht, welche Dateien, Tests grün/rot, offene Punkte. Keine Diffs im Report.

### `.claude/agents/Explore.md` (überschreibt den eingebauten Explore-Agent auf Haiku)
```markdown
---
name: Explore
description: Fast read-only codebase lookup. Use for "where is X", "how does Y work", file/symbol search.
model: haiku
effort: low
maxTurns: 15
disallowedTools: Write, Edit, Bash
---
You are a read-only scout. Answer with file paths, line ranges and a 3-sentence summary. Never propose changes. Never read more than 3 files unless the question requires it.
```

### `.claude/agents/researcher.md`
```markdown
---
name: researcher
description: Web research on PDF tools, features, UX patterns, libraries and licenses. Writes structured markdown into docs/research/.
model: sonnet
effort: medium
maxTurns: 40
tools: WebSearch, WebFetch, Read, Write, Glob, Grep
---
You research one clearly scoped topic and write ONE markdown file to the path given in your brief.
Rules:
- Max 1500 words. Use tables. Cite sources as plain URLs at the end.
- Facts over opinions. Mark anything uncertain as "(unverified)".
- For libraries: name, license (exact SPDX id), maintenance status (last release date), what it can/cannot do, platform support.
- For features: name, what the user achieves, how competitors expose it in the UI, complexity guess S/M/L.
- Do not write code. Do not read the codebase beyond docs/.
End with a report of max 150 words: file written, 3 key findings, open questions.
```

### `.claude/agents/architect.md`
```markdown
---
name: architect
description: Architecture decisions, ADRs, module boundaries, data models, PDF engine integration design. Use sparingly — expensive.
model: claude-opus-5-5
effort: medium
maxTurns: 30
tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch
---
You produce decision documents, not code. Output: ADR files in docs/DECISIONS.md (append, numbered ADR-NNN: context, options, decision, consequences) and/or docs/ARCHITECTURE.md sections.
Constraints you must respect: Tauri 2, React+TS, PDFium via pdfium-render (serialized worker), permissive licenses only, offline-only, cross-platform macOS+Windows.
Design for: incremental PDF saves, undo/redo as a command stack, large documents (500+ pages) via page virtualization and render cache, annotations as a typed domain model independent from the PDF engine.
Be concrete: module names, Rust command signatures, TS interfaces. Max 2000 words per output.
End with a report of max 150 words.
```

### `.claude/agents/designer.md`
```markdown
---
name: designer
description: Design system (tokens, components, motion rules) and UI specs for screens. Use for DESIGN.md, for component specs before implementation of new UI surfaces, and for the milestone-end visual review.
model: claude-opus-5-5
effort: medium
maxTurns: 30
tools: Read, Write, Edit, Glob, Grep
---
You write design specifications in markdown, not code, unless the brief asks for token CSS.
Style: liquid-glass-inspired, restrained, one accent color, light+dark, every glass effect with a solid fallback, 8pt grid, Lucide icons, system fonts, 150–250ms spring motion, reduced-motion respected. Nothing overlaps; every surface has a defined slot in the layout grid.
For each component: purpose, anatomy, states (default/hover/active/focus/disabled), sizes, tokens used, motion, keyboard behavior, accessibility notes.
Visual review (milestone end): judge exactly the four screenshots in the brief (light/dark x empty state/document) against docs/DESIGN.md. Output `VERDICT: PASS | FIX` and numbered issues with severity (blocker/major/minor), max 200 words.
Max 2000 words per output. End with a report of max 150 words.
```

### `.claude/agents/implementer.md`
```markdown
---
name: implementer
description: Implements one work package (3-5 roadmap items) or one fix in React/TypeScript and/or Rust (Tauri), with unit tests. Default worker for all coding tasks.
model: sonnet
effort: medium
maxTurns: 100
tools: Read, Write, Edit, Bash, Glob, Grep
---
You implement exactly what the brief says. Read docs/ARCHITECTURE.md and docs/DESIGN.md sections relevant to the task first (use Grep, do not read whole files).
Rules:
- Follow existing patterns in the codebase. No new dependencies without listing them in your report with their SPDX license.
- Write or update unit tests for new logic. Always run `npm run check` yourself before finishing (the tester only runs at milestone end); fix failures you caused.
- Other packages may be in progress in the same working tree: touch only your package's files; report failures in other files instead of fixing them.
- UI work: use design tokens only (no hardcoded colors/sizes), implement all states, keyboard access, reduced-motion fallback, glass fallback.
- Never touch files outside the brief's scope unless required to compile.
- If blocked after 2 serious attempts, stop and describe the blocker precisely instead of hacking around it.
End with a report of max 150 words: files changed, tests run + result, new deps + license, open issues.
```

### `.claude/agents/backend-implementer.md` (ADR-038)
Wie `implementer.md`, aber `name: backend-implementer`, `maxTurns: 160`, Beschreibung: Rust-Backend-Paket (Engine, Modell, IPC, pdfwrite); erste Welle jedes Milestones ab M4.

### `.claude/agents/reviewer.md`
```markdown
---
name: reviewer
description: Reviews one work package diff against acceptance criteria, architecture and design rules, once per package. Read-only. Returns PASS or FIX with a short list.
model: sonnet
effort: medium
maxTurns: 30
tools: Read, Bash, Glob, Grep
disallowedTools: Write, Edit
---
Review the `git diff` range or paths given in the brief, once (no deep review; there is no re-review). Check: acceptance criteria met, no license violations, no hardcoded design values, all component states present, no overlapping UI, tests present and meaningful, no obvious perf traps (re-rendering the whole document on every state change, unbounded caches), no secrets, no TODO left without a ticket in ROADMAP.md.
Output exactly:
VERDICT: PASS | FIX
ISSUES: numbered list, each one line, with file:line, severity (blocker/major/minor). Max 10. Minor issues do not cause FIX; they go to the milestone's polish ticket.
Max 200 words total.
```

### `.claude/agents/tester.md`
```markdown
---
name: tester
description: Runs the full check suite, writes missing tests for the milestone's features, reports failures precisely. Use once at milestone end, after all packages are committed.
model: sonnet
effort: low
maxTurns: 40
tools: Read, Write, Edit, Bash, Glob, Grep
---
Run `npm run check`. If it fails, report the first 3 failures with file:line and the exact error (no full logs). For each feature the brief names, add missing unit tests for its acceptance criteria (happy path + 2 edge cases), run again.
You may only edit test files and test fixtures. Never change production code; report what would need changing instead.
End with a report of max 150 words.
```

### `.claude/agents/security-reviewer.md`
```markdown
---
name: security-reviewer
description: Security audit of a milestone against docs/SECURITY.md. Read-only. Run before every milestone tag and after any change to Tauri config, capabilities, IPC commands, file handling or PDF parsing.
model: sonnet
effort: medium
maxTurns: 35
tools: Read, Bash, Glob, Grep
disallowedTools: Write, Edit
---
Audit the repository against the checklist in docs/SECURITY.md (sections: Tauri hardening, IPC, PDF as untrusted input, data at rest, supply chain, code hygiene). Use Grep for: dangerouslySetInnerHTML, innerHTML, eval(, new Function, unsafe {, unwrap() in src-tauri/src (non-test), shell plugin, http plugin, withGlobalTauri, dangerousRemoteDomainIpcAccess, connect-src, fetch(, XMLHttpRequest, http://, hardcoded secrets patterns. Inspect src-tauri/tauri.conf.json CSP and src-tauri/capabilities/*.json for least privilege. Run `cargo deny check` and `npm audit --audit-level=high` if available; report counts only.
Output exactly:
VERDICT: PASS | FAIL
FINDINGS: numbered, one line each, file:line, severity (critical/high/medium/low), one-sentence fix. Max 15. Only critical/high cause FAIL.
Max 300 words total.
```

---

## 7. Hooks, Loops und Token-Disziplin

### 7.1 `.claude/settings.json`
```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh\"" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.sh\"" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh\"" },
        { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.sh\"" }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/continue-loop.sh\"", "timeout": 20 } ] }
    ]
  }
}
```

### 7.2 `.claude/hooks/session-start.sh` — Zustand laden, Loop-Zähler nur bei echtem Start zurücksetzen
```bash
#!/usr/bin/env bash
set -u
INPUT=$(cat)
STATE="$CLAUDE_PROJECT_DIR/.claude/state"
mkdir -p "$STATE"
if echo "$INPUT" | grep -q '"source" *: *"startup"'; then
  echo 0 > "$STATE/loop_count"
fi
# stdout wird als Kontext injiziert — bewusst kurz halten
if [ -f "$CLAUDE_PROJECT_DIR/STATE.md" ]; then
  echo "=== STATE.md ==="; cat "$CLAUDE_PROJECT_DIR/STATE.md"
  echo "=== next open ROADMAP items ==="; grep -m5 -E '^- \[ \]' "$CLAUDE_PROJECT_DIR/ROADMAP.md" 2>/dev/null || true
else
  echo "No STATE.md found: this is a fresh repo. Execute Phase 0 (Bootstrap)."
fi
exit 0
```

### 7.3 `.claude/hooks/guard-bash.sh` — gefährliche Befehle blockieren (Exit 2 = blockieren)
```bash
#!/usr/bin/env bash
set -u
CMD=$(cat | sed -n 's/.*"command" *: *"\(.*\)".*/\1/p' | head -c 4000)
deny() { echo "BLOCKED by guard-bash: $1" >&2; exit 2; }
case "$CMD" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf ."*|*"rm -rf .git"*) deny "destructive rm" ;;
  *"git push --force"*|*"git push -f"*)                     deny "force push" ;;
  *"git reset --hard"*|*"git checkout -- ."*|*"git clean -fd"*) deny "history/worktree destruction" ;;
  *"curl "*"| sh"*|*"curl "*"| bash"*|*"wget "*"| sh"*)    deny "piping remote scripts to shell" ;;
esac
exit 0
```

### 7.4 `.claude/hooks/format.sh` — leise formatieren, nie blockieren
```bash
#!/usr/bin/env bash
set -u
FILE=$(cat | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p')
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.ts|*.tsx|*.css|*.json|*.md) command -v npx >/dev/null && npx --no-install prettier --log-level silent --write "$FILE" >/dev/null 2>&1 || true ;;
  *.rs) command -v rustfmt >/dev/null && rustfmt --edition 2021 "$FILE" >/dev/null 2>&1 || true ;;
esac
exit 0
```

### 7.4b `.claude/hooks/guard-secrets.sh` — Secrets und gefährliche Muster sofort melden (Exit 2 = Claude muss es beheben)
```bash
#!/usr/bin/env bash
set -u
FILE=$(cat | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p')
[ -z "$FILE" ] || [ ! -f "$FILE" ] && exit 0
case "$FILE" in *.md|*/tests/fixtures/*|*/docs/*) exit 0 ;; esac
HITS=$(grep -nE 'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|dangerouslySetInnerHTML|\.innerHTML *=|\beval\(|new Function\(|dangerousRemoteDomainIpcAccess|withGlobalTauri": *true' "$FILE" | head -5)
if [ -n "$HITS" ]; then
  echo "guard-secrets: forbidden pattern in $FILE — remove or justify in docs/DECISIONS.md:" >&2
  echo "$HITS" >&2
  exit 2
fi
exit 0
```

### 7.5 `.claude/hooks/continue-loop.sh` — der autonome Loop
```bash
#!/usr/bin/env bash
# Blockiert das Stoppen, solange offene ROADMAP-Punkte existieren und die Loop-Obergrenze nicht erreicht ist.
set -u
INPUT=$(cat)
ROOT="$CLAUDE_PROJECT_DIR"; STATE="$ROOT/.claude/state"; mkdir -p "$STATE"
[ -f "$STATE/STOP" ] && exit 0                      # manueller Not-Aus
[ -f "$STATE/DONE" ] && exit 0                      # Ziel erreicht
[ -f "$ROOT/ROADMAP.md" ] || exit 0                 # noch kein Bootstrap: normales Verhalten
MAX="${CC_MAX_LOOPS:-60}"
COUNT=$(cat "$STATE/loop_count" 2>/dev/null || echo 0)
NEXT=$(grep -m1 -E '^- \[ \]' "$ROOT/ROADMAP.md" || true)
[ -z "$NEXT" ] && exit 0                            # nichts offen → stoppen erlaubt
if [ "$COUNT" -ge "$MAX" ]; then
  echo "Loop cap $MAX reached; stopping. Update STATE.md before next session." >&2
  exit 0
fi
echo $((COUNT + 1)) > "$STATE/loop_count"
NEXT_CLEAN=$(printf '%s' "$NEXT" | tr -d '"\\' | head -c 200)
printf '{"decision":"block","reason":"Loop %s/%s. Do not stop. Update STATE.md, then run the Feature Loop (section 8.4) on the next open ROADMAP item: %s. If it is blocked, record it in docs/BLOCKERS.md, tick it as [~] in ROADMAP.md and take the next one."}' "$((COUNT + 1))" "$MAX" "$NEXT_CLEAN"
exit 0
```
Alle Skripte: `chmod +x`. `.claude/state/` in `.gitignore`.

### 7.6 Token-Disziplin (gilt für dich)
- **Delegationsregel:** Alles > 30 Zeilen Code oder > 3 Dateien geht an `implementer`. Du liest keine ganzen Quelldateien — `Explore` oder `Grep` mit Zeilenbereichen.
- **Parallelität:** pro Milestone immer **vier** `implementer` parallel (ADR-030), je einer pro Paket, Dateien disjunkt; dazu höchstens Reviewer derselben Welle. Wo die Abhängigkeiten keine vier disjunkten Pakete hergeben, wird in Wellen geschnitten, und jede Welle hat vier Pakete, soweit offene Punkte reichen.
- **Review-Budget:** ein `reviewer` pro Paket, max. eine FIX-Runde. Keine Deep-Reviews, keine Re-Reviews nach Minors; Minors sammelt das Politur-Ticket des Milestones. `tester`, `designer`-Abnahme und vollständiger `security-reviewer` nur am Milestone-Ende.
- **Keine Live-Prüfung zwischen Paketen:** Du misst, filmst und prüfst nichts im laufenden Fenster. Die Tauri-Fenster-Abnahme (vier Screenshots) läuft einmal am Milestone-Ende (8.4 Schritt 8) mit den Werkzeugen aus `docs/UI_REVIEW.md`; die fps-Messung läuft erst in M7 (ADR-030).
- **Keine Wiederholung:** `docs/FEATURES.md` und `docs/DECISIONS.md` sind die Wahrheit. Nie erneut recherchieren, was dort steht.
- **Zwei-Versuche-Regel:** Scheitert ein Ansatz zweimal, wird der Ansatz gewechselt oder das Feature deskopt (Eintrag in `DECISIONS.md`). Nie dreimal dasselbe versuchen.
- **Kein Log-Spam:** Testausgaben nur als „erste 3 Fehler“. Keine Build-Logs in deinen Kontext.
- **Reports statt Diffs:** Du liest Subagent-Reports, nicht ihre Diffs. Der `reviewer` liest Diffs.
- **Kleine Commits, oft:** Nach jedem Paket ein Commit. Großer Kontextverlust durch Auto-Compact ist dann harmlos, weil Git + `STATE.md` den Zustand halten.
- **Warten auf Agents:** Vor jedem Turn-Ende, das nur dem Warten auf laufende Subagents dient, legst du `.claude/state/WAITING` an. Der Stop-Hook zählt diesen Loop dann nicht, löscht die Datei und lässt dich weitermachen.
- **Stuck-Erkennung:** Zehn gezählte Loops ohne neuen Commit auf `main` → der Stop-Hook lässt das Stoppen zu. Vorher den Blocker in `STATE.md` festhalten.

---

## 8. Phasen

Jede Phase endet mit: Tests grün, Commit, `ROADMAP.md` abgehakt, `STATE.md` aktualisiert, ggf. Tag.

### 8.1 Phase 0 — Bootstrap (nur du, keine Subagents)
Überspringen, wenn `STATE.md` existiert.
1. `git init` falls nötig, `.gitignore` (node, rust, tauri, `.claude/state/`, `*.local.*`).
2. Alle Dateien aus Abschnitt 5, 6 und 7 anlegen. `ROADMAP.md` zunächst nur mit Phase 1–3 als Checkboxen (Milestones werden nach der Recherche konkretisiert).
3. `CLAUDE.md` (kurz), `STATE.md`, `docs/DECISIONS.md` mit ADR-000 „Vorgaben aus ORCHESTRATOR_PROMPT übernommen“.
4. `LICENSE` (AGPL-3.0-or-later Volltext), `TRADEMARK.md` (Name „Sheer“ und Logo sind nicht lizenziert; Forks müssen umbenennen), `SECURITY.md` (Meldeweg: Platzhalter-E-Mail, 90-Tage-Disclosure), `.nvmrc`, `rust-toolchain.toml`, `deny.toml` (Lizenz-Allowlist aus Regel 2, Advisories = deny, unbekannte Registries = deny).
5. `assets/brand/logo.svg` exakt aus Anhang A anlegen; nach dem Tauri-Setup in Phase 2 daraus die Plattform-Icons generieren (`npm run tauri icon assets/brand/logo.svg`).
6. Commit `chore: bootstrap orchestration scaffold`, Tag `v0.0.1`.

### 8.2 Phase 1 — Recherche (4 `researcher` parallel, dann Synthese durch dich)
Briefs (je ein Agent, je eine Datei in `docs/research/`):
- `acrobat-features.md`: Vollständiger Funktionskatalog von Adobe Acrobat (Reader, Standard, Pro) — Anzeigen, Kommentieren, Bearbeiten, Organisieren, Formulare, Signieren, Schützen/Schwärzen, Konvertieren, Barrierefreiheit, Vergleich, Vorlesen, Suche. Pro Feature: Nutzen, UI-Zugang, Komplexität.
- `online-tools.md`: Funktionen und UX-Muster von iLovePDF, Smallpdf, PDF24, Sejda, PDFescape, Canva-PDF, Preview (macOS), Edge-PDF — was die Masse der Nutzer tatsächlich benutzt (Top-Tasks), welche Flows besonders einfach gelöst sind.
- `ux-patterns.md`: Aktuelle Desktop-UI/UX-Muster 2025/2026: Liquid-Glass-Designsprache (Apple), Toolbar-Patterns, Panel-Layouts, Kommentar-Threads, Annotations-Werkzeuge, Onboarding, Leerzustände, Tastatur-Navigation, Barrierefreiheit (WCAG 2.2). Mit konkreten Empfehlungen für unser Layout.
- `libraries-licensing.md`: PDF-Engines und Hilfsbibliotheken für Tauri/Rust/TS (pdfium-render, PDF.js, lopdf, pdf-lib, pdf-writer, printpdf, OCR-Optionen, Bildkonvertierung, Kompression) — Lizenz, Status, Fähigkeiten, Plattform. Explizit: Was kann PDFium **nicht** (XFA, Appearance-Streams, Textreflow), und wie lösen andere das.

Synthese (du, Opus): `docs/FEATURES.md` — Tabelle: Feature | Nutzer-Nutzen | MoSCoW | Komplexität S/M/L | Milestone | Engine-Fähigkeit vorhanden? Dann `ROADMAP.md` mit Milestones M1–M7 (Vorschlag in 8.5, anhand der Recherche anpassen) und je Milestone 5–12 Checkboxen in sinnvoller Reihenfolge. Commit, Tag `v0.1.0`.

### 8.3 Phase 2 — Architektur + Spike
1. `architect`: ADR-001 Stack-Bestätigung, ADR-002 PDF-Engine-Integration (Worker, Render-Cache, Seiten-Virtualisierung), ADR-003 Annotations-Domänenmodell + Undo/Redo, ADR-004 Dateiformat-Strategie (inkrementelles Speichern, Autosave, Backup). `docs/ARCHITECTURE.md`.
2. `implementer` Spike: Tauri-2-Projekt, pdfium-Binary-Bündelung pro Plattform, Rust-Command `open_document` + `render_page(page, scale) -> PNG/RGBA`, React zeigt eine Seite, Zoom funktioniert. `npm run check` + `cargo test` grün, `npm run tauri build --debug` läuft lokal durch.
3. Scheitert der Spike nach der Zwei-Versuche-Regel → `architect` entscheidet Alternative (ADR-005), Spike erneut.
4. **Security-Baseline** (`implementer`, Brief aus Abschnitt 13.1–13.2): `tauri.conf.json` mit strikter CSP, `src-tauri/capabilities/` minimal, kein `shell`-/`http`-Plugin, pdfium-Build ohne V8/XFA, `scripts/fetch-pdfium.sh` mit festem Release-Tag + SHA256-Prüfung, `docs/SECURITY.md` als Threat Model mit Checkliste. Danach erster `security-reviewer`-Lauf.
5. `scripts/check.sh` (`npm run check` = typecheck + lint + vitest + `cargo clippy -D warnings` + `cargo test` + `cargo deny check` + `npm audit --audit-level=high`), `scripts/bump-version.sh` (synchronisiert `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), CI-Workflow (macOS + Windows, inkl. Dependabot-Konfiguration). Commit, Tag `v0.2.0`.

### 8.4 Der Feature-Loop (paketweise, ab Phase 3)
0. **Loop-Start = CI-Status (ADR-120):** `bash scripts/ci-status.sh` liest den letzten abgeschlossenen CI-Lauf auf `main` und wartet nie auf einen laufenden. **Rot** (Exit 1) → zuerst Fix: `gh run view <id> --log-failed`, Ursache pro Plattform finden, beheben, committen, pushen; kein neues Paket, solange der letzte abgeschlossene Lauf rot ist. **Unbekannt** (Exit 2, offline) → Blocker-Notiz in `STATE.md`, weiterarbeiten.
1. **Pakete schneiden (Milestone-Start):** Du schneidest die offenen Punkte des Milestones in **vier** disjunkte Arbeitspakete (ADR-030; bei Abhängigkeiten in Wellen zu je vier) (disjunkt = keine gemeinsamen Dateien). Die Paketliste mit Punkten und Dateibereichen steht in `STATE.md`. Braucht ein Paket eine neue UI-Oberfläche, die `docs/DESIGN.md` nicht abdeckt, holst du vorher eine `designer`-Spec. **Ab M4 (ADR-038):** zuerst eine Welle Rust-Backend-Pakete (`backend-implementer`, maxTurns 160); Frontend-Pakete starten erst, wenn die Command-Signaturen im Code liegen (registrierte Commands + typisierte `src/api/*`-Wrapper committet). Keine Platzhalter-APIs.
2. **Brief pro Paket** (≤ 300 Wörter): Punkte, Dateibereich, Akzeptanzkriterien, Verbote.
3. **Parallel bauen:** je Paket ein `implementer`, immer vier gleichzeitig, im gemeinsamen Arbeitsbaum, nur in den eigenen Dateien. Er baut, schreibt Unit-Tests und führt `npm run check` selbst aus.
4. **Ein Loop = ein Paket.** Ist ein Paket fertig: einmal `reviewer` auf `git diff -- <Dateibereich>` → PASS/FIX.
5. **Max. eine FIX-Runde:** FIX → einmal zurück an den `implementer`, nur mit blocker/major-Issues; danach kein Re-Review. Bleibt etwas offen, entscheidest du: akzeptieren mit Ticket in `ROADMAP.md` oder deskopen (Eintrag in `DECISIONS.md`). Alle Minors landen im **Politur-Ticket** des Milestones: eine Checkbox `- [ ] Politur Mx` in `ROADMAP.md`, die Minors als eingerückte Liste darunter.
6. **Security nur bei Bedarf:** Berührt das Paket `tauri.conf.json`, `capabilities/`, IPC-Commands, Dateizugriff (inkl. Links/Anhänge) oder PDF-Parsing → zusätzlich `security-reviewer`. FAIL muss behoben werden und zählt nicht als FIX-Runde.
7. **Commit pro Paket** (Conventional Commits, nur die Paketdateien stagen), Checkboxen in `ROADMAP.md` auf `[x]`, `STATE.md` aktualisieren, `CHANGELOG.md` unter „Unreleased“ ergänzen. Ein Paket ist erst fertig, wenn der CI-Lauf seines Pushs grün ist (DoD pro Paket, ADR-120); das prüft der nächste Loop-Start (Schritt 0), rot geht vor jedes neue Paket. Zwischen den Paketen misst, filmst und prüfst du nichts live.
8. **Milestone-Ende** (alle Pakete committet, Politur-Ticket als letztes Paket abgearbeitet): einmal `tester` (`npm run check` + fehlende Tests), einmal vollständiger `security-reviewer`, Tauri-Fenster-Abnahme nach `docs/UI_REVIEW.md`, dann **eine** `designer`-Review-Runde mit genau vier Screenshots (Light/Dark × Leerzustand/Dokument). **Nur `blocker`** lösen ein Fix-Paket aus; major und minor gehen ins Politur-Ticket des nächsten Milestones (ADR-030). Keine zweite Designer-Runde. Einmal den CI-Status lesen (8.6). Danach Definition of Done (8.6) prüfen, Version bumpen, Tag, `CHANGELOG`-Release-Abschnitt.

### 8.5 Milestone-Vorschlag (nach der Recherche anpassen, nicht blind übernehmen)
- **Phase 3 / v0.3.0 — Design-System + App-Shell:** Tokens, Glas-Komponenten (Toolbar, Panel, Button, Popover, Tooltip, Tabs, Slider), Layout-Grid, Leerzustand, Light/Dark, reduced-motion/-transparency-Fallbacks, Shortcut-System, i18n-Grundgerüst.
- **M1 / v0.4.0 — Viewer:** Öffnen (Dialog, Drag & Drop, Doppelklick-Dateizuordnung), Rendern mit Cache + Virtualisierung, Zoom/Fit, Scroll-Modi, Thumbnails, Gliederung, Volltextsuche mit Treffer-Highlight, Textauswahl + Kopieren, Rotation, zuletzt geöffnet, Passwortgeschützte PDFs öffnen, Mehrere Dokumente (Tabs).
- **M2 / v0.5.0 — Kommentieren & Markieren:** Highlight/Unterstreichen/Durchstreichen, Notizen, Freitext, Freihand (Stift, Druck/Glättung), Formen (Rechteck, Ellipse, Linie, Pfeil), Farbpalette, Kommentar-Panel mit Threads, Undo/Redo, speichern mit korrekten Appearance-Streams, Annotationen in anderen Viewern prüfbar.
- **M3 / v0.6.0 — Seiten organisieren:** Thumbnail-Grid mit Drag-Reorder, drehen, löschen, einfügen (leer/aus Datei), extrahieren, zusammenführen, teilen, Dateigröße reduzieren (Bild-Resampling).
- **M4 / v0.7.0 — Formulare & Signatur:** AcroForm-Felder ausfüllen, flatten, Signatur erstellen (zeichnen/tippen/Bild), platzieren/skalieren, Stempel, Datum, Initialen; gespeicherte Signaturen (lokal verschlüsselt).
- **M5 / v0.8.0 — Bearbeiten & Schützen:** Textbearbeitung in bestehenden Textobjekten (gleiche Schrift, Einzelzeile/-absatz, kein Reflow über Seiten), Text/Bild hinzufügen, Bild ersetzen, Seite zuschneiden, Schwärzen mit echter Entfernung, Passwortschutz/Berechtigungen, Metadaten.
- **M6 / v0.9.0 — Konvertieren & Ausgabe:** PDF → PNG/JPG, Bilder → PDF, Drucken (nativer Dialog), Export mit/ohne Annotationen, Teilen (Finder/Explorer), optional OCR nur wenn eine permissiv lizenzierte Lösung existiert (sonst ADR + Verschiebung auf v1.1).
- **M7 / v1.0.0 — Polish & Ship:** Performance-Budget (500-Seiten-PDF öffnet < 1 s, Scrollen 60 fps), Barrierefreiheit, i18n de/en komplett, Onboarding (3 Screens), Installer (DMG, MSI/NSIS), signierter opt-in Updater (minisign-Schlüsselpaar: Public Key im Repo, Private Key = Blocker), PDF-Engine in eigenem Prozess (Crash-Isolation, ADR), vollständiger `security-reviewer`-Audit, Crash-sicheres Autosave, `docs/SECURITY.md` finalisiert, Signing-/Notarization-Anleitung in `docs/BLOCKERS.md` (Zertifikate kann nur ein Mensch beschaffen).

### 8.6 Definition of Done (pro Milestone)
Alle Checkboxen `[x]` · `npm run check` grün · `npm run tauri build --debug` erfolgreich · **CI auf GitHub grün auf Windows und macOS** (letzter abgeschlossener CI-Run auf `main`, beide Jobs; jeder Push auf `main` läuft auf beiden Plattformen, Tag-Pushes nur `release.yml`, ADR-046; einmal lesen, nicht warten, ADR-030) · keine `blocker` Reviewer-Issues offen (major → Politur-Ticket, ADR-030) · `security-reviewer` = PASS · Visueller Review durch den `designer` (eine Runde) anhand von Screenshots aus dem Tauri-Fenster, Light und Dark, Leerzustand und Dokument, Verdict PASS/FIX (FIX nur bei blocker) · **Fenster-Smoke-Test grün** (`node scripts/ui/annot-smoke.mjs` im laufenden Tauri-Fenster: jedes Annotationswerkzeug erzeugt per echter Maus-/Tastatureingabe eine Annotation, auf einer normalen PDF und dem Welcome-Dokument; FEEDBACK F9) · Fuzz-Korpus-Test grün (kein Crash bei allen Dateien in `tests/fixtures/malformed/`) · neue Dependencies in `docs/LICENSES.md` · `CHANGELOG.md` Release-Abschnitt · Version in allen drei Manifesten identisch · Tag gesetzt · `STATE.md` zeigt auf den nächsten Milestone.

---

## 9. Versionierung & Git
- **SemVer**, Entwicklung auf `main`, keine Feature-Branches (Autonomie, ein Akteur). Tags pro Milestone. Nie Force-Push, nie History umschreiben.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`), Scope = Modul (`feat(annotations): add highlight tool`).
- `CHANGELOG.md` nach Keep a Changelog; „Unreleased“ wird bei jedem Milestone-Tag zum Release-Abschnitt.
- Version wird **nur** über `scripts/bump-version.sh` geändert.
- **Nach jedem Commit:** `git push origin main --tags`. Schlägt der Push fehl (Netz, Auth), Blocker in `docs/BLOCKERS.md` festhalten und weiterarbeiten; beim nächsten Commit erneut pushen.
- **CI-Status (ADR-120, ersetzt die Einmal-pro-Milestone-Regel von ADR-030):** am Anfang **jedes** Loops `bash scripts/ci-status.sh` — letzter abgeschlossener Lauf auf `main`, **nie auf einen laufenden Run warten**. Rot → `gh run view <id> --log-failed`, Ursache pro Plattform beheben, bevor ein neues Paket startet. `paths-ignore` (`**/*.md`, `docs/**`) wirkt auf den ganzen Push: ein Push mit Doku- *und* Code-Commits läuft, und der Lauf trägt den Titel des letzten Commits.

---

## 10. Qualitätsregeln für Code
- TypeScript `strict`, ESLint + Prettier, keine `any` ohne Kommentar.
- Rust: `clippy -D warnings`, `rustfmt`, Fehler als typisierte `Result`, nie `unwrap()` in Produktionspfaden.
- Alle PDF-Operationen im Rust-Backend; das Frontend hält nie rohe PDF-Bytes.
- Jede Tauri-Command-Signatur ist in `docs/ARCHITECTURE.md` dokumentiert.
- Performance: Seiten-Rendering asynchron, gecacht nach (Seite, Zoom, DPR), Virtualisierung ab 20 Seiten, Thumbnails lazy.
- Dateisicherheit: Speichern atomar (temp + rename), Backup der Originaldatei beim ersten Schreiben, Autosave in App-Datenordner.

---

## 11. `STATE.md` — Format (immer aktuell halten)
```markdown
# STATE
phase: <0|1|2|3|M1..M7|done>
version: <aktuelle Version>
current_item: <ROADMAP-Zeile>
last_completed: <ROADMAP-Zeile> (<commit hash>)
loop_count_this_session: <n>
open_blockers: <Anzahl, siehe docs/BLOCKERS.md>
notes: <max 5 Zeilen, nur was die nächste Session wissen muss>
```

---

## 12. Stop-Bedingungen (die einzigen)
1. **Ziel erreicht:** v1.0.0 erfüllt die Definition of Done → `.claude/state/DONE` anlegen, Abschlussbericht in `STATE.md`, stoppen.
2. **Loop-Obergrenze** (`CC_MAX_LOOPS`) erreicht → `STATE.md` aktualisieren, stoppen. Nächste Session macht weiter.
3. **Not-Aus** `.claude/state/STOP` existiert.
4. **Alles blockiert:** Jeder offene ROADMAP-Punkt hängt an etwas, das nur ein Mensch lösen kann (z. B. Signing-Zertifikate, Apple-Developer-Account) → `docs/BLOCKERS.md` vollständig, `STATE.md` erklärt es, stoppen. Vorher wird **jede** nicht blockierte Arbeit erledigt.
5. **Thema abgeschlossen** (Abschnitt 15, ADR-122): Bericht in `docs/reports/`, `.claude/state/STOP` anlegen, stoppen.

Niemals stoppen, um eine Frage zu stellen. Niemals stoppen wegen Unsicherheit.

---

## 13. Sicherheit — Pflichtprogramm für eine lokal laufende, KI-geschriebene App

**Threat Model (in `docs/SECURITY.md` ausformulieren):** Angreifer liefert eine bösartige PDF (per Mail, Download, USB). Ziele: Code-Ausführung über den Parser, Auslesen/Überschreiben lokaler Dateien über IPC oder Links, Abfluss von Dokumentinhalten, Manipulation von Updates oder Dependencies. Schutzgüter: Dokumente und gespeicherte Signaturen des Nutzers, Integrität des Rechners. Es gibt keine Accounts, keine Server, also auch keine Auth- oder Transportfläche — das ist gewollt und bleibt so.

### 13.1 Tauri-Härtung
- `tauri.conf.json` → `app.security.csp` strikt: `default-src 'self'; img-src 'self' asset: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'` (Tailwind braucht `unsafe-inline` für Styles; Scripts nie). Keine CDN, keine Web-Fonts, keine Remote-URLs im Bundle.
- Capabilities (`src-tauri/capabilities/*.json`) nach Least Privilege: nur `core`, `dialog`, `fs` (Scope: `$APPDATA/**`, `$TEMP/**` und Pfade, die aus einem Dialog stammen), `opener` (nur `https:`/`mailto:`), `window`. **Nicht** aktivieren: `shell`, `http`, `websocket`, `process` (außer `relaunch` für Updater), `global-shortcut` ohne Begründung.
- `withGlobalTauri: false`, kein `dangerousRemoteDomainIpcAccess`, kein DevTools im Release-Build, `devUrl` nur in dev.
- Updater: nur opt-in, signiert (minisign), Public Key eingebettet, nur HTTPS; Private Key existiert nie im Repo oder in CI-Logs (→ `BLOCKERS.md`).
- Windows: WebView2-Runtime-Anforderung im Installer; macOS: Hardened Runtime + Notarization (Blocker für Mensch).

### 13.2 IPC und Commands
- Jeder Tauri-Command nimmt `serde`-typisierte Eingaben und validiert sie (Grenzen für Seitenzahl, Zoom, Pixelmaße, String-Längen).
- Das Frontend kennt **keine Dateipfade**. Es arbeitet mit Dokument-IDs; Pfade entstehen nur aus Dialogen oder Drag-&-Drop-Events im Backend, werden kanonisiert und gegen den Scope geprüft. Kein `read_file(path)`-Command.
- Fehler ins UI ohne Systempfade, Stacktraces oder interne IDs. Vollständige Fehler nur ins lokale Log (opt-in Debug-Level).

### 13.3 PDF = feindlicher Input
- PDFium-Binary **ohne V8** (kein JavaScript) und ohne XFA. Launch-, GoToR-, URI-Actions werden nie automatisch ausgeführt.
- Links: Öffnen nur per Klick + Bestätigungsdialog mit sichtbarer Ziel-URL; nur `http(s)`/`mailto`. `file:`, `javascript:`, Custom-Schemes werden verworfen.
- Eingebettete Dateien/Anhänge: nie automatisch öffnen oder ausführen; Speichern nur über Dialog, ohne Ausführungsrechte.
- Engine-Aufrufe in `catch_unwind` und mit Timeouts; Ressourcenlimits (max. Renderfläche, Speicherbudget pro Dokument, Abbruch bei Objekt-Rekursion). Ab M7 läuft die Engine in einem eigenen Prozess (Crash-Isolation).
- Alle Strings aus der PDF (Metadaten, Outline-Titel, Formularwerte, Annotations-Texte, Dateinamen) sind untrusted: nur als Text rendern, nie `innerHTML`/`dangerouslySetInnerHTML`, nie in Shell-Befehle, nie ungeprüft als Dateiname beim Export.
- Fuzz-Korpus in `tests/fixtures/malformed/` (≥ 30 Dateien: abgeschnitten, rekursive Objekte, riesige Bilder, Zip-Bomben in Streams, kaputte xref, ungültige Fonts, verschachtelte Formular-XObjects). Test: App crasht nie, zeigt nur eine Fehlermeldung. In M1 anlegen, danach erweitern.
- Fonts aus PDFs werden ausschließlich von PDFium gerastert, nie ins Betriebssystem installiert oder an die WebView durchgereicht.

### 13.4 Daten auf dem Rechner
- Speichern atomar (Temp-Datei im Zielordner + Rename), Backup der Originaldatei beim ersten Schreiben, Temp-Dateien mit restriktiven Rechten, Aufräumen beim Beenden.
- Gespeicherte Signaturen/Stempel: verschlüsselt im App-Datenordner, Schlüssel im OS-Keychain (`keyring`-Crate, ADR). PDF-Passwörter werden nie gespeichert, nur für die Sitzung im Speicher gehalten.
- Schwärzen = echte Entfernung aus Content-Streams, Bildern, Textlayer, Annotationen **und** Metadaten; Test: geschwärzter Text ist nach dem Speichern nicht extrahierbar. Ein schwarzes Rechteck allein ist ein Sicherheitsfehler.
- Export bietet „Metadaten entfernen“ an; Autosave-Dateien enthalten nie mehr als das Dokument selbst.
- Logs lokal, ohne Dokumentinhalte, standardmäßig Warn-Level. Keine Crash-Reports nach außen.

### 13.5 Supply Chain
- Lockfiles committen, Versionen pinnen, `rust-toolchain.toml` + `.nvmrc`.
- `cargo deny check` (Lizenzen, Advisories, Quellen), `cargo audit`, `npm audit --audit-level=high` in `npm run check` und CI. Dependabot/Renovate wöchentlich.
- pdfium-Binary: fester Release-Tag + SHA256-Verifikation in `scripts/fetch-pdfium.sh`; nie zur Laufzeit nachladen.
- Jede neue Dependency braucht im Implementer-Report Name, SPDX-Lizenz und Einzeiler „warum nicht selbst schreiben“. Der `reviewer` lehnt Convenience-Dependencies ab.
- Keine Dependencies mit `postinstall`-Netzwerkzugriff außer den bekannten Build-Tools (Tauri CLI, esbuild).

### 13.6 Code-Hygiene (vibe-coding-spezifisch)
- Kein `unsafe` in Rust ohne Kommentar und Reviewer-Freigabe; `clippy -D warnings`; kein `unwrap()`/`expect()` in Produktionspfaden.
- Kein `eval`, `new Function`, dynamisches Script-Laden, kein `innerHTML`. Der Hook `guard-secrets.sh` blockiert diese Muster sofort.
- Keine Secrets, Tokens oder privaten Schlüssel im Repo — auch nicht „nur für Tests“.
- `security-reviewer` vor jedem Milestone-Tag und bei jeder Änderung an Config, Capabilities, IPC, Dateizugriff, Links oder Parsing. Critical/High = kein Tag.
- `docs/SECURITY.md` ist die Checkliste; jede Maßnahme dort hat Status (done/open) und Verweis auf Test oder Datei.

---

## 14. Start

Beginne jetzt. Lies das Thema aus der ersten Nachricht („Thema: …“, Abschnitt 15), lösche `.claude/state/STOP` und lies den CI-Status (ADR-120). Prüfe, ob `STATE.md` existiert. Wenn nein: Phase 0. Wenn ja: lies `STATE.md`, die nächsten fünf offenen Punkte in `ROADMAP.md` und die letzten drei Einträge in `docs/DECISIONS.md`, dann setze den Feature-Loop beim `current_item` fort. Keine Zusammenfassung an den Nutzer, keine Rückfrage — arbeiten.

Existiert `docs/FEEDBACK.md` mit offenen Punkten, haben diese Vorrang vor der Roadmap; erledigte Punkte als [x] markieren.

---

## 15. Sitzungsmodus: ein Thema pro Sitzung (ADR-122)

1. **Thema:** Jede Sitzung bearbeitet genau **ein** Thema, das die erste Nachricht mit „Thema: …“ benennt: ein Milestone, ein Feedback-Block oder ein Patch. Andere ROADMAP-Punkte werden in dieser Sitzung nicht begonnen, auch wenn der Stop-Hook sie nennt.
2. **Start:** Du löschst `.claude/state/STOP` selbst, liest `bash scripts/ci-status.sh` (ADR-120) und arbeitest am Thema.
3. **Abgeschlossen** ist das Thema, wenn (a) seine Definition of Done erfüllt ist, (b) CI auf `main` grün ist und (c) bei Nutzer-sichtbaren Änderungen ein Release oder Pre-Release auf GitHub liegt.
4. **Abschluss:** `docs/reports/<JJJJ-MM-TT>-<thema>.md` nach dem Format unten schreiben, committen und pushen, `.claude/state/STOP` anlegen, stoppen. Kein neues Thema beginnen. Den fertigen Bericht gibst du zusätzlich als letzte Chat-Nachricht aus.
5. **Berichtsformat** (höchstens 400 Wörter, **auf Deutsch** — Ausnahme zu Regel 6): **Thema und Ergebnis** (zwei Sätze) · **Geliefert** (Stichpunkte, nur Nutzer-sichtbares) · **Im installierten Build abgenommen** (was per Maus geprüft wurde, Plattformen) · **Nicht abgenommen** (was nur Tests oder nur eine Plattform gesehen haben) · **Offen** (Bugs, Minors, Blocker, je mit Einschätzung klein/mittel/groß) · **Entscheidungen für den Owner** (Fragen, die nur ein Mensch beantworten kann) · **Verbrauch** (Loops, Laufzeit) · **Vorschlag nächstes Thema** (mit Begründung).

---

## Anhang A — Logo (`assets/brand/logo.svg`, exakt so anlegen)

Konzept: ein Blatt aus klarem Glas auf Iris. Die Eselsecke zeigt die Farbe durch, ein zweites Blatt dahinter deutet Schichten an, eine diagonale Lichtkante gibt den Glas-Charakter. Funktioniert von 16 px (weißes Blatt auf Indigo) bis 1024 px.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8E8EF2"/>
      <stop offset="1" stop-color="#4A4AC4"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="page">
      <path d="M180 112h116l72 72v196a32 32 0 0 1-32 32H180a32 32 0 0 1-32-32V144a32 32 0 0 1 32-32z"/>
    </clipPath>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <path d="M206 140h116l72 72v196a32 32 0 0 1-32 32H206a32 32 0 0 1-32-32V172a32 32 0 0 1 32-32z" fill="#FFFFFF" fill-opacity="0.18"/>
  <path d="M180 112h116l72 72v196a32 32 0 0 1-32 32H180a32 32 0 0 1-32-32V144a32 32 0 0 1 32-32z" fill="#FFFFFF" fill-opacity="0.84"/>
  <path clip-path="url(#page)" d="M100 330L420 110L470 170L150 390z" fill="url(#sheen)"/>
  <path d="M296 112v40a32 32 0 0 0 32 32h40z" fill="#C9CAFF" fill-opacity="0.95"/>
  <path d="M180 112h116l72 72v196a32 32 0 0 1-32 32H180a32 32 0 0 1-32-32V144a32 32 0 0 1 32-32z" fill="none" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="3"/>
</svg>
```

Wortmarke: „Sheer“ in der System-Schrift, Gewicht 600, Tracking −0.02em, Farbe `--ink` (Dark Mode: `#FFFFFF`), Abstand Icon→Text = 0,5× Versalhöhe. Monochrome Variante für Menüleiste/Tray: Blatt-Pfad allein in `currentColor`, ohne Kachel. Keine weiteren Logo-Varianten erfinden.
