//! ClockFeed — the sidecar's /bus/events consumer for the clock tuple.
//!
//! A background thread holds an SSE connection to the bridge and feeds
//! `clock.daisy.position` / `clock.daisy.rate` into the SongClock port —
//! the page's exact consumption pattern: anchor at local receipt time,
//! read state through ARBITRATION (`pkt.resolved` when present, the
//! retained value otherwise), auto-reconnect and let retained replay
//! restore state. The `file` source slaves decode position to this clock
//! so the sidecar analyzes the timeline the room hears.

use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::songclock::SongClock;

const POSITION_PATH: &str = "clock.daisy.position";
const RATE_PATH: &str = "clock.daisy.rate";

pub struct ClockFeed {
    clock: Arc<Mutex<SongClock>>,
    t0: Instant,
}

impl ClockFeed {
    pub fn start(base: &str) -> Self {
        let clock = Arc::new(Mutex::new(SongClock::default()));
        let t0 = Instant::now();
        let url = format!("{}/bus/events", base.trim_end_matches('/'));
        {
            let clock = clock.clone();
            std::thread::Builder::new()
                .name("clock-feed".into())
                .spawn(move || loop {
                    match ureq::get(&url).timeout(Duration::from_secs(86400)).call() {
                        Ok(resp) => {
                            let reader = BufReader::new(resp.into_reader());
                            let mut data = String::new();
                            for line in reader.lines() {
                                let Ok(line) = line else { break };
                                if let Some(rest) = line.strip_prefix("data: ") {
                                    data = rest.to_string();
                                } else if line.is_empty() && !data.is_empty() {
                                    let at_ms = t0.elapsed().as_secs_f64() * 1000.0;
                                    apply_frame(&data, at_ms, &clock);
                                    data.clear();
                                }
                            }
                        }
                        Err(_) => { /* bridge down — retry below */ }
                    }
                    std::thread::sleep(Duration::from_secs(1));
                })
                .expect("spawn clock-feed thread");
        }
        ClockFeed { clock, t0 }
    }

    /// Extrapolated song position (seconds); None before the first anchor.
    /// Stale clocks freeze (SongClock semantics) — the caller decides the
    /// stale fallback (file mode reverts to wall pacing).
    pub fn position(&self) -> Option<f64> {
        let at_ms = self.t0.elapsed().as_secs_f64() * 1000.0;
        self.clock.lock().unwrap().now(at_ms)
    }

    pub fn stale(&self) -> bool {
        let at_ms = self.t0.elapsed().as_secs_f64() * 1000.0;
        self.clock.lock().unwrap().stale(at_ms)
    }
}

/// One SSE data frame (a bus packetFrame or retained frame) into the
/// clock. Pure, so the parsing is testable without a socket. Mirrors the
/// page: value = resolved when present, else the state value.
pub fn apply_frame(data: &str, at_ms: f64, clock: &Mutex<SongClock>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    let Some(path) = v.pointer("/state/path").and_then(|p| p.as_str()) else {
        return;
    };
    if path != POSITION_PATH && path != RATE_PATH {
        return;
    }
    let val = v
        .get("resolved")
        .or_else(|| v.pointer("/state/value"))
        .and_then(from_value);
    let Some(val) = val else { return };
    let mut c = clock.lock().unwrap();
    if path == POSITION_PATH {
        c.on_position(val, at_ms);
    } else {
        c.on_rate(val);
    }
}

fn from_value(v: &serde_json::Value) -> Option<f64> {
    v.get("number")
        .or_else(|| v.get("integer"))
        .and_then(|n| n.as_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_and_rate_frames_drive_the_clock() {
        let clock = Mutex::new(SongClock::default());
        apply_frame(
            r#"{"schema":"bus.v1","state":{"path":"clock.daisy.position","value":{"number":12.5}},"resolved":{"number":12.5}}"#,
            1000.0,
            &clock,
        );
        apply_frame(
            r#"{"schema":"bus.v1","state":{"path":"clock.daisy.rate","value":{"number":1.01}}}"#,
            1000.0,
            &clock,
        );
        let c = clock.lock().unwrap();
        let pos = c.now(2000.0).unwrap();
        assert!((pos - (12.5 + 1.01)).abs() < 1e-12);
    }

    #[test]
    fn resolved_wins_over_packet_payload() {
        // A shadowed writer's keepalive must not flap the clock — read
        // through arbitration, the phase-2/4 rule.
        let clock = Mutex::new(SongClock::default());
        apply_frame(
            r#"{"state":{"path":"clock.daisy.position","value":{"number":99.0}},"resolved":{"number":12.5}}"#,
            0.0,
            &clock,
        );
        assert_eq!(clock.lock().unwrap().now(0.0), Some(12.5));
    }

    #[test]
    fn unrelated_and_malformed_frames_are_ignored() {
        let clock = Mutex::new(SongClock::default());
        apply_frame(r#"{"state":{"path":"sensor.door.distance_cm","value":{"number":80}}}"#, 0.0, &clock);
        apply_frame("not json", 0.0, &clock);
        apply_frame(r#"{"event":{"path":"audio.main.kick_onset"}}"#, 0.0, &clock);
        assert_eq!(clock.lock().unwrap().now(0.0), None);
    }

    #[test]
    fn integer_rendered_positions_parse() {
        // proto-JSON renders whole-number doubles as integer literals;
        // the bridge's toValue() picks {integer} for them.
        let clock = Mutex::new(SongClock::default());
        apply_frame(
            r#"{"state":{"path":"clock.daisy.position","value":{"integer":30}},"resolved":{"integer":30}}"#,
            0.0,
            &clock,
        );
        assert_eq!(clock.lock().unwrap().now(0.0), Some(30.0));
    }
}
