#!/usr/bin/env python3
"""Parse Waldorf Microwave II/XT user-wave SysEx dumps wrapped in Standard MIDI Files.

These .mid files (from synth.stromeko.net) are not music: each is a container for
one or more Waldorf "user wave" (UW) SysEx dumps. This module decodes them to
8-bit single-cycle waveforms with no external dependencies.

Format (per SysEx message, all bytes 7-bit except F0/F7 framing):

    F0 3E 0E dd 12 hh ll  <128 nibble bytes>  cc  F7
       |  |  |  |  |  |    |                   |
       |  |  |  |  |  |    |                   checksum = sum(nibble bytes) & 0x7F
       |  |  |  |  |  |    64 samples, high-nibble-then-low-nibble per sample
       |  |  |  |  |  low 7 bits of wave number
       |  |  |  |  high 7 bits of wave number  (num = hh*128 + ll, e.g. 1178 = UW1178)
       |  |  |  command 0x12 = wave dump
       |  |  device id (0 = broadcast/standard)
       |  equipment id 0x0E = Microwave II / XT / XTk
       Waldorf manufacturer id 0x3E

Each dump stores 64 samples. The full single-cycle wave is 128 samples,
reconstructed by Waldorf/PPG point symmetry:  wave[127-i] = 255 - wave[i].

Usage:
    python3 waldorf_wavetable.py dump  FILE.mid          # list waves
    python3 waldorf_wavetable.py json  FILE.mid OUT.json # export all waves
    python3 waldorf_wavetable.py bank  FILE.mid OUT.json # grouped wavetable bank for the editor
    python3 waldorf_wavetable.py wav   FILE.mid OUTDIR/  # one .wav per wave (128-sample cycle)
"""
import struct
import sys

WALDORF_ID = 0x3E
EQ_MICROWAVE_II_XT = 0x0E
CMD_WAVE_DUMP = 0x12
STORED_SAMPLES = 64          # samples actually transmitted
FULL_SAMPLES = 128           # single-cycle length after mirroring


def _read_vlq(data, i):
    val = 0
    while True:
        b = data[i]
        i += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            return val, i


def iter_sysex(data):
    """Yield raw SysEx payloads (3E ... F7) from a Standard MIDI File."""
    assert data[:4] == b"MThd", "not a Standard MIDI File"
    hlen = struct.unpack(">I", data[4:8])[0]
    i = 8 + hlen
    while i < len(data) and data[i:i + 4] == b"MTrk":
        tlen = struct.unpack(">I", data[i + 4:i + 8])[0]
        i += 8
        end = i + tlen
        while i < end:
            _, i = _read_vlq(data, i)            # delta time
            status = data[i]
            if status == 0xFF:                    # meta event
                i += 2
                mlen, i = _read_vlq(data, i)
                i += mlen
            elif status in (0xF0, 0xF7):          # sysex / escape
                i += 1
                slen, i = _read_vlq(data, i)
                if status == 0xF0:
                    yield data[i:i + slen]
                i += slen
            else:                                 # channel message
                i += 3 if (status & 0x80) else 2
        i = end


def decode_wave(sx):
    """Decode one wave-dump SysEx payload into a dict with the 64 stored samples."""
    if sx[0] != WALDORF_ID:
        raise ValueError(f"not a Waldorf SysEx (id={sx[0]:#x})")
    eq, dev, cmd = sx[1], sx[2], sx[3]
    if cmd != CMD_WAVE_DUMP:
        raise ValueError(f"not a wave dump (cmd={cmd:#x})")
    wave_num = sx[4] * 128 + sx[5]
    body = sx[6:-2]
    checksum, terminator = sx[-2], sx[-1]
    if terminator != 0xF7:
        raise ValueError("missing F7 terminator")
    samples = [(body[j] << 4) | body[j + 1] for j in range(0, len(body), 2)]
    return {
        "wave_num": wave_num,
        "equipment_id": eq,
        "device_id": dev,
        "samples": samples,                       # 64 values, 0..255
        "checksum": checksum,
        "checksum_ok": (sum(body) & 0x7F) == checksum,
    }


def full_cycle(samples):
    """Reconstruct the 128-sample single cycle via Waldorf point symmetry."""
    return samples + [255 - s for s in reversed(samples)]


def parse_file(path):
    data = open(path, "rb").read()
    return [decode_wave(sx) for sx in iter_sysex(data)]


def _cmd_dump(path):
    waves = parse_file(path)
    print(f"{path}: {len(waves)} wave dump(s)")
    bad = [w["wave_num"] for w in waves if not w["checksum_ok"]]
    nums = [w["wave_num"] for w in waves]
    print(f"  UW{min(nums)}..UW{max(nums)}   checksum bad: {bad or 'none'}")
    for w in waves[:8]:
        s = w["samples"]
        print(f"  UW{w['wave_num']}  cksum={'ok' if w['checksum_ok'] else 'BAD'}  "
              f"first8={s[:8]}  min={min(s)} max={max(s)}")
    if len(waves) > 8:
        print(f"  ... ({len(waves) - 8} more)")


