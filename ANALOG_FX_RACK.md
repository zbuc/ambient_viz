# Analog FX rack — software-controlled modular analog effects

Design notes for a modular system of **discrete analog FX circuits** that the
Daisy/Pi can switch, reroute, and parameterize in software. Captured from a
2026-06-08 design session. Speculative / future work — see `BACKLOG.md`
("Analog FX hardware"). Nothing here is built yet.

The goal: build real analog effects (e.g. analog distortion, analog reverb) as
swappable breakout PCBs on a common backplane, and drive their routing and
parameters from the same controller + SSE/sensor plumbing that already drives the
visualizer.

---

## 1. Feasibility of software control

### A) Routing — feasible, well-trodden

Digitally-controlled analog signal routing is standard (Eurorack, pedal
switchers, modular synths). Two approaches:

- **Analog crosspoint / switch ICs** — `MT8816` (8×16 crosspoint), `ADG1414`
  (octal SPST), `DG409`, `CD4053`. Controlled over SPI/I²C. Enables
  series / parallel / swap-order / bypass. Downsides: charge injection → clicks
  on switching; some THD.
- **Latching signal relays** — cleaner audio (true bypass, low distortion, no
  charge injection), but slower and more drive circuitry. Best when routing
  changes infrequently.

For a slow/atmospheric aesthetic where routing changes are occasional and can be
crossfaded, either works; relays give the cleanest path.

### B) Parameters — feasible, parameter-dependent

- **Mix (dry/wet), drive, gain, tone** → easy. Digital potentiometers
  (`MCP41xxx` SPI, `AD5252` I²C, `X9C` series) in place of pots, or **VCAs/OTAs**
  (`THAT2180`, `LM13700`) where click-free smooth automation matters. VCAs beat
  digipots' zipper noise — relevant for slow swells.
- **Distortion params** → easy. Digipot sets gain / bias / clipping threshold.
- **Reverb "room size" → the hard one**, dictated by reverb topology:
  - *Real spring/plate*: decay is **physically fixed** by the springs. Software
    can control mix, input drive, damping filter, feedback/regen — but not true
    "size." Limited.
  - *BBD-based* (`MN3005`, Coolaudio `V3205`): delay time = clock frequency →
    fully software-controllable by generating the BBD clock from the MCU. Real
    size control. Caveat: BBDs are scarce/pricey now.
  - *PT2399-based* (cheap lo-fi delay chip, common in DIY reverb): delay time set
    by a resistor → swap in a digipot → software-controllable "size." **Pragmatic
    route** if continuous software room-size is a hard requirement.

**Takeaway:** A is straightforward; B is straightforward *except* "room size,"
which forces the reverb topology — go PT2399 or BBD, not spring, if you need
continuous software size control.

### Controller & gotchas

- **Controller = Daisy** (spare I²C/SPI/GPIO + USB link to the Pi), so the
  existing sensor/SSE plumbing can drive routing + params.
- Digital-line noise coupling into analog audio → opto-isolate / careful layout.
- Digipot zipper noise → prefer VCAs for swells.
- Switch clicks → relays, zero-cross switching, or crossfade.

---

## 2. Modular backplane architecture

Make the blocks swappable daughtercards on a motherboard with N identical keyed
slots, joined by a common wiring harness.

### Key decisions

1. **Bus audio to a central crosspoint, NOT slot→slot.** Each slot's audio
   in/out routes over the harness to a routing matrix (`MT8816`-style) on the
   motherboard. Software then patches any installed card in any order /
   combination. Chaining slot N→N+1 would instead freeze routing to physical slot
   order. This is the decision that makes modularity and "reroute through any
   combination" coexist.
2. **Buffer audio at every card's input and output.** Then connector contact
   resistance, harness impedance, and cable length stop mattering. The single
   most important reliability move.
3. **Solve "indexable slots" with a per-slot I²C mux (`TCA9548A`).** Each slot
   gets its own isolated I²C segment, so cards can be built **identically** and
   addresses can repeat without collision; software selects a slot by enabling its
   mux channel. Scales past 8 slots and tolerates cards with many I²C chips.
   - *Alternatives:* 3 address-strap pins per slot (`A0/A1/A2`) → max 8 slots, can
     collide if a card needs many same-type chips; or SPI with a per-slot `CS`
     line (the "index" = which CS), deterministic but costs GPIO / a CS decoder.
