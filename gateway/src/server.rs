//! TLS listener on the stick's cloud port. One stick, one connection at a
//! time in practice; a new connection replaces the old one's session.

use crate::clock::{heartbeat_tail, ClockSync};
use crate::decode::{decode_live, decode_payload, DecodeError, Record};
use crate::protocol::{data_ack, extract_frames, registration_serial, AckMode, Bootstrap};
use crate::rawlog::RawLog;
use crate::relay::{Health, Link, Upstream};
use crate::sink::Sink;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering::Relaxed};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default = "d_listen")]
    pub listen: String,
    pub cert: PathBuf,
    pub key: PathBuf,
    /// tmpfs directory: raw frame log and the ack_mode control file.
    #[serde(default = "d_logdir")]
    pub log_dir: PathBuf,
    #[serde(default = "d_logmax")]
    pub log_max_bytes: u64,
    /// Worker ingest URL; empty = decode and log only.
    #[serde(default)]
    pub push_url: String,
    #[serde(default)]
    pub push_token: String,
    #[serde(default = "d_interval")]
    pub push_interval_s: u64,
    #[serde(default = "d_ack")]
    pub ack_mode: String,
    /// Relay to the WAAREE cloud while it is healthy (see relay.rs).
    #[serde(default)]
    pub relay: RelayCfg,
}

#[derive(Debug, Deserialize)]
pub struct RelayCfg {
    #[serde(default)]
    pub enabled: bool,
    /// Where the stick was headed before the router redirected it; the
    /// original destination is not visible after the DNAT.
    #[serde(default = "d_upstream")]
    pub upstream: String,
    #[serde(default = "d_ct")]
    pub connect_timeout_s: u64,
    /// No byte from the upstream this long after the stick registers = mute.
    #[serde(default = "d_rt")]
    pub reply_timeout_s: u64,
    #[serde(default = "d_pi")]
    pub probe_interval_s: u64,
    /// Optional SHA-256 (hex) of the upstream's certificate to insist on.
    #[serde(default)]
    pub pin_sha256: String,
}

impl Default for RelayCfg {
    fn default() -> Self {
        RelayCfg { enabled: false, upstream: d_upstream(), connect_timeout_s: d_ct(), reply_timeout_s: d_rt(), probe_interval_s: d_pi(), pin_sha256: String::new() }
    }
}

fn d_upstream() -> String { "34.93.70.153:14431".into() }
fn d_ct() -> u64 { 10 }
fn d_rt() -> u64 { 30 }
fn d_pi() -> u64 { 600 }

pub type BoxRead = Pin<Box<dyn AsyncRead + Unpin>>;
pub type BoxWrite = Pin<Box<dyn AsyncWrite + Unpin>>;

fn d_listen() -> String { "0.0.0.0:14431".into() }
fn d_logdir() -> PathBuf { "/tmp/stick-gw".into() }
fn d_logmax() -> u64 { 1 << 20 }
fn d_interval() -> u64 { 300 }
fn d_ack() -> String { "none".into() }

#[derive(Default)]
pub struct Stats {
    pub frames: AtomicU64,
    pub bad_crc: AtomicU64,
    pub records: AtomicU64,
    pub unique: AtomicU64,
    pub decode_err: AtomicU64,
    pub acks: AtomicU64,
    pub sessions: AtomicU64,
}

pub struct Shared {
    pub sink: Mutex<Sink>,
    pub log: Mutex<RawLog>,
    pub stats: Stats,
    pub ack: AtomicU8,
    pub clock: Mutex<ClockSync>,
    pub health: Mutex<Health>,
    pub upstream: Option<Box<dyn Upstream>>,
    pub link: Mutex<(Link, u32)>,
    pub reply_timeout: Duration,
    pub started: tokio::time::Instant,
}

