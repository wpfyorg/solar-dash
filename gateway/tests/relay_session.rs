//! Failover logic of a stick session against a fake upstream.

use std::sync::atomic::AtomicU8;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use stick_gateway::protocol::make_frame;
use stick_gateway::rawlog::RawLog;
use stick_gateway::relay::{Connecting, Health, Link, Upstream};
use stick_gateway::server::{handle, BoxRead, BoxWrite, Shared};
use stick_gateway::sink::Sink;
use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::task::LocalSet;
use tokio::time::timeout;

/// Hands out one end of a duplex pipe; the test keeps the other.
struct Fake(Mutex<Option<Result<DuplexStream, String>>>);

impl Upstream for Fake {
    fn connect(&self) -> Connecting<'_> {
        let r = self.0.lock().unwrap().take().expect("one connect per test");
        Box::pin(async move {
            let s = r?;
            let (rd, wr) = tokio::io::split(s);
            Ok((Box::pin(rd) as BoxRead, Box::pin(wr) as BoxWrite))
        })
    }
}

fn shared(up: Option<Result<DuplexStream, String>>) -> Arc<Shared> {
    let dir = std::env::temp_dir().join(format!("stick-gw-relay-{}-{:p}", std::process::id(), &up));
    Arc::new(Shared {
        sink: Mutex::new(Sink::default()),
        log: Mutex::new(RawLog::open(dir.join("f.jsonl"), 1 << 20)),
        stats: Default::default(),
        ack: AtomicU8::new(0),
        clock: Mutex::new(Default::default()),
        health: Mutex::new(Health::new(600.0)),
        upstream: up.map(|u| Box::new(Fake(Mutex::new(Some(u)))) as Box<dyn Upstream>),
        link: Mutex::new((Link::Unknown, 0)),
        reply_timeout: Duration::from_secs(30),
        started: tokio::time::Instant::now(),
    })
}

fn registration() -> Vec<u8> {
    let mut p = vec![1, 0, 1, 8, 15];
    p.extend_from_slice(b"TESTSERIAL00001");
    p.extend_from_slice(&[0, 0, 0x48]);
    make_frame([0x7e, 0x7e], [0x2a, 1, 0xb1, 0xd4], 0xd6, &p, [0xe7, 0xe7])
}

const REG_ACK: [u8; 18] = [0x7e, 0x7e, 0xaa, 1, 0xb1, 0x63, 0x58, 0, 5, 1, 1, 1, 0, 0, 0x78, 0x34, 0xe7, 0xe7];

async fn read_n(s: &mut DuplexStream, n: usize, secs: u64) -> Option<Vec<u8>> {
    let mut b = vec![0u8; n];
    timeout(Duration::from_secs(secs), s.read_exact(&mut b)).await.ok()?.ok()?;
    Some(b)
}

