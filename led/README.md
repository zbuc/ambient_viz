# led — the render-node code (led_room's render plane)

A map of what's here, kept current. `led_room`'s LED nodes: ESP32 boards driving
SK9822 strips, each rendering its own slice from shared control signals.

**Where things live.** This is a *root* workspace, a sibling of `analysis/` — not
inside `daisy/` (that workspace is on-Daisy audio-plane code only) and not inside
`projects/led_room/` (that directory is project-as-data: manifests, policy, moods).

```
led/
  crates/led-core/    no_std, zero deps — colour, dimming, framing.  TESTED.
  crates/host/        Mac binary `led-sim` — judge fades without hardware.
  crates/node-fw/     ESP32 firmware.  SKELETON, NEVER COMPILED (see below).
```

## Status

| | state |
|---|---|
| `led-core` | Working, 16 tests green. `cargo test` from `led/`. |
| `host` (`led-sim`) | Working. `cargo run -p led-host --bin led-sim`. |
| `node-fw` | **Skeleton, never built.** No esp toolchain on this machine — every `esp_hal::` call is written from docs, not checked by a compiler. Expect to fix names on first build. |
| ESP-NOW ingress | Not started. |
| OTA | Not started. |

## The decisions behind this, and why

**SK9822, not WS2812/SK6812.** Two-wire (clock + data) means plain SPI: no
timing-critical bit encoding, immune to WiFi interrupts, and DMA-able. But the
deciding property is *dimming*. The SK9822 has an 8-bit PWM duty **and** a 5-bit
global field that sets a constant current — a real current DAC, not the ~580 Hz
current PWM a true APA102 uses (which is why an APA102 flickers on camera when you
dim with its global, and an SK9822 does not). Combining both gives ~13 bits, so a
long fade to black stays smooth instead of stair-stepping across the last few of
256 codes. That is the whole ballgame for slow ambient work. The cost: ~3x the
price of WS2812, and no RGBW variant (SK6812 has a real white die; we gave that up).

**`no_std` esp-hal, not std esp-idf.** esp-hal is vendor-backed, hit 1.0 in Oct 2025,
and its ESP32 peripherals are hardware-tested in Espressif's CI. It is also the same
shape as the Daisy firmware. The tradeoffs we accepted, eyes open:

- The SPI **DMA API is `unstable`** and churning (`SpiDmaBus` merges into `SpiDma` in
  1.2) — hence the `~1.1` pin, and expect a break on the next bump.
- **ESP-NOW has no hardware CI on Xtensa.** Espressif's radio test matrix contains
  exactly one chip and it is the C6. There is no automated regression signal for the
  radio on our part. **Soak-test for days before anything goes on a wall.**
- **OTA needs an OTA-capable bootloader you build yourself** (`esp-bootloader-esp-idf`);
  espflash's prebuilt bootloader may not include OTA support.

If the radio turns out to be flaky on Xtensa, the escape hatch is an **ESP32-C6**
(~$8): no compiler fork, plain stable Rust, and the only chip Espressif actually
regression-tests the radio on. `led-core` is chip-agnostic, so that migration would
touch `node-fw` only.

## led-core

The whole pipeline, none of the hardware — what `dsp` is to the Daisy `firmware`.
It runs unchanged on the Mac, which is how fade quality gets judged and regressed
without a strip attached.

```
perceptual input -> Gamma -> Rgb16 (linear) -> Dimmer -> Led{global,r,g,b} -> sk9822::encode -> bytes
```

- **`color`** — `Gamma::G22` / `G28` as 256-entry tables into linear 16-bit light.
  Precomputed literals, so no libm and no allocator. `map_u16` interpolates, because
  an 8-bit fade input would step through only 256 positions no matter how good the
  dimmer under it is.
- **`dim`** — the hybrid split. The global field is per-LED (shared by R/G/B), so it
  is chosen from the LED's **peak** channel: the smallest current step that still
  leaves that peak inside the 8-bit PWM range. The rounding residue is spent by a
  **temporal dither** (one byte of state per channel per LED), so the mean duty
  converges on the exact value across frames.