impl Shared {
    pub fn mono(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    pub fn set_link(&self, l: Link) {
        let mut cur = self.link.lock().unwrap();
        if cur.0 != l {
            log::info!("WAAREE link: {} -> {}", cur.0.as_str(), l.as_str());
            *cur = (l, now_f64() as u32);
        }
    }
}

const ACK_MODES: [AckMode; 4] = [AckMode::None, AckMode::Mirror7e, AckMode::Mirror7f, AckMode::Ts7e];

pub fn ack_from_u8(v: u8) -> AckMode {
    ACK_MODES[(v as usize).min(3)]
}

pub fn ack_to_u8(m: AckMode) -> u8 {
    ACK_MODES.iter().position(|x| *x == m).unwrap() as u8
}

fn now_f64() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn tls_acceptor(cert: &Path, key: &Path) -> Result<TlsAcceptor, String> {
    let certs = rustls_pemfile::certs(&mut BufReader::new(File::open(cert).map_err(|e| format!("cert: {e}"))?))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("cert: {e}"))?;
    let key = rustls_pemfile::private_key(&mut BufReader::new(File::open(key).map_err(|e| format!("key: {e}"))?))
        .map_err(|e| format!("key: {e}"))?
        .ok_or("no private key in key file")?;
    // The stick speaks TLS 1.2 (ECDHE-RSA-AES-GCM, as foxess_local_gateway pins).
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| e.to_string())?;
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

