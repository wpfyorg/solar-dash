//! Holds decoded records between the socket and the Worker push.
//!
//! Records arrive in stick time. They wait in `pending` until the session's
//! clock bracket is tight enough to convert them to real time, then move to
//! `ready` (keyed by real unix time, deduped within +-60 s since a resend maps
//! to the same instant give or take clock jitter) until a push succeeds.

use crate::clock::ClockSync;
use crate::decode::Record;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

const DEDUPE_S: u32 = 60;
const KNOWN_CAP: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Out {
    /// Real unix time (stick time mapped through the clock bracket).
    pub t: u32,
    #[serde(flatten)]
    pub rec: Record,
}

#[derive(Default)]
pub struct Sink {
    pending: Vec<Record>,
    ready: BTreeMap<u32, Out>,
    known: BTreeSet<u32>,
    pub dups: u64,
}

impl Sink {
    pub fn add(&mut self, r: Record) {
        self.pending.push(r);
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn ready_len(&self) -> usize {
        self.ready.len()
    }

    /// Converts pending records with `clock` when its bracket is at most
    /// `max_width` seconds (or `force`). Returns how many were new.
    pub fn convert(&mut self, clock: &ClockSync, max_width: f64, force: bool) -> usize {
        if clock.skew().is_none() || (clock.width() > max_width && !force) {
            return 0;
        }
        let mut new = 0;
        for rec in std::mem::take(&mut self.pending) {
            let t = clock.to_real(rec.ts).expect("skew checked");
            if self.known.range(t.saturating_sub(DEDUPE_S)..=t + DEDUPE_S).next().is_some() {
                self.dups += 1;
                continue;
            }
            self.known.insert(t);
            self.ready.insert(t, Out { t, rec });
            new += 1;
        }
        while self.known.len() > KNOWN_CAP {
            let first = *self.known.iter().next().unwrap();
            self.known.remove(&first);
        }
        new
    }

    pub fn batch(&self, n: usize) -> Vec<Out> {
        self.ready.values().take(n).cloned().collect()
    }

    pub fn done(&mut self, sent: &[Out]) {
        for o in sent {
            self.ready.remove(&o.t);
        }
    }

    /// Memory guard if the Worker stays unreachable for days.
    pub fn trim_ready(&mut self, cap: usize) {
        while self.ready.len() > cap {
            let first = *self.ready.keys().next().unwrap();
            self.ready.remove(&first);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ts: u32) -> Record {
        Record {
            ts, ac_w: 100, grid_v: 230.0, ac_a: 0.5, hz: 50.0, pv_v: 250.0, pv_a: 0.5, temp_a: 30,
            temp_b: 30, temp_c: 39, day_wh: 0, life_wh: 1000, state: 2, flags: 0, unk75: 429,
        }
    }

    fn clock(skew: f64) -> ClockSync {
        let mut c = ClockSync::default();
        // Observe just before and just after the stick's 256 s counter ticks.
        let stick = (((2_000_000_000.0 - skew) / 256.0).floor() * 256.0) + 255.5;
        for dt in [0.0, 1.0] {
            c.observe(stick + dt + skew, ((stick + dt) / 256.0).floor() as u32);
        }
        c
    }

    #[test]
    fn waits_for_a_tight_clock_then_dedupes_resends() {
        let mut s = Sink::default();
        let loose = ClockSync::default();
        s.add(rec(1_000));
        assert_eq!(s.convert(&loose, 90.0, false), 0);
        let c = clock(500_000_000.3);
        s.add(rec(1_000)); // resend within the session
        s.add(rec(1_305));
        assert_eq!(s.convert(&c, 90.0, false), 2);
        assert_eq!(s.dups, 1);
        assert_eq!(s.ready_len(), 2);
        // Reconnect maps the same stick record to ~the same instant: still a dup.
        s.add(rec(1_000));
        assert_eq!(s.convert(&clock(500_000_000.9), 90.0, false), 0);
        let b = s.batch(10);
        assert_eq!(b.len(), 2);
        assert!(b[0].t < b[1].t);
        s.done(&b);
        assert_eq!(s.ready_len(), 0);
        // Already-pushed records stay known, so a later replay is not re-queued.
        s.add(rec(1_305));
        assert_eq!(s.convert(&c, 90.0, false), 0);
    }

    #[test]
    fn json_shape() {
        let o = Out { t: 5, rec: rec(7) };
        let v: serde_json::Value = serde_json::to_value(&o).unwrap();
        assert_eq!(v["t"], 5);
        assert_eq!(v["ts"], 7);
        assert_eq!(v["ac_w"], 100);
    }
}
