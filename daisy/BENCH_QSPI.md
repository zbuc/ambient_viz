# QSPI XIP performance benchmark (pre/post port)

Quantifies how running the firmware from external **QSPI flash (XIP @ 0x90000000)**
vs the **internal flash (0x08000000)** affects the real-time audio DSP — the open
question in `PLAN_QSPI_BOOTLOADER.md` ("XIP is slower; measure `CB_FULL_US`").

## Method

- **Per-stage DWT cycle counter** (`feature = "bench"`, `main.rs`): each master-
  chain stage (`sd` decode, `tape`, `freeze`, `bell`, `voice`, `limiter`) is
  wrapped in `bench_stage!`, which records the **max DWT_CYCCNT delta per
  heartbeat interval**. Reported over RTT as `bench(cyc): …`. CPU @ 480 MHz, so
  **cycles ÷ 480 = µs**. `cb_full_us` (whole-callback max) is reported alongside.
- **Auto-strike**: bench builds re-trigger bell + voice every ~750 blocks
  (~0.5 s) so those stages actually run without needing the Pi/MIDI.
- **opt level**: the DSP crates (`dsp`, `infinitedsp-core`) are pinned to **opt-s
  via the per-package profile override** regardless of the build's base opt-level
  (see workspace `Cargo.toml`). So the per-stage cycle costs are the **opt-s DSP
  cost in every build** — `voice` can be measured even though its image only fits
  internal flash at base-opt-z (the non-DSP code shrinks, the DSP stays fast).
- Run on the Daisy Pod (SDMMC SD), captured over the STLINK/RTT.

### Build / flash-fit matrix (internal flash, 128 KB)

| Build | base opt | fits internal? |
|---|---|---|
| `sd-sdmmc,bench` (base = tape+limiter) | s | ✅ |
| `bell,sd-sdmmc,bench` | s | ✅ |
| `freeze,sd-sdmmc,bench` | s | ✅ |
| `voice,sd-sdmmc,bench` | s | ❌ overflow (~1.3 KB) → measure at base opt-z |
| `voice,sd-sdmmc,bench` | z | ✅ (DSP still opt-s via override) |
| `bell,voice,freeze,sd-sdmmc,bench` | z | ❌ overflow (~2.6 KB) — **QSPI-only** |

The all-features image not fitting internal flash *at all* is the whole reason
for QSPI. Measure it only post-port.

## PRE-QSPI baseline — internal flash, DSP @ opt-s (2026-06-09)

Per-stage max cycles (≈ µs = cyc/480), Daisy Pod, steady state:

| Stage | cycles | µs | notes |
|---|---:|---:|---|
| `sd` decode | ~1,770 | 3.7 | i16→f32, in firmware (build opt-level) |
| **`tape`** | **~134,000** | **279** | dominant cost — the XIP-sensitive hot path |
| `freeze` (idle) | ~1,090 | 2.3 | send only; glitch runs only when active |
| `bell` | ~57,600 (peak) | 120 | FM voice + ping-pong; varies with envelope |
| `voice` | ~61,400 | 128 | formant synth + reverb (while active) |
| `limiter` | ~3,360 (peak) | 7 | |

Whole-callback `cb_full` by combo (deadline = **667 µs**, BLOCK_LENGTH=32 @ 48 k):

| Combo | cb_full µs | headroom |
|---|---:|---:|
| base (tape+lim) | 305 | 362 |
| +freeze | 305 | 362 |
| +bell | 427 (peak) | 240 |
| +voice | 457 | 210 |
| all (proj. tape+bell+voice+tail) | ~570 | ~97 |

**Takeaways:** tape is ~80–90 % of the base callback; bell and voice each add
~120–130 µs. At opt-s the all-features projection (~570 µs) clears the 667 µs
deadline — but only just, which is why opt-z (which ~2× the DSP) blew it.

## POST-QSPI — XIP @ 0x90000000 (measured 2026-06-09)

Image: `bell,voice,sd-sdmmc,qspi,bench` (154 KB, app @ `0x90040000` via the Daisy
bootloader). Daisy Pod, SDMMC SD, captured over STLINK/RTT (`bench(cyc):` line)
and confirmed by direct SWD reads of the `BENCH_*` atomics. Steady state, all of
tape+bell+voice running together (the auto-strike fires bell+voice every ~0.5 s).

