//! Sans-I/O `rustls` + `aws-lc-rs` TLS termination with lock-free hot certificate reload
//! and session-ticket preservation across reloads.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use aws_lc_rs::digest::{Context, SHA256};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use rustls::crypto::{aws_lc_rs as tls_aws_lc_rs, CryptoProvider, SupportedKxGroup};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, CertificateRevocationListDer, PrivateKeyDer};
use rustls::server::danger::ClientCertVerifier;
use rustls::server::{ClientHello, ProducesTickets, ResolvesServerCert, WebPkiClientVerifier};
use rustls::sign::CertifiedKey;
use rustls::version::{TLS12, TLS13};
use rustls::{RootCertStore, SupportedCipherSuite, SupportedProtocolVersion};
pub use rustls::{ServerConfig, ServerConnection};

#[derive(Debug)]
pub enum TlsError {
    MissingMaterial,
    Io(io::Error),
    InvalidCertChain,
    InvalidPrivateKey,
    InvalidServerName(String),
    InvalidTicketKeys,
    InvalidCaCerts,
    InvalidCrl,
    MissingCaForClientAuth,
    InvalidClientVerifier(String),
    InvalidProtocolVersion(String),
    InvalidCipherSuite(String),
    InvalidEcdhCurve(String),
    Rustls(rustls::Error),
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingMaterial => write!(
                f,
                "TLS requires cert/key PEM or cert_file_name/key_file_name"
            ),
            Self::Io(err) => write!(f, "TLS file I/O error: {err}"),
            Self::InvalidCertChain => write!(f, "no valid PEM certificates found"),
            Self::InvalidPrivateKey => write!(f, "no valid PEM private key found"),
            Self::InvalidTicketKeys => write!(
                f,
                "TLS ticket keys must be one or more 48-byte entries (16-byte name + 32-byte key)"
            ),
            Self::InvalidCaCerts => write!(f, "no valid PEM CA certificates found"),
            Self::InvalidCrl => write!(f, "no valid PEM CRL entries found"),
            Self::MissingCaForClientAuth => {
                write!(f, "requestCert requires ca or ca_file_name trust anchors")
            }
            Self::InvalidClientVerifier(msg) => {
                write!(f, "invalid client certificate verifier: {msg}")
            }
            Self::InvalidProtocolVersion(v) => write!(f, "unsupported TLS protocol version: {v}"),
            Self::InvalidCipherSuite(c) => write!(f, "unsupported TLS cipher suite: {c}"),
            Self::InvalidEcdhCurve(c) => write!(f, "unsupported ECDH/KEM curve: {c}"),
            Self::InvalidServerName(s) => write!(f, "invalid SNI server name: {s}"),
            Self::Rustls(err) => write!(f, "rustls error: {err}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// SNI virtual-host certificate & private key pair (exact hostname or `*.domain` wildcard).
#[derive(Debug, Clone, Default)]
pub struct SniCertInput {
    pub server_name: String,
    pub cert_pem: Option<Vec<u8>>,
    pub key_pem: Option<Vec<u8>>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
}

/// TLS configuration material accepted by `TlsStore` (inline PEM or file paths, plus mTLS & policy).
#[derive(Debug, Clone, Default)]
pub struct TlsInput {
    pub cert_pem: Option<Vec<u8>>,
    pub key_pem: Option<Vec<u8>>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
    pub ca_pem: Option<Vec<u8>>,
    pub ca_file: Option<String>,
    pub crl_pem: Option<Vec<u8>>,
    pub crl_file: Option<String>,
    pub request_cert: bool,
    pub reject_unauthorized: bool,
    pub min_version: Option<String>,
    pub max_version: Option<String>,
    pub ciphers: Option<String>,
    pub ciphersuites: Option<String>,
    pub ecdh_curve: Option<String>,
    pub alpn_protocols: Vec<Vec<u8>>,
    /// Optional SNI certificates matched against the TLS ClientHello `server_name` extension.
    pub sni_certs: Vec<SniCertInput>,
    /// Optional shared session ticket key material for cross-worker TLS session resumption in cluster
    /// mode: one or more 48-byte entries (`16B key_name || 32B AES-256-GCM key`), newest first. The
    /// first entry seals new tickets; every entry opens them, so a key can be rotated in ahead of the
    /// one it replaces and retired once its tickets have expired.
    pub ticket_keys: Option<Vec<u8>>,
}

struct ResolvedSniMaterial {
    server_name: String,
    cert: Vec<u8>,
    key: Vec<u8>,
}

struct ResolvedMaterial {
    cert: Vec<u8>,
    key: Vec<u8>,
    ca: Option<Vec<u8>>,
    crl: Option<Vec<u8>>,
    sni: Vec<ResolvedSniMaterial>,
}

fn read_cert_key(
    cert_pem: &Option<Vec<u8>>,
    cert_file: &Option<String>,
    key_pem: &Option<Vec<u8>>,
    key_file: &Option<String>,
) -> Result<(Vec<u8>, Vec<u8>), TlsError> {
    let cert = match (cert_pem, cert_file) {
        (Some(bytes), _) => bytes.clone(),
        (None, Some(path)) => fs::read(path).map_err(TlsError::Io)?,
        (None, None) => return Err(TlsError::MissingMaterial),
    };
    let key = match (key_pem, key_file) {
        (Some(bytes), _) => bytes.clone(),
        (None, Some(path)) => fs::read(path).map_err(TlsError::Io)?,
        (None, None) => return Err(TlsError::MissingMaterial),
    };
    Ok((cert, key))
}

impl TlsInput {
    fn resolve_pem(&self) -> Result<ResolvedMaterial, TlsError> {
        let (cert, key) = read_cert_key(
            &self.cert_pem,
            &self.cert_file,
            &self.key_pem,
            &self.key_file,
        )?;
        let ca = match (&self.ca_pem, &self.ca_file) {
            (Some(bytes), _) => Some(bytes.clone()),
            (None, Some(path)) => Some(fs::read(path).map_err(TlsError::Io)?),
            (None, None) => None,
        };
        let crl = match (&self.crl_pem, &self.crl_file) {
            (Some(bytes), _) => Some(bytes.clone()),
            (None, Some(path)) => Some(fs::read(path).map_err(TlsError::Io)?),
            (None, None) => None,
        };
        let mut sni = Vec::with_capacity(self.sni_certs.len());
        for entry in &self.sni_certs {
            let normalized = normalize_server_name(&entry.server_name)?;
            let (sc, sk) = read_cert_key(
                &entry.cert_pem,
                &entry.cert_file,
                &entry.key_pem,
                &entry.key_file,
            )?;
            sni.push(ResolvedSniMaterial {
                server_name: normalized,
                cert: sc,
                key: sk,
            });
        }
        Ok(ResolvedMaterial {
            cert,
            key,
            ca,
            crl,
            sni,
        })
    }
}

/// Lock-free certificate store supporting live `reloadTls()` while preserving session tickets when
/// the TLS policy is unchanged (and rotating the ticketer whenever security policy changes).
#[derive(Debug)]
pub struct TlsStore {
    config: ArcSwap<ServerConfig>,
    ticket_state: Mutex<TicketState>,
}

struct TicketState {
    ticketer: Arc<dyn ProducesTickets>,
    policy_digest: [u8; 32],
    shared_keys: Option<Vec<u8>>,
    active_input: TlsInput,
}

impl std::fmt::Debug for TicketState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TicketState")
            .field("policy_digest", &self.policy_digest)
            .field("has_shared_keys", &self.shared_keys.is_some())
            .finish_non_exhaustive()
    }
}

