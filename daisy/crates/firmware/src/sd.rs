//! SD card stack — selectable backend behind a feature flag.
//!
//! - **`sd-spi`** (default): SPI1 + `embedded-sdmmc`, for the 6-pin WWZMDiB
//!   prototype module.
//! - **`sd-sdmmc`**: native SDMMC1 peripheral (embassy `Sdmmc`) bridged into the
//!   same `embedded-sdmmc` `VolumeManager` via a `block_on` adapter, for a proper
//!   SD socket wired to SDMMC1 (Adafruit #4682 proto / GCT MEM2075 prod).
//!
//! Both paths produce a value implementing `embedded_sdmmc::BlockDevice`, so the
//! `main.rs` mount/stream code (`VolumeManager`, `file.read`, …) is identical.
//!
//! SPI wiring (sd-spi):                  SDMMC1 wiring (sd-sdmmc):
//!   MISO  D9  PB4  SPI1_MISO              CLK  D6  PC12  SDMMC1_CK
//!   MOSI  D10 PB5  SPI1_MOSI              CMD  D5  PD2   SDMMC1_CMD
//!   SCK   D8  PG11 SPI1_SCK               D0   D4  PC8   SDMMC1_D0
//!   CS    D7  PG10 GPIO (idle high)       D1   D3  PC9   SDMMC1_D1   (4-bit only)
//!                                         D2   D2  PC10  SDMMC1_D2   (4-bit only)
//!                                         D3   D1  PC11  SDMMC1_D3   (4-bit only)
//!
//! NOTE: in `sd-sdmmc` builds, D2/PC10 doubles as the USART3 debug-TX pin, so
//! 4-bit and `debug-uart` cannot coexist — the bus auto-degrades to 1-bit when
//! `debug-uart` is on. See daisy/BREAKOUT.md §4.3.
#![allow(dead_code)]

use embedded_sdmmc::{TimeSource, Timestamp};

#[cfg(all(feature = "sd-spi", feature = "sd-sdmmc"))]
compile_error!("features `sd-spi` and `sd-sdmmc` are mutually exclusive — enable exactly one SD backend");
#[cfg(not(any(feature = "sd-spi", feature = "sd-sdmmc")))]
compile_error!("no SD backend selected — enable exactly one of `sd-spi` or `sd-sdmmc`");

// ============================================================================
// SPI backend (`sd-spi`)
// ============================================================================
#[cfg(feature = "sd-spi")]
mod spi_backend {
    use daisy_embassy::pins::{SeedPin10, SeedPin7, SeedPin8, SeedPin9};
    use embassy_stm32::Peri;
    use embassy_stm32::gpio::{Level, Output, Speed};
    use embassy_stm32::mode::Blocking;
    use embassy_stm32::peripherals::SPI1;
    use embassy_stm32::spi::mode::Master;
    use embassy_stm32::spi::{Config as SpiConfig, Spi};
    use embassy_stm32::time::Hertz;
    use embassy_time::Delay;
    use embedded_hal_bus::spi::ExclusiveDevice;
    use embedded_sdmmc::SdCard;

    /// Concrete blocking-SPI device wrapping SPI1 + a GPIO CS.
    pub type SdSpi<'a> = ExclusiveDevice<Spi<'a, Blocking, Master>, Output<'a>, Delay>;

    /// SPI clock for the SD init handshake. The SD spec mandates ≤400 kHz for
    /// CMD0/ACMD41, and slow edges are far more reliable on the crowded
    /// hand-wired breakout — initialising at full speed is the usual cause of
    /// intermittent "card not found" on cold boot.
    const INIT_HZ: u32 = 400_000;
    /// SPI clock for streaming once acquired (SD default-speed ≤25 MHz).
    const FAST_HZ: u32 = 24_000_000;

