#!/usr/bin/env bash
# QSPI flash runner — invoked by cargo's `target.runner` from the `flash-qspi`
# and `flash-qspi-debug` aliases (see daisy/.cargo/config.toml). cargo builds the
# firmware ELF and passes its path as the final arg; we objcopy it to a raw .bin,
# wait for the Daisy bootloader's DFU window (a USB power-cycle opens it), flash
# over dfu-util with retries, then verify the app booted (PLAYED_FRAMES advancing).
#
#   args: $1 = mode ("attach" | "noattach"), $2 = path to built ELF
#
# `attach` (debug build) streams the defmt RTT heartbeat via `probe-rs attach`
# after a successful boot — the QSPI equivalent of the old `cargo flash` dev loop.
set -euo pipefail

MODE="${1:-noattach}"
ELF="${2:?cargo did not pass an ELF path}"
CHIP="STM32H750IBKx"
APP_ADDR="0x90040000"
BIN="${ELF%/*}/$(basename "$ELF").qspi.bin"

SYSROOT="$(rustc --print sysroot)"
OBJCOPY="$(find "$SYSROOT" -name llvm-objcopy 2>/dev/null | head -1)"
NM="$(find "$SYSROOT" -name llvm-nm 2>/dev/null | head -1)"
[ -n "$OBJCOPY" ] || { echo "!! llvm-objcopy not found (install: rustup component add llvm-tools)"; exit 1; }

echo "==> objcopy ELF -> raw bin"
"$OBJCOPY" -O binary "$ELF" "$BIN"
printf "    %s (%s bytes)\n" "$BIN" "$(wc -c < "$BIN" | tr -d ' ')"

echo "==> waiting for the bootloader DFU window — POWER-CYCLE the Daisy (unplug/replug USB)…"
flashed=0
for _ in $(seq 1 9000); do            # ~30 min ceiling
  if dfu-util -l 2>/dev/null | grep -q "0483:df11"; then
    echo "==> DFU detected — flashing immediately"
    for attempt in 1 2 3 4 5 6; do
      echo "    attempt $attempt"
      dfu-util -a 0 -s "${APP_ADDR}:leave" -D "$BIN" 2>&1 | tee /tmp/flash_qspi_dfu.txt | tail -3 || true
      if grep -q "File downloaded successfully\|Download.*done\|leaving DFU" /tmp/flash_qspi_dfu.txt; then
        echo "==> flash OK"; flashed=1; break
      fi
      # the bootloader window is short; a flaky first-page ERASE_PAGE clears on an
      # immediate retry while DFU is still up. Bail once it leaves.
      dfu-util -l 2>/dev/null | grep -q "0483:df11" || { echo "==> DFU window closed after attempt $attempt"; break; }
    done
    break
  fi
  sleep 0.2
done
[ "$flashed" = 1 ] || { echo "!! never caught the DFU window — re-run and power-cycle again"; exit 1; }

# --- boot check: PLAYED_FRAMES (symbol address read from THIS ELF) ---
sleep 4
PF="$("$NM" "$ELF" 2>/dev/null | grep -E '_ZN8firmware13PLAYED_FRAMES' | head -1 | awk '{print "0x"$1}')"
if [ -n "$PF" ]; then
  rd(){ probe-rs read --chip "$CHIP" b32 "$1" 1 2>/dev/null | tail -1 | tr -d ' '; }
  a="$(rd "$PF")"; sleep 2; b="$(rd "$PF")"
  if [ "$a" != "$b" ]; then echo "==> BOOT OK — PLAYED_FRAMES advancing ($a -> $b)"; else echo "!! PLAYED_FRAMES stalled ($a) — may have panicked"; fi
fi

if [ "$MODE" = "attach" ]; then
  echo "==> attaching for RTT logs (Ctrl-C to detach)…"
  exec probe-rs attach --chip "$CHIP" "$ELF"
else
  echo "==> done. For logs:  probe-rs attach --chip $CHIP $ELF"
fi