- **`sk9822`** — the framing, and the two details that separate working from subtly
  broken: a **reset frame** (4 zero bytes after the LED data — without it an SK9822
  displays every frame one frame *late*), and an **end frame of ZEROS sized to n/2
  bits** (the datasheet's 32 bits of *ones* is wrong twice: too short above ~64 LEDs,
  and the ones shift into unaddressed LEDs and light them white). Byte order is
  **B, G, R**. `Frame<N>` is `repr(align(4))` because esp-hal's ESP32 SPI DMA silently
  memcpy's any buffer that is not 4-byte aligned.

## led-sim

```
cargo run -p led-host --bin led-sim            # all three sections
cargo run -p led-host --bin led-sim -- fade    # dimming table vs PWM-only
cargo run -p led-host --bin led-sim -- dither  # dither convergence
cargo run -p led-host --bin led-sim -- frame   # the exact wire bytes
```

`fade` is the one to look at: the `pwm-only` column (what an 8-bit strip could do)
sits at 0.000000 through the entire bottom of the fade while the hybrid split is
still resolving levels. `dither` shows a linear level of **1/65535** — below what
8-bit PWM can represent at all — landing on its ideal value as a frame average.

## Hardware

ESP32-DevKitC-32 (WROOM-32, Xtensa LX6 dual-core). VSPI: **GPIO18 = SCLK,
GPIO23 = MOSI**. Read **[SAFETY.md](SAFETY.md)** before the first power-on — it is
short, and two of the rules in it are the difference between a working node and a
dead one.

**Power topology: 12V local to a cluster, and a 5V buck at each node.** Two levels of
locality, for two different reasons.

*Within* an island, distribute at 12V: it carries the same power at 2.4x less current,
so the trunk barely drops and the wire stays thin, and each node then regenerates a
clean local 5V centimetres from its strip — 5V being the rail that cannot tolerate a
drop.

*Across* the room, **do not assume one PSU.** A single supply means 12V trunks
radiating to every corner, which is the wires-strewn-about problem the distributed-node
design exists to avoid. The room is **several power islands**, each with its own supply,
fuse block, and cluster of nodes, each sized to its own load. One PSU is a bench
convenience; it is not the architecture.

```
per island:

12V PSU ──[main fuse]──> 6-way blade-fuse block (12V, 5A per branch)
                              ├── node 1: buck 12V->5V ──> strip 1 + 74AHCT125
                              ├── node 2: ...
                              └── node 3: ...
```

Because the nodes are coupled *wirelessly*, **no signal wire crosses between islands** —
so islands need no ground bonding and cannot form a ground loop. That is a dividend of
"never ship pixels": the control architecture buys electrical independence too. The
corollary is a rule: if a wire ever *does* cross between islands, their grounds must be
bonded. See [SAFETY.md](SAFETY.md) — *Power islands*.

- **Feed exactly 5.0V, and inject at BOTH ENDS of the strip.** The window is one-sided:
  below 5V the higher-forward-voltage blue and green dies dim before red, so an
  undervolted strip goes muddy orange rather than simply darker (a *colour* shift, not
  a brightness loss) — but BTF's own note is "using voltage DC5V, higher than 5V will
  destroy it". So you cannot trim the source up to fight voltage drop. The only lever
  left is feeding both ends of the strip, which halves the drop along its copper. One
  extra pigtail per strip. (This also means a fixed-5V buck is fine — there is nothing
  to trim.)
- **Bucks: >=15A continuous at 5V, synchronous.** BTF spec the strip at **43W/m,
  0.3W/LED — 8.6A at full white for a 1m/144 strip**, and recommend a 5V/10A supply per
  metre. Add the ESP32 (in the install, where it is fed from the buck) and a node is
  ~9.2A worst case, so a 10A buck has no margin. A non-synchronous module (LM2596,
  XL4016) also burns ~15% as heat inside the fixture, and LM2596 boards top out at
  2-3A — their own listings warn above 15W.
- **Fuse the 12V side**, not the 5V side: a node at full white draws ~9A at 5V, which is
  only **~4A at 12V** — so **7.5A per branch** (a 5A fuse sits at ~84% of rating and will
  nuisance-blow once warm; 10A is safe for 16 AWG but isolates faults poorly).
