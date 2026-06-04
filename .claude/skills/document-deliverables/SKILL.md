---
name: document-deliverables
description: Erzeugt Kunden-Deliverables als echte Dateien — PDF (aus Markdown) und XLSX/Excel (aus JSON) — lokal, scope-isoliert, mit Brand-Footer, und fügt sie als anklickbare Datei-Karte in den Chat ein. Nutze, wann immer der User einen Bericht, ein Angebot, einen Vertrag, ein Konzept, eine Kosten-/Pricing-Tabelle, einen Report oder ein Ledger als DATEI will (nicht als Chat-Text). Lokale, N2/N9-konforme Generierung — keine Anthropic-Cloud-Sandbox.
when_to_use: Bericht als PDF, Angebot, Vertrag, Konzept, Excel, Tabelle, Kosten-Aufstellung, Pricing, Ledger, Report, "schreib mir … als Datei/PDF/Excel".
allowed-tools: Bash(lazyos-cli cloud generate *), Bash(cat > /tmp/*), Read, Write
---

# Document Deliverables — laz.ing Built-In-Skill (lokal, N2/N9)

Dieser Skill bündelt das verbindliche Vorgehen, um aus Arbeitsergebnissen
**echte Office-Dateien** zu machen, die der Kunde anklicken/herunterladen kann —
statt Roh-Text im Chat zu dumpen. Alle Pfade laufen **lokal** über
`lazyos-cli cloud generate` (kein Cloud-Sandbox-Roundtrip; Workspace-Scope-
Envelope bleibt gewahrt, N2/N9).

## Grundregel

Wenn der User eine **Datei** will (PDF, Excel, Report, Angebot, Tabelle):
1. Inhalt lokal als Quell-Datei nach `/tmp/` schreiben.
2. `lazyos-cli cloud generate` aufrufen → es lädt die fertige Datei in die
   Workspace-Cloud und gibt eine `surfaceMarkup`-Zeile zurück.
3. Die zurückgelieferte `surfaceMarkup`-Zeile **UNVERÄNDERT** (verbatim, N1) in
   die Antwort einfügen — sie rendert als Datei-Karte mit Download/Vorschau.
4. Maximal ein Satz Begleittext. **Niemals** den Roh-Inhalt zusätzlich dumpen.

## PDF (aus Markdown)

```bash
cat > /tmp/report.md <<'EOF'
# Mai-Report — Kunde Nord
…Markdown…
EOF
lazyos-cli cloud generate "<workspaceId>" --md-file=/tmp/report.md --title="Mai-Report"
```

## XLSX / Excel (aus JSON) — Kosten-Ledger, Reports, Pricing-Tabellen

JSON-Form (Werte **verbatim**, N1 — nicht runden/kürzen, außer der User will es):

```json
{
  "sheets": [
    {
      "name": "Kosten Mai",
      "headers": ["Posten", "Netto (€)", "Kategorie"],
      "rows": [
        ["Hosting (Vercel)", 42.00, "Infra"],
        ["Domains", 12.50, "Infra"],
        ["DATEV-Lizenz", 89.00, "Software"]
      ]
    }
  ]
}
```

```bash
cat > /tmp/kosten.json <<'EOF'
{ "sheets": [ { "name": "Kosten Mai", "headers": ["Posten","Netto (€)"], "rows": [["Hosting",42.0],["Domains",12.5]] } ] }
EOF
lazyos-cli cloud generate "<workspaceId>" --xlsx-file=/tmp/kosten.json --title="Kosten Mai"
```

- Mehrere Sheets möglich (Array `sheets`). Tab-Namen werden Excel-sicher gekappt.
- Header-Zeile wird fett + fixiert.
- Zahlen als JSON-`number` übergeben (nicht als String), damit Excel rechnen kann.

## Disziplin (laz.ing N-Constraints)

- **N1** — Zellwerte / PDF-Inhalt verbatim, keine stille Kürzung.
- **N2/N9** — Generierung ist **lokal** + workspace-isoliert; kein Cross-Scope-
  Export ohne Bridge. Kein Anthropic-Cloud-Sandbox-Pfad.
- **Brand** — der Footer/Brand wird serverseitig aus dem Workspace aufgelöst
  (laz.ing Design Manifest). Nicht selbst faken.

## DOCX / Word (aus Markdown) — Angebote, Verträge, Reports

```bash
cat > /tmp/angebot.md <<'EOF'
# Angebot — Website-Relaunch
## Leistungen
- Konzept & Design
- Umsetzung (Next.js)
**Gesamtpreis:** 12.400 € netto
EOF
lazyos-cli cloud generate "<workspaceId>" --docx-file=/tmp/angebot.md --title="Angebot Website"
```
- Markdown wird zu echtem Word: `#/##/###` → Überschriften, `- ` → Bullets,
  `**fett**` + `` `code` `` inline. N1: Text verbatim.

## Pitches / Decks — ZWEI Wege (Design-Deck BEVORZUGT)

### A) Design-Deck als HTML→PDF (bevorzugt — sieht am besten aus)

Für visuell starke Pitches: gestalte selbst ein **HTML-Deck** im laz.ing-Brand
(Pitch-Black #070707, radiale Glows, SF-Pro), je Folie eine `<section>` mit
`@page { size: 1280px 720px }` (16:9), und binde **generierte Bilder** ein
(über `/image <beschreibung>` ODER `/api/imagegen/generate` → nimm die
`previewUrl` als `<img src>`). Dann:

```bash
cat > /tmp/deck.html <<'EOF'
<!doctype html><html><head><style>
@page{size:1280px 720px;margin:0}
body{margin:0;font-family:'SF Pro Display',system-ui,sans-serif}
section{width:1280px;height:720px;background:#070707;color:#F5F5F7;
  display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;
  background-image:radial-gradient(circle at 80% 20%, rgba(94,158,255,.18), transparent 50%)}
h1{font-size:72px;letter-spacing:-.04em;margin:0}
ul{font-size:32px;line-height:1.6}
</style></head><body>
<section><h1>Relaunch-Pitch — Kunde Nord</h1></section>
<section><h2>Lösung</h2><ul><li>Next.js-Relaunch</li><li>Performance-Budget</li></ul></section>
</body></html>
EOF
lazyos-cli cloud generate "<workspaceId>" --html-file=/tmp/deck.html --landscape --title="Relaunch-Pitch"
```

Das erzeugt deutlich bessere Ergebnisse als der pptx-Skill — volle Gestaltungs-
freiheit + echte AI-Visuals. **Default für „mach mir einen Pitch/ein Deck".**

### B) PPTX (nur wenn der Kunde eine editierbare .pptx-Datei BRAUCHT)

```bash
lazyos-cli cloud generate "<workspaceId>" --pptx-file=/tmp/pitch.json --title="..."
# JSON: { "subtitle":"...", "slides":[{"title":"...","bullets":["..."]}] }
```
Schlicht (Titelfolie + bullets, 16:9), aber editierbar in PowerPoint.

## Nächste Slice

Brand-Theme-Bibliothek für die HTML-Decks (fertige Folien-Layouts) + DOCX
tracked changes für Verträge.
