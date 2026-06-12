//! TapPublisher — the writer-discipline core, a port of the browser
//! publisher (static/audio-tap.js): control-rate decimation of the
//! analysis loop, quantized change-dedupe, the keepalive obligation
//! inside the declared stale window, a file-persisted boot epoch, and the
//! 403-disable / backoff failure posture. One contract, two
//! implementations — the JS tests (server/test/audio-tap.test.js) and
//! the tests below pin the same behaviors, and tools/sim/
//! validate-audiotap.js judges both writers' captures by the same lanes.

use std::collections::HashMap;
use std::path::Path;

use crate::bus::{Monotonic, Packet, PostResult, Source, State, Time, Value, SCHEMA};

pub const SOURCE_ID: &str = "spiffe://pain-material.local/analysis/audio-tap";

/// field paths under the tap instance (manifest of record:
/// projects/pain-material/manifest/modules/audio-tap-sidecar.json).
/// v0 publishes LEVEL only; the rest go live with the stage-1 surfaces.
#[allow(dead_code)]
pub mod paths {
    pub const BASS: &str = "audio.main.bass";
    pub const MID: &str = "audio.main.mid";
    pub const TREBLE: &str = "audio.main.treble";
    pub const LEVEL: &str = "audio.main.level";
    pub const BASS_FAST: &str = "audio.main.bass_fast";
}

/// Boot epoch (BUS_PROTOCOL.md ordering key): a file-persisted counter —
/// the bridge's own mechanism — seeded from wall-clock seconds when the
/// file is missing, so the value stays monotonic across state loss as
/// long as a second has passed.
pub fn next_boot_epoch(file: &Path, now_sec: u64) -> u32 {
    let prev = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok());
    let n = match prev {
        Some(p) => (p + 1).max(1),
        None => now_sec.max(1),
    } as u32;
    let _ = std::fs::write(file, n.to_string()); // best effort, like the bridge
    n
}

pub struct Config {
    pub source_id: String,
    pub device: String,
    pub priority: i64,
    pub period_ms: f64,
    pub keepalive_ms: f64,
    pub error_backoff_ms: f64,
    pub quant: f64,
    pub boot_epoch: u32,
}