def _cmd_json(path, out):
    import json
    waves = parse_file(path)
    payload = [{"wave_num": w["wave_num"], "stored": w["samples"],
                "cycle": full_cycle(w["samples"])} for w in waves]
    json.dump(payload, open(out, "w"))
    print(f"wrote {len(payload)} waves -> {out}")


# Wavetable groupings for the big combined user-wave set, from
# Readme_XTUsersoundset3_and_VS-Waves.html (typo'd ranges corrected against the
# actual contiguous UW1035..UW1249 data). Each group is <=64 waves so it maps
# cleanly onto the Microwave's 0..60 wave-position model. The two "unused" waves
# (UW1187-1188) are folded into PPG E-Bass, where the readme says they belong.
WAVETABLE_GROUPS = [
    ("vswaves1", "VS-Waves 1", 1035, 1095),
    ("xtuser", "XT User Waves", 1096, 1125),
    ("ppgebass", "PPG E-Bass", 1126, 1188),
    ("vswaves2", "VS-Waves 2", 1189, 1249),
]


def _cmd_bank(path, out):
    """Emit a wavetable bank JSON for the browser editor: named wavetables, each
    a list of full 128-sample cycles stored as signed 8-bit (native depth)."""
    import json
    by_num = {w["wave_num"]: w for w in parse_file(path)}
    tables = []
    for tid, name, lo, hi in WAVETABLE_GROUPS:
        waves = []
        for n in range(lo, hi + 1):
            w = by_num.get(n)
            if w is None:
                continue
            cyc = full_cycle(w["samples"])              # 0..255, 128 samples
            waves.append({"n": n, "s": [c - 128 for c in cyc]})  # -> i8
        if waves:
            tables.append({"id": tid, "name": name, "waves": waves})
    bank = {"wave_len": FULL_SAMPLES, "source": path.split("/")[-1],
            "wavetables": tables}
    json.dump(bank, open(out, "w"), separators=(",", ":"))
    nwaves = sum(len(t["waves"]) for t in tables)
    print(f"wrote {len(tables)} wavetables / {nwaves} waves -> {out}")


def _cmd_rustbin(path, out):
    """Emit a raw signed-8-bit blob for the Rust dsp core: full 128-sample
    cycles, grouped in WAVETABLE_GROUPS order (same as the editor bank), so
    `include_bytes!` + the metadata in wavetable_bank.rs index it identically.
    Prints the table offsets to paste/verify against that metadata."""
    by_num = {w["wave_num"]: w for w in parse_file(path)}
    blob = bytearray()
    offset = 0
    meta = []
    for tid, name, lo, hi in WAVETABLE_GROUPS:
        count = 0
        for n in range(lo, hi + 1):
            w = by_num.get(n)
            if w is None:
                continue
            for c in full_cycle(w["samples"]):       # 0..255
                blob.append((c - 128) & 0xFF)          # -> i8 two's complement
            count += 1
        meta.append((tid, name, offset, count))
        offset += count
    with open(out, "wb") as f:
        f.write(blob)
    print(f"wrote {offset} waves x {FULL_SAMPLES} = {len(blob)} bytes -> {out}")
    print("// metadata for wavetable_bank.rs (first = wave index, count = waves):")
    for tid, name, first, count in meta:
        print(f'    WtTableDef {{ id: "{tid}", name: "{name}", first: {first}, count: {count} }},')


def _cmd_wav(path, outdir):
    import os
    import wave as wavemod
    os.makedirs(outdir, exist_ok=True)
    waves = parse_file(path)
    for w in waves:
        cycle = full_cycle(w["samples"])          # 0..255 unsigned 8-bit
        fn = os.path.join(outdir, f"UW{w['wave_num']}.wav")
        with wavemod.open(fn, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(1)                    # 8-bit WAV is unsigned
            wf.setframerate(44100)
            wf.writeframes(bytes(cycle))
    print(f"wrote {len(waves)} single-cycle .wav files -> {outdir}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "dump":
        _cmd_dump(sys.argv[2])
    elif cmd == "json" and len(sys.argv) >= 4:
        _cmd_json(sys.argv[2], sys.argv[3])
    elif cmd == "bank":
        _cmd_bank(sys.argv[2], sys.argv[3])
    elif cmd == "rustbin":
        _cmd_rustbin(sys.argv[2], sys.argv[3])
    elif cmd == "wav":
        _cmd_wav(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(1)