#[tokio::test(start_paused = true)]
async fn dead_upstream_means_local_answers_at_once() {
    LocalSet::new()
        .run_until(async {
            let sh = shared(Some(Err("connect timeout".into())));
            let (mut stick, srv) = duplex(65536);
            let h = tokio::task::spawn_local(handle(srv, 1, sh.clone()));
            stick.write_all(&registration()).await.unwrap();
            assert_eq!(read_n(&mut stick, 18, 2).await.unwrap(), REG_ACK);
            assert_eq!(sh.link.lock().unwrap().0, Link::Down);
            assert!(!sh.health.lock().unwrap().should_relay());
            drop(stick);
            assert_eq!(h.await.unwrap(), "eof");
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn mute_upstream_fails_over_after_the_timeout_without_double_answers() {
    LocalSet::new()
        .run_until(async {
            let (up_far, mut up_near) = duplex(65536);
            let sh = shared(Some(Ok(up_far)));
            let (mut stick, srv) = duplex(65536);
            tokio::task::spawn_local(handle(srv, 1, sh.clone()));
            stick.write_all(&registration()).await.unwrap();
            // The registration reaches the upstream untouched, and nobody answers yet.
            assert_eq!(read_n(&mut up_near, registration().len(), 1).await.unwrap(), registration());
            assert!(read_n(&mut stick, 1, 25).await.is_none(), "no local answer while the upstream may still reply");
            // After ~30 s of silence the answer the stick has been waiting for arrives.
            assert_eq!(read_n(&mut stick, 18, 10).await.unwrap(), REG_ACK);
            assert_eq!(sh.link.lock().unwrap().0, Link::Down);
            // And the session carries on locally: the next bootstrap step is answered.
            let step1 = make_frame([0x7e, 0x7e], [0x2c, 1, 0xb1, 0xd5], 0x4d, &[0xe1, 1, 4, 0], [0xe7, 0xe7]);
            stick.write_all(&step1).await.unwrap();
            assert_eq!(read_n(&mut stick, 13, 2).await.unwrap()[2], 0xac);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn healthy_upstream_is_relayed_untouched_and_still_decoded() {
    LocalSet::new()
        .run_until(async {
            let (up_far, mut up_near) = duplex(65536);
            let sh = shared(Some(Ok(up_far)));
            let (mut stick, srv) = duplex(65536);
            tokio::task::spawn_local(handle(srv, 1, sh.clone()));
            stick.write_all(&registration()).await.unwrap();
            assert_eq!(read_n(&mut up_near, registration().len(), 1).await.unwrap(), registration());
            // The upstream's own reply goes back verbatim; we add nothing.
            let theirs = make_frame([0x7e, 0x7e], [0xaa, 1, 0xb1, 0x63], 0x58, &[9, 9, 9], [0xe7, 0xe7]);
            up_near.write_all(&theirs).await.unwrap();
            assert_eq!(read_n(&mut stick, theirs.len(), 2).await.unwrap(), theirs);
            assert_eq!(sh.link.lock().unwrap().0, Link::Relaying);
            // A live record still lands in the sink, and is forwarded upstream.
            let live = make_frame([0x7e, 0x7e], [2, 0x6a, 0x62, 0x53], 0x87, &[0u8; 160], [0xe7, 0xe7]);
            stick.write_all(&live).await.unwrap();
            assert_eq!(read_n(&mut up_near, live.len(), 1).await.unwrap(), live);
            assert_eq!(sh.sink.lock().unwrap().pending_len(), 1);
            // No local bytes sneaked in beside the upstream's.
            assert!(read_n(&mut stick, 1, 40).await.is_none());
            assert!(sh.health.lock().unwrap().should_relay());
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn upstream_dying_mid_session_drops_the_stick_so_it_reconnects() {
    LocalSet::new()
        .run_until(async {
            let (up_far, mut up_near) = duplex(65536);
            let sh = shared(Some(Ok(up_far)));
            let (mut stick, srv) = duplex(65536);
            let h = tokio::task::spawn_local(handle(srv, 1, sh.clone()));
            stick.write_all(&registration()).await.unwrap();
            up_near.write_all(&[0x7e, 0x7e, 1, 2, 3]).await.unwrap();
            assert!(read_n(&mut stick, 5, 2).await.is_some());
            drop(up_near);
            assert!(h.await.unwrap().starts_with("upstream lost"));
            assert_eq!(sh.link.lock().unwrap().0, Link::Down);
            assert!(!sh.health.lock().unwrap().should_relay());
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn local_session_hands_back_to_the_upstream_only_at_a_boundary() {
    LocalSet::new()
        .run_until(async {
            let sh = shared(Some(Err("down".into())));
            let (mut stick, srv) = duplex(65536);
            let h = tokio::task::spawn_local(handle(srv, 1, sh.clone()));
            stick.write_all(&registration()).await.unwrap();
            assert!(read_n(&mut stick, 18, 2).await.is_some());
            // Upstream still down: the session is left alone, however long it runs.
            assert!(timeout(Duration::from_secs(300), async { tokio::time::sleep(Duration::from_secs(500)).await }).await.is_err());
            assert!(!h.is_finished());
            // A probe finds it back: the session is closed so the stick reconnects.
            sh.health.lock().unwrap().on_probe(true, 0.0);
            assert_eq!(timeout(Duration::from_secs(5), h).await.unwrap().unwrap(), "upstream is back: reconnect to relay");
            assert!(sh.health.lock().unwrap().should_relay());
        })
        .await;
}
