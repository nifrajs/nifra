//! Sans-I/O `rustls` + `aws-lc-rs` TLS termination with lock-free hot certificate reload
//! and session-ticket preservation across reloads.

use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::sync::Arc;

use arc_swap::ArcSwap;
use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::ProducesTickets;
pub use rustls::{ServerConfig, ServerConnection};

#[derive(Debug)]
pub enum TlsError {
    MissingMaterial,
    Io(io::Error),
    InvalidCertChain,
    InvalidPrivateKey,
    InvalidTicketKeys,
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
            Self::Rustls(err) => write!(f, "rustls error: {err}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// TLS configuration material accepted by `TlsStore` (inline PEM or file paths).
#[derive(Debug, Clone)]
pub struct TlsInput {
    pub cert_pem: Option<Vec<u8>>,
    pub key_pem: Option<Vec<u8>>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
    pub alpn_protocols: Vec<Vec<u8>>,
    /// Optional shared session ticket key material for cross-worker TLS session resumption in cluster
    /// mode: one or more 48-byte entries (`16B key_name || 32B AES-256-GCM key`), newest first. The
    /// first entry seals new tickets; every entry opens them, so a key can be rotated in ahead of the
    /// one it replaces and retired once its tickets have expired.
    pub ticket_keys: Option<Vec<u8>>,
}

impl TlsInput {
    fn resolve_pem(&self) -> Result<(Vec<u8>, Vec<u8>), TlsError> {
        let cert = match (&self.cert_pem, &self.cert_file) {
            (Some(bytes), _) => bytes.clone(),
            (None, Some(path)) => fs::read(path).map_err(TlsError::Io)?,
            (None, None) => return Err(TlsError::MissingMaterial),
        };
        let key = match (&self.key_pem, &self.key_file) {
            (Some(bytes), _) => bytes.clone(),
            (None, Some(path)) => fs::read(path).map_err(TlsError::Io)?,
            (None, None) => return Err(TlsError::MissingMaterial),
        };
        Ok((cert, key))
    }
}

/// Lock-free certificate store supporting live `reloadTls()` while preserving session tickets.
#[derive(Debug)]
pub struct TlsStore {
    config: ArcSwap<ServerConfig>,
    ticketer: Arc<dyn ProducesTickets>,
}

/// Cross-worker TLS session ticketer backed by AES-256-GCM (`aws-lc-rs`) using shared keys.
struct SharedKeyTicketer {
    /// Newest first; the first seals, all open.
    keys: Vec<TicketKey>,
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
        key.aead
            .seal_in_place_append_tag(nonce, Aad::from(&key.name), &mut in_out)
            .ok()?;
        let mut ticket = Vec::with_capacity(16 + 12 + in_out.len());
        ticket.extend_from_slice(&key.name);
        ticket.extend_from_slice(&nonce_bytes);
        ticket.extend_from_slice(&in_out);
        Some(ticket)
    }

    fn from_bytes(raw: &[u8]) -> Result<Self, TlsError> {
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
            rng: SystemRandom::new(),
        })
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
        let plain = key
            .aead
            .open_in_place(nonce, Aad::from(&key.name), &mut buf)
            .ok()?;
        let (issued, rest) = plain.split_first_chunk::<8>()?;
        let age = unix_secs().saturating_sub(u64::from_be_bytes(*issued));
        (age <= u64::from(TICKET_LIFETIME_SECS)).then(|| rest.to_vec())
    }
}

impl TlsStore {
    pub fn from_input(input: &TlsInput) -> Result<Self, TlsError> {
        let (cert, key) = input.resolve_pem()?;
        let ticketer: Arc<dyn ProducesTickets> = match &input.ticket_keys {
            Some(bytes) => Arc::new(SharedKeyTicketer::from_bytes(bytes)?),
            None => rustls::crypto::aws_lc_rs::Ticketer::new().map_err(TlsError::Rustls)?,
        };
        let cfg = build_config(
            &cert,
            &key,
            input.alpn_protocols.clone(),
            Arc::clone(&ticketer),
        )?;
        Ok(Self {
            config: ArcSwap::from_pointee(cfg),
            ticketer,
        })
    }

    pub fn from_pem(
        cert_pem: &[u8],
        key_pem: &[u8],
        alpn_protocols: Vec<Vec<u8>>,
    ) -> Result<Self, TlsError> {
        let ticketer: Arc<dyn ProducesTickets> =
            rustls::crypto::aws_lc_rs::Ticketer::new().map_err(TlsError::Rustls)?;
        let cfg = build_config(cert_pem, key_pem, alpn_protocols, Arc::clone(&ticketer))?;
        Ok(Self {
            config: ArcSwap::from_pointee(cfg),
            ticketer,
        })
    }

    /// Atomically swap the TLS certificate/key for all future handshakes while preserving session
    /// tickets. Leaves the previous certificate in place if validation fails.
    pub fn reload_input(&self, input: &TlsInput) -> Result<(), TlsError> {
        let (cert, key) = input.resolve_pem()?;
        self.reload_pem(&cert, &key, input.alpn_protocols.clone())
    }

    pub fn reload_pem(
        &self,
        cert_pem: &[u8],
        key_pem: &[u8],
        alpn_protocols: Vec<Vec<u8>>,
    ) -> Result<(), TlsError> {
        let cfg = build_config(
            cert_pem,
            key_pem,
            alpn_protocols,
            Arc::clone(&self.ticketer),
        )?;
        self.config.store(Arc::new(cfg));
        Ok(())
    }

    /// Create a sans-I/O `ServerConnection` for a newly accepted socket.
    pub fn new_connection(&self) -> Result<ServerConnection, TlsError> {
        let cfg = self.config.load_full();
        ServerConnection::new(cfg).map_err(TlsError::Rustls)
    }
}

fn build_config(
    cert_pem: &[u8],
    key_pem: &[u8],
    alpn_protocols: Vec<Vec<u8>>,
    ticketer: Arc<dyn ProducesTickets>,
) -> Result<ServerConfig, TlsError> {
    let mut cert_reader = Cursor::new(cert_pem);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<_, _>>()
        .map_err(|_| TlsError::InvalidCertChain)?;
    if certs.is_empty() {
        return Err(TlsError::InvalidCertChain);
    }

    let mut key_reader = Cursor::new(key_pem);
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|_| TlsError::InvalidPrivateKey)?
        .ok_or(TlsError::InvalidPrivateKey)?;

    let mut cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(TlsError::Rustls)?;
    cfg.alpn_protocols = alpn_protocols;
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
    if !plaintext.is_empty() {
        conn.writer().write_all(plaintext)?;
    }
    while conn.wants_write() {
        if conn.write_tls(ciphertext_out)? == 0 {
            break;
        }
    }
    Ok(())
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
}