/// Re-reads `<log_dir>/ack_mode` every few seconds so ACK variants can be
/// tried on the live stick without a restart.
pub async fn watch_ack_file(shared: Arc<Shared>, path: PathBuf) {
    let mut last = String::new();
    loop {
        if let Ok(s) = tokio::fs::read_to_string(&path).await {
            let s = s.trim().to_string();
            if s != last {
                match AckMode::parse(&s) {
                    Some(m) => {
                        shared.ack.store(ack_to_u8(m), Relaxed);
                        log::info!("ack mode -> {m:?}");
                    }
                    None => log::warn!("ignoring unknown ack mode {s:?}"),
                }
                last = s;
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

pub async fn run(listener: TcpListener, acceptor: TlsAcceptor, shared: Arc<Shared>) {
    let mut session = 0u64;
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                log::warn!("accept: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        session += 1;
        shared.stats.sessions.fetch_add(1, Relaxed);
        let acceptor = acceptor.clone();
        let shared = shared.clone();
        tokio::task::spawn_local(async move {
            let tls = match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => return log::warn!("session {session} {peer}: tls: {e}"),
                Err(_) => return log::warn!("session {session} {peer}: tls timeout"),
            };
            log::info!("session {session} {peer}: connected");
            let why = handle(tls, session, shared.clone()).await;
            log::info!("session {session} {peer}: closed ({why})");
        });
    }
}

/// While the upstream is believed down, tries a bare connect now and then.
/// A success only flags it; the session handler then hands over at a clean
/// boundary.
pub async fn probe_loop(sh: Arc<Shared>) {
    let Some(up) = sh.upstream.as_ref() else { return };
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let now = sh.mono();
        if !sh.health.lock().unwrap().probe_due(now) {
            continue;
        }
        let ok = match up.connect().await {
            Ok(_) => true,
            Err(e) => {
                log::info!("upstream probe failed: {e}");
                false
            }
        };
        if ok {
            log::info!("upstream probe ok: switching back at the next session boundary");
        }
        sh.health.lock().unwrap().on_probe(ok, sh.mono());
    }
}

/// Per-connection state: everything decoded locally, whoever answers.
struct Sess {
    buf: Vec<u8>,
    boot: Bootstrap,
    clock: ClockSync,
    seen: HashSet<u32>,
    serial: String,
    registered: bool,
}

impl Sess {
    /// Decodes the stick's bytes. Returns (replies we would give, registration seen).
    /// The caller decides whether they are sent or only held.
    fn on_stick(&mut self, sh: &Shared, session: u64, bytes: &[u8], rx: f64) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        // (bootstrap replies, per-record ACKs)
        let (mut boots, mut acks) = (Vec::new(), Vec::new());
        self.buf.extend_from_slice(bytes);
        for f in extract_frames(&mut self.buf) {
            sh.stats.frames.fetch_add(1, Relaxed);
            sh.log.lock().unwrap().line(&format!("{{\"t\":{rx:.3},\"s\":{session},\"d\":\"rx\",\"crc\":{},\"h\":\"{}\"}}", f.valid_crc, hex(&f.raw)));
            if !f.valid_crc {
                sh.stats.bad_crc.fetch_add(1, Relaxed);
                continue;
            }
            if !f.is_7f() {
                if let Some(s) = registration_serial(&f) {
                    log::info!("session {session}: registration, serial {s}");
                    self.serial = s;
                    self.registered = true;
                }
                if let Some(r) = self.boot.response_for(&f) {
                    boots.push(r);
                }
                if let Some(tail) = heartbeat_tail(f.device) {
                    self.clock.observe(rx, tail);
                    *sh.clock.lock().unwrap() = self.clock;
                    sh.sink.lock().unwrap().convert(&self.clock, 90.0, false);
                }
            }
            // Records come two ways: the replay of buffered samples (7f, 186 B)
            // and the live sample every ~5 min (7e, device 02.., 160 B).
            let decoded: Option<Result<Record, DecodeError>> = if f.is_7f() && f.payload.len() == 186 {
                Some(decode_payload(&f.payload))
            } else if !f.is_7f() && f.device[0] == 2 && f.payload.len() == 160 {
                Some(decode_live(f.device, f.func, &f.payload))
            } else {
                None
            };
            match decoded {
                None => {}
                Some(Ok(rec)) => {
                    sh.stats.records.fetch_add(1, Relaxed);
                    if self.seen.insert(rec.ts) {
                        sh.stats.unique.fetch_add(1, Relaxed);
                        let mut s = sh.sink.lock().unwrap();
                        s.add(rec);
                        s.convert(&self.clock, 90.0, false);
                    }
                    if f.is_7f() {
                        if let Some(a) = data_ack(ack_from_u8(sh.ack.load(Relaxed)), &f) {
                            sh.stats.acks.fetch_add(1, Relaxed);
                            acks.push(a);
                        }
                    }
                }
                Some(Err(e)) => {
                    sh.stats.decode_err.fetch_add(1, Relaxed);
                    log::warn!("session {session}: decode: {e:?}");
                }
            }
        }
        (boots, acks)
    }
}

fn log_tx(sh: &Shared, session: u64, dir: &str, b: &[u8]) {
    sh.log.lock().unwrap().line(&format!("{{\"t\":{:.3},\"s\":{session},\"d\":\"{dir}\",\"h\":\"{}\"}}", now_f64(), hex(b)));
}

/// Logs upstream frames (for the record) without touching the bytes.
fn log_upstream(sh: &Shared, session: u64, ubuf: &mut Vec<u8>, bytes: &[u8]) {
    ubuf.extend_from_slice(bytes);
    for f in extract_frames(ubuf) {
        log_tx(sh, session, "up", &f.raw);
    }
}

pub async fn handle<S: AsyncRead + AsyncWrite + Unpin>(io: S, session: u64, sh: Arc<Shared>) -> String {
    let (mut rd, mut wr) = tokio::io::split(io);
    let mut s = Sess { buf: Vec::new(), boot: Bootstrap::default(), clock: ClockSync::default(), seen: HashSet::new(), serial: String::new(), registered: false };
    let mut chunk = [0u8; 2048];
    let mut uchunk = [0u8; 2048];
    let mut ubuf: Vec<u8> = Vec::new();

    // Who answers this session: the upstream if healthy, else us.
    let mut up: Option<(BoxRead, BoxWrite)> = None;
    if let Some(u) = sh.upstream.as_ref() {
        if sh.health.lock().unwrap().should_relay() {
            match u.connect().await {
                Ok(p) => {
                    log::info!("session {session}: relaying to upstream");
                    up = Some(p);
                }
                Err(e) => {
                    log::warn!("session {session}: upstream unavailable ({e}); answering locally");
                    sh.health.lock().unwrap().on_fail(sh.mono());
                    sh.set_link(Link::Down);
                }
            }
        } else {
            log::info!("session {session}: upstream down; answering locally");
        }
    }
    let mut up_rx = 0u64;
    let mut reg_at: Option<f64> = None;
    let mut held: Vec<Vec<u8>> = Vec::new(); // bootstrap replies the upstream owes the stick
    let mut tick = tokio::time::interval(Duration::from_secs(1));

    let reason = loop {
        // True when the upstream has gone mute or dead before ever replying.
        let mut mute: Option<&str> = None;
        tokio::select! {
            r = tokio::time::timeout(Duration::from_secs(600), rd.read(&mut chunk)) => {
                let n = match r {
                    Err(_) => break "idle 10 min".to_string(),
                    Ok(Ok(0)) => break "eof".to_string(),
                    Ok(Err(e)) => break format!("read: {e}"),
                    Ok(Ok(n)) => n,
                };
                let (boots, acks) = s.on_stick(&sh, session, &chunk[..n], now_f64());
                if let Some((_, uw)) = up.as_mut() {
                    // Relaying: the upstream answers. Replies we computed are kept
                    // in case it never does.
                    if s.registered && reg_at.is_none() {
                        reg_at = Some(sh.mono());
                    }
                    held.extend(boots);
                    if let Err(e) = uw.write_all(&chunk[..n]).await {
                        if up_rx == 0 { mute = Some("write failed"); log::warn!("session {session}: upstream write: {e}"); }
                        else { sh.health.lock().unwrap().on_fail(sh.mono()); sh.set_link(Link::Down); break format!("upstream write: {e}"); }
                    }
                } else {
                    for r in boots.into_iter().chain(acks) {
                        log_tx(&sh, session, "tx", &r);
                        if let Err(e) = wr.write_all(&r).await {
                            return format!("write: {e}");
                        }
                    }
                }
            }
            r = async { up.as_mut().unwrap().0.read(&mut uchunk).await }, if up.is_some() => {
                match r {
                    Ok(n) if n > 0 => {
                        if up_rx == 0 {
                            log::info!("session {session}: upstream replied");
                            sh.health.lock().unwrap().on_reply();
                            sh.set_link(Link::Relaying);
                            held.clear();
                        }
                        up_rx += n as u64;
                        log_upstream(&sh, session, &mut ubuf, &uchunk[..n]);
                        if let Err(e) = wr.write_all(&uchunk[..n]).await {
                            return format!("write: {e}");
                        }
                    }
                    other => {
                        if up_rx == 0 {
                            mute = Some("upstream closed");
                        } else {
                            sh.health.lock().unwrap().on_fail(sh.mono());
                            sh.set_link(Link::Down);
                            break format!("upstream lost ({})", other.err().map(|e| e.to_string()).unwrap_or_else(|| "eof".into()));
                        }
                    }
                }
            }
            _ = tick.tick() => {
                if up.is_some() && up_rx == 0 {
                    if let Some(t) = reg_at {
                        if sh.mono() - t >= sh.reply_timeout.as_secs_f64() {
                            mute = Some("no reply to registration");
                        }
                    }
                } else if up.is_none() && sh.upstream.is_some() && sh.health.lock().unwrap().switch_pending() {
                    break "upstream is back: reconnect to relay".to_string();
                }
            }
        }
        if let Some(why) = mute {
            // Fail over inside the session: drop the upstream and give the
            // stick the answers it has been waiting for.
            log::warn!("session {session}: upstream mute ({why}); answering locally");
            up = None;
            sh.health.lock().unwrap().on_fail(sh.mono());
            sh.set_link(Link::Down);
            for r in std::mem::take(&mut held) {
                log_tx(&sh, session, "tx", &r);
                if let Err(e) = wr.write_all(&r).await {
                    return format!("write: {e}");
                }
            }
        }
    };
    // Whatever is still unconverted gets the best bracket this session had.
    sh.sink.lock().unwrap().convert(&s.clock, f64::INFINITY, true);
    if !s.serial.is_empty() {
        log::info!("session {session}: serial {}", s.serial);
    }
    reason
}
