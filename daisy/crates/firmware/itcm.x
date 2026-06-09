/* ITCM ram-functions: hot code relocated to the H750's zero-wait-state ITCM
   (0x00000000) to dodge QSPI-XIP I-cache contention (see BENCH_QSPI.md). VMA in
   ITCMRAM, LMA in FLASH (internal 0x08000000 or QSPI 0x90040000 — both regions
   are named FLASH in their respective memory.x), copied to ITCM at boot by
   copy_itcm() in main.rs.

   Per-build, benchmark-driven placement: a function lands here only when tagged
   `#[cfg_attr(feature = "itcm-<x>", link_section = ".itcm")]` and that feature is
   on. With nothing tagged the section is empty (__sitcm == __eitcm → copy_itcm
   moves 0 bytes), so this fragment is harmless to link into every firmware build.

   Inserted AFTER .rodata, NOT .data: cortex-m-rt's `INSERT AFTER .data` hook
   deliberately extends `__edata = .` to cover the injected section so its OWN
   .data copy loads it — but that assumes a RAM VMA. Our VMA is ITCM, and we run
   our own copy (copy in pre_init), so landing before `__edata = .` would clobber
   it to an ITCM address (breaking cortex-m-rt's .data init -> boot HardFault).
   .rodata is a FLASH section and the following `.data {…} > RAM` resets the
   location counter, so __sdata/__edata stay correct. `*(.itcm .itcm.*)` is NOT
   wrapped in KEEP, so unreferenced ram-funcs can still be GC'd. */
SECTIONS {
  .itcm : ALIGN(4) {
    . = ALIGN(4);
    __sitcm = .;
    *(.itcm .itcm.*);
    . = ALIGN(4);
    __eitcm = .;
  } > ITCMRAM AT > FLASH
} INSERT AFTER .rodata;

/* LMA (load address in FLASH/QSPI) of the .itcm section — the copy source. */
__siitcm = LOADADDR(.itcm);
