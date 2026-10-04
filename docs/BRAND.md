# SHEER — CORPORATE DESIGN & UI DESIGN SYSTEM

## 1. Brand

Produktname:
sheer.

Schreibweise:
Immer „sheer.“ — komplett kleingeschrieben und mit Punkt.

Produkt:
sheer ist eine moderne Desktop-Anwendung zum Lesen, Bearbeiten, Kommentieren,
Organisieren und Exportieren von PDFs.

Die Anwendung soll funktional mit professionellen PDF-Tools konkurrieren,
visuell aber deutlich leichter, moderner und ruhiger wirken.

Claim:
PDFs made simple.

Optionaler längerer Claim:
Read. Edit. Organize. Effortlessly.


## 2. Design Direction

Die visuelle Identität von sheer orientiert sich an modernem Editorial Design,
zeitgenössischem Schweizer Grafikdesign und minimalistischen digitalen Interfaces.

Zentrale Eigenschaften:

- minimal
- ruhig
- hochwertig
- präzise
- modern
- leicht
- editorial
- funktional
- freundlich, aber nicht verspielt
- technisch, aber nicht „developer-like“
- selbstbewusst, aber nicht aggressiv

Die Oberfläche soll NICHT wie klassische Business-Software aussehen.

Insbesondere vermeiden:

- typische Microsoft-/Enterprise-Optik
- übermäßig viele Rahmen
- starke Drop Shadows
- dunkle Toolbars
- schwarze Flächen
- aggressive Farbkontraste
- klassische blaue SaaS-Akzentfarben
- Glassmorphism
- starke 3D-Effekte
- bunte Icons
- unnötige Farbvielfalt
- überladene Menüs
- zu viele Cards innerhalb von Cards

Das Interface soll visuell sehr ruhig bleiben.

Die eigentliche PDF-Datei ist immer der Mittelpunkt.


## 3. Core Visual Concept

Das wichtigste visuelle Markenelement ist:

NEON YELLOW + SOFT BLUR

Gelb soll nicht einfach als normale UI-Farbe verwendet werden.

Neben klaren gelben Akzenten gibt es große, weiche, diffuse gelbe Lichtflächen,
die teilweise außerhalb von Containern liegen oder in neutrale Hintergründe
übergehen.

Referenzgefühl:

weiß / warmes Off-White / sehr helles Grau
+
diffuses Neon-Gelb
+
schwarze Typografie

Der Gradient darf organisch und leicht unvorhersehbar wirken.

Er soll eher wie Licht aussehen als wie ein klassischer linearer Gradient.


## 4. Color System

### Solar Yellow

Primary Brand Color

HEX:
#FFF84D

Alternative für besonders intensive Highlights:
#FFFF22

Verwendung:

- Primary Actions
- aktive Tools
- ausgewählte Elemente
- Highlighting
- wichtige Statusindikatoren
- Brand Gradients
- kleine visuelle Akzente

NICHT großflächig für komplette UI-Bereiche verwenden.


### Ink

HEX:
#0F0F0F

Verwendung:

- Haupttext
- Icons
- Logo
- starke Kontraste


### Mist

HEX:
#DDE2EA

Verwendung:

- kühle Hintergrundflächen
- Gradient-Ausgangsfarbe
- subtile UI-Flächen


### Sand

HEX:
#F6F5F1

Verwendung:

- warmer sekundärer Hintergrund
- Panels
- Hover-Flächen
- Cards


### Canvas

HEX:
#FAFAF8

Primärer App-Hintergrund.


### White

HEX:
#FFFFFF

Verwendung:

- PDF-Flächen
- Panels
- Dialoge


### Secondary Text

#6F6F6B


### Borders

#E5E5E1

Borders grundsätzlich sehr subtil verwenden.


## 5. Gradient System

Gradients sind ein zentraler Bestandteil der Marke.

Keine klassischen:
linear-gradient(yellow, white)

Stattdessen bevorzugt:

radial-gradient()
mehrere überlagerte radial gradients
Blur
große Radien
teilweise außerhalb des sichtbaren Containers

