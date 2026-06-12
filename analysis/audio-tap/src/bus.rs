//! bus.v1 packet types + the /bus/publish client.
//!
//! These are serde mirrors of proto/bus.proto's SignalPacket in its
//! proto-JSON rendering — the wire the phase-8A ingress accepts (the same
//! bytes the browser TapPublisher sends). prost/pbjson codegen over the
//! shared proto/ replaces these mirrors when the schema surface grows
//! beyond STATE-with-number; the wire-compat test below pins the shape
//! against a packet captured from the browser publisher in the meantime.

use serde::{Deserialize, Serialize};

pub const SCHEMA: &str = "bus.v1";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub source_id: String,
    pub seq: u64,
    pub boot_epoch: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Monotonic {
    pub device: String,
    pub nanos: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Time {
    pub monotonic: Monotonic,
}

/// The Value oneof, externally tagged: `{"number": 0.5}` on the wire.
/// The tap publishes numbers; the other arms exist so a captured packet
/// of any value kind round-trips.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Value {
    Number(f64),
    Integer(i64),
    Boolean(bool),
    Text(String),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct State {
    pub path: String,
    pub value: Value,
}

/// EVENT body — append-only fires (onsets). No dedupe_key: the bus
/// defaults to source#epoch#seq, which is exactly one-fire-one-packet.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Event {
    pub path: String,
    pub payload: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Packet {
    pub schema: String,
    pub source: Source,
    pub time: Time,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<State>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<Event>,
}

/// What a post attempt resolved to — the three cases the publisher's
/// failure posture distinguishes (matches the browser publisher).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PostResult {
    /// 2xx — accepted (per-packet rejects are the bridge's business; they
    /// land in the capture + inspector, not in this transport result).
    Ok,
    /// 403 — this host may not publish; the tap disables itself for good.
    Forbidden,
    /// Anything else (bridge down, 5xx, timeout) — back off and retry.
    Error,
}

pub struct BusClient {
    url: String,
    agent: ureq::Agent,
}

impl BusClient {
    pub fn new(base: &str) -> Self {
        BusClient {
            url: format!("{}/bus/publish", base.trim_end_matches('/')),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_millis(1000))
                .build(),
        }
    }

    pub fn publish(&self, packets: &[Packet]) -> PostResult {
        match self.agent.post(&self.url).send_json(packets) {
            Ok(_) => PostResult::Ok,
            Err(ureq::Error::Status(403, _)) => PostResult::Forbidden,
            Err(_) => PostResult::Error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A packet as the BROWSER publisher emits it (captured from the 8A
    // soak fixture, bus_rx). Deserialize -> serialize must reproduce the
    // same JSON value — the two publishers speak one wire.
    const BROWSER_PACKET: &str = r#"{
        "schema": "bus.v1",
        "source": { "sourceId": "spiffe://pain-material.local/browser/audio-tap", "seq": 1, "bootEpoch": 101 },
        "time": { "monotonic": { "device": "browser", "nanos": 1000000000 } },
        "priority": 300,
        "state": { "path": "audio.main.bass", "value": { "number": 0.5 } }
    }"#;

    #[test]
    fn wire_compat_round_trip() {
        let pkt: Packet = serde_json::from_str(BROWSER_PACKET).unwrap();
        assert_eq!(pkt.schema, SCHEMA);
        assert_eq!(pkt.source.boot_epoch, 101);
        assert_eq!(pkt.state.as_ref().unwrap().value, Value::Number(0.5));
        assert!(pkt.event.is_none());
        let reserialized: serde_json::Value =
            serde_json::to_value(&pkt).unwrap();
        let original: serde_json::Value =
            serde_json::from_str(BROWSER_PACKET).unwrap();
        assert_eq!(reserialized, original);
    }

    #[test]
    fn event_packet_serializes_with_event_arm_only() {
        let pkt = Packet {
            schema: SCHEMA.to_string(),
            source: Source {
                source_id: "s".into(),
                seq: 7,
                boot_epoch: 1,
            },
            time: Time {
                monotonic: Monotonic { device: "analysis".into(), nanos: 1 },
            },
            priority: 250,
            state: None,
            event: Some(Event {
                path: "audio.main.kick_onset".into(),
                payload: Value::Number(0.4),
            }),
        };
        let j = serde_json::to_value(&pkt).unwrap();
        assert!(j.get("state").is_none());
        assert_eq!(j["event"]["payload"]["number"], 0.4);
    }

    #[test]
    fn value_oneof_is_externally_tagged() {
        assert_eq!(
            serde_json::to_string(&Value::Number(0.25)).unwrap(),
            r#"{"number":0.25}"#
        );
        assert_eq!(
            serde_json::to_string(&Value::Boolean(true)).unwrap(),
            r#"{"boolean":true}"#
        );
    }
}