/// Cross-worker TLS session ticketer backed by AES-256-GCM (`aws-lc-rs`) using shared keys.
struct SharedKeyTicketer {
    /// Newest first; the first seals, all open.
    keys: Vec<TicketKey>,
    /// Deterministic SHA-256 digest of TLS authentication & security policy (bound via AEAD AAD).
    policy_digest: [u8; 32],
    rng: SystemRandom,
}

const TICKET_LIFETIME_SECS: u32 = 6 * 60 * 60;

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

struct TicketKey {
    name: [u8; 16],
    aead: LessSafeKey,
}

impl std::fmt::Debug for SharedKeyTicketer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedKeyTicketer").finish_non_exhaustive()
    }
}

#[inline]
fn ticket_aad(key_name: &[u8; 16], policy_digest: &[u8; 32]) -> [u8; 48] {
    let mut aad = [0u8; 48];
    aad[..16].copy_from_slice(key_name);
    aad[16..].copy_from_slice(policy_digest);
    aad
}

impl SharedKeyTicketer {
    /// Seal `plain` under the newest key, stamped with the time it was issued.
    ///
    /// The stamp rides inside the sealed bytes, so a key that stays in the list past the advertised
    /// lifetime still cannot resume a ticket older than it.
    fn seal(&self, issued: u64, plain: &[u8]) -> Option<Vec<u8>> {
        let key = self.keys.first()?;
        let mut nonce_bytes = [0u8; 12];
        self.rng.fill(&mut nonce_bytes).ok()?;
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);
        let mut in_out = Vec::with_capacity(8 + plain.len() + 16);
        in_out.extend_from_slice(&issued.to_be_bytes());
        in_out.extend_from_slice(plain);
        let aad = ticket_aad(&key.name, &self.policy_digest);
        key.aead
            .seal_in_place_append_tag(nonce, Aad::from(&aad), &mut in_out)
            .ok()?;
        let mut ticket = Vec::with_capacity(16 + 12 + in_out.len());
        ticket.extend_from_slice(&key.name);
        ticket.extend_from_slice(&nonce_bytes);
        ticket.extend_from_slice(&in_out);
        Some(ticket)
    }

    fn from_bytes_with_policy(raw: &[u8], policy_digest: [u8; 32]) -> Result<Self, TlsError> {
        if raw.is_empty() || raw.len() % 48 != 0 {
            return Err(TlsError::InvalidTicketKeys);
        }
        let mut keys: Vec<TicketKey> = Vec::with_capacity(raw.len() / 48);
        for entry in raw.chunks_exact(48) {
            let mut name = [0u8; 16];
            name.copy_from_slice(&entry[..16]);
            // Two keys under one name could not be told apart when a ticket comes back.
            if keys.iter().any(|key| key.name == name) {
                return Err(TlsError::InvalidTicketKeys);
            }
            let unbound = UnboundKey::new(&AES_256_GCM, &entry[16..])
                .map_err(|_| TlsError::InvalidTicketKeys)?;
            keys.push(TicketKey {
                name,
                aead: LessSafeKey::new(unbound),
            });
        }
        Ok(Self {
            keys,
            policy_digest,
            rng: SystemRandom::new(),
        })
    }

    #[cfg(test)]
    fn from_bytes(raw: &[u8]) -> Result<Self, TlsError> {
        Self::from_bytes_with_policy(raw, [0u8; 32])
    }
}

impl ProducesTickets for SharedKeyTicketer {
    fn enabled(&self) -> bool {
        true
    }

    fn lifetime(&self) -> u32 {
        TICKET_LIFETIME_SECS
    }

    fn encrypt(&self, plain: &[u8]) -> Option<Vec<u8>> {
        self.seal(unix_secs(), plain)
    }

    fn decrypt(&self, cipher: &[u8]) -> Option<Vec<u8>> {
        if cipher.len() < 16 + 12 + 16 {
            return None;
        }
        let key = self.keys.iter().find(|key| cipher[..16] == key.name)?;
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes.copy_from_slice(&cipher[16..28]);
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);
        let mut buf = cipher[28..].to_vec();
        let aad = ticket_aad(&key.name, &self.policy_digest);
        let plain = key
            .aead
            .open_in_place(nonce, Aad::from(&aad), &mut buf)
            .ok()?;
        let (issued, rest) = plain.split_first_chunk::<8>()?;
        let age = unix_secs().saturating_sub(u64::from_be_bytes(*issued));
        (age <= u64::from(TICKET_LIFETIME_SECS)).then(|| rest.to_vec())
    }
}