4. **Per-card ID EEPROM (`24Cxx`) for auto-enumeration.** Each breakout carries a
   tiny EEPROM with a descriptor — card type, param map, routing capabilities. On
   boot the controller walks the slots, discovers *what's plugged in where*, and
   auto-configures the software control map. This turns "a wiring harness" into a
   genuinely **plug-and-play, software-defined FX rack**.

### Per-slot connector — signal groups

A single keyed connector per slot carries:

| Group | Pins | Notes |
|---|---|---|
| **Audio** | `IN`, `OUT` (+ `AGND` guards) | single-ended buffered, or differential `IN±`/`OUT±` for noise immunity |
| **Analog power** | `+12V`, `−12V`, 2× `AGND` | for op-amps / VCAs / OTAs |
| **Digital power** | `+5V`, `+3V3`, 2× `DGND` | for digipots / switch ICs / EEPROM |
| **Control bus** | `SDA`, `SCL` (shared I²C) | one 2-wire bus reaches every slot |
| **Slot select / index** | mux channel or `CS` or `A0/A1/A2` | see decision 3 |
| **ID / detect** | `CARD_PRESENT` + EEPROM on shared I²C | auto-enumeration |
| **Spare** | 1–2 GPIO | future-proofing |

### Per-card / per-slot protection

- Key/polarize the connector — reverse insertion must be physically impossible.
- Per-slot PTC fuse + local decoupling; budget current per slot in the spec.
- Reverse-protection diodes on each card's power inputs.

Precedent for the whole pattern: Eurorack / modular-synth backplanes, PC
expansion slots.

---

## 3. Connector choice

The fork: cards **tethered by a cable** ("single wiring harness") vs **seated in
slots** (expansion-slot backplane). Different connector families.

### Cable-per-card (matches the "single harness" mental model)

- **Recommended start: 2×N shrouded IDC box header (2.54 mm) + ribbon.** The box
  shroud is the key (polarizing notch); optionally blank one pin + plug the
  matching socket hole as a hard key. Cheapest, ubiquitous, hand-solderable, one
  flat harness. Caveat: ribbon is mediocre for audio crosstalk and repeated
  insertion — interleave ground pins, don't reseat constantly.