    /// Build the SPI1 bus + CS into the `SdCard` embedded-sdmmc wants. Does NOT
    /// initialise the card — that happens lazily on the first block-device call.
    pub fn build_sd_card<'a>(
        spi1: Peri<'a, SPI1>,
        sck: SeedPin8<'a>,
        mosi: SeedPin10<'a>,
        miso: SeedPin9<'a>,
        cs: SeedPin7<'a>,
    ) -> SdCard<SdSpi<'a>, Delay> {
        let mut spi_config = SpiConfig::default();
        spi_config.frequency = Hertz(INIT_HZ);

        let spi = Spi::new_blocking(spi1, sck, mosi, miso, spi_config);
        let cs = Output::new(cs, Level::High, Speed::Low);
        let spi_device = ExclusiveDevice::new(spi, cs, Delay).unwrap();

        SdCard::new(spi_device, Delay)
    }

    /// Bump the SD SPI clock to streaming speed. Call only after the card has
    /// been acquired at `INIT_HZ`; only the bus baud rate changes.
    pub fn set_fast(sdcard: &SdCard<SdSpi<'_>, Delay>) {
        let mut cfg = SpiConfig::default();
        cfg.frequency = Hertz(FAST_HZ);
        sdcard.spi(|dev| {
            let _ = dev.bus_mut().set_config(&cfg);
        });
    }
}

#[cfg(feature = "sd-spi")]
pub use spi_backend::{build_sd_card, set_fast};

// ============================================================================
// SDMMC backend (`sd-sdmmc`)
// ============================================================================
#[cfg(feature = "sd-sdmmc")]
mod sdmmc_backend {
    use core::cell::RefCell;
    use core::mem::MaybeUninit;

    #[cfg(not(feature = "debug-uart"))]
    use daisy_embassy::pins::{SeedPin1, SeedPin2, SeedPin3};
    use daisy_embassy::pins::{SeedPin4, SeedPin5, SeedPin6};
    use embassy_futures::block_on;
    use embassy_stm32::Peri;
    use embassy_stm32::peripherals::SDMMC1;
    use embassy_stm32::sdmmc::sd::{Addressable, Card, CmdBlock, DataBlock, StorageDevice};
    use embassy_stm32::sdmmc::{Config as SdmmcConfig, Error as SdmmcRawError, InterruptHandler, Sdmmc};
    use embassy_stm32::time::Hertz;
    use embedded_sdmmc::{Block, BlockCount, BlockDevice, BlockIdx};

    embassy_stm32::bind_interrupts!(struct Irqs {
        SDMMC1 => InterruptHandler<SDMMC1>;
    });

    /// SDMMC operating clock (embassy does the ≤400 kHz init internally, then
    /// ramps to this for the data phase). 25 MHz = SD default-speed.
    const FREQ_HZ: u32 = 25_000_000;

    // ── SDMMC IDMA scratch buffers, in AXI SRAM (D1, cache-managed) ─────────
    // ROOT CAUSE (2026-06-09): the STM32H7 SDMMC IDMA cannot reach DTCM, and
    // this firmware aliases the default RAM region (stack + .bss/.data) to
    // DTCMRAM (memory.x `REGION_ALIAS(RAM, DTCMRAM)`). A `CmdBlock`/`DataBlock`
    // on the stack is thus invisible to the IDMA: the data-path state machine
    // stalls forever draining to it (no DATAEND, no timeout). Tiny reads
    // (8-byte SCR) sneak through the FIFO; the first ≥FIFO read (64-byte ACMD13
    // SD-status, then every 512-byte block) hangs. Confirmed on a Daisy Pod:
    // a DTCM buffer hangs; an AXI-SRAM buffer acquires. (D2 SRAM `.sram1_bss`
    // is non-cacheable but NOT reachable cross-domain by SDMMC1's D1 IDMA.)
    //
    // So the buffers live in AXI SRAM (D1, `.axisram_bss`, same domain as the
    // heap) — IDMA-reachable. AXI SRAM is cacheable, so we do explicit cache
    // maintenance around the transfers: invalidate after a read (drop stale
    // lines before the CPU copies out), clean before a write (flush CPU writes
    // so the IDMA sees them). Buffers are 32-byte aligned (one Cortex-M7 cache
    // line) and 32-byte-multiple sized so the by-address ops don't touch
    // neighbours. embedded-sdmmc's `Block`s stay in DTCM (CPU-only).
    //
    // SAFETY: all SDMMC operations run sequentially on the thread executor
    // (one-shot acquire, then the single reader task). The audio executor never
    // touches SD; these statics are never accessed concurrently or re-entrantly
    // (the `RefCell` in `SdmmcBlock` guards the driver).
    #[repr(align(32))]
    struct Aligned32<T>(MaybeUninit<T>);

