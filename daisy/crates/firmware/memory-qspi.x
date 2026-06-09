/* STM32H750IB on Daisy Seed — QSPI XIP build (feature = "qspi").
 *
 * Runs the app from external QSPI flash via the Electro-Smith Daisy bootloader,
 * instead of the 128 KB internal flash. The bootloader (in internal flash) sets
 * up the QSPI peripheral in memory-mapped (XIP) mode, sets VTOR, and jumps to the
 * app. It reserves the first 256 KB (four 64 KB sectors) of QSPI at 0x90000000,
 * so apps are linked at 0x90040000 — matching libDaisy's STM32H750IB_qspi.lds.
 *   https://electro-smith.github.io/libDaisy/md_doc_2md_2__a7___getting-_started-_daisy-_bootloader.html
 *
 * Only the FLASH region differs from memory.x (0x08000000/128 K -> 0x90040000/
 * ~7.9 MB). Everything else — DTCM stack/.bss, AXI-SRAM heap, D2/D3, SDRAM, the
 * custom NOLOAD sections — is identical. The app .bin is loaded over the
 * bootloader's USB DFU: `dfu-util -a 0 -s 0x90040000:leave -D firmware.bin`.
 */

MEMORY
{
    FLASH     (RX)  : ORIGIN = 0x90040000, LENGTH = 7936K
    DTCMRAM   (RWX) : ORIGIN = 0x20000000, LENGTH = 128K
    SRAM      (RWX) : ORIGIN = 0x24000000, LENGTH = 512K
    RAM_D2    (RWX) : ORIGIN = 0x30000000, LENGTH = 288K
    RAM_D3    (RWX) : ORIGIN = 0x38000000, LENGTH = 64K
    ITCMRAM   (RWX) : ORIGIN = 0x00000000, LENGTH = 64K
    SDRAM     (RWX) : ORIGIN = 0xc0000000, LENGTH = 64M
    QSPIFLASH (RX)  : ORIGIN = 0x90000000, LENGTH = 8M
}

REGION_ALIAS(RAM, DTCMRAM);

SECTIONS
{
    .sram1_bss (NOLOAD) :
    {
        . = ALIGN(4);
        _ssram1_bss = .;

        PROVIDE(__sram1_bss_start__ = _sram1_bss);
        *(.sram1_bss)
        *(.sram1_bss*)
        . = ALIGN(4);
        _esram1_bss = .;

        PROVIDE(__sram1_bss_end__ = _esram1_bss);
    } > RAM_D2

    /* Global heap: on-chip AXI SRAM (cached, fast) instead of external SDRAM, so
     * the DSP delay-line working set doesn't thrash to slow external memory. The
     * tape + freeze FX buffers (~137 KB) fit comfortably in 512 KB. */
    .axisram_bss (NOLOAD) :
    {
        . = ALIGN(8);
        _saxisram_bss = .;
        *(.axisram_bss)
        *(.axisram_bss*)
        . = ALIGN(8);
        _eaxisram_bss = .;
    } > SRAM

    .sdram_bss (NOLOAD) :
    {
        . = ALIGN(4);
        _ssdram_bss = .;

        PROVIDE(__sdram_bss_start = _ssdram_bss);
        *(.sdram_bss)
        *(.sdram_bss*)
        . = ALIGN(4);
        _esdram_bss = .;

        PROVIDE(__sdram_bss_end = _esdram_bss);
    } > SDRAM
}
