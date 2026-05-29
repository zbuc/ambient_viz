# 20251006 arrangement 1
# 64 steps = 4 bars of 16th notes (res: 16)
name: 20251006 arrangement 1
steps: 64
res: 16
# Harmony for the stab lane. Roman numerals are diatonic to this key;
# the prog list is consumed one chord per stab hit and restarts each loop.
key: D minor
octave: 3
#     beat 1          beat 2          beat 3          beat 4   (per bar, 16ths)
#     1 e + a 2 e + a 3 e + a 4 e + a |  ...
kick: X . . . . . . . X . . . . . . . | X . . . . . . . X . . . . . . . | X . . . . . . . X . . . . . . . | X . . . . . . . X . . . . . . .
chat: X X . X X X . X X X . X X X . X | X X . X X X . X X X . X X X . X | X X . X X X . X X X . X X X . X | X X . X X X . X X X . X X X . X
ohat: . . X . . . X . . . X . . . X . | . . X . . . X . . . X . . . X . | . . X . . . X . . . X . . . X . | . . X . . . X . . . X . . . X .
stab: . . . . . . . . X . . . . . . . | . . . . . . . . X . . . . . . . | . . . . . . . . X . . . . . . . | . . . . . . . . X . . . . . . .
prog: ii ii i ii
# Per-hit stab character (0 = dark/short/filtered, 9 = bright/long/open).
# One digit aligned to each stab hit (step 8 of each bar): the four stabs
# move dark → medium → bright/open → dark again over the loop.
stabtone: . . . . . . . . 2 . . . . . . . | . . . . . . . . 5 . . . . . . . | . . . . . . . . 9 . . . . . . . | . . . . . . . . 3 . . . . . . .
# Rumble bass: one whole-note per bar (strike + holds), riding the harmony.
# `_` sustains the note; it holds seamlessly into the next bar / loop.
bass: X _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ | X _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ | X _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ | X _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
bassprog: ii ii i ii
