# SAFETY — LED nodes

Three things to protect, in order: **people**, **the audience's neurology**, and
**the hardware**. The last one is the only one that's cheap to get wrong.

Read this before the first power-on. The rules with **DO NOT** in them are ones
where the failure is instant and unrecoverable.

---

## 1. Wiring rules that release smoke

**DO NOT put 12V on a 5V strip.** The trunk is 12V and the strips are 5V; the buck
is the only thing between them. A miswired branch destroys 144 LEDs instantly. Label
the 12V and 5V wire, and keep them in different colours from each other.

**DO NOT exceed 5.0V, ever — not even to fight voltage drop.** BTF's note on the strip
is blunt: *"using voltage DC5V, higher than 5V will destroy it."* The tolerance window
is one-sided and narrow: undervolting shifts colour (blue and green dim before red),
overvolting kills the strip. Since you cannot trim the source up, the only way to fight
drop along the strip is to **feed both ends** — which is why every strip gets two
pigtails, not one.

**DO NOT back-feed the ESP32.** On the bench the board is powered over USB. If you
*also* wire the buck's 5V into the board's 5V pin you have tied two supplies
together, and not every DevKitC revision has a protection diode. So:

- **bench** — ESP32 on USB; strip and 74AHCT125 on the buck; **grounds tied together**.
- **install** — no USB attached; the board takes its 5V from the buck like everything
  else.

Never both at once.

**Common ground, always.** The strip, the level shifter, the buck, and the ESP32 must
share a ground. A floating ground is the classic cause of "the first pixel is
garbage" — and worse, it puts the signal lines at an undefined potential relative to
the strip. A non-isolated buck shares ground with its 12V input, which is what we
want here.

**Ferrule every stranded wire that lands in a screw terminal.** 18 AWG silicone wire
is very fine-stranded: it splays under a screw and single strands escape to touch the
neighbouring terminal. On a 150W supply that is not a nuisance, it is a short.

---

## 2. Fusing and current

The 12V supply is **12.5A / 150W**. That is enough energy to melt wire, and it will
do so without complaint — a supply's rating is what it *can* deliver, not a limit
that protects anything downstream.

- **Main fuse at the supply output.**
- **Per-branch fuse at 5A on the 12V side** (a node drawing 8A at 5V is ~3.5A at 12V).
  One blown fuse then takes out one node instead of browning out the bench.
- **Wire to the fuse, not to the load.** 18 AWG minimum on a 5A branch; 16 AWG trunk.
  The fuse protects the *wire*; if the wire is thinner than the fuse allows, the wire
  is the fuse.
- A 144-LED strip at full white is **8.6A at 5V** — BTF spec it at **43W/m, 0.3W/LED**,
  and recommend a 5V/10A supply per metre. That is the manufacturer's own number, not a
  worst case to be argued down. Size each supply against the cluster it actually feeds —
  see *Power islands* below.
- **A node is ~9.2A worst case** (strip + ESP32 + shifter), so its buck wants >=15A.

---

## 3. Power islands — do not assume one PSU

**One supply is a bench convenience, not the architecture.** A single PSU in a room
means 12V trunks radiating to every corner, which is precisely the wires-strewn-about
problem the distributed-node design exists to avoid. The room topology is **several
power islands**: a supply local to each cluster of nodes, each sized to its own load,
each with its own fuse block.

The bench rig (one 12V/12.5A supply, three nodes) is one island that happens to be
the whole system. Do not read it as the install rig.

**A power island is a data island — and that is free here.** The nodes are coupled
*wirelessly* (ESP-NOW): no signal wire crosses between islands, so islands need no
ground bonding, and you cannot build a ground loop between two earthed supplies. This
is a real dividend of "never ship pixels" — the control architecture buys electrical
independence, not just radio bandwidth.

The rule that follows, and the only one that matters:

> **If a wire ever crosses between two islands — a data line, or two strips chained
> end to end — their grounds MUST be bonded.** Signal referenced to a ground it does
> not share is undefined, and at 12V/150W per island the return current has somewhere
> unpleasant to go. Better: don't cross islands. Keep every wire inside one.

**A power island is also a failure domain.** If one supply dies, its nodes go dark and
the rest of the room does not. That is the *desirable* behaviour, but it means an
emitter group can span islands and must degrade gracefully with a member missing —
a choreography that assumes every node is alive will look broken rather than dimmed.
That's a plugin/graph obligation, not an electrical one, but it originates here.

---

## 4. Bring-up order

One unknown at a time. Do not connect a strip to a buck you have not verified — when
the strip then misbehaves you will not know which part lied to you.

1. **Buck alone, no load.** Set the output to 5.0V with a meter.
2. **Buck on a dummy load** (power resistor, or an automotive bulb) at a few amps.
   Confirm 5.0-5.1V *holds* under load and the module is not cooking. Ten minutes.
3. **Buck + strip, no data.** Strip should be dark (or whatever garbage it powered up
   with). Re-measure **at the strip's input terminals, under load** — this is the
   number that matters, and it is not the number at the buck's terminals.
4. **Add the level shifter, then data.** Now debug software.

---

## 5. Thermal

- The aluminium channel is the **heatsink**, not just the diffuser. Do not run a strip
  at brightness while it's coiled on a reel or lying on a desk — a reel concentrates
  every LED's heat into a small volume.
- A non-synchronous buck at 8A dumps ~15% as heat *inside the fixture*. Synchronous
  modules exist for this reason; use them, and heatsink them.
- Leave an air gap behind any mounted fixture.

---

## 6. Eyes and the audience

**A 144-LED strip at full white is genuinely blinding at close range.** Do not point a
bench strip at your face, and do not "just try full brightness" while leaning over it.
The exhibit runs at a small fraction of full output; full white is a test condition,
not an artistic one.

**Photosensitivity is a hard limit, not a preference.** The node manifest already
declares it:

```json
"safe": { "maxBrightness": 0.9, "maxFlashHz": 3.0 }
```

Flashing above ~3 Hz at high contrast can trigger seizures in photosensitive people.
This is the standard threshold (WCAG / Harding), and it applies to a room-scale light
installation far more than to a screen. Treat `maxFlashHz` as a **contract the render
node enforces**, not advice the choreography is trusted to follow — a plugin bug that
strobes a room is not an aesthetic problem.

The same applies to `maxBrightness`: it exists so that no signal path, however broken,
can drive the room to full output.

---

## 7. Mains

Every supply's **input** side is mains — and a room with several power islands has
several of them. If a unit is open-frame (the LRS-style brick with exposed screw
terminals), its mains terminals must be covered before it lives on a bench or a wall,
and it must be earthed. An enclosed supply with a captive lead is the safer choice and
worth the few dollars, especially multiplied across islands.

Nothing downstream of a buck is a shock hazard — 5V is not. **Everything upstream of
each 12V supply is.**
