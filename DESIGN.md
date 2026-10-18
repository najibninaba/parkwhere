---
name: ParkWhere
description: Find a carpark near where you're going in Singapore, posted like a kerbside notice.
colors:
  ink: "#151412"
  ink-soft: "#3d3a34"
  ink-mute: "#5c5850"
  paper: "#f5f0e5"
  paper-deep: "#ebe4d4"
  paper-line: "#ddd4c1"
  card-white: "#fffdf8"
  bay-blue: "#1f47c4"
  bay-blue-deep: "#17369a"
  kerb-yellow: "#f2c230"
  lots-plenty: "#1a9e57"
  lots-some: "#6a9e1a"
  lots-few: "#d98a1c"
  lots-full: "#c2412d"
  lots-unknown: "#8c877c"
  notice-ok: "#e3f1e6"
  notice-warn: "#fbecc0"
  notice-bad: "#f7d9d1"
  map-sea: "#6da8e4"
typography:
  display:
    fontFamily: "Archivo, Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "clamp(32px, 8.5vw, 44px)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 118"
  wordmark:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 125"
  numeral:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112"
    fontFeature: "'tnum' 1"
  title:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.06em"
rounded:
  none: "0px"
  dot: "50%"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
    height: "44px"
  button-primary:
    backgroundColor: "{colors.bay-blue}"
    textColor: "{colors.card-white}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.bay-blue-deep}"
  chip:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 12px"
    height: "40px"
  chip-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  input:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
    height: "48px"
  card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
  count-box:
    backgroundColor: "{colors.lots-unknown}"
    textColor: "{colors.card-white}"
    typography: "{typography.numeral}"
    rounded: "{rounded.none}"
    padding: "4px 6px"
  notice:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
---

# Design System: ParkWhere

## Overview

**Creative North Star: "The Kerbside Notice"**

ParkWhere looks like the signboard at a carpark entrance: square, high-contrast and plainly worded. Every fact on it has a date. It is a civic tool, a sibling of Cuaca, so it uses the same ink-on-paper base, wide Archivo for display, a grotesque for reading and a monospace for labels. A driver reads it on a phone while arriving somewhere unfamiliar, so it must be readable at arm's length and quick to act on.

The map leads. The landing page shows every carpark on a map of Singapore, with one sentence about how current the counts are, and the call to action sits on the map. Results keep the same map and add numbered pins next to a list of cards. Colour carries information (how many car lots are available) and is withheld when the information is old: grey is the honest colour.

The system is deliberately plain. It has no gradients, glass, decorative illustration or rounded "app" softness. Any feeling of quality comes from exact type, firm 2px ink rules, tabular numbers and careful states.

**Key Characteristics:**
- Ink on warm paper, square corners, 2px ink borders.
- Map first. The panel sits beside it on wide screens and below it as a sheet on phones.
- Colour means car lots available, and only for counts from the last 15 minutes.
- Bay blue is for action, and kerb yellow is for "this one" and for selection.
- Uppercase IBM Plex Mono labels for controls and field names, never for sentences.

## Colors

A civic palette: warm paper and near-black ink, one blue for action, one yellow for marking, and a five-step availability scale.