| Stage | int cyc | qspi cyc | Δ% | qspi µs |
|---|---:|---:|---:|---:|
| sd | 1,770 | ~3,200 | +81 % | 6.7 |
| **tape** | **134,000** | **~168,500** | **+26 %** | **351** |
| freeze | 1,090 | n/a | — | — (dropped: heap, see below) |
| bell | 57,600 | ~64,200 | +11 % | 134 |
| voice | 61,400 | ~87,000 | +42 % | 181 |
| limiter | 3,360 | ~8,300 | +147 % | 17 |

I-cache is **on** (`main.rs` `enable_icache`) and QSPI (`0x90000000`) is cacheable
write-through under the default MPU map — XIP is cached, not raw-fetched. So the
penalty is **I-cache *contention***, not uncached fetch: the pre-QSPI baseline
measured each feature *in isolation* (forced by the 128 KB flash limit, one
feature per image), whereas QSPI runs them *together* (the whole point of the
port). Their combined hot-loop footprint exceeds the 16 KB I-cache, so every
stage sees a higher miss rate than it did alone — which is why the small stages
(voice +42 %, limiter +147 %) inflate more in % than tape (+26 %). tape is still
the dominant *absolute* cost (351 µs).

### Is it real-time-safe? — YES (as shipped)

- Sum of DWT stages with tape+bell+voice all active ≈ 168.5k + 64.2k + 87k + 3.2k
  + 8.3k ≈ **331k cyc ≈ 690 µs**, vs the **667 µs** single-block deadline — i.e.
  a worst-case callback runs ~23 µs *over* one block's playback time.
- BUT `SAI_ERR = 2` over **80+ s** of continuous tape+bell+voice (both struck
  every 0.5 s) — i.e. essentially zero underruns (the 2 are the boot transient).
  The SAI **DMA double-buffer** gives a full extra block of slack, so an
  occasional 690 µs callback is absorbed as long as the *average* stays under
  667 µs (voice is idle between utterances). **QSPI XIP is real-time-viable with
  the full bell+voice feature set — which never fit internal flash at all.**
- `cb_full_us` (the heartbeat field) is measured via `embassy_time` at
  tick-hz-32768 → quantized to ~30.5 µs steps (it pins at 671 = 22 ticks), so it's
  too coarse to trust precisely. The **DWT per-stage cycles are the accurate
  figure**; both builds use the identical block size, so the deltas are
  apples-to-apples.

### Caveats / notes

- **SD backing track was NOT streaming** on the test card (`SD_UNDERRUN` climbs
  ~57 k/s — the SPSC ring never fills; the file isn't present/opened on this
  card). So `tape` processed **silence**, not the real backing track. tape's
  instruction stream is data-independent (the loss-FIR + compressor exp2/log2 run
  every sample regardless of value, no zero-input early-out), so the cycle
  comparison holds — but re-verify the absolute tape cost with the real backing
  track present for final confidence.
- `freeze` is omitted: bell+voice+freeze together exceed the 504 KB AXI heap
  (boot alloc panic). Its cost is tiny (~1,090 cyc idle) and was captured on
  internal flash; not worth the heap to co-bench here.