impl TlsStore {
    pub fn from_input(input: &TlsInput) -> Result<Self, TlsError> {
        let mat = input.resolve_pem()?;
        let fp = policy_digest(input, &mat);
        let (ticketer, shared_keys): (Arc<dyn ProducesTickets>, Option<Vec<u8>>) =
            match &input.ticket_keys {
                Some(bytes) => (
                    Arc::new(SharedKeyTicketer::from_bytes_with_policy(bytes, fp)?),
                    Some(bytes.clone()),
                ),
                None => (
                    tls_aws_lc_rs::Ticketer::new().map_err(TlsError::Rustls)?,
                    None,
                ),
            };
        let cfg = build_config(input, &mat, Arc::clone(&ticketer))?;
        Ok(Self {
            config: ArcSwap::from_pointee(cfg),
            ticket_state: Mutex::new(TicketState {
                ticketer,
                policy_digest: fp,
                shared_keys,
                active_input: input.clone(),
            }),
        })
    }

    pub fn from_pem(
        cert_pem: &[u8],
        key_pem: &[u8],
        alpn_protocols: Vec<Vec<u8>>,
    ) -> Result<Self, TlsError> {
        Self::from_input(&TlsInput {
            cert_pem: Some(cert_pem.to_vec()),
            key_pem: Some(key_pem.to_vec()),
            alpn_protocols,
            ..Default::default()
        })
    }

    /// Atomically swap the TLS certificate/key and policy for all future handshakes. Session
    /// tickets survive cert/key rotation when security policy is unchanged; any change to mTLS,
    /// protocol bounds, cipher suites, or curves rotates an ephemeral ticketer so stale tickets
    /// cannot resume under loosened assumptions. Leaves the previous config intact on any error.
    pub fn reload_input(&self, input: &TlsInput) -> Result<(), TlsError> {
        let mat = input.resolve_pem()?;
        let fp = policy_digest(input, &mat);
        let mut guard = self.ticket_state.lock().unwrap_or_else(|e| e.into_inner());

        // Validate/construct replacement ticketer before storing `ServerConfig` so failures leave
        // both the active config and active ticketer untouched.
        let (next_ticketer, next_shared) = match &input.ticket_keys {
            Some(bytes) => {
                if guard.policy_digest == fp
                    && guard.shared_keys.as_deref() == Some(bytes.as_slice())
                {
                    (Arc::clone(&guard.ticketer), Some(bytes.clone()))
                } else {
                    (
                        Arc::new(SharedKeyTicketer::from_bytes_with_policy(bytes, fp)?)
                            as Arc<dyn ProducesTickets>,
                        Some(bytes.clone()),
                    )
                }
            }
            None => {
                if guard.shared_keys.is_none() && guard.policy_digest == fp {
                    (Arc::clone(&guard.ticketer), None)
                } else {
                    (
                        tls_aws_lc_rs::Ticketer::new().map_err(TlsError::Rustls)?,
                        None,
                    )
                }
            }
        };

        let cfg = build_config(input, &mat, Arc::clone(&next_ticketer))?;
        self.config.store(Arc::new(cfg));
        guard.ticketer = next_ticketer;
        guard.policy_digest = fp;
        guard.shared_keys = next_shared;
        guard.active_input = input.clone();
        Ok(())
    }

    pub fn reload_pem(
        &self,
        cert_pem: &[u8],
        key_pem: &[u8],
        alpn_protocols: Vec<Vec<u8>>,
    ) -> Result<(), TlsError> {
        let next = {
            let guard = self.ticket_state.lock().unwrap_or_else(|e| e.into_inner());
            input_with_pem_override(&guard.active_input, cert_pem, key_pem, alpn_protocols)
        };
        self.reload_input(&next)
    }

    /// Add or replace an SNI certificate entry and atomically reload the store (preserving tickets).
    pub fn add_server_name(&self, entry: SniCertInput) -> Result<(), TlsError> {
        let normalized = normalize_server_name(&entry.server_name)?;
        let mut next = {
            let guard = self.ticket_state.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_input.clone()
        };
        next.sni_certs.retain(|existing| {
            normalize_server_name(&existing.server_name).ok().as_deref()
                != Some(normalized.as_str())
        });
        let mut normalized_entry = entry;
        normalized_entry.server_name = normalized;
        next.sni_certs.push(normalized_entry);
        self.reload_input(&next)
    }

    /// Remove an SNI certificate entry and atomically reload the store. Returns `true` if removed.
    pub fn remove_server_name(&self, server_name: &str) -> Result<bool, TlsError> {
        let normalized = normalize_server_name(server_name)?;
        let mut next = {
            let guard = self.ticket_state.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_input.clone()
        };
        let before = next.sni_certs.len();
        next.sni_certs.retain(|existing| {
            normalize_server_name(&existing.server_name).ok().as_deref()
                != Some(normalized.as_str())
        });
        if next.sni_certs.len() == before {
            return Ok(false);
        }
        self.reload_input(&next)?;
        Ok(true)
    }

    /// Create a sans-I/O `ServerConnection` for a newly accepted socket.
    pub fn new_connection(&self) -> Result<ServerConnection, TlsError> {
        let cfg = self.config.load_full();
        ServerConnection::new(cfg).map_err(TlsError::Rustls)
    }
}

fn normalize_server_name(raw: &str) -> Result<String, TlsError> {
    let trimmed = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.bytes().any(|b| b.is_ascii_control() || b == b' ') {
        return Err(TlsError::InvalidServerName(raw.to_owned()));
    }
    if let Some(rest) = trimmed.strip_prefix("*.") {
        if rest.is_empty() || rest.contains('*') || !rest.contains('.') {
            return Err(TlsError::InvalidServerName(raw.to_owned()));
        }
    } else if trimmed.contains('*') {
        return Err(TlsError::InvalidServerName(raw.to_owned()));
    }
    Ok(trimmed)
}

