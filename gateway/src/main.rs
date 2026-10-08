use argh::FromArgs;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use stick_gateway::push::{push_round, push_status, PushCfg};
use stick_gateway::relay::{Health, Link, TlsUpstream, Upstream};
use stick_gateway::rawlog::RawLog;
use stick_gateway::protocol::AckMode;
use stick_gateway::server::{ack_to_u8, probe_loop, run, tls_acceptor, watch_ack_file, Config, Shared};
use stick_gateway::sink::Sink;

/// Local cloud for the WAAREE/FoxESS Wi-Fi stick.
#[derive(FromArgs)]
struct Args {
    /// path to the JSON config
    #[argh(option, default = "String::from(\"/etc/stick-gateway.json\")")]
    config: String,
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Args = argh::from_env();
    let cfg: Config = match std::fs::read_to_string(&args.config).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string())) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config {}: {e}", args.config);
            std::process::exit(2);
        }
    };
    let acceptor = tls_acceptor(&cfg.cert, &cfg.key).unwrap_or_else(|e| {
        eprintln!("tls: {e}");
        std::process::exit(2);
    });
    let ack = AckMode::parse(&cfg.ack_mode).unwrap_or(AckMode::None);
    let shared = Arc::new(Shared {
        sink: Mutex::new(Sink::default()),
        log: Mutex::new(RawLog::open(cfg.log_dir.join("frames.jsonl"), cfg.log_max_bytes)),
        stats: Default::default(),
        ack: std::sync::atomic::AtomicU8::new(ack_to_u8(ack)),
        clock: Mutex::new(Default::default()),
        health: Mutex::new(Health::new(cfg.relay.probe_interval_s as f64)),
        upstream: cfg.relay.enabled.then(|| {
            let pin = (!cfg.relay.pin_sha256.is_empty()).then(|| cfg.relay.pin_sha256.clone());
            Box::new(TlsUpstream { addr: cfg.relay.upstream.clone(), timeout: Duration::from_secs(cfg.relay.connect_timeout_s), pin }) as Box<dyn Upstream>
        }),
        link: Mutex::new((if cfg.relay.enabled { Link::Unknown } else { Link::Off }, 0)),
        reply_timeout: Duration::from_secs(cfg.relay.reply_timeout_s),
        started: tokio::time::Instant::now(),
    });

    if !cfg.push_url.is_empty() {
        let (s, c) = (shared.clone(), PushCfg { url: cfg.push_url.clone(), token: cfg.push_token.clone() });
        let every = Duration::from_secs(cfg.push_interval_s.max(60));
        std::thread::spawn(move || {
            let mut last = Instant::now();
            let mut pushed_link: Option<(Link, u32)> = None;
            loop {
                std::thread::sleep(Duration::from_secs(10));
                let link = *s.link.lock().unwrap();
                let changed = pushed_link != Some(link) && link.0 != Link::Unknown;
                if last.elapsed() < every && !changed {
                    continue;
                }
                last = Instant::now();
                let now = (link.0.as_str(), link.1);
                let n = push_round(&c, &s.sink, now);
                if n > 0 {
                    log::info!("pushed {n} records");
                    pushed_link = Some(link);
                } else if changed && push_status(&c, now) {
                    pushed_link = Some(link);
                }
            }
        });
    } else {
        log::warn!("push_url empty: decoding and logging only");
    }

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        let listener = tokio::net::TcpListener::bind(&cfg.listen).await.unwrap_or_else(|e| {
            eprintln!("bind {}: {e}", cfg.listen);
            std::process::exit(2);
        });
        log::info!("listening on {} (ack {ack:?})", cfg.listen);
        tokio::task::spawn_local(watch_ack_file(shared.clone(), cfg.log_dir.join("ack_mode")));
        let sh = shared.clone();
        tokio::task::spawn_local(async move {
            // Per-minute rate line: the numbers the ACK experiments are judged on.
            let (mut t0, mut u0, mut r0) = (Instant::now(), 0u64, 0u64);
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let (u, r) = (sh.stats.unique.load(Relaxed), sh.stats.records.load(Relaxed));
                let dt = t0.elapsed().as_secs_f64();
                let (du, dr) = (u - u0, r - r0);
                let dupe = if dr > 0 { 100.0 * (dr - du) as f64 / dr as f64 } else { 0.0 };
                let (ready, pending, w) = {
                    let s = sh.sink.lock().unwrap();
                    (s.ready_len(), s.pending_len(), sh.clock.lock().unwrap().width())
                };
                log::info!(
                    "stats: unique/s {:.3} resend% {:.0} | total frames {} records {} unique {} badcrc {} decode_err {} acks {} | ready {ready} pending {pending} clock±{w:.1}s",
                    du as f64 / dt, dupe,
                    sh.stats.frames.load(Relaxed), r, u, sh.stats.bad_crc.load(Relaxed), sh.stats.decode_err.load(Relaxed), sh.stats.acks.load(Relaxed)
                );
                (t0, u0, r0) = (Instant::now(), u, r);
            }
        });
        tokio::task::spawn_local(probe_loop(shared.clone()));
        run(listener, acceptor, shared).await;
    });
}