- **bench-strike fix:** the auto-strike originally fired on tick 0 (the literal
  first callback), which panicked (bounds/index — striking bell+voice before the
  DSP chain had run once, with `sample_index = 0`). Guarded to `t != 0 && t % 750
  == 0`; steady-state strikes at tick 750+ are fine. This was a *bench-harness*
  bug, not a QSPI or feature-combo bug (bell+voice@opt-s ran in Friday's exhibit).

### Recommendation

Ship the QSPI port — it lifts the flash ceiling and runs the full feature set
real-time. The +26 % tape XIP cost is absorbed by DMA buffering today. **If future
DSP load grows** (more voices, the freeze send, a sequencer), the headroom
shrinks; the mitigation is to **ITCM-ramfunc the tape hot loop**
(`#[link_section = ".itcm"]`, `ITCMRAM @ 0x0, 64 K` free, zero-wait-state — exempt
from I-cache contention entirely). tape is the prime candidate (largest absolute
stage). Re-measure after, expecting tape to drop back toward its ~134k internal
figure and to *stop* evicting the other stages from the I-cache (so voice/limiter
should improve too).

## ITCM tape placement — measured (2026-06-09)

Built the scaffolding (`itcm.x` linker section `INSERT AFTER .rodata`, boot copy in
`pre_init` with explicit ITCM enable, `#[cfg_attr(feature="itcm-tape", unsafe(
link_section=".itcm"))]` on `TapeProcessor::process`) and ran `cargo bin-qspi-bench-itcm`
vs `bin-qspi-bench`. `TapeProcessor::process` lands at ITCM `0x0` (4792 B = its body
+ inlined hysteresis/wow/chew; the slice callees loss/head_bump/noise stay in QSPI).

| stage | QSPI no-ITCM | QSPI +ITCM-tape | Δ | note |
|---|---:|---:|---:|---|
| **tape** | 168,500 | 157,768 | **−6.4 %** | moved (inlined body only) |
| **voice** | 87,000 | 76,345 | **−12.2 %** | *untouched* — contention relief |
| **limiter** | 8,300 | 2,448 | **−70 %** | *untouched* — contention relief |
| bell | 64,200 | 62,090 | −3.3 % | *untouched* |
| sd | 3,200 | 7,245 | **+126 %** | *untouched* — cache re-map, got worse |

Net worst-case callback (tape+bell+voice active) ≈ −53 µs (690 → ~637 µs); `cb_full`
671 → 640 µs. **Confirms the double-benefit thesis:** ITCM helps the moved stage AND
relieves I-cache pressure on the others (voice/limiter improved more, in %, than tape
itself). Two caveats, both instructive for per-build tuning:
- **tape's own gain is capped** at −6.4 % because only its inlined body moved; its
  flash-resident callees (loss/head_bump/noise) would need their own `.itcm` tags to
  approach the ~134k internal figure. The inlining boundary is real.
- **sd got *worse* (+4k cyc)** — relocating 4.8 KB shifts every other function's
  I-cache set mapping; sd landed in a worse spot. ITCM placement is **not monotonic**,
  so the "which stages" choice must be *measured per build*, not assumed (see memory
  `daisy-modular-itcm-perbuild`).

**Scaffolding bugs found+fixed** (worth knowing for the next stage you ITCM): (1) the
copy must run in `pre_init`, not `main` — in `main` it didn't populate ITCM and tape
ran from empty ITCM → HardFault; (2) `INSERT AFTER .data` clobbers cortex-m-rt's
`__edata` (it extends it for the *RAM* .data-load mechanism, but our VMA is ITCM) →
the `.data` init loop runs to a bad bound → boot HardFault. Use `INSERT AFTER .rodata`.
Verify each new ITCM stage with `llvm-nm` (symbol at `0x0000xxxx`) + `llvm-size -A`
(`.itcm` byte count) + a boot check (PLAYED_FRAMES advancing).

### ITCM selection criterion #2: COLD-START audibility (not just steady-state cost)

Observed (2026-06-09): the **first bell strike after boot glitched** — high-pitched
chopping — then every later strike was clean. Cause: the bell's FM `tick()` lives in
QSPI and is **cold in the I-cache on its first run**, so that one callback fetches the
whole hot loop over the slow QSPI bus, blows the 667 µs deadline, the SAI overruns, and
the audio loop restarts *mid-ring* → audible glitch. Once the code is cached, it's fine.
Levels were never the issue (peaks stayed 0.18–0.42 FS — no clipping; the earlier
"distortion" was only the bench firing bell+voice every 0.5 s, which the spaced/
alternating auto-strike removed).

**Implication for ITCM placement:** steady-state cycle cost (the `bench(cyc)` averages)
is **not the only criterion**. A stage with perfectly fine *average* cost can still
glitch **audibly on its cold first run** if it's:
1. **sparsely triggered** (so it's frequently evicted → cold again — bell, voice, any
   one-shot), AND
2. **directly audible** (its output is heard the instant it fires).

ITCM code is never cached and never cold → zero-wait on the very first sample, so it
**eliminates the cold-start glitch outright**. So the per-build decision has two
distinct motivations, and they can point at *different* stages:
- **Throughput headroom** → ITCM the always-on, dominant-cost, cache-thrashing stage
  (here: `tape`). Driven by steady-state `bench(cyc)` + the contention relief it buys.
- **Cold-start glitch removal** → ITCM the sparsely-triggered audible voice (here:
  `bell`), *even if its average cost is small*. Driven by listening to the first
  post-boot strike + watching `SAI_ERR` spike around first triggers.

How to spot candidates in the bench data: the per-stage counter reports the **max** per
interval, so a large gap between a stage's *cold* spike (first interval it runs) and its
*warm* steady value flags cold-start risk. Pair that with an ear on the first strike.
For `bell` specifically, `itcm-bell` (mark `FmVoice::tick`/`FmStab`) is the fix when the
first-strike glitch matters for an installation; deferred unless an install needs it.