Beispiel:

background:
  radial-gradient(
    circle at 80% 85%,
    rgba(255, 248, 77, 0.95) 0%,
    rgba(255, 248, 77, 0.55) 22%,
    rgba(255, 248, 77, 0) 55%
  ),
  #F6F5F1;

Alternative:

background:
  radial-gradient(
    circle at 75% 75%,
    rgba(255,255,34,0.9),
    transparent 48%
  ),
  radial-gradient(
    circle at 20% 10%,
    rgba(221,226,234,0.8),
    transparent 45%
  ),
  #F6F5F1;

Wichtig:

Gradients nicht überall verwenden.

Sie sind Brand Moments.

Typische Verwendung:

- Empty States
- Welcome Screen
- Home Dashboard
- Login / Onboarding
- App Icon
- Loading Screens
- Hero-Flächen
- ausgewählte Dokumentvorschauen

Der eigentliche PDF Editor sollte deutlich funktionaler und neutraler bleiben.


## 6. Typography

Primäre Schrift:

Inter

Fallback:

- Helvetica Neue
- Helvetica
- Arial
- sans-serif

Falls verfügbar kann alternativ Satoshi verwendet werden.

Typografie ist ein wesentliches Gestaltungselement.

Große Überschriften dürfen bewusst sehr groß und leicht gesetzt werden.


### Display

font-size: 64–96px
font-weight: 400
letter-spacing: -0.045em
line-height: 0.95–1.0


### H1

48–64px
font-weight: 400
letter-spacing: -0.035em


### H2

32–40px
font-weight: 400
letter-spacing: -0.025em


### H3

20–24px
font-weight: 500


### Body

14–16px
font-weight: 400
line-height: 1.5


### UI Label

13–14px
font-weight: 500


### Caption

11–12px
font-weight: 400
color: secondary text


Wichtig:

Keine unnötig fetten Überschriften.

Der visuelle Charakter entsteht durch:

Größe
Whitespace
Positionierung
Kontrast

und nicht durch Bold Typography.


## 7. Logo

Primärlogo:

sheer.

komplett lowercase.

Der Punkt gehört zwingend zur Wortmarke.

Logo grundsätzlich in:

#0F0F0F

auf hellen Hintergründen.

Die Wortmarke soll geometrisch, reduziert und sehr sauber wirken.

Keine:

- Symbole neben dem Logo
- Dokument-Icons
- PDF-Symbole
- Acrobat-artigen Formen
- Verläufe innerhalb der Wortmarke

Das Logo lebt ausschließlich von der Typografie.

Der Punkt ist ein bewusstes Markenelement.


## 8. App Icon

Das App Icon verwendet:

s.

WICHTIG:

Das „s.“ muss OPTISCH UND GEOMETRISCH ZENTRIERT sein.

Nicht einfach Text mit normalem Padding einsetzen.

Horizontal und vertikal muss die gesamte Kombination aus „s“ UND Punkt
als eine visuelle Einheit zentriert werden.

Standard Icon:

- Rounded Square
- heller Mist/Sand Hintergrund
- weicher Solar-Yellow Glow
- schwarzes „s.“
- kein Rahmen
- kein Schatten oder nur extrem subtil

Alternative Minimalversion:

Solar Yellow Hintergrund
+
schwarzes s.

Kein:

- PDF-Dokument-Symbol
- gefaltetes Blatt
- Adobe-artige Form
- Monogramm aus mehreren Buchstaben

Das Icon soll abstrakt und brand-orientiert bleiben.


## 9. Shape Language

Border Radius:

Small controls:
6–8px

Buttons:
8–10px

Cards:
10–14px

Large panels:
14–18px

Modals:
16px


Keine extrem pillenförmigen Buttons, außer bei:

- Tags
- Filters
- kleinen Toggle Controls


## 10. Borders

Borders:

1px solid #E5E5E1

Borders nur verwenden, wenn sie Struktur schaffen.

Bevorzugte Hierarchie:

Whitespace
→ Hintergrundunterschied
→ Border