#[derive(Debug)]
struct SniCertResolver {
    default: Arc<CertifiedKey>,
    exact: HashMap<String, Arc<CertifiedKey>>,
    wildcards: HashMap<String, Arc<CertifiedKey>>,
}

impl SniCertResolver {
    fn resolve_for_name(&self, server_name: Option<&str>) -> Arc<CertifiedKey> {
        if let Some(name) = server_name {
            let clean = name.trim_end_matches('.').to_ascii_lowercase();
            if let Some(cert) = self.exact.get(&clean) {
                return Arc::clone(cert);
            }
            if let Some((_, suffix)) = clean.split_once('.') {
                if let Some(cert) = self.wildcards.get(suffix) {
                    return Arc::clone(cert);
                }
            }
        }
        Arc::clone(&self.default)
    }
}

impl ResolvesServerCert for SniCertResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.resolve_for_name(client_hello.server_name()))
    }
}

fn input_with_pem_override(
    base: &TlsInput,
    cert_pem: &[u8],
    key_pem: &[u8],
    alpn_protocols: Vec<Vec<u8>>,
) -> TlsInput {
    let mut next = base.clone();
    next.cert_pem = Some(cert_pem.to_vec());
    next.key_pem = Some(key_pem.to_vec());
    next.cert_file = None;
    next.key_file = None;
    next.alpn_protocols = alpn_protocols;
    next
}

fn feed_opt_bytes(ctx: &mut Context, bytes: Option<&[u8]>) {
    match bytes {
        Some(slice) => {
            ctx.update(&[1]);
            ctx.update(&(slice.len() as u64).to_be_bytes());
            ctx.update(slice);
        }
        None => ctx.update(&[0]),
    }
}

/// Deterministic SHA-256 digest of TLS authentication & security policy (excludes leaf cert/key and
/// `ticket_keys` so cert-only renewals and ticket-key rotations preserve sessions under equal policy).
fn policy_digest(input: &TlsInput, mat: &ResolvedMaterial) -> [u8; 32] {
    let mut ctx = Context::new(&SHA256);
    ctx.update(b"nifra-tls-policy-v1");
    feed_opt_bytes(&mut ctx, mat.ca.as_deref());
    feed_opt_bytes(&mut ctx, mat.crl.as_deref());
    ctx.update(&[
        u8::from(input.request_cert),
        u8::from(input.reject_unauthorized),
    ]);
    feed_opt_bytes(&mut ctx, input.min_version.as_deref().map(str::as_bytes));
    feed_opt_bytes(&mut ctx, input.max_version.as_deref().map(str::as_bytes));
    feed_opt_bytes(&mut ctx, input.ciphers.as_deref().map(str::as_bytes));
    feed_opt_bytes(&mut ctx, input.ciphersuites.as_deref().map(str::as_bytes));
    feed_opt_bytes(&mut ctx, input.ecdh_curve.as_deref().map(str::as_bytes));
    let digest = ctx.finish();
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn parse_tls_version(raw: &str) -> Result<u8, TlsError> {
    match raw.trim() {
        "TLSv1.2" | "1.2" => Ok(12),
        "TLSv1.3" | "1.3" => Ok(13),
        other => Err(TlsError::InvalidProtocolVersion(other.to_owned())),
    }
}

fn resolve_protocol_versions(
    min_version: Option<&str>,
    max_version: Option<&str>,
) -> Result<Vec<&'static SupportedProtocolVersion>, TlsError> {
    let min = min_version
        .map(parse_tls_version)
        .transpose()?
        .unwrap_or(12);
    let max = max_version
        .map(parse_tls_version)
        .transpose()?
        .unwrap_or(13);
    if min > max {
        return Err(TlsError::InvalidProtocolVersion(format!(
            "minVersion TLSv1.{} > maxVersion TLSv1.{}",
            min - 10,
            max - 10
        )));
    }
    let mut out = Vec::with_capacity(2);
    if max >= 13 && min <= 13 {
        out.push(&TLS13);
    }
    if min <= 12 && max >= 12 {
        out.push(&TLS12);
    }
    Ok(out)
}

fn match_cipher_suite(token: &str) -> Option<SupportedCipherSuite> {
    let u = token.trim().to_ascii_uppercase();
    match u.as_str() {
        "TLS_AES_256_GCM_SHA384" | "TLS13_AES_256_GCM_SHA384" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS13_AES_256_GCM_SHA384)
        }
        "TLS_AES_128_GCM_SHA256" | "TLS13_AES_128_GCM_SHA256" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS13_AES_128_GCM_SHA256)
        }
        "TLS_CHACHA20_POLY1305_SHA256" | "TLS13_CHACHA20_POLY1305_SHA256" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256)
        }
        "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384" | "ECDHE-ECDSA-AES256-GCM-SHA384" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384)
        }
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256" | "ECDHE-ECDSA-AES128-GCM-SHA256" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256)
        }
        "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256" | "ECDHE-ECDSA-CHACHA20-POLY1305" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256)
        }
        "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384" | "ECDHE-RSA-AES256-GCM-SHA384" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384)
        }
        "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" | "ECDHE-RSA-AES128-GCM-SHA256" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)
        }
        "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256" | "ECDHE-RSA-CHACHA20-POLY1305" => {
            Some(tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256)
        }
        _ => None,
    }
}

fn push_unique_suite(out: &mut Vec<SupportedCipherSuite>, suite: SupportedCipherSuite) {
    if !out.contains(&suite) {
        out.push(suite);
    }
}