impl Config {
    /// Defaults mirror the browser publisher; priority defaults to the
    /// SHADOW rung (250 < the browser tap's 300) per the migration plan.
    pub fn shadow(boot_epoch: u32) -> Self {
        Config {
            source_id: SOURCE_ID.to_string(),
            device: "analysis".to_string(),
            priority: 250,
            period_ms: 50.0,
            keepalive_ms: 450.0,
            error_backoff_ms: 2000.0,
            quant: 1000.0,
            boot_epoch,
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct Counters {
    pub posts: u64,
    pub errors: u64,
    pub packets: u64,
    pub disabled: bool,
}

pub struct TapPublisher {
    cfg: Config,
    seq: u64,
    disabled: bool,
    last_tick_at: f64,
    blocked_until: f64,
    counters: Counters,
    last_sent: HashMap<&'static str, f64>,
    last_sent_at: HashMap<&'static str, f64>,
}

impl TapPublisher {
    pub fn new(cfg: Config) -> Self {
        TapPublisher {
            cfg,
            seq: 0,
            disabled: false,
            last_tick_at: f64::NEG_INFINITY,
            blocked_until: f64::NEG_INFINITY,
            counters: Counters::default(),
            last_sent: HashMap::new(),
            last_sent_at: HashMap::new(),
        }
    }

    /// One analysis-loop tick: `values` are (path, raw value) pairs;
    /// decimation/dedupe/keepalive decide what actually posts. `post` is
    /// injectable (the BusClient live, a closure in tests).
    pub fn frame(
        &mut self,
        values: &[(&'static str, f64)],
        at_ms: f64,
        post: &mut dyn FnMut(&[Packet]) -> PostResult,
    ) {
        if self.disabled || !at_ms.is_finite() {
            return;
        }
        if at_ms - self.last_tick_at < self.cfg.period_ms || at_ms < self.blocked_until {
            return;
        }
        self.last_tick_at = at_ms;

        let mut packets = Vec::new();
        for &(path, raw) in values {
            if !raw.is_finite() {
                continue; // rule-13: never publish non-finite
            }
            let v = (raw.clamp(0.0, 1.0) * self.cfg.quant).round() / self.cfg.quant;
            let changed = self.last_sent.get(path) != Some(&v);
            let due = match self.last_sent_at.get(path) {
                Some(&t) => at_ms - t >= self.cfg.keepalive_ms,
                None => true,
            };
            if !changed && !due {
                continue;
            }
            self.seq += 1;
            packets.push(Packet {
                schema: SCHEMA.to_string(),
                source: Source {
                    source_id: self.cfg.source_id.clone(),
                    seq: self.seq,
                    boot_epoch: self.cfg.boot_epoch,
                },
                time: Time {
                    monotonic: Monotonic {
                        device: self.cfg.device.clone(),
                        nanos: (at_ms * 1e6).round() as u64,
                    },
                },
                priority: self.cfg.priority,
                state: State {
                    path: path.to_string(),
                    value: Value::Number(v),
                },
            });
            self.last_sent.insert(path, v);
            self.last_sent_at.insert(path, at_ms);
        }
        if packets.is_empty() {
            return;
        }

        self.counters.posts += 1;
        self.counters.packets += packets.len() as u64;
        match post(&packets) {
            PostResult::Ok => {}
            PostResult::Forbidden => {
                self.disabled = true;
                self.counters.disabled = true;
                eprintln!("audio-tap: /bus/publish refused (403) — tap disabled");
            }
            PostResult::Error => {
                self.counters.errors += 1;
                self.blocked_until = at_ms + self.cfg.error_backoff_ms;
            }
        }
    }

    pub fn counters(&self) -> &Counters {
        &self.counters
    }

    pub fn disabled(&self) -> bool {
        self.disabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pub_with(priority: i64) -> TapPublisher {
        let mut cfg = Config::shadow(101);
        cfg.priority = priority;
        TapPublisher::new(cfg)
    }

    fn collect() -> (
        std::rc::Rc<std::cell::RefCell<Vec<Vec<Packet>>>>,
        impl FnMut(&[Packet]) -> PostResult,
    ) {
        let posts = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let p2 = posts.clone();
        (posts, move |pkts: &[Packet]| {
            p2.borrow_mut().push(pkts.to_vec());
            PostResult::Ok
        })
    }

    const BANDS: &[(&str, f64)] = &[
        (paths::BASS, 0.5),
        (paths::MID, 0.25),
        (paths::LEVEL, 0.75),
    ];

    #[test]
    fn first_frame_posts_one_packet_per_field_well_formed() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        p.frame(BANDS, 1000.0, &mut sink);
        let posts = posts.borrow();
        assert_eq!(posts.len(), 1);
        let pkts = &posts[0];
        assert_eq!(pkts.len(), 3);
        for pkt in pkts {
            assert_eq!(pkt.schema, SCHEMA);
            assert_eq!(pkt.source.source_id, SOURCE_ID);
            assert_eq!(pkt.source.boot_epoch, 101);
            assert_eq!(pkt.priority, 250);
        }
        // seq strictly increasing across the batch (one per-source counter)
        let seqs: Vec<u64> = pkts.iter().map(|p| p.source.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(seqs, sorted);
    }

    #[test]
    fn decimates_to_period() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        let mut t = 1000.0;
        let mut x = 0.0;
        while t < 1200.0 {
            x += 0.01; // always-changing value
            p.frame(&[(paths::BASS, x)], t, &mut sink);
            t += 16.0;
        }
        assert!(posts.borrow().len() <= 5, "got {}", posts.borrow().len());
    }

    #[test]
    fn dedupes_then_keepalives_inside_stale_window() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        p.frame(BANDS, 1000.0, &mut sink);
        let mut t = 1050.0;
        while t <= 1400.0 {
            p.frame(BANDS, t, &mut sink); // unchanged: no traffic
            t += 50.0;
        }
        assert_eq!(posts.borrow().len(), 1);
        p.frame(BANDS, 1450.0, &mut sink); // 450 ms since last send
        assert_eq!(posts.borrow().len(), 2);
        assert_eq!(posts.borrow()[1].len(), 3);
    }

    #[test]
    fn sub_quantum_wiggle_does_not_defeat_dedupe() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        p.frame(&[(paths::BASS, 0.5)], 1000.0, &mut sink);
        p.frame(&[(paths::BASS, 0.5002)], 1050.0, &mut sink); // rounds to 0.5
        assert_eq!(posts.borrow().len(), 1);
        p.frame(&[(paths::BASS, 0.502)], 1100.0, &mut sink);
        assert_eq!(posts.borrow().len(), 2);
    }

    #[test]
    fn non_finite_skipped_out_of_range_clamped() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        p.frame(
            &[(paths::BASS, f64::NAN), (paths::LEVEL, 1.7)],
            1000.0,
            &mut sink,
        );
        let posts = posts.borrow();
        assert_eq!(posts[0].len(), 1);
        assert_eq!(posts[0][0].state.path, paths::LEVEL);
        assert_eq!(posts[0][0].state.value, Value::Number(1.0));
    }

    #[test]
    fn forbidden_disables_for_good() {
        let mut p = pub_with(250);
        let mut sink = |_: &[Packet]| PostResult::Forbidden;
        p.frame(BANDS, 1000.0, &mut sink);
        assert!(p.disabled());
        let (posts, mut ok_sink) = collect();
        p.frame(&[(paths::BASS, 0.9)], 1100.0, &mut ok_sink);
        assert_eq!(posts.borrow().len(), 0);
    }

    #[test]
    fn transient_error_backs_off_then_resumes() {
        let mut p = pub_with(250);
        let mut fail = |_: &[Packet]| PostResult::Error;
        p.frame(BANDS, 1000.0, &mut fail);
        assert_eq!(p.counters().errors, 1);
        let (posts, mut ok_sink) = collect();
        p.frame(&[(paths::BASS, 0.9)], 1500.0, &mut ok_sink); // inside backoff
        assert_eq!(posts.borrow().len(), 0);
        p.frame(&[(paths::BASS, 0.9)], 3100.0, &mut ok_sink); // past backoff
        assert_eq!(posts.borrow().len(), 1);
        assert!(!p.disabled());
    }

    #[test]
    fn epoch_increments_persisted_counter_seeds_from_time() {
        let dir = std::env::temp_dir().join(format!("audiotap-epoch-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        assert_eq!(next_boot_epoch(&dir, 1234567), 1234567); // empty -> time seed
        assert_eq!(next_boot_epoch(&dir, 1234567), 1234568); // then counter
        assert_eq!(next_boot_epoch(&dir, 5), 1234569);
        let _ = std::fs::remove_file(&dir);
    }
}