### Primary
- **Bay Blue** (#1f47c4): the action colour. Used for the prominent "Near me" button, Directions, the selected card's ring, the destination pin and focus outlines. It darkens to **Bay Blue Deep** (#17369a) on hover.

### Secondary
- **Kerb Yellow** (#f2c230): the marker colour. Used for text selection, the selected pin's outline, the logo's dot and the small squares before the landing promises. It is never used as text and never as a large fill.

### Tertiary (availability scale)
- **Plenty** (#1a9e57): 50 or more car lots available.
- **Some** (#6a9e1a): 10 to 49.
- **Few** (#d98a1c): 1 to 9. Text on it is ink, not white.
- **Full** (#c2412d): 0 available now.
- **Unknown** (#8c877c): no count, a count over 15 minutes old, or a count with no time (LTA). It is grey, never red.

### Neutral
- **Ink** (#151412): text, 2px borders, the header bar and pressed chips.
- **Ink Soft** (#3d3a34) and **Ink Mute** (#5c5850): secondary text, hints and metadata.
- **Paper** (#f5f0e5): the page and panel background.
- **Paper Deep** (#ebe4d4) and **Paper Line** (#ddd4c1): hover fills, hairlines and skeleton shapes.
- **Card White** (#fffdf8): cards, inputs, chips and map overlays.
- **Notice OK, Warn and Bad** (#e3f1e6, #fbecc0, #f7d9d1): tinted backgrounds for status notices, paired with a leading dot in plenty, few or full.
- **Map Sea** (#6da8e4): the area beyond OneMap's tiles, so it reads as sea and not as a grey gap.

### Named Rules
**The Fresh Colour Rule.** A count is coloured only if it was reported in the last 15 minutes. Older counts and counts with no time keep their number but show in Unknown grey, with their age beside them.

**The One Action Rule.** Bay blue marks the one thing to do next on a surface. If two things are blue, one of them is wrong.

## Typography

**Display Font:** Archivo (with Schibsted Grotesk and system-ui)
**Body Font:** Schibsted Grotesk (with system-ui)
**Label Font:** IBM Plex Mono (with ui-monospace)

**Character:** Wide, heavy Archivo gives the notice its headline voice and makes numbers readable from a distance. Schibsted Grotesk keeps the body plain and civic. Plex Mono labels look like stencilled field names.

### Hierarchy
- **Display** (800, clamp(32px, 8.5vw, 44px), 0.98): the landing heading only.
- **Wordmark** (800, 22px, width 125): "ParkWhere" in the header.
- **Numeral** (800, 30px, width 112, tabular): car lot counts and price totals on cards, and the count on the live line. Counts use thousands separators (1,236).
- **Title** (600, 16px, 1.3): carpark names on cards.
- **Body** (400, 16px, 1.5): sentences. Hints and metadata use 13 to 15px in Ink Mute.
- **Label** (600, 12px, 0.06em, uppercase): field names, buttons and the legend. Buttons use 13px.

### Named Rules
**The Tabular Count Rule.** Any number that updates (counts, prices, the live line) uses tabular figures, and its box never shrinks below its digits.

## Layout

A single map-and-panel shell.

- **Phones (below 900px):** the map takes 52% of the viewport height on landing and 40% on results (40% and 220px minimum when the screen is under 640px tall). The panel overlaps the map's bottom 20px as a sheet with a small grabber, and the map's attribution and zoom buttons are lifted clear of it. The panel comes first in the DOM, so keyboards and screen readers reach search first, and CSS order shows the map first.
- **Wide screens (900px and up):** the map fills the viewport under the 56px header. The panel floats over it at the left (16px inset, 440px wide, scrolling on its own). Map fitting pads 472px on the left, so pins never land under the panel.
- **Spacing rhythm:** 6, 8, 12, 16 and 24px. Card internals use 10 to 12px. Sections in the panel use 14 to 20px gaps.
- **Touch:** every control is at least 40px tall, and 44px for primary buttons and links. `pnpm check:mobile` enforces this, and fails if a page overflows sideways at 320, 390 or 412px or if any count or price box clips its text.

## Elevation & Depth

Mostly flat. Depth comes from 2px ink borders and tonal paper. Shadows are used only where a surface really floats over the map.

### Shadow Vocabulary
- **Sheet** (`0 -1px 0 rgb(21 20 18 / 0.08), 0 -10px 30px -12px rgb(21 20 18 / 0.28)`): the phone panel lifting over the map.
- **Float** (`0 1px 2px rgb(21 20 18 / 0.12), 0 8px 24px -8px rgb(21 20 18 / 0.3)`): the desktop panel, map overlays (live line, legend, "Search this area"), the search results list and the selected card.

### Named Rules
**The Border Is The Edge Rule.** Cards, chips, inputs and buttons get their edge from a 2px ink border, not from a shadow. Hard offset "block" shadows are not used.

## Shapes

Square corners everywhere (0px), as on a printed notice. The only round shapes are dots: the live dot, the legend and banner dots, overview map dots and the destination pin. Rank badges and count boxes are square. Joined chip groups share borders, with each chip overlapping the previous one by 2px.

## Components

### Buttons
- **Shape:** square (0px), 2px border, at least 44px tall, uppercase Plex Mono at 13px.
- **Default:** paper fill and ink border. Hover deepens to Paper Deep.
- **Primary:** bay-blue fill and white text, for Directions and the prominent "Near me". Hover goes to Bay Blue Deep.
- **Press:** every button, chip and card header scales to 0.96 for 120ms.
- **Link-style buttons** (Clear, Change, Try again): underlined, semibold, 44px tap area.

### Chips
- **Style:** card-white fill, 2px ink border, 40px tall.
- **State:** pressed chips invert to ink with paper text. Radius and sort chips sit in joined groups, and quick picks sit apart in a wrapping row.

### Cards
- **Style:** card-white, 2px ink border, square, no shadow at rest.
- **Selected:** bay-blue border plus a bay-blue ring and the Float shadow. The rank badge turns bay blue.
- **Content:** rank badge, name, then a muted line (id, distance, type). Below that are two figure columns, car lots on the left and price on the right, then tags, then actions (Directions and Rates disclose in place).

### Count Box (signature)
The square block that shows a car lot count in Numeral type, filled with the availability colour. The label sits underneath ("car lots available, out of 143"), with the time reported on its own line. When a count is old or undated, the box turns Unknown grey and the age line gets a warning mark. When there is no count, it shows "?".

### Inputs
- **Style:** card-white, 2px ink border, square, 48px tall (56px when prominent on landing).
- **Focus:** the border turns bay blue, with a 3px bay-blue halo at 25%.

### Map overlays
Card-white chips with the Float shadow. The live line sits top left and the legend bottom left. On phones both stay clear of the sheet. Pins are 30px squares with a 2px ink border, a number in Plex Mono and an availability fill. A selected pin gets a kerb-yellow outline and scales to 1.15.

### Notices
Tinted background (OK, Warn or Bad), a leading coloured dot and plain sentences. There is no coloured side stripe.

### Skeletons
Paper Deep blocks shaped like real cards, with a slow white sheen. The map skeleton is a light street-grid with "Loading map…" and never blocks dragging.

## Do's and Don'ts

### Do:
- **Do** show every count with its age, and colour it only under the Fresh Colour Rule.
- **Do** keep corners square and borders at 2px ink.
- **Do** use tabular Archivo numerals for counts and prices, with thousands separators.
- **Do** keep OneMap's logo and attribution visible on every map.
- **Do** respect `prefers-reduced-motion`: no sheen, no fly-to animation, no smooth scroll.
- **Do** run `pnpm check:mobile` after any layout change.

### Don't:
- **Don't** colour an unknown, old or LTA count. Grey is the honest colour.
- **Don't** use rounded cards, pill buttons, gradients, glass or decorative illustration.
- **Don't** put a coloured stripe on the side of a card or notice, or use hard offset shadows.
- **Don't** use kerb yellow for text or large fills.
- **Don't** use monospace for sentences. It is for labels and data only.
- **Don't** let a number's box shrink below its digits.