    #[unsafe(link_section = ".axisram_bss")]
    static mut DMA_CMD: Aligned32<CmdBlock> = Aligned32(MaybeUninit::uninit());
    #[unsafe(link_section = ".axisram_bss")]
    static mut DMA_DATA: Aligned32<DataBlock> = Aligned32(MaybeUninit::uninit());

    /// `&mut` to the AXI-SRAM `CmdBlock` scratch. Invalidated (not zeroed): we
    /// must NOT leave dirty cache lines, or their writeback would clobber the
    /// IDMA's SRAM write during acquire; invalidating also makes embassy's
    /// post-IDMA CPU read miss → fetch fresh (correct SCR → correct bus width).
    /// SAFETY: any bit pattern is valid for `[u32; 16]`; the IDMA fills it before
    /// any meaningful read, and SDMMC ops are serialized (see module note).
    fn dma_cmd() -> &'static mut CmdBlock {
        let p = unsafe { (*(&raw mut DMA_CMD)).0.assume_init_mut() };
        dcache_invalidate(p as *const CmdBlock as *const u8, core::mem::size_of::<CmdBlock>());
        p
    }
    /// `&mut` to the AXI-SRAM `DataBlock` scratch (512 B IDMA buffer). Not zeroed
    /// (would dirty the cache); read/write do their own cache maintenance.
    fn dma_data() -> &'static mut DataBlock {
        unsafe { (*(&raw mut DMA_DATA)).0.assume_init_mut() }
    }

    /// Drop any cached lines for `[ptr, ptr+len)` so the CPU re-reads what the
    /// IDMA just wrote to SRAM. `ptr`/`len` must be 32-byte aligned/multiples.
    fn dcache_invalidate(ptr: *const u8, len: usize) {
        let mut scb = unsafe { cortex_m::Peripherals::steal().SCB };
        unsafe { scb.invalidate_dcache_by_address(ptr as usize, len) };
    }
    /// Flush CPU writes in `[ptr, ptr+len)` out to SRAM so the IDMA reads them.
    fn dcache_clean(ptr: *const u8, len: usize) {
        let mut scb = unsafe { cortex_m::Peripherals::steal().SCB };
        scb.clean_dcache_by_address(ptr as usize, len);
    }

    /// `embedded_sdmmc::BlockDevice::Error` must be `Debug`; wrap embassy's.
    #[derive(Debug)]
    pub struct SdmmcError(pub SdmmcRawError);

    // Forward defmt formatting to the inner embassy error so the variant
    // (NoCard / Timeout / Crc / …) prints over RTT.
    impl defmt::Format for SdmmcError {
        fn format(&self, f: defmt::Formatter) {
            defmt::write!(f, "{}", self.0)
        }
    }

    /// Adapter: presents an async embassy `StorageDevice` as the *synchronous*
    /// `embedded_sdmmc::BlockDevice` via `block_on`. `RefCell` bridges the
    /// `&self` trait methods to the `&mut self` driver. Still blocks the
    /// executor on each read — the true async/DMA path is a separate task.
    pub struct SdmmcBlock<'a, 'b> {
        dev: RefCell<StorageDevice<'a, 'b, Card>>,
        blocks: u32,
    }

    impl SdmmcBlock<'_, '_> {
        pub fn num_bytes(&self) -> u64 {
            self.blocks as u64 * Block::LEN as u64
        }
    }

    impl BlockDevice for SdmmcBlock<'_, '_> {
        type Error = SdmmcError;

        fn read(&self, blocks: &mut [Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
            let mut dev = self.dev.borrow_mut();
            let db = dma_data(); // IDMA target — AXI SRAM (D1), cache-managed
            let addr = db as *const DataBlock as *const u8;
            for (i, blk) in blocks.iter_mut().enumerate() {
                block_on(dev.read_block(start_block_idx.0 + i as u32, &mut *db)).map_err(SdmmcError)?;
                // IDMA wrote the block to SRAM; drop stale cache lines first.
                dcache_invalidate(addr, core::mem::size_of::<DataBlock>());
                // DataBlock is [u32; 128]; SD byte stream is the LE bytes of each word.
                for (word, chunk) in db.0.iter().zip(blk.contents.chunks_exact_mut(4)) {
                    chunk.copy_from_slice(&word.to_le_bytes());
                }
            }
            Ok(())
        }

        fn write(&self, blocks: &[Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
            let mut dev = self.dev.borrow_mut();
            let db = dma_data(); // IDMA source — AXI SRAM (D1), cache-managed
            let addr = db as *const DataBlock as *const u8;
            for (i, blk) in blocks.iter().enumerate() {
                for (word, chunk) in db.0.iter_mut().zip(blk.contents.chunks_exact(4)) {
                    *word = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                }
                // Flush the CPU-written block to SRAM so the IDMA reads it.
                dcache_clean(addr, core::mem::size_of::<DataBlock>());
                block_on(dev.write_block(start_block_idx.0 + i as u32, &*db)).map_err(SdmmcError)?;
            }
            Ok(())
        }

        fn num_blocks(&self) -> Result<BlockCount, Self::Error> {
            Ok(BlockCount(self.blocks))
        }
    }

    /// Construct the SDMMC1 peripheral, 4-bit (debug-uart off). The returned
    /// `Sdmmc` must outlive everything built from it — `StorageDevice` borrows
    /// it mutably.
    #[cfg(not(feature = "debug-uart"))]
    pub fn build_sdmmc<'a>(
        sdmmc: Peri<'a, SDMMC1>,
        clk: SeedPin6<'a>,
        cmd: SeedPin5<'a>,
        d0: SeedPin4<'a>,
        d1: SeedPin3<'a>,
        d2: SeedPin2<'a>,
        d3: SeedPin1<'a>,
    ) -> Sdmmc<'a> {
        Sdmmc::new_4bit(sdmmc, Irqs, clk, cmd, d0, d1, d2, d3, SdmmcConfig::default())
    }

    /// Construct the SDMMC1 peripheral, 1-bit (debug-uart on — D2/PC10 is the
    /// debug-TX pin, so 4-bit is impossible).
    #[cfg(feature = "debug-uart")]
    pub fn build_sdmmc<'a>(
        sdmmc: Peri<'a, SDMMC1>,
        clk: SeedPin6<'a>,
        cmd: SeedPin5<'a>,
        d0: SeedPin4<'a>,
    ) -> Sdmmc<'a> {
        Sdmmc::new_1bit(sdmmc, Irqs, clk, cmd, d0, SdmmcConfig::default())
    }

    /// Acquire the card and wrap it as a `BlockDevice`. Unlike the SPI path,
    /// no external retry loop: `new_sd_card`'s internal CMD0/ACMD41 handshake
    /// already polls until the card is ready, so it absorbs normal power-up
    /// settling. (The SPI backend's retry dance was for the marginal hand-wired
    /// breakout, not card settling — a proper SDMMC socket doesn't need it.)
    /// Borrows the peripheral for the lifetime of the returned adapter.
    pub async fn acquire_sdmmc<'a, 'b>(
        sdmmc: &'a mut Sdmmc<'b>,
    ) -> Result<SdmmcBlock<'a, 'b>, SdmmcError> {
        let cmd_block = dma_cmd(); // IDMA scratch — must be in D2 SRAM, not DTCM
        let dev = StorageDevice::new_sd_card(sdmmc, cmd_block, Hertz(FREQ_HZ))
            .await
            .map_err(SdmmcError)?;
        let blocks = (dev.card().size() / Block::LEN as u64) as u32;
        Ok(SdmmcBlock {
            dev: RefCell::new(dev),
            blocks,
        })
    }
}

#[cfg(feature = "sd-sdmmc")]
pub use sdmmc_backend::{acquire_sdmmc, build_sdmmc};

// ============================================================================
// Common
// ============================================================================

/// Stub `TimeSource`. embedded-sdmmc uses this to stamp FAT directory entries
/// on writes; reads don't need it. Wire in real wall-clock awareness (MIDI
/// timecode / USB SOF) here when we start writing.
pub struct ZeroTime;

impl TimeSource for ZeroTime {
    fn get_timestamp(&self) -> Timestamp {
        Timestamp {
            year_since_1970: 0,
            zero_indexed_month: 0,
            zero_indexed_day: 0,
            hours: 0,
            minutes: 0,
            seconds: 0,
        }
    }
}
