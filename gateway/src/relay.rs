//! Optional relay to the real WAAREE cloud, with automatic failover.
//!
//! While the upstream is healthy the stick's bytes go to it and its replies
//! come back untouched; we only listen in (decode and push). When it is down
//! or mute we answer locally instead. Switching back to the upstream happens
//! only between stick sessions: a probe notes the upstream is back, the
//! current local session is closed, and the stick's reconnect tries it again.

use crate::server::{BoxRead, BoxWrite};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;

/// What we believe about the upstream; drives who answers the stick.
#[derive(Debug)]
pub struct Health {
    up: bool,
    probe_ok: bool,
    next_probe: f64,
    backoff: f64,
    base: f64,
}

impl Health {
    /// Starts optimistic: the first session tries the upstream.
    pub fn new(probe_interval_s: f64) -> Health {
        Health { up: true, probe_ok: false, next_probe: 0.0, backoff: probe_interval_s, base: probe_interval_s }
    }

    /// Should a new stick session try the upstream?
    pub fn should_relay(&self) -> bool {
        self.up || self.probe_ok
    }

    /// The upstream failed or stayed mute. Backs off exponentially (to 1 h).
    pub fn on_fail(&mut self, now: f64) {
        self.up = false;
        self.probe_ok = false;
        self.next_probe = now + self.backoff;
        self.backoff = (self.backoff * 2.0).min(3600.0);
    }

    /// The upstream answered the stick.
    pub fn on_reply(&mut self) {
        self.up = true;
        self.probe_ok = false;
        self.backoff = self.base;
    }

    pub fn probe_due(&self, now: f64) -> bool {
        !self.up && !self.probe_ok && now >= self.next_probe
    }

    /// Result of a bare connect probe. Failing keeps the current schedule.
    pub fn on_probe(&mut self, ok: bool, now: f64) {
        if ok {
            self.probe_ok = true;
        } else {
            self.next_probe = now + self.base;
        }
    }

    /// A local session should close so the stick reconnects to the upstream.
    pub fn switch_pending(&self) -> bool {
        !self.up && self.probe_ok
    }
}

/// How the dashboard is told about the WAAREE link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    Off,
    Unknown,
    Relaying,
    Down,
}

impl Link {
    pub fn as_str(self) -> &'static str {
        match self {
            Link::Off => "off",
            Link::Unknown => "unknown",
            Link::Relaying => "relaying",
            Link::Down => "down",
        }
    }
}

pub type Connecting<'a> = Pin<Box<dyn Future<Output = Result<(BoxRead, BoxWrite), String>> + 'a>>;

pub trait Upstream: Send + Sync {
    fn connect(&self) -> Connecting<'_>;
}

/// TLS client to the WAAREE cloud. Its certificate is self-signed, so it is
/// not validated; the SHA-256 fingerprint is logged on every connect and,
/// when `pin` is set, a different one is refused.
pub struct TlsUpstream {
    pub addr: String,
    pub timeout: Duration,
    pub pin: Option<String>,
}

#[derive(Debug)]
struct Capture {
    fp: Arc<Mutex<Option<String>>>,
    algs: Vec<SignatureScheme>,
}

impl ServerCertVerifier for Capture {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, Error> {
        let d = ring::digest::digest(&ring::digest::SHA256, end.as_ref());
        *self.fp.lock().unwrap() = Some(d.as_ref().iter().map(|b| format!("{b:02x}")).collect());
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.clone()
    }
}

impl Upstream for TlsUpstream {
    fn connect(&self) -> Connecting<'_> {
        Box::pin(async move {
            let host = self.addr.rsplit_once(':').map(|x| x.0).unwrap_or(&self.addr).to_string();
            let tcp = tokio::time::timeout(self.timeout, TcpStream::connect(&self.addr))
                .await
                .map_err(|_| "connect timeout".to_string())?
                .map_err(|e| format!("connect: {e}"))?;
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let fp = Arc::new(Mutex::new(None));
            let verifier = Capture { fp: fp.clone(), algs: provider.signature_verification_algorithms.supported_schemes() };
            let cfg = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            let name = ServerName::try_from(host).map_err(|e| format!("server name: {e}"))?;
            let tls = tokio::time::timeout(self.timeout, tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp))
                .await
                .map_err(|_| "tls timeout".to_string())?
                .map_err(|e| format!("tls: {e}"))?;
            let seen = fp.lock().unwrap().clone().unwrap_or_default();
            log::info!("upstream {} cert sha256 {seen}", self.addr);
            if let Some(p) = &self.pin {
                if !p.eq_ignore_ascii_case(&seen) {
                    return Err(format!("cert fingerprint {seen} does not match pin"));
                }
            }
            let (r, w) = tokio::io::split(tls);
            Ok((Box::pin(r) as BoxRead, Box::pin(w) as BoxWrite))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_probes_and_switches_back() {
        let mut h = Health::new(600.0);
        assert!(h.should_relay() && !h.probe_due(0.0) && !h.switch_pending());
        h.on_fail(100.0);
        assert!(!h.should_relay());
        assert!(!h.probe_due(699.0) && h.probe_due(700.0));
        // A failed probe reschedules at the base interval.
        h.on_probe(false, 700.0);
        assert!(!h.probe_due(1299.0) && h.probe_due(1300.0));
        // A good probe asks the current local session to hand over.
        h.on_probe(true, 1300.0);
        assert!(h.switch_pending() && h.should_relay() && !h.probe_due(5000.0));
        // The relay then stays mute: back off doubles.
        h.on_fail(1400.0);
        assert!(!h.should_relay() && !h.probe_due(1400.0 + 1199.0) && h.probe_due(1400.0 + 1200.0));
        h.on_fail(3000.0);
        h.on_fail(9000.0);
        h.on_fail(20000.0);
        h.on_fail(30000.0);
        assert!(h.probe_due(30000.0 + 3600.0) && !h.probe_due(30000.0 + 3599.0), "capped at an hour");
        h.on_reply();
        assert!(h.should_relay() && !h.switch_pending());
        h.on_fail(0.0);
        assert!(h.probe_due(600.0), "a reply resets the backoff");
    }
}