- **Level-shift both clock and data** (3.3V -> 5V, 74AHCT125). The AHCT family is the
  one that reads 3.3V as a valid high on a 5V rail; HC will not do.
- **1000 uF at each strip's power input**, on the buck's 5V output.
- Avoid GPIO 6-11 (flash), 34-39 (input-only), and 12 (boot strapping pin).
- Keep the board a few cm clear of the aluminium channel: it has a PCB trace antenna,
  and mounting it flush against metal detunes it. Worth doing before you spend an
  evening debugging "ESP-NOW dropouts" that are mechanical.

## Custom topologies (not a straight line)

Strips are meant to be cut. Every LED boundary is a cut point with four pads — `5V`,
`GND`, `CI` (clock in), `DI` (data in) — fed from the previous segment's `CO`/`DO`.
Cut, solder four wires, respect the arrows: data flows one way only. Serpentine
matrices, arcs, scattered clusters are all just this.

**The software does not care.** `led-core` treats a strip as a flat array of N pixels;
the dimmer and the frame encoder have no concept of shape. Topology is purely a
**mapping from geometry to index**, and it lives in the node's render code plus the
manifest's `geometry` block. A serpentine matrix is "row 1 left-to-right, row 2
right-to-left" in the index map, and nothing else changes. (What the manifest cannot
yet express is anything but `topology: LINE` — arbitrary shapes want a per-pixel
position list or a generator. OPEN, and worth deciding against a shape that actually
exists rather than inventing a schema first.)

**Signal chains; power is local.** The four-wire jumper carries clock, data and ground.
Ground must be jumpered too — it is the signal reference — but it should not be the
current path.

**Sizing a power jumper, if you do daisy-chain it.** You can, over short hops. Round-trip
copper drop (out *and* return) at a full-white 8.6A:

| gauge | mOhm/m | drop over 20 cm | over 1 m |
|---|---|---|---|
| 18 AWG | 21 | **72 mV** | 361 mV |
| 16 AWG | 13 | 45 mV | 224 mV |
| 14 AWG | 8.3 | 29 mV | 143 mV |

Two rules follow:

- **Size each hop for CUMULATIVE downstream current, not one segment's.** Chain six
  segments and the first jumper carries all six (8.6A), not 1.4A. Sizing each hop for
  the segment it lands on is how a wire cooks.
- **Under ~20-30 cm on 18 AWG, chain freely.** Past that the drop starts eating a budget
  you cannot refill — remember there is **no headroom to trim into**, and the strip's own
  copper already loses 0.3-0.5V end to end at full white. That drop, not the jumper, is
  usually the real bottleneck; chaining whole *strips* end to end goes orange no matter
  what wire you use.

**For a topology that sprawls: extend 12V, not 5V.** 5V at 8.6A does not travel — every
metre costs ~150 mV even in fat wire. The same power at 12V draws 2.4x less current and
has 12V of headroom to lose it into. So a far-flung fixture gets its own 12V branch off
the fuse block and its own buck, rather than a thicker 5V run. This is the power-island
principle one scale down: **make 5V a local phenomenon, everywhere.**

**Hand-soldering note.** At 144/m the cut pads are tiny and closely spaced; four joints
per junction on 12 mm pitch is genuinely fiddly. If a topology needs many junctions,
**60/m is far kinder to solder** (bigger pads, less power, cheaper) — the price is a
coarser pitch, so it needs proportionally more diffuser standoff (~15-20 mm rather than
~7 mm).

## Next

1. **Bring up the bucks first, on a dummy load** (see SAFETY.md). Then **light a
   strip**: fix `node-fw` against the real esp-hal API, run the breath
   animation, and compare the fade against `led-sim` by eye. Decide gamma 2.2 vs 2.8
   on the bench, and whether `global`-boundary flicker is visible (if it is, add
   hysteresis to the current-step choice in `dim`).
2. **ESP-NOW ingress** (esp-radio + esp-alloc + esp-rtos — start the scheduler
   *before* initializing the radio). Then the node subscribes to control signals and
   renders its own slice: no pixels on the wire.
3. **OTA**, before anything is mounted.
4. **Manifest**: `node-manifest.draft.json` moves into
   `projects/led_room/manifest/modules/` once a real node boots and publishes health.
