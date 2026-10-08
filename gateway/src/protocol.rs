//! FoxESS tcp/14431 framing, ported from foxess_local_gateway's protocol.py
//! (GPL-3.0). Only what the local cloud needs: frame extraction with CRC16,
//! registration, the 3-step bootstrap ACK.

pub fn crc16_le(data: &[u8]) -> [u8; 2] {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xA001 } else { crc >> 1 };
        }
    }
    crc.to_le_bytes()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub start: [u8; 2],
    pub device: [u8; 4],
    pub func: u8,
    pub payload: Vec<u8>,
    pub valid_crc: bool,
    pub raw: Vec<u8>,
}

impl Frame {
    pub fn is_7f(&self) -> bool {
        self.start == [0x7f, 0x7f]
    }
}

pub fn make_frame(start: [u8; 2], device: [u8; 4], func: u8, payload: &[u8], end: [u8; 2]) -> Vec<u8> {
    let mut body = Vec::with_capacity(7 + payload.len());
    body.extend_from_slice(&device);
    body.push(func);
    body.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    body.extend_from_slice(payload);
    let mut out = Vec::with_capacity(body.len() + 6);
    out.extend_from_slice(&start);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc16_le(&body));
    out.extend_from_slice(&end);
    out
}

/// Parses exactly one frame (`raw` is the whole frame, markers included).
pub fn parse_frame(raw: &[u8]) -> Option<Frame> {
    if raw.len() < 13 {
        return None;
    }
    let plen = u16::from_be_bytes([raw[7], raw[8]]) as usize;
    if raw.len() != 13 + plen {
        return None;
    }
    let body = &raw[2..9 + plen];
    let crc = &raw[9 + plen..11 + plen];
    Some(Frame {
        start: [raw[0], raw[1]],
        device: [raw[2], raw[3], raw[4], raw[5]],
        func: raw[6],
        payload: raw[9..9 + plen].to_vec(),
        valid_crc: crc == crc16_le(body),
        raw: raw.to_vec(),
    })
}

fn find_marker(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == [0x7e, 0x7e] || w == [0x7f, 0x7f])
}

/// Pulls every complete frame out of `buf`, leaving a partial tail in place.
/// Resynchronises on the next marker after garbage or a bad end marker.
pub fn extract_frames(buf: &mut Vec<u8>) -> Vec<Frame> {
    let mut frames = Vec::new();
    loop {
        match find_marker(buf) {
            None => {
                // Keep a trailing 7e/7f: its pair may arrive in the next read.
                let keep = matches!(buf.last(), Some(0x7e | 0x7f)) as usize;
                let drop = buf.len() - keep;
                buf.drain(..drop);
                return frames;
            }
            Some(i) if i > 0 => {
                buf.drain(..i);
            }
            Some(_) => {}
        }
        if buf.len() < 13 {
            return frames;
        }
        let end: [u8; 2] = if buf[0] == 0x7e { [0xe7, 0xe7] } else { [0xf7, 0xf7] };
        let total = 13 + u16::from_be_bytes([buf[7], buf[8]]) as usize;
        if total > 4096 {
            buf.drain(..2);
            continue;
        }
        if buf.len() < total {
            return frames;
        }
        let raw: Vec<u8> = buf.drain(..total).collect();
        if raw[total - 2..] != end {
            continue;
        }
        if let Some(f) = parse_frame(&raw) {
            frames.push(f);
        }
    }
}

/// Reply device: first byte given, tail = request tail - 0x71 (24-bit).
fn reply_device(req: &[u8; 4], first: u8) -> [u8; 4] {
    let tail = u32::from_be_bytes([0, req[1], req[2], req[3]]).wrapping_sub(0x71) & 0xFF_FFFF;
    let t = tail.to_be_bytes();
    [first, t[1], t[2], t[3]]
}

fn bootstrap_response(req: &Frame, func_offset: u8, payload: &[u8]) -> Vec<u8> {
    make_frame(
        [0x7e, 0x7e],
        reply_device(&req.device, req.device[0] | 0x80),
        req.func.wrapping_add(func_offset),
        payload,
        [0xe7, 0xe7],
    )
}

/// Registration frame. Standard variants are 28 bytes with prefix
/// 01 00 01 31/30; the WAAREE stick sends a 23-byte one with 01 00 01 08.
pub fn is_registration(f: &Frame) -> bool {
    f.start == [0x7e, 0x7e]
        && f.payload.len() >= 20
        && ((f.payload.len() == 28 && matches!(f.payload[..4], [1, 0, 1, 0x31] | [1, 0, 1, 0x30]))
            || f.payload[..4] == [1, 0, 1, 8])
}

pub fn registration_serial(f: &Frame) -> Option<String> {
    if !is_registration(f) {
        return None;
    }
    let n = *f.payload.get(4)? as usize;
    let s = f.payload.get(5..5 + n)?;
    String::from_utf8(s.to_vec()).ok()
}

/// The three-step bootstrap handshake. Returns the reply for each step.
#[derive(Default)]
pub struct Bootstrap {
    step: u8,
}

impl Bootstrap {
    pub fn response_for(&mut self, f: &Frame) -> Option<Vec<u8>> {
        match self.step {
            0 if is_registration(f) => {
                self.step = 1;
                Some(bootstrap_response(f, 0x82, &[1, 1, 1, 0, 0]))
            }
            1 if f.start == [0x7e, 0x7e] && f.raw.len() == 17 => {
                self.step = 2;
                Some(bootstrap_response(f, 0x80, &[]))
            }
            2 if f.start == [0x7e, 0x7e] && f.raw.len() == 14 => {
                self.step = 3;
                Some(bootstrap_response(f, 0x81, &[1]))
            }
            _ => None,
        }
    }
}