Nicht:

Border
→ Border
→ Border


## 11. Shadows

Shadows extrem sparsam.

Standard:

0 2px 12px rgba(0,0,0,0.04)

Floating Elements:

0 8px 30px rgba(0,0,0,0.08)

Keine starken schwarzen Schatten.


## 12. Iconography

Icons:

- Outline
- monochrom
- 1.5–2px Stroke
- rounded line caps
- geometrisch
- minimal

Empfehlung:

Lucide Icons

Icon-Größen:

16px
18px
20px

24px nur für größere Aktionen.

Icons normalerweise:

#0F0F0F

Secondary:

#6F6F6B

Active:

#0F0F0F auf Solar Yellow


## 13. Buttons

### Primary

Background:
#FFF84D

Text:
#0F0F0F

Radius:
8–10px

Kein starker Shadow.


### Secondary

Background:
#F6F5F1

Text:
#0F0F0F


### Ghost

transparent

Hover:
#F6F5F1


### Icon Button

Standard:

36 × 36px

oder

40 × 40px

Icon zentriert.

Hover:
subtiler Sand Background.


## 14. Interaction Design

Hover:

subtil und ruhig.

Keine starken Animationen.

Transitions:

120–180ms

Bevorzugt:

ease-out


Hover darf verändern:

- Background
- leichte Opacity
- Border
- Icon Color


Keine:

- starken Scale Animationen
- Bounce
- Glow bei jedem Button
- unnötigen Microanimations


## 15. Application Architecture

Desktop Layout grundsätzlich:

┌─────────────────────────────────────────────┐
│ Top Bar                                     │
├─────────┬───────────────────────┬───────────┤
│ Pages   │                       │ Tools     │
│         │      PDF Canvas       │           │
│         │                       │           │
│         │                       │           │
└─────────┴───────────────────────┴───────────┘


Der PDF Canvas ist immer das wichtigste Element.

Navigation und Werkzeuge müssen visuell zurücktreten.


## 16. Top Toolbar

Höhe ungefähr:

52–60px

Hintergrund:

#FAFAF8 oder #FFFFFF

Elemente:

Back
Filename
Zoom
Page Controls
Undo / Redo
Search
Share
Export
Done

Toolbar möglichst flach halten.

Keine dunkle Toolbar.


## 17. Page Sidebar

Breite:

ca. 180–220px

Hintergrund:

#FAFAF8

Thumbnail Cards:

weiß
subtiler Border
kleiner Radius

Selected Page:

Solar Yellow Akzent

Zum Beispiel:

border: 2px solid #FFF84D

oder:

kleiner gelber Indicator.


## 18. PDF Canvas

Background:

#EFEFEC

PDF Page:

#FFFFFF

Shadow:

0 4px 24px rgba(0,0,0,0.08)

Der Canvas darf funktional wirken.

Keine Brand Gradients hinter dem PDF.

Das Dokument muss maximal lesbar bleiben.


## 19. Tool Sidebar

Breite:

ca. 260–320px

Tools:

Highlight
Text
Draw
Comment
Signature
Shapes
Images
Links
Pages
Export

Werkzeuge als ruhige Rows oder Sections darstellen.

Nicht jedes Werkzeug als große Card.


Selected Tool:

Solar Yellow Accent.


## 20. Highlighting

Highlighting ist ein wichtiger visueller Link zwischen Marke und Produkt.

Default PDF Highlight:

#FFF84D

mit leichter Transparenz.

Dadurch wird das Brand Yellow gleichzeitig zu einer echten Produktfunktion.

Das ist bewusst so vorgesehen.


## 21. Home Screen

Home soll stärker nach Marke aussehen als der Editor.

Beispiel:

sheer.

PDFs
made simple.

[ Search documents... ]

Recent


Hier dürfen große Yellow Glow Gradients vorkommen.

Dokumente als sehr reduzierte Cards.

Keine klassische Dashboard-Optik mit:

„Statistics“
„Analytics“
„Quick Actions“

Sheer ist ein Werkzeug, kein SaaS-Admin-Dashboard.


