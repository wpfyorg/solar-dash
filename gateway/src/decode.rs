//! Decoder for the 7f data frames a WAAREE (FoxESS) string-inverter stick
//! sends: a 5-minute inverter record.
//!
//! Outer 7f payload (186 bytes): ts (u32 BE) | 8 zero bytes | 0xad | inner
//! frame `7e 7e 02 ts[0..3] ts[3] 00 a0 <160-byte body> crc16 e7 e7`.
//! The body is 80 big-endian u16 words. Word map below; see `Record` for the
//! confidence of each field.

use crate::protocol::parse_frame;
use serde::Serialize;

pub const BODY_LEN: usize = 160;

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    Length(usize),
    Layout,
    InnerCrc,
    TsMismatch,
}

/// One inverter sample. `ts` is the stick's own clock exactly as sent (a
/// 32-bit second count); how it maps to wall-clock time is resolved by the
/// Worker (see STICK_CLOCK_OFFSET_MIN there).
///
/// Confidence: ac_w, grid_v, ac_a, hz, pv_v, pv_a, life_wh, day_wh are
/// confirmed against the day shape (night 0, midday peak, monotonic lifetime
/// counter, v*i ~ p). temps and state are plausible but need a reading from
/// the inverter display; `unk75` is unidentified.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    pub ts: u32,
    pub ac_w: u16,
    pub grid_v: f64,
    pub ac_a: f64,
    pub hz: f64,
    pub pv_v: f64,
    pub pv_a: f64,
    pub temp_a: u16,
    pub temp_b: u16,
    pub temp_c: u16,
    pub day_wh: u32,
    pub life_wh: u32,
    pub state: u16,
    pub flags: u16,
    pub unk75: u16,
}

fn w(body: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([body[2 * i], body[2 * i + 1]])
}

pub fn decode_payload(p: &[u8]) -> Result<Record, DecodeError> {
    if p.len() != 186 {
        return Err(DecodeError::Length(p.len()));
    }
    if p[12] != 0xad || p[4..12] != [0u8; 8] {
        return Err(DecodeError::Layout);
    }
    let ts = u32::from_be_bytes([p[0], p[1], p[2], p[3]]);
    let inner = parse_frame(&p[13..]).ok_or(DecodeError::Layout)?;
    if inner.start != [0x7e, 0x7e] || inner.payload.len() != BODY_LEN || p[p.len() - 2..] != [0xe7, 0xe7] {
        return Err(DecodeError::Layout);
    }
    // parse_frame checked the inner CRC into valid_crc; also pin the ts echo.
    if !inner.valid_crc {
        return Err(DecodeError::InnerCrc);
    }
    if inner.device[0] != 2 || inner.device[1..] != p[0..3] || inner.func != p[3] {
        return Err(DecodeError::TsMismatch);
    }
    let b = &inner.payload;
    Ok(Record {
        ts,
        ac_w: w(b, 1),
        grid_v: w(b, 3) as f64 / 10.0,
        ac_a: w(b, 4) as f64 / 10.0,
        hz: w(b, 5) as f64 / 100.0,
        pv_v: w(b, 15) as f64 / 10.0,
        pv_a: w(b, 16) as f64 / 10.0,
        temp_a: w(b, 27),
        temp_b: w(b, 28),
        temp_c: w(b, 29),
        day_wh: w(b, 30) as u32 * 100,
        life_wh: w(b, 32) as u32 * 100,
        state: w(b, 74),
        flags: w(b, 58),
        unk75: w(b, 75),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<(Vec<u8>, Record)> {
        include_str!("../tests/records.hex")
            .lines()
            .map(|l| {
                let p: Vec<u8> = (0..l.len() / 2).map(|i| u8::from_str_radix(&l[2 * i..2 * i + 2], 16).unwrap()).collect();
                let r = decode_payload(&p).expect("fixture decodes");
                (p, r)
            })
            .collect()
    }

    #[test]
    fn first_record() {
        let (_, r) = &fixture()[0];
        assert_eq!(r.ts, 0x6a5de65b);
        assert_eq!((r.ac_w, r.grid_v, r.pv_v, r.life_wh, r.state), (103, 230.1, 248.7, 582_700, 2));
        assert!((r.hz - 49.99).abs() < 1e-4);
    }

    #[test]
    fn rejects_damage() {
        let (mut p, _) = fixture().remove(0);
        assert_eq!(decode_payload(&p[..100]), Err(DecodeError::Length(100)));
        p[40] ^= 1;
        assert_eq!(decode_payload(&p), Err(DecodeError::InnerCrc));
        let (mut p, _) = fixture().remove(0);
        p[12] = 0;
        assert_eq!(decode_payload(&p), Err(DecodeError::Layout));
        let (mut p, _) = fixture().remove(0);
        p[3] ^= 1;
        assert_eq!(decode_payload(&p), Err(DecodeError::TsMismatch));
    }

    #[test]
    fn whole_backlog_is_plausible() {
        let recs: Vec<Record> = fixture().into_iter().map(|(_, r)| r).collect();
        assert!(recs.len() > 100);
        // Records come in stick order: ts and lifetime counter never go backwards.
        for pair in recs.windows(2) {
            assert!(pair[1].ts > pair[0].ts);
            assert!(pair[1].life_wh >= pair[0].life_wh, "lifetime fell at ts {}", pair[1].ts);
        }
        for r in &recs {
            assert!((0.0..=300.0).contains(&r.grid_v), "grid {}", r.grid_v);
            assert!(r.ac_w <= 3500, "power {}", r.ac_w);
            assert!(r.hz == 0.0 || (49.0..=51.0).contains(&r.hz), "hz {}", r.hz);
        }
        // V*I tracks AC power once the load is real (0.1 A is coarse at low
        // power; the odd sample is instantaneous vs averaged).
        let loaded: Vec<_> = recs.iter().filter(|r| r.ac_w > 800).collect();
        let off = loaded.iter().filter(|r| (r.grid_v * r.ac_a - r.ac_w as f64).abs() / r.ac_w as f64 > 0.1).count();
        assert!(loaded.len() > 30 && off * 20 <= loaded.len(), "{off} of {} off", loaded.len());
        // Over the pairs close enough together to integrate, the lifetime
        // counter agrees with integrating AC power.
        let (mut e, mut life) = (0.0, 0.0);
        for pair in recs.windows(2) {
            let dt = (pair[1].ts - pair[0].ts) as f64;
            if dt <= 1500.0 {
                e += (pair[0].ac_w as f64 + pair[1].ac_w as f64) / 2.0 * dt / 3600.0;
                life += (pair[1].life_wh - pair[0].life_wh) as f64;
            }
        }
        assert!(life > 10_000.0 && (e - life).abs() / life < 0.15, "integrated {e} Wh vs counter {life} Wh");
    }
}
