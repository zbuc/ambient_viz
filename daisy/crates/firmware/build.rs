use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let out = &PathBuf::from(env::var_os("OUT_DIR").unwrap());

    // Pick the linker memory layout: QSPI XIP (app at 0x90040000, run via the
    // Daisy bootloader) when the `qspi` feature is on, else internal flash.
    let memory_x: &[u8] = if env::var_os("CARGO_FEATURE_QSPI").is_some() {
        include_bytes!("memory-qspi.x")
    } else {
        include_bytes!("memory.x")
    };
    File::create(out.join("memory.x"))
        .unwrap()
        .write_all(memory_x)
        .unwrap();

    // ITCM ram-function section (INSERT AFTER .data). Always emitted; empty and
    // harmless unless a function is tagged `link_section = ".itcm"`. Added to the
    // link with `-Titcm.x` (see .cargo/config.toml rustflags).
    File::create(out.join("itcm.x"))
        .unwrap()
        .write_all(include_bytes!("itcm.x"))
        .unwrap();

    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rerun-if-changed=memory-qspi.x");
    println!("cargo:rerun-if-changed=itcm.x");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_QSPI");
}
