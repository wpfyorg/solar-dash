//! Pushes ready records to the dashboard Worker: POST {records:[...]} with a
//! bearer token. At most one push round per interval; a round may send several
//! batches so a backlog drains in one go.

use crate::sink::{Out, Sink};
use std::sync::Mutex;
use std::time::Duration;

pub const BATCH: usize = 400;
pub const MAX_BATCHES_PER_ROUND: usize = 6;
pub const READY_CAP: usize = 20_000;

pub struct PushCfg {
    pub url: String,
    pub token: String,
}

/// WAAREE link as the dashboard shows it: (mode, since unix time).
pub type LinkNow = (&'static str, u32);

fn post(cfg: &PushCfg, batch: &[Out], link: LinkNow) -> Result<(), String> {
    let body = serde_json::json!({ "records": batch, "link": { "mode": link.0, "since": link.1 } });
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build()
        .post(&cfg.url)
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .send_json(body)
        .map(|_| ())
        .map_err(|e| match e {
            ureq::Error::Status(c, _) => format!("HTTP {c}"),
            other => other.to_string(),
        })
}

/// One push round. Returns records delivered.
/// Status only, when the link changed and there are no records waiting.
pub fn push_status(cfg: &PushCfg, link: LinkNow) -> bool {
    post(cfg, &[], link).map_err(|e| log::warn!("status push failed: {e}")).is_ok()
}

pub fn push_round(cfg: &PushCfg, sink: &Mutex<Sink>, link: LinkNow) -> usize {
    let mut sent = 0;
    for _ in 0..MAX_BATCHES_PER_ROUND {
        let batch = sink.lock().unwrap().batch(BATCH);
        if batch.is_empty() {
            break;
        }
        match post(cfg, &batch, link) {
            Ok(()) => {
                sink.lock().unwrap().done(&batch);
                sent += batch.len();
            }
            Err(e) => {
                log::warn!("push failed ({} records kept): {e}", batch.len());
                break;
            }
        }
    }
    sink.lock().unwrap().trim_ready(READY_CAP);
    sent
}