/// How (if at all) each 7f data frame is acknowledged. Nothing is known to be
/// required; these are the candidates tried on the live stick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckMode {
    None,
    /// 7e envelope, reply device/func derived as in the bootstrap, empty payload.
    Mirror7e,
    /// Same as Mirror7e but in the 7f envelope.
    Mirror7f,
    /// 7e envelope, payload = the record's 4-byte timestamp.
    Ts7e,
}

impl AckMode {
    pub fn parse(s: &str) -> Option<AckMode> {
        match s.trim() {
            "none" => Some(AckMode::None),
            "mirror7e" => Some(AckMode::Mirror7e),
            "mirror7f" => Some(AckMode::Mirror7f),
            "ts7e" => Some(AckMode::Ts7e),
            _ => None,
        }
    }
}

pub fn data_ack(mode: AckMode, f: &Frame) -> Option<Vec<u8>> {
    let dev = reply_device(&f.device, f.device[0] | 0x80);
    let func = f.func.wrapping_add(0x80);
    match mode {
        AckMode::None => None,
        AckMode::Mirror7e => Some(make_frame([0x7e, 0x7e], dev, func, &[], [0xe7, 0xe7])),
        AckMode::Mirror7f => Some(make_frame([0x7f, 0x7f], dev, func, &[], [0xf7, 0xf7])),
        AckMode::Ts7e => Some(make_frame([0x7e, 0x7e], dev, func, f.payload.get(..4)?, [0xe7, 0xe7])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        s.split_whitespace().map(|b| u8::from_str_radix(b, 16).unwrap()).collect()
    }

    // Real captured exchange (serial replaced; frames rebuilt so the CRC holds).
    fn registration() -> Frame {
        let mut p = vec![1, 0, 1, 8, 15];
        p.extend_from_slice(b"TESTSERIAL00001");
        p.extend_from_slice(&[0, 0, 0x48]);
        parse_frame(&make_frame([0x7e, 0x7e], [0x2a, 1, 0xb1, 0xd4], 0xd6, &p, [0xe7, 0xe7])).unwrap()
    }

    #[test]
    fn crc_matches_captured_ack() {
        // Captured cloud reply: body 'aa 01 b1 63 58 00 05 01 01 01 00 00', crc 78 34.
        assert_eq!(crc16_le(&hex("aa 01 b1 63 58 00 05 01 01 01 00 00")), [0x78, 0x34]);
    }

    #[test]
    fn registration_23_byte_variant() {
        let f = registration();
        assert!(f.valid_crc && is_registration(&f));
        assert_eq!(registration_serial(&f).as_deref(), Some("TESTSERIAL00001"));
    }

    #[test]
    fn bootstrap_matches_captured_replies() {
        let mut b = Bootstrap::default();
        let r = b.response_for(&registration()).unwrap();
        assert_eq!(r, hex("7e 7e aa 01 b1 63 58 00 05 01 01 01 00 00 78 34 e7 e7"));
        let f2 = parse_frame(&make_frame([0x7e, 0x7e], [0x2c, 1, 0xb1, 0xd5], 0x4d, &[0xe1, 1, 4, 0], [0xe7, 0xe7])).unwrap();
        assert_eq!(b.response_for(&f2).unwrap(), hex("7e 7e ac 01 b1 64 cd 00 00 84 0e e7 e7"));
        let f3 = parse_frame(&make_frame([0x7e, 0x7e], [0x2b, 1, 0xb1, 0xd5], 0x5a, &[0], [0xe7, 0xe7])).unwrap();
        assert_eq!(b.response_for(&f3).unwrap(), hex("7e 7e ab 01 b1 64 db 00 01 01 8b 9d e7 e7"));
        assert!(b.response_for(&f3).is_none());
    }

    #[test]
    fn extract_handles_split_garbage_and_bad_end() {
        let a = make_frame([0x7e, 0x7e], [2, 0, 0, 0], 1, &[1, 2, 3], [0xe7, 0xe7]);
        let b = make_frame([0x7f, 0x7f], [3, 0, 0, 0], 2, &[9; 40], [0xf7, 0xf7]);
        let mut stream = vec![0xde, 0xad];
        stream.extend_from_slice(&a);
        stream.extend_from_slice(&b);
        let mut buf = Vec::new();
        let mut got = Vec::new();
        for chunk in stream.chunks(7) {
            buf.extend_from_slice(chunk);
            got.extend(extract_frames(&mut buf));
        }
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|f| f.valid_crc));
        assert!(got[1].is_7f() && got[1].payload.len() == 40);
        assert!(buf.is_empty());

        let mut bad = a.clone();
        let n = bad.len();
        bad[n - 1] = 0;
        bad.extend_from_slice(&b);
        let got = extract_frames(&mut bad);
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn corrupt_crc_flagged() {
        let mut a = make_frame([0x7e, 0x7e], [2, 0, 0, 0], 1, &[1, 2, 3], [0xe7, 0xe7]);
        a[9] ^= 1;
        let mut v = a;
        assert!(!extract_frames(&mut v)[0].valid_crc);
    }

    #[test]
    fn data_ack_shapes() {
        let f = parse_frame(&make_frame([0x7f, 0x7f], [0x37, 1, 0xb1, 0xd5], 0x85, &[1; 20], [0xf7, 0xf7])).unwrap();
        assert!(data_ack(AckMode::None, &f).is_none());
        let a = data_ack(AckMode::Mirror7e, &f).unwrap();
        assert_eq!(&a[..9], &hex("7e 7e b7 01 b1 64 05 00 00")[..]);
        assert!(parse_frame(&a).unwrap().valid_crc);
        assert_eq!(data_ack(AckMode::Ts7e, &f).unwrap().len(), 17);
    }
}