## 22. Empty States

Empty States dürfen stark visuell sein.

Beispiel:

großer diffuser Yellow Glow

+

Drop a PDF here.

oder:

Open something worth reading.


## 23. Spacing System

Basis:

4px

Spacing Tokens:

4
8
12
16
20
24
32
40
48
64
80
96

Standard UI Padding:

16–24px

Große Screens:

32–48px

Whitespace großzügig verwenden.


## 24. Design Tokens

Bitte diese Tokens zentral definieren und niemals unnötig
Hardcoded Values über die Anwendung verteilen.

Beispiel:

:root {
  --color-yellow: #FFF84D;
  --color-yellow-bright: #FFFF22;

  --color-ink: #0F0F0F;
  --color-text-secondary: #6F6F6B;

  --color-canvas: #FAFAF8;
  --color-sand: #F6F5F1;
  --color-mist: #DDE2EA;
  --color-border: #E5E5E1;
  --color-white: #FFFFFF;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
}


## 25. Brand Hierarchy

Wichtig:

Die Marke darf nicht die Funktion behindern.

Deshalb gelten zwei unterschiedliche visuelle Modi:


BRAND MODE

Für:

Home
Welcome
Onboarding
Empty States
Marketing
Loading

Mehr:

- Gradients
- große Typografie
- Yellow Glow
- großzügiger Whitespace


WORK MODE

Für:

PDF Editor
Annotations
Forms
Signatures
Page Management

Mehr:

- Weiß
- Grau
- klare Linien
- kompakte Controls
- funktionale Informationshierarchie

Yellow nur für:

Selection
Primary Actions
Highlights
Active States


Das verhindert, dass die Anwendung wie eine Designstudie statt wie ein
professionelles Werkzeug aussieht.


## 26. Overall UX Principle

Bei jeder UI-Entscheidung fragen:

„Kann etwas entfernt werden, ohne Funktion oder Verständlichkeit zu verlieren?“

Wenn ja:
entfernen.

Die Anwendung soll sich schnell und selbstverständlich anfühlen.

Komplexität darf vorhanden sein, aber sie soll erst erscheinen,
wenn der Nutzer sie benötigt.

Progressive Disclosure verwenden.

Nicht alle PDF-Funktionen gleichzeitig zeigen.


## 27. Visual Priority

Priorität bei jeder Ansicht:

1. Inhalt / PDF
2. aktuelle Aufgabe
3. relevante Werkzeuge
4. Navigation
5. Branding

Branding darf niemals wichtiger werden als der Inhalt.


## 28. Reference Direction

Das beigefügte Corporate-Design-Moodboard ist die visuelle Referenz.

Besonders wichtig sind:

- extreme typografische Klarheit
- Solar Yellow
- weiche Yellow Glows
- hellgraue / warme Hintergründe
- großzügiger Whitespace
- feine schwarze Icons
- flache UI
- große ruhige Typografie
- reduzierte Controls

Schwarze Hintergrundflächen gehören NICHT zum Corporate Design.

Dark Mode ist aktuell kein Bestandteil des Brand Systems und soll nicht
aus dem Moodboard abgeleitet werden.


## 29. Implementation Rule for Claude Code

Wenn du neue Komponenten oder Screens implementierst:

1. Verwende bestehende Design Tokens.
2. Erstelle keine neue Farbe, wenn eine vorhandene funktioniert.
3. Verwende Yellow nur bewusst als Akzent.
4. Nutze Whitespace vor zusätzlichen Borders.
5. Halte Icons monochrom.
6. Vermeide unnötige Shadows.
7. Behalte die PDF-Fläche als visuellen Mittelpunkt.
8. Nutze Brand Gradients nur in Brand Moments.
9. Halte Arbeitsoberflächen neutral.
10. Prüfe vor Abschluss eines Screens, ob UI-Elemente entfernt oder
   vereinfacht werden können.

Wenn Funktionalität und visuelle Reduktion miteinander kollidieren,
hat Verständlichkeit Vorrang.