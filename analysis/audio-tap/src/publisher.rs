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

use crate::bus::{Event, Monotonic, Packet, PostResult, Source, State, Time, Value, SCHEMA};

pub const SOURCE_ID: &str = "spiffe://pain-material.local/analysis/audio-tap";

/// field paths under the tap instance (manifest of record:
/// projects/pain-material/manifest/modules/audio-tap-sidecar.json).
pub mod paths {
    // compat surface (browser-tap continuity, STATE)
    pub const BASS: &str = "audio.main.bass";
    pub const MID: &str = "audio.main.mid";
    pub const TREBLE: &str = "audio.main.treble";
    pub const LEVEL: &str = "audio.main.level";
    pub const BASS_FAST: &str = "audio.main.bass_fast";
    // slice aggregate (STATE; max since last publish — stage 2)
    pub const PEAK: &str = "audio.main.peak";
    // detector surface (sole writer, STATE)
    pub const KICK: &str = "audio.main.kick";
    pub const PAD: &str = "audio.main.pad";
    pub const LEAD: &str = "audio.main.lead";
    // onset surface (EVENT)
    pub const KICK_ONSET: &str = "audio.main.kick_onset";
}

/// Slice-aggregated paths (the time-slice lesson): a point sample at the
/// publish tick is blind to anything that rose and fell inside the gap,
/// so these publish the MAX seen since their last published packet —
/// every frame() call feeds the accumulator even when decimation drops
/// the frame.
fn is_aggregate_max(path: &str) -> bool {
    path == paths::PEAK
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
    slice_max: HashMap<&'static str, f64>, // path -> running max since last publish
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
            slice_max: HashMap::new(),
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
        // Aggregates accumulate on EVERY frame — before any decimation
        // gate — so values inside a dropped frame still reach the packet.
        for &(path, raw) in values {
            if is_aggregate_max(path) && raw.is_finite() {
                let c = raw.clamp(0.0, 1.0);
                let e = self.slice_max.entry(path).or_insert(c);
                if c > *e {
                    *e = c;
                }
            }
        }
        if at_ms - self.last_tick_at < self.cfg.period_ms || at_ms < self.blocked_until {
            return;
        }
        self.last_tick_at = at_ms;

        let mut packets = Vec::new();
        for &(path, point) in values {
            let raw = if is_aggregate_max(path) {
                match self.slice_max.get(path) {
                    Some(&m) => m,
                    None => point,
                }
            } else {
                point
            };
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
            let mut pkt = self.packet_shell(at_ms);
            pkt.state = Some(State {
                path: path.to_string(),
                value: Value::Number(v),
            });
            packets.push(pkt);
            self.last_sent.insert(path, v);
            self.last_sent_at.insert(path, at_ms);
            if is_aggregate_max(path) {
                self.slice_max.remove(path); // the slice restarts at publish
            }
        }
        if packets.is_empty() {
            return;
        }
        self.send(&packets, at_ms, post);
    }

    /// One discrete fire (onset EVENT): no decimation, no dedupe — an
    /// event is news by definition; rate is bounded upstream by the
    /// detector's cooldown. Shares the per-source seq with the states.
    pub fn event(
        &mut self,
        path: &'static str,
        strength: f64,
        at_ms: f64,
        post: &mut dyn FnMut(&[Packet]) -> PostResult,
    ) {
        if self.disabled || !at_ms.is_finite() || at_ms < self.blocked_until {
            return;
        }
        if !strength.is_finite() {
            return; // rule-13
        }
        let v = (strength.clamp(0.0, 1.0) * self.cfg.quant).round() / self.cfg.quant;
        self.seq += 1;
        let mut pkt = self.packet_shell(at_ms);
        pkt.event = Some(Event {
            path: path.to_string(),
            payload: Value::Number(v),
        });
        self.send(std::slice::from_ref(&pkt), at_ms, post);
    }

    fn packet_shell(&self, at_ms: f64) -> Packet {
        Packet {
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
            state: None,
            event: None,
        }
    }

    fn send(
        &mut self,
        packets: &[Packet],
        at_ms: f64,
        post: &mut dyn FnMut(&[Packet]) -> PostResult,
    ) {
        self.counters.posts += 1;
        self.counters.packets += packets.len() as u64;
        match post(packets) {
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
    fn aggregate_path_publishes_slice_max_and_resets_at_publish() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        // tick 1 at t=1000 publishes; frames at 1016/1032 are DECIMATED but
        // their peaks must reach the next packet.
        p.frame(&[(paths::PEAK, 0.2)], 1000.0, &mut sink);
        p.frame(&[(paths::PEAK, 0.9)], 1016.0, &mut sink); // decimated, hottest
        p.frame(&[(paths::PEAK, 0.3)], 1032.0, &mut sink); // decimated
        p.frame(&[(paths::PEAK, 0.1)], 1060.0, &mut sink); // tick 2
        let posts = posts.borrow();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0][0].state.as_ref().unwrap().value, Value::Number(0.2));
        assert_eq!(posts[1][0].state.as_ref().unwrap().value, Value::Number(0.9));
        drop(posts);
        // slice restarted at the 0.9 publish: next tick sees only what came after
        let (posts2, mut sink2) = collect();
        p.frame(&[(paths::PEAK, 0.15)], 1120.0, &mut sink2);
        assert_eq!(posts2.borrow()[0][0].state.as_ref().unwrap().value, Value::Number(0.15));
    }

    #[test]
    fn events_bypass_decimation_and_dedupe_share_the_seq() {
        let mut p = pub_with(250);
        let (posts, mut sink) = collect();
        p.frame(BANDS, 1000.0, &mut sink);
        // two fires inside one decimation period, identical strength
        p.event(paths::KICK_ONSET, 0.4, 1010.0, &mut sink);
        p.event(paths::KICK_ONSET, 0.4, 1020.0, &mut sink);
        let posts = posts.borrow();
        assert_eq!(posts.len(), 3);
        let e1 = &posts[1][0];
        let e2 = &posts[2][0];
        assert!(e1.state.is_none());
        assert_eq!(e1.event.as_ref().unwrap().path, paths::KICK_ONSET);
        assert_eq!(e1.event.as_ref().unwrap().payload, Value::Number(0.4));
        assert!(e2.source.seq > e1.source.seq);
        // and a state frame after the events keeps the shared counter monotonic
        let (posts2, mut sink2) = collect();
        p.frame(&[(paths::BASS, 0.9)], 1100.0, &mut sink2);
        assert!(posts2.borrow()[0][0].source.seq > e2.source.seq);
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
        let st = posts[0][0].state.as_ref().unwrap();
        assert_eq!(st.path, paths::LEVEL);
        assert_eq!(st.value, Value::Number(1.0));
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
