//! TLS listener on the stick's cloud port. One stick, one connection at a
//! time in practice; a new connection replaces the old one's session.

use crate::clock::{heartbeat_tail, ClockSync};
use crate::decode::{decode_payload, DecodeError};
use crate::protocol::{data_ack, extract_frames, registration_serial, AckMode, Bootstrap};
use crate::rawlog::RawLog;
use crate::sink::Sink;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
}

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

async fn handle<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut io: S, session: u64, sh: Arc<Shared>) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    let mut boot = Bootstrap::default();
    let mut clock = ClockSync::default();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut serial = String::new();
    let reason = loop {
        let n = match tokio::time::timeout(Duration::from_secs(600), io.read(&mut chunk)).await {
            Err(_) => break "idle 10 min".to_string(),
            Ok(Ok(0)) => break "eof".to_string(),
            Ok(Err(e)) => break format!("read: {e}"),
            Ok(Ok(n)) => n,
        };
        let rx = now_f64();
        buf.extend_from_slice(&chunk[..n]);
        for f in extract_frames(&mut buf) {
            sh.stats.frames.fetch_add(1, Relaxed);
            sh.log.lock().unwrap().line(&format!("{{\"t\":{rx:.3},\"s\":{session},\"d\":\"rx\",\"crc\":{},\"h\":\"{}\"}}", f.valid_crc, hex(&f.raw)));
            if !f.valid_crc {
                sh.stats.bad_crc.fetch_add(1, Relaxed);
                continue;
            }
            let mut replies: Vec<Vec<u8>> = Vec::new();
            if !f.is_7f() {
                if let Some(s) = registration_serial(&f) {
                    log::info!("session {session}: registration, serial {s}");
                    serial = s;
                }
                if let Some(r) = boot.response_for(&f) {
                    replies.push(r);
                }
                if let Some(tail) = heartbeat_tail(f.device) {
                    clock.observe(rx, tail);
                    *sh.clock.lock().unwrap() = clock;
                    sh.sink.lock().unwrap().convert(&clock, 90.0, false);
                }
            } else if f.payload.len() == 186 {
                match decode_payload(&f.payload) {
                    Ok(rec) => {
                        sh.stats.records.fetch_add(1, Relaxed);
                        if seen.insert(rec.ts) {
                            sh.stats.unique.fetch_add(1, Relaxed);
                            let mut s = sh.sink.lock().unwrap();
                            s.add(rec);
                            s.convert(&clock, 90.0, false);
                        }
                        if let Some(a) = data_ack(ack_from_u8(sh.ack.load(Relaxed)), &f) {
                            replies.push(a);
                            sh.stats.acks.fetch_add(1, Relaxed);
                        }
                    }
                    Err(e) => {
                        sh.stats.decode_err.fetch_add(1, Relaxed);
                        log::warn!("session {session}: decode: {}", match e {
                            DecodeError::Length(n) => format!("length {n}"),
                            other => format!("{other:?}"),
                        });
                    }
                }
            }
            for r in replies {
                sh.log.lock().unwrap().line(&format!("{{\"t\":{:.3},\"s\":{session},\"d\":\"tx\",\"h\":\"{}\"}}", now_f64(), hex(&r)));
                if let Err(e) = io.write_all(&r).await {
                    return format!("write: {e}");
                }
            }
        }
    };
    // Whatever is still unconverted gets the best bracket this session had.
    sh.sink.lock().unwrap().convert(&clock, f64::INFINITY, true);
    if !serial.is_empty() {
        log::info!("session {session}: serial {serial}");
    }
    reason
}