fn expand_cipher_selector(
    token: &str,
    out: &mut Vec<SupportedCipherSuite>,
) -> Result<(), TlsError> {
    if token.eq_ignore_ascii_case("HIGH") || token.eq_ignore_ascii_case("DEFAULT") {
        for &suite in tls_aws_lc_rs::DEFAULT_CIPHER_SUITES {
            push_unique_suite(out, suite);
        }
        return Ok(());
    }
    if token.eq_ignore_ascii_case("TLSv1.3") {
        for suite in [
            tls_aws_lc_rs::cipher_suite::TLS13_AES_256_GCM_SHA384,
            tls_aws_lc_rs::cipher_suite::TLS13_AES_128_GCM_SHA256,
            tls_aws_lc_rs::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
        ] {
            push_unique_suite(out, suite);
        }
        return Ok(());
    }
    if token.eq_ignore_ascii_case("TLSv1.2") {
        for suite in [
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            tls_aws_lc_rs::cipher_suite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        ] {
            push_unique_suite(out, suite);
        }
        return Ok(());
    }
    let suite =
        match_cipher_suite(token).ok_or_else(|| TlsError::InvalidCipherSuite(token.to_owned()))?;
    push_unique_suite(out, suite);
    Ok(())
}

fn resolve_cipher_suites(
    ciphers: Option<&str>,
    ciphersuites: Option<&str>,
) -> Result<Option<Vec<SupportedCipherSuite>>, TlsError> {
    if ciphers.is_none() && ciphersuites.is_none() {
        return Ok(None);
    }
    let mut selected = Vec::new();
    let mut excluded = Vec::new();
    let mut saw_positive = false;

    for raw in [ciphers, ciphersuites].into_iter().flatten() {
        for part in raw.split([':', ',', ' ', '\t']) {
            let token = part.trim();
            if token.is_empty() {
                continue;
            }
            if let Some(neg) = token.strip_prefix('!') {
                if neg.is_empty() {
                    return Err(TlsError::InvalidCipherSuite(token.to_owned()));
                }
                expand_cipher_selector(neg, &mut excluded)
                    .map_err(|_| TlsError::InvalidCipherSuite(token.to_owned()))?;
                continue;
            }
            saw_positive = true;
            expand_cipher_selector(token, &mut selected)?;
        }
    }

    if !saw_positive {
        selected.extend_from_slice(tls_aws_lc_rs::DEFAULT_CIPHER_SUITES);
    }
    selected.retain(|s| !excluded.contains(s));
    if selected.is_empty() {
        return Err(TlsError::InvalidCipherSuite(
            "no supported TLS cipher suites remain".to_owned(),
        ));
    }
    Ok(Some(selected))
}

fn match_kx_group(token: &str) -> Option<&'static dyn SupportedKxGroup> {
    match token.trim().to_ascii_uppercase().as_str() {
        "X25519" => Some(tls_aws_lc_rs::kx_group::X25519),
        "P-256" | "PRIME256V1" | "SECP256R1" => Some(tls_aws_lc_rs::kx_group::SECP256R1),
        "P-384" | "SECP384R1" => Some(tls_aws_lc_rs::kx_group::SECP384R1),
        "X25519MLKEM768" => Some(tls_aws_lc_rs::kx_group::X25519MLKEM768),
        "SECP256R1MLKEM768" => Some(tls_aws_lc_rs::kx_group::SECP256R1MLKEM768),
        "MLKEM768" => Some(tls_aws_lc_rs::kx_group::MLKEM768),
        "MLKEM1024" => Some(tls_aws_lc_rs::kx_group::MLKEM1024),
        _ => None,
    }
}

fn resolve_kx_groups(
    curve: Option<&str>,
) -> Result<Option<Vec<&'static dyn SupportedKxGroup>>, TlsError> {
    let Some(raw) = curve else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("auto") {
        return Ok(Some(tls_aws_lc_rs::ALL_KX_GROUPS.to_vec()));
    }
    let mut selected: Vec<&'static dyn SupportedKxGroup> = Vec::new();
    for part in trimmed.split([':', ',', ' ', '\t']) {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        let group =
            match_kx_group(token).ok_or_else(|| TlsError::InvalidEcdhCurve(token.to_owned()))?;
        if !selected.iter().any(|g| g.name() == group.name()) {
            selected.push(group);
        }
    }
    if selected.is_empty() {
        return Err(TlsError::InvalidEcdhCurve(
            "ecdhCurve must name at least one curve".to_owned(),
        ));
    }
    Ok(Some(selected))
}

fn parse_cert_pem<F>(pem: &[u8], on_error: F) -> Result<Vec<CertificateDer<'static>>, TlsError>
where
    F: Fn() -> TlsError,
{
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<_, _>>()
        .map_err(|_| on_error())?;
    if certs.is_empty() {
        return Err(on_error());
    }
    Ok(certs)
}

fn parse_ca_store(ca_pem: &[u8]) -> Result<RootCertStore, TlsError> {
    let certs = parse_cert_pem(ca_pem, || TlsError::InvalidCaCerts)?;
    let mut roots = RootCertStore::empty();
    for cert in certs {
        roots.add(cert).map_err(|_| TlsError::InvalidCaCerts)?;
    }
    Ok(roots)
}

fn parse_private_key(key_pem: &[u8]) -> Result<PrivateKeyDer<'static>, TlsError> {
    PrivateKeyDer::from_pem_slice(key_pem).map_err(|_| TlsError::InvalidPrivateKey)
}

fn parse_crls(crl_pem: &[u8]) -> Result<Vec<CertificateRevocationListDer<'static>>, TlsError> {
    let crls: Vec<CertificateRevocationListDer<'static>> =
        CertificateRevocationListDer::pem_slice_iter(crl_pem)
            .collect::<Result<_, _>>()
            .map_err(|_| TlsError::InvalidCrl)?;
    if crls.is_empty() {
        return Err(TlsError::InvalidCrl);
    }
    Ok(crls)
}