- **Cleaner/latched alternative: Molex Micro-Fit 3.0 / Mini-Fit Jr. / JST-XH.**
  Inherently polarized + positively latched (can't insert backwards), survives
  handling/vibration. Trade-off: loses flat-ribbon simplicity; crimping is more
  tedious.

### Seated slot-cards (true backplane)

| Connector | Why | Trade-off |
|---|---|---|
| **DIN 41612** (eurocard) | *The* industrial daughtercard-into-backplane standard (VME, eurocard). Robust, high cycle life, explicit keying/coding. | Bulky, pricier, more board area. |
| **PCB card-edge + edge socket** | Cheapest *per card* (edge is just gold PCB fingers). Expansion-slot feel, notch-keyed. | Motherboard needs an edge socket; edge needs hard-gold/ENIG; moderate insertion durability. Best at many slots. |

### Keying mechanisms

- Shrouded IDC → shroud notch + pulled/blocked key pin.
- Card-edge → keying slot milled at a defined finger position + socket key bar.
- DIN 41612 / Molex / JST → inherent polarization (+ coding pins on DIN).

### Recommendation

Prototype with **shrouded 2.54 mm IDC + ribbon** (fast, cheap, keyable),
interleaving grounds for audio. Step up to **DIN 41612** (seated, bulletproof) or
**card-edge** (cheapest at many slots) if it graduates into a polished rack.
Double up power pins so 2.54 mm contacts aren't current-limited.

### Eurorack A-100 backplane, for reference

The Doepfer A-100 bus uses **standard 2.54 mm dual-row shrouded IDC headers +
ribbon** — the same family as above:

- **16-pin (2×8)** full bus; **10-pin (2×5)** common subset (most modules).
- **Red stripe = −12 V** by universal convention, aligned to the marked edge.
- Rail layout: −12 V at the stripe edge, **+12 V** at the opposite edge, **ground**
  block through the middle, and on the 16-pin version three extra signals:
  **+5 V, CV bus, Gate bus** ("A-100 system bus"). The 10-pin drops the +5 V / CV /
  Gate row. (Original A-100 didn't supply +5 V on the bus — modern boards do.)

**Crucial divergence:** the Eurorack backplane carries **power + 2 control signals
only — NOT audio.** Audio travels over front-panel 3.5 mm patch cables, off the
bus entirely, specifically to dodge crosstalk. Our central-crosspoint design
*requires* audio to traverse the backplane to reach the matrix — which Eurorack
avoids. So: copy the A-100 **power + I²C/control bus** almost verbatim (repurpose
the CV/Gate pins as `SDA`/`SCL`), but treat audio as a separate, shielded,
buffered concern (see §4). Also borrow the A-100's lesson the *other* way — its
reversible power connector is the canonical module-frying footgun; actually use
the shroud notch + key pin rather than trusting a stripe convention.

---

## 4. Audio on the shared bus — signal integrity

Is it reasonable to run audio on the same ribbon as power + I²C, given
buffered + ground-guarded + differential? **Yes — but make differential
mandatory, not optional.** Single-ended buffered+guarded next to a switching
digital line is marginal; differential is what makes sharing the bus robust. The
three measures attack *different* mechanisms and are complementary:

| Measure | Fixes | Mechanism |
|---|---|---|
| **Buffered (low source-Z)** | Susceptibility | ~50–100 Ω driven line shunts coupled charge; high-Z lines are the ones that pick up crosstalk. Biggest single win. |
| **Ground guards** | The coupling *path* | Grounded conductors between audio and aggressors intercept capacitive coupling. The "every other wire is ground" ribbon trick (IDE/SCSI). |
| **Differential** | Residual coupling | Common-mode noise (ground bounce, rail noise, far-field) cancels at the receiver by CMRR (60–90 dB). The part guard grounds can't give you. |

### Why this is more forgiving than it sounds

Your worst neighbor is I²C, but **the control bus is event-driven** — clocked only
when *changing* a param, idle during steady-state audio. Big advantage over a
continuously-streaming digital bus. So the realistic failure mode isn't steady
hiss; it's a faint **tick correlated with a bus transaction or switch toggle** —
already mitigated by buffering, crossfade/zero-cross switching, and the slow
aesthetic.

### Caveats differential does NOT solve

1. **Rail noise via the card's own supply pins.** Buffering protects the signal
   path, not op-amp PSRR. Switching cards inject transients onto ±12 V. Fix at the
   **card**: local RC/ferrite + bulk decoupling, or per-card regulation.
   Independent of bus crosstalk.
2. **Grounding topology.** Carry **separate AGND and DGND** pins, joined at **one
   star point** at the PSU/motherboard, so digital return current never shares the
   audio reference.
3. **Relays/switch drive.** Coil flyback is real EMI — flyback diode *at the
   coil*, drive from the digital domain. Analog-switch charge injection causes
   clicks regardless of the bus (per-switch issue → crossfade/zero-cross).
4. **No transmission-line worry.** At audio frequencies wavelengths are
   kilometers — ribbon needs no controlled impedance. The whole problem is
   near-field crosstalk, which the three measures cover.

### Recommended pin ordering on a single ribbon

Group and fence:

```
[ −12V  −12V ] … [ GND  +12V  +12V  GND ] … [ +5V  +3V3  DGND ]
[ AGND  AUDIO+  AUDIO−  AGND ]   ← differential pair, ground on both sides
[ AGND  SDA  SCL  DGND ]         ← control pair, fenced off from audio by AGND
```

Keep the audio pair physically distant from `SDA/SCL` with a ground wall between,
double up power pins, split AGND/DGND meeting only at the star.

### The zero-compromise alternative

The bulletproof option is what Eurorack chose: keep audio off the shared ribbon
entirely. Practical middle ground — **two connectors per card**: the A-100-style
power+I²C ribbon, plus a short **shielded** audio cable (twisted pair or
mini-coax) for the differential leg. Still "essentially one harness," but audio
gets its own shielded return and you stop spending guard pins on the ribbon.

**Bottom line:** buffered + guarded + **differential** on one bus is legitimate
and done in real mixing-console/telecom backplanes — commit to the differential,
fix rail noise at the card (not the bus), and split your grounds. For zero
compromise, peel audio onto its own short shielded pair and leave the ribbon for
power + control.
