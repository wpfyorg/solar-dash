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

fn post(cfg: &PushCfg, batch: &[Out]) -> Result<(), String> {
    let body = serde_json::json!({ "records": batch });
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
pub fn push_round(cfg: &PushCfg, sink: &Mutex<Sink>) -> usize {
    let mut sent = 0;
    for _ in 0..MAX_BATCHES_PER_ROUND {
        let batch = sink.lock().unwrap().batch(BATCH);
        if batch.is_empty() {
            break;
        }
        match post(cfg, &batch) {
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