fn build_client_verifier(
    mat: &ResolvedMaterial,
    request_cert: bool,
    reject_unauthorized: bool,
    provider: &Arc<CryptoProvider>,
) -> Result<Option<Arc<dyn ClientCertVerifier>>, TlsError> {
    let parsed_crls = match &mat.crl {
        Some(pem) => Some(parse_crls(pem)?),
        None => None,
    };
    let parsed_roots = match &mat.ca {
        Some(pem) => Some(Arc::new(parse_ca_store(pem)?)),
        None => None,
    };
    if !request_cert {
        return Ok(None);
    }
    let roots = parsed_roots.ok_or(TlsError::MissingCaForClientAuth)?;
    let mut builder = WebPkiClientVerifier::builder_with_provider(roots, Arc::clone(provider));
    if let Some(crls) = parsed_crls {
        builder = builder.with_crls(crls);
    }
    if !reject_unauthorized {
        builder = builder.allow_unauthenticated();
    }
    let verifier = builder
        .build()
        .map_err(|e| TlsError::InvalidClientVerifier(e.to_string()))?;
    Ok(Some(verifier))
}

fn build_config(
    input: &TlsInput,
    mat: &ResolvedMaterial,
    ticketer: Arc<dyn ProducesTickets>,
) -> Result<ServerConfig, TlsError> {
    let certs = parse_cert_pem(&mat.cert, || TlsError::InvalidCertChain)?;
    let key = parse_private_key(&mat.key)?;

    let versions =
        resolve_protocol_versions(input.min_version.as_deref(), input.max_version.as_deref())?;
    let mut provider = tls_aws_lc_rs::default_provider();
    if let Some(suites) =
        resolve_cipher_suites(input.ciphers.as_deref(), input.ciphersuites.as_deref())?
    {
        provider.cipher_suites = suites;
    }
    if let Some(groups) = resolve_kx_groups(input.ecdh_curve.as_deref())? {
        provider.kx_groups = groups;
    }
    let provider = Arc::new(provider);
    let client_verifier = build_client_verifier(
        mat,
        input.request_cert,
        input.reject_unauthorized,
        &provider,
    )?;

    let wants_verifier = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(&versions)
        .map_err(TlsError::Rustls)?;
    let wants_cert = match client_verifier {
        Some(verifier) => wants_verifier.with_client_cert_verifier(verifier),
        None => wants_verifier.with_no_client_auth(),
    };
    let mut cfg = if mat.sni.is_empty() {
        wants_cert
            .with_single_cert(certs, key)
            .map_err(TlsError::Rustls)?
    } else {
        let default =
            Arc::new(CertifiedKey::from_der(certs, key, &provider).map_err(TlsError::Rustls)?);
        let mut exact = HashMap::new();
        let mut wildcards = HashMap::new();
        for entry in &mat.sni {
            let sc = parse_cert_pem(&entry.cert, || TlsError::InvalidCertChain)?;
            let sk = parse_private_key(&entry.key)?;
            let ck = Arc::new(CertifiedKey::from_der(sc, sk, &provider).map_err(TlsError::Rustls)?);
            if let Some(suffix) = entry.server_name.strip_prefix("*.") {
                wildcards.insert(suffix.to_owned(), ck);
            } else {
                exact.insert(entry.server_name.clone(), ck);
            }
        }
        wants_cert.with_cert_resolver(Arc::new(SniCertResolver {
            default,
            exact,
            wildcards,
        }))
    };
    cfg.alpn_protocols = input.alpn_protocols.clone();
    cfg.ticketer = ticketer;
    Ok(cfg)
}

/// Sans-I/O TLS receive step: feeds incoming ciphertext into `conn`, appends decrypted application
/// bytes into `plaintext_out`, and appends any handshake/alert TLS records into `ciphertext_out`.
///
/// Returns `Ok(true)` if the peer sent a TLS `close_notify` EOF.
pub fn feed_ciphertext(
    conn: &mut ServerConnection,
    ciphertext: &[u8],
    plaintext_out: &mut Vec<u8>,
    ciphertext_out: &mut Vec<u8>,
) -> Result<bool, rustls::Error> {
    let mut cursor = Cursor::new(ciphertext);
    let mut peer_closed = false;

    while (cursor.position() as usize) < ciphertext.len() {
        let before = cursor.position();
        match conn.read_tls(&mut cursor) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let state = match conn.process_new_packets() {
            Ok(s) => s,
            Err(err) => {
                // Flush any TLS alert generated for the peer before returning the error.
                while conn.wants_write() {
                    if conn.write_tls(ciphertext_out).unwrap_or(0) == 0 {
                        break;
                    }
                }
                return Err(err);
            }
        };
        if state.peer_has_closed() {
            peer_closed = true;
        }
        if state.plaintext_bytes_to_read() > 0 {
            let mut tmp = [0u8; 16 * 1024];
            loop {
                match conn.reader().read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => plaintext_out.extend_from_slice(&tmp[..n]),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }
        }
        while conn.wants_write() {
            if conn.write_tls(ciphertext_out).unwrap_or(0) == 0 {
                break;
            }
        }
        if cursor.position() == before {
            break;
        }
    }

    Ok(peer_closed)
}

/// Sans-I/O TLS send step: encrypts `plaintext` into TLS records appended to `ciphertext_out`.
pub fn encrypt_plaintext(
    conn: &mut ServerConnection,
    plaintext: &[u8],
    ciphertext_out: &mut Vec<u8>,
) -> io::Result<()> {
    // rustls holds a bounded amount of unsent records, so a large write alternates with draining.
    let mut rest = plaintext;
    loop {
        let taken = conn.writer().write(rest)?;
        rest = &rest[taken..];
        let mut drained = 0;
        while conn.wants_write() {
            let n = conn.write_tls(ciphertext_out)?;
            if n == 0 {
                break;
            }
            drained += n;
        }
        if rest.is_empty() {
            return Ok(());
        }
        if taken == 0 && drained == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_pem_cleanly() {
        let err = TlsStore::from_pem(b"not a cert", b"not a key", vec![]).unwrap_err();
        assert!(matches!(err, TlsError::InvalidCertChain));
    }

    #[test]
    fn shared_ticket_keys_round_trip_across_workers() {
        let key = [0x42u8; 48];
        let worker_a = SharedKeyTicketer::from_bytes(&key).unwrap();
        let worker_b = SharedKeyTicketer::from_bytes(&key).unwrap();
        let mut ticket = worker_a.encrypt(b"session-state-payload").unwrap();
        assert_eq!(worker_b.decrypt(&ticket).unwrap(), b"session-state-payload");
        let last = ticket.len() - 1;
        ticket[last] ^= 0xff;
        assert!(worker_b.decrypt(&ticket).is_none());
    }

    #[test]
    fn a_ticket_older_than_its_lifetime_is_refused_even_under_a_current_key() {
        let ticketer = SharedKeyTicketer::from_bytes(&[0x33u8; 48]).unwrap();
        let now = unix_secs();
        let lifetime = u64::from(TICKET_LIFETIME_SECS);
        let fresh = ticketer.seal(now, b"state").unwrap();
        assert_eq!(ticketer.decrypt(&fresh).as_deref(), Some(&b"state"[..]));
        let edge = ticketer.seal(now - lifetime + 5, b"state").unwrap();
        assert!(ticketer.decrypt(&edge).is_some());
        let stale = ticketer.seal(now - lifetime - 5, b"state").unwrap();
        assert!(ticketer.decrypt(&stale).is_none());
    }

    #[test]
    fn rotated_ticket_keys_keep_old_tickets_valid_until_retired() {
        let old = [0x11u8; 48];
        let new = [0x22u8; 48];
        let before = SharedKeyTicketer::from_bytes(&old).unwrap();
        let ticket = before.encrypt(b"resume me").unwrap();

        // New key first, old one still listed: new tickets use the new key, old ones still open.
        let ring = [new.as_slice(), old.as_slice()].concat();
        let rotating = SharedKeyTicketer::from_bytes(&ring).unwrap();
        assert_eq!(rotating.decrypt(&ticket).unwrap(), b"resume me");
        let fresh = rotating.encrypt(b"fresh").unwrap();
        assert_eq!(fresh[..16], new[..16]);

        // A worker that has not rotated yet cannot open the new ticket; one that retired the old key
        // can no longer open old tickets.
        assert!(before.decrypt(&fresh).is_none());
        let retired = SharedKeyTicketer::from_bytes(&new).unwrap();
        assert!(retired.decrypt(&ticket).is_none());
        assert_eq!(retired.decrypt(&fresh).unwrap(), b"fresh");
    }

    #[test]
    fn malformed_ticket_key_material_is_refused() {
        for bad in [vec![], vec![1u8; 47], vec![1u8; 49], vec![1u8; 96]] {
            assert!(
                matches!(
                    SharedKeyTicketer::from_bytes(&bad),
                    Err(TlsError::InvalidTicketKeys)
                ),
                "{} bytes",
                bad.len()
            );
        }
        // Two entries that share a name (here, identical) are ambiguous.
        let twin = [[0x33u8; 48], [0x33u8; 48]].concat();
        assert!(SharedKeyTicketer::from_bytes(&twin).is_err());
    }

    #[test]
    fn tls_policy_validation_rejects_bad_versions_ciphers_curves_and_ca() {
        assert!(matches!(
            resolve_protocol_versions(Some("TLSv1.3"), Some("TLSv1.2")),
            Err(TlsError::InvalidProtocolVersion(_))
        ));
        assert!(matches!(
            resolve_protocol_versions(Some("SSLv3"), None),
            Err(TlsError::InvalidProtocolVersion(_))
        ));
        assert!(matches!(
            resolve_cipher_suites(Some("RC4-MD5"), None),
            Err(TlsError::InvalidCipherSuite(_))
        ));
        let suites = resolve_cipher_suites(Some("TLS_AES_256_GCM_SHA384"), None)
            .unwrap()
            .unwrap();
        assert_eq!(suites.len(), 1);
        assert!(matches!(
            resolve_kx_groups(Some("secp192r1")),
            Err(TlsError::InvalidEcdhCurve(_))
        ));
        assert_eq!(
            resolve_kx_groups(Some("X25519:P-256"))
                .unwrap()
                .unwrap()
                .len(),
            2
        );
        assert!(matches!(
            parse_ca_store(b"not a pem"),
            Err(TlsError::InvalidCaCerts)
        ));
        assert!(matches!(
            parse_crls(b"not a crl"),
            Err(TlsError::InvalidCrl)
        ));
    }

    #[test]
    fn shared_ticket_keys_are_bound_to_security_policy() {
        let key = [0x55u8; 48];
        let policy_a = [0x01u8; 32];
        let policy_b = [0x02u8; 32];
        let a1 = SharedKeyTicketer::from_bytes_with_policy(&key, policy_a).unwrap();
        let a2 = SharedKeyTicketer::from_bytes_with_policy(&key, policy_a).unwrap();
        let b1 = SharedKeyTicketer::from_bytes_with_policy(&key, policy_b).unwrap();

        let ticket = a1.encrypt(b"session-state").unwrap();
        assert_eq!(a2.decrypt(&ticket).as_deref(), Some(&b"session-state"[..]));
        // Same key bytes under a different auth/CRL policy must reject the old ticket.
        assert!(b1.decrypt(&ticket).is_none());
    }

    #[test]
    fn cipher_exclusions_expand_group_selectors_and_reject_unknown() {
        let tls13_only = resolve_cipher_suites(Some("TLSv1.3:TLSv1.2:!TLSv1.2"), None)
            .unwrap()
            .unwrap();
        assert_eq!(tls13_only.len(), 3);
        assert!(tls13_only.iter().all(|s| {
            matches!(
                s.suite(),
                rustls::CipherSuite::TLS13_AES_256_GCM_SHA384
                    | rustls::CipherSuite::TLS13_AES_128_GCM_SHA256
                    | rustls::CipherSuite::TLS13_CHACHA20_POLY1305_SHA256
            )
        }));
        assert!(matches!(
            resolve_cipher_suites(Some("DEFAULT:!UNKNOWN"), None),
            Err(TlsError::InvalidCipherSuite(_))
        ));
    }

    #[test]
    fn reload_pem_override_preserves_mtls_and_ticket_keys_policy() {
        let base = TlsInput {
            cert_file: Some("old-cert.pem".to_owned()),
            key_file: Some("old-key.pem".to_owned()),
            ca_pem: Some(b"ca-bytes".to_vec()),
            crl_pem: Some(b"crl-bytes".to_vec()),
            request_cert: true,
            reject_unauthorized: true,
            min_version: Some("TLSv1.2".to_owned()),
            max_version: Some("TLSv1.3".to_owned()),
            ciphers: Some("TLSv1.3:TLSv1.2".to_owned()),
            ecdh_curve: Some("X25519:P-256".to_owned()),
            alpn_protocols: vec![b"h2".to_vec()],
            ticket_keys: Some(vec![0x77u8; 48]),
            ..Default::default()
        };
        let next =
            input_with_pem_override(&base, b"new-cert", b"new-key", vec![b"http/1.1".to_vec()]);
        assert_eq!(next.cert_pem.as_deref(), Some(&b"new-cert"[..]));
        assert_eq!(next.key_pem.as_deref(), Some(&b"new-key"[..]));
        assert!(next.cert_file.is_none());
        assert!(next.key_file.is_none());
        assert_eq!(next.ca_pem, base.ca_pem);
        assert_eq!(next.crl_pem, base.crl_pem);
        assert!(next.request_cert);
        assert!(next.reject_unauthorized);
        assert_eq!(next.min_version, base.min_version);
        assert_eq!(next.max_version, base.max_version);
        assert_eq!(next.ciphers, base.ciphers);
        assert_eq!(next.ecdh_curve, base.ecdh_curve);
        assert_eq!(next.ticket_keys, base.ticket_keys);
        assert_eq!(next.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn pem_object_parsing_handles_mixed_sections_and_malformed_inputs() {
        // `parse_crls` skips non-CRL PEM blocks and decodes `X509 CRL` sections.
        let mixed = b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n\
-----BEGIN X509 CRL-----\nBAUG\n-----END X509 CRL-----\n";
        let crls = parse_crls(mixed).unwrap();
        assert_eq!(crls.len(), 1);
        assert_eq!(crls[0].as_ref(), &[4, 5, 6]);

        // Only non-CRL PEM blocks -> still rejected as missing CRL.
        let cert_only = b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
        assert!(matches!(parse_crls(cert_only), Err(TlsError::InvalidCrl)));

        // Truncated PEM section (missing END marker) -> rejected cleanly.
        let truncated = b"-----BEGIN X509 CRL-----\nBAUG\n";
        assert!(matches!(parse_crls(truncated), Err(TlsError::InvalidCrl)));
        assert!(matches!(
            parse_ca_store(b"-----BEGIN CERTIFICATE-----\nAQID\n"),
            Err(TlsError::InvalidCaCerts)
        ));
    }

    #[test]
    fn private_key_pem_supports_pkcs1_pkcs8_sec1_and_rejects_missing_or_malformed() {
        let pkcs1 = parse_private_key(
            b"-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----\n",
        )
        .unwrap();
        assert!(matches!(pkcs1, PrivateKeyDer::Pkcs1(_)));
        assert_eq!(pkcs1.secret_der(), &[1, 2, 3]);

        let pkcs8 =
            parse_private_key(b"-----BEGIN PRIVATE KEY-----\nBAUG\n-----END PRIVATE KEY-----\n")
                .unwrap();
        assert!(matches!(pkcs8, PrivateKeyDer::Pkcs8(_)));
        assert_eq!(pkcs8.secret_der(), &[4, 5, 6]);

        let sec1 = parse_private_key(
            b"-----BEGIN EC PRIVATE KEY-----\nBwgJ\n-----END EC PRIVATE KEY-----\n",
        )
        .unwrap();
        assert!(matches!(sec1, PrivateKeyDer::Sec1(_)));
        assert_eq!(sec1.secret_der(), &[7, 8, 9]);

        // Leading non-key PEM sections are skipped until a supported private key block.
        let cert_then_key = b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n\
-----BEGIN PRIVATE KEY-----\nBAUG\n-----END PRIVATE KEY-----\n";
        assert!(matches!(
            parse_private_key(cert_then_key),
            Ok(PrivateKeyDer::Pkcs8(_))
        ));

        // Missing key block (empty or cert-only) -> InvalidPrivateKey.
        assert!(matches!(
            parse_private_key(b""),
            Err(TlsError::InvalidPrivateKey)
        ));
        assert!(matches!(
            parse_private_key(b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n"),
            Err(TlsError::InvalidPrivateKey)
        ));

        // Malformed PEM (missing END marker / invalid base64) -> InvalidPrivateKey.
        assert!(matches!(
            parse_private_key(b"-----BEGIN PRIVATE KEY-----\nBAUG\n"),
            Err(TlsError::InvalidPrivateKey)
        ));
        assert!(matches!(
            parse_private_key(b"-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----\n"),
            Err(TlsError::InvalidPrivateKey)
        ));

        // `TlsStore::from_pem` reaches `parse_private_key` after parsing certificates.
        let valid_cert_block = b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
        assert!(matches!(
            TlsStore::from_pem(valid_cert_block, b"not a key", vec![]),
            Err(TlsError::InvalidPrivateKey)
        ));
    }

    #[test]
    fn sni_server_name_normalization_matches_exact_and_single_label_wildcard() {
        assert_eq!(
            normalize_server_name("Example.COM.").unwrap(),
            "example.com"
        );
        assert_eq!(
            normalize_server_name("*.Example.com").unwrap(),
            "*.example.com"
        );
        assert!(matches!(
            normalize_server_name(""),
            Err(TlsError::InvalidServerName(_))
        ));
        assert!(matches!(
            normalize_server_name("*.localhost"),
            Err(TlsError::InvalidServerName(_))
        ));
        assert!(matches!(
            normalize_server_name("*.*.example.com"),
            Err(TlsError::InvalidServerName(_))
        ));
    }
}
