//! SASL-based authentication support.

use base64::Engine;
use base64::display::Base64Display;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, KeyInit, Mac};
use rand::{self, RngExt};
use sha1::Sha1;
use sha2::digest::FixedOutput;
use sha2::{Digest, Sha256};
use std::fmt::Write;
use std::io;
use std::iter;
use std::mem;
use std::str;

const NONCE_LENGTH: usize = 24;

/// The maximum SCRAM iteration count the client will accept from the server.
///
/// The iteration count is sent by the server and drives a PBKDF2 loop, so an
/// unbounded value lets a malicious or impersonating server force the client to
/// perform an arbitrary number of HMAC operations before authentication even
/// completes (a denial of service). 100_000 is ~24x the PostgreSQL default of
/// 4096 and matches the default cap the PostgreSQL JDBC driver (pgjdbc) adopted
/// for the same issue (CVE-2026-42198).
const MAX_ITERATION_COUNT: u32 = 100_000;

/// The identifier of the SCRAM-SHA-256 SASL authentication mechanism.
pub const SCRAM_SHA_256: &str = "SCRAM-SHA-256";
/// The identifier of the SCRAM-SHA-256-PLUS SASL authentication mechanism.
pub const SCRAM_SHA_256_PLUS: &str = "SCRAM-SHA-256-PLUS";
/// The identifier of the GaussDB/openGauss SHA256 SASL authentication mechanism.
pub const GAUSSDB_SHA256: &str = "SHA256";
/// The identifier of the GaussDB/openGauss MD5_SHA256 SASL authentication mechanism.
pub const GAUSSDB_MD5_SHA256: &str = "MD5_SHA256";

// since postgres passwords are not required to exclude saslprep-prohibited
// characters or even be valid UTF8, we run saslprep if possible and otherwise
// return the raw password.
fn normalize(pass: &[u8]) -> Vec<u8> {
    let pass = match str::from_utf8(pass) {
        Ok(pass) => pass,
        Err(_) => return pass.to_vec(),
    };

    match stringprep::saslprep(pass) {
        Ok(pass) => pass.into_owned().into_bytes(),
        Err(_) => pass.as_bytes().to_vec(),
    }
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(data: &str) -> Result<Vec<u8>, String> {
    if data.len() % 2 != 0 {
        return Err("invalid hex length".into());
    }

    let mut out = Vec::with_capacity(data.len() / 2);
    let bytes = data.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char)
            .to_digit(16)
            .ok_or_else(|| "invalid hex digit".to_string())?;
        let lo = (bytes[i + 1] as char)
            .to_digit(16)
            .ok_or_else(|| "invalid hex digit".to_string())?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Ok(out)
}

/// Derive salted password for GaussDB SHA256 authentication.
/// GaussDB pre-hashes the password with SHA256 and hex-encodes it
/// before feeding it to the Hi() function.
fn derive_gaussdb_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let pwd_sha = sha2::Sha256::digest(password);
    let pwd_hex = hex_encode(&pwd_sha);
    hi(pwd_hex.as_bytes(), salt, iterations)
}

/// Derive salted password for GaussDB MD5_SHA256 authentication.
/// GaussDB computes MD5(password + username), then SHA256("md5" + md5_hex),
/// then feeds the hex-encoded result to Hi().
fn derive_gaussdb_md5_sha256(
    password: &[u8],
    username: &str,
    salt: &[u8],
    iterations: u32,
) -> [u8; 32] {
    let mut hasher = md5::Md5::new();
    hasher.update(password);
    hasher.update(username.as_bytes());
    let md5_result = hasher.finalize();
    let md5_hex = format!("md5{}", hex_encode(&md5_result));

    let sha_result = sha2::Sha256::digest(md5_hex.as_bytes());
    let sha_hex = hex_encode(&sha_result);
    hi(sha_hex.as_bytes(), salt, iterations)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut hmac =
        Hmac::<Sha256>::new_from_slice(key).expect("HMAC is able to accept all key sizes");
    hmac.update(data);
    hmac.finalize().into_bytes().into()
}

fn detect_iteration(
    password: &[u8],
    salt: &[u8],
    token_bytes: &[u8],
    expected_sig_hex: &str,
    server_iteration: u32,
) -> Result<u32, String> {
    let expected_sig = hex_decode(expected_sig_hex)?;

    for &candidate in &[server_iteration, 10000, 2048] {
        let mut k = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha1>(password, salt, candidate, &mut k);
        let server_key = hmac_sha256(&k, b"Sever Key");
        let candidate_sig = hmac_sha256(&server_key, token_bytes);
        if candidate_sig.as_slice() == expected_sig.as_slice() {
            return Ok(candidate);
        }
    }

    Err("unable to match GaussDB server iteration".into())
}

/// Computes the legacy/openGauss-style SHA256 challenge-response proof used by
/// GaussDB's non-standard `AuthenticationSASL` variant.
pub fn gaussdb_rfc5802_sha256(
    password: &[u8],
    random64code: &str,
    token: &str,
    server_signature_hex: Option<&str>,
    server_iteration: u32,
) -> Result<String, String> {
    let salt = hex_decode(random64code)?;
    let token_bytes = hex_decode(token)?;

    let iteration = if let Some(expected_sig) = server_signature_hex {
        detect_iteration(
            password,
            &salt,
            &token_bytes,
            expected_sig,
            server_iteration,
        )?
    } else {
        server_iteration
    };

    let mut k = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha1>(password, &salt, iteration, &mut k);
    let client_key = hmac_sha256(&k, b"Client Key");
    let stored_key = Sha256::digest(client_key);
    let hmac_result = hmac_sha256(stored_key.as_slice(), &token_bytes);
    let mut proof = hmac_result;
    for (a, b) in proof.iter_mut().zip(client_key.iter()) {
        *a ^= b;
    }

    Ok(hex_encode(&proof))
}

pub(crate) fn hi(str: &[u8], salt: &[u8], i: u32) -> [u8; 32] {
    let mut hmac =
        Hmac::<Sha256>::new_from_slice(str).expect("HMAC is able to accept all key sizes");
    hmac.update(salt);
    hmac.update(&[0, 0, 0, 1]);
    let mut prev = hmac.finalize().into_bytes();

    let mut hi = prev;

    for _ in 1..i {
        let mut hmac = Hmac::<Sha256>::new_from_slice(str).expect("already checked above");
        hmac.update(&prev);
        prev = hmac.finalize().into_bytes();

        for (hi, prev) in hi.iter_mut().zip(prev) {
            *hi ^= prev;
        }
    }

    hi.into()
}

enum ChannelBindingInner {
    Unrequested,
    Unsupported,
    TlsServerEndPoint(Vec<u8>),
}

/// The channel binding configuration for a SCRAM authentication exchange.
pub struct ChannelBinding(ChannelBindingInner);

impl ChannelBinding {
    /// The server did not request channel binding.
    pub fn unrequested() -> ChannelBinding {
        ChannelBinding(ChannelBindingInner::Unrequested)
    }

    /// The server requested channel binding but the client is unable to provide it.
    pub fn unsupported() -> ChannelBinding {
        ChannelBinding(ChannelBindingInner::Unsupported)
    }

    /// The server requested channel binding and the client will use the `tls-server-end-point`
    /// method.
    pub fn tls_server_end_point(signature: Vec<u8>) -> ChannelBinding {
        ChannelBinding(ChannelBindingInner::TlsServerEndPoint(signature))
    }

    fn gs2_header(&self) -> &'static str {
        match self.0 {
            ChannelBindingInner::Unrequested => "y,,",
            ChannelBindingInner::Unsupported => "n,,",
            ChannelBindingInner::TlsServerEndPoint(_) => "p=tls-server-end-point,,",
        }
    }

    fn cbind_data(&self) -> &[u8] {
        match self.0 {
            ChannelBindingInner::Unrequested | ChannelBindingInner::Unsupported => &[],
            ChannelBindingInner::TlsServerEndPoint(ref buf) => buf,
        }
    }
}

/// Which SASL mechanism variant to use for password derivation.
#[derive(Clone)]
enum Mechanism {
    ScramSha256,
    GaussdbSha256,
    GaussdbMd5Sha256 { username: String },
}

enum State {
    Update {
        nonce: String,
        password: Vec<u8>,
        channel_binding: ChannelBinding,
        mechanism: Mechanism,
    },
    Finish {
        salted_password: [u8; 32],
        auth_message: String,
    },
    Done,
}

/// A type which handles the client side of the SCRAM-SHA-256/SCRAM-SHA-256-PLUS authentication
/// process.
///
/// During the authentication process, if the backend sends an `AuthenticationSASL` message which
/// includes `SCRAM-SHA-256` as an authentication mechanism, this type can be used.
///
/// After a `ScramSha256` is constructed, the buffer returned by the `message()` method should be
/// sent to the backend in a `SASLInitialResponse` message along with the mechanism name.
///
/// The server will reply with an `AuthenticationSASLContinue` message. Its contents should be
/// passed to the `update()` method, after which the buffer returned by the `message()` method
/// should be sent to the backend in a `SASLResponse` message.
///
/// The server will reply with an `AuthenticationSASLFinal` message. Its contents should be passed
/// to the `finish()` method, after which the authentication process is complete.
pub struct ScramSha256 {
    message: String,
    state: State,
}

impl ScramSha256 {
    /// Constructs a new instance which will use the provided password for authentication.
    pub fn new(password: &[u8], channel_binding: ChannelBinding) -> ScramSha256 {
        ScramSha256::new_inner(password, channel_binding, Mechanism::ScramSha256, None)
    }

    /// Constructs a new instance for GaussDB SHA256 authentication.
    /// Uses GaussDB's password derivation (SHA256 + hex-encode before Hi()).
    pub fn new_gaussdb_sha256(password: &[u8], channel_binding: ChannelBinding) -> ScramSha256 {
        ScramSha256::new_inner(password, channel_binding, Mechanism::GaussdbSha256, None)
    }

    /// Constructs a new instance for GaussDB MD5_SHA256 authentication.
    /// Uses GaussDB's MD5 + SHA256 password derivation before Hi().
    pub fn new_gaussdb_md5_sha256(
        password: &[u8],
        username: &str,
        channel_binding: ChannelBinding,
    ) -> ScramSha256 {
        ScramSha256::new_inner(
            password,
            channel_binding,
            Mechanism::GaussdbMd5Sha256 {
                username: username.to_string(),
            },
            None,
        )
    }

    fn new_inner(
        password: &[u8],
        channel_binding: ChannelBinding,
        mechanism: Mechanism,
        nonce: Option<String>,
    ) -> ScramSha256 {
        let nonce = nonce.unwrap_or_else(|| {
            let mut rng = rand::rng();
            (0..NONCE_LENGTH)
                .map(|_| {
                    let mut v = rng.random_range(0x21u8..0x7e);
                    if v == 0x2c {
                        v = 0x7e
                    }
                    v as char
                })
                .collect::<String>()
        });

        ScramSha256 {
            message: format!("{}n=,r={}", channel_binding.gs2_header(), nonce),
            state: State::Update {
                nonce,
                password: normalize(password),
                channel_binding,
                mechanism,
            },
        }
    }

    /// Returns the message which should be sent to the backend in an `SASLResponse` message.
    pub fn message(&self) -> &[u8] {
        if let State::Done = self.state {
            panic!("invalid SCRAM state");
        }
        self.message.as_bytes()
    }

    /// Updates the state machine with the response from the backend.
    ///
    /// This should be called when an `AuthenticationSASLContinue` message is received.
    pub fn update(&mut self, message: &[u8]) -> io::Result<()> {
        let (client_nonce, password, channel_binding, mechanism) =
            match mem::replace(&mut self.state, State::Done) {
                State::Update {
                    nonce,
                    password,
                    channel_binding,
                    mechanism,
                } => (nonce, password, channel_binding, mechanism),
                _ => return Err(io::Error::other("invalid SCRAM state")),
            };

        let message =
            str::from_utf8(message).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

        let parsed = Parser::new(message).server_first_message()?;

        if !parsed.nonce.starts_with(&client_nonce) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid nonce"));
        }

        if parsed.iteration_count > MAX_ITERATION_COUNT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SCRAM iteration count exceeds the maximum allowed",
            ));
        }

        let salt = match STANDARD.decode(parsed.salt) {
            Ok(salt) => salt,
            Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidInput, e)),
        };

        let salted_password = match &mechanism {
            Mechanism::ScramSha256 => hi(&password, &salt, parsed.iteration_count),
            Mechanism::GaussdbSha256 => {
                derive_gaussdb_sha256(&password, &salt, parsed.iteration_count)
            }
            Mechanism::GaussdbMd5Sha256 { username } => {
                derive_gaussdb_md5_sha256(&password, username, &salt, parsed.iteration_count)
            }
        };

        let mut hmac = Hmac::<Sha256>::new_from_slice(&salted_password)
            .expect("HMAC is able to accept all key sizes");
        hmac.update(b"Client Key");
        let client_key = hmac.finalize().into_bytes();

        let mut hash = Sha256::default();
        hash.update(client_key);
        let stored_key = hash.finalize_fixed();

        let mut cbind_input = vec![];
        cbind_input.extend(channel_binding.gs2_header().as_bytes());
        cbind_input.extend(channel_binding.cbind_data());
        let cbind_input = STANDARD.encode(&cbind_input);

        self.message.clear();
        write!(&mut self.message, "c={},r={}", cbind_input, parsed.nonce).unwrap();

        let auth_message = format!("n=,r={},{},{}", client_nonce, message, self.message);

        let mut hmac = Hmac::<Sha256>::new_from_slice(&stored_key)
            .expect("HMAC is able to accept all key sizes");
        hmac.update(auth_message.as_bytes());
        let client_signature = hmac.finalize().into_bytes();

        let mut client_proof = client_key;
        for (proof, signature) in client_proof.iter_mut().zip(client_signature) {
            *proof ^= signature;
        }

        write!(
            &mut self.message,
            ",p={}",
            Base64Display::new(&client_proof, &STANDARD)
        )
        .unwrap();

        self.state = State::Finish {
            salted_password,
            auth_message,
        };
        Ok(())
    }

    /// Finalizes the authentication process.
    ///
    /// This should be called when the backend sends an `AuthenticationSASLFinal` message.
    /// Authentication has only succeeded if this method returns `Ok(())`.
    pub fn finish(&mut self, message: &[u8]) -> io::Result<()> {
        let (salted_password, auth_message) = match mem::replace(&mut self.state, State::Done) {
            State::Finish {
                salted_password,
                auth_message,
            } => (salted_password, auth_message),
            _ => return Err(io::Error::other("invalid SCRAM state")),
        };

        let message =
            str::from_utf8(message).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

        let parsed = Parser::new(message).server_final_message()?;

        let verifier = match parsed {
            ServerFinalMessage::Error(e) => {
                return Err(io::Error::other(format!("SCRAM error: {e}")));
            }
            ServerFinalMessage::Verifier(verifier) => verifier,
        };

        let verifier = match STANDARD.decode(verifier) {
            Ok(verifier) => verifier,
            Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidInput, e)),
        };

        let mut hmac = Hmac::<Sha256>::new_from_slice(&salted_password)
            .expect("HMAC is able to accept all key sizes");
        hmac.update(b"Server Key");
        let server_key = hmac.finalize().into_bytes();

        let mut hmac = Hmac::<Sha256>::new_from_slice(&server_key)
            .expect("HMAC is able to accept all key sizes");
        hmac.update(auth_message.as_bytes());
        hmac.verify_slice(&verifier)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "SCRAM verification error"))
    }
}

struct Parser<'a> {
    s: &'a str,
    it: iter::Peekable<str::CharIndices<'a>>,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Parser<'a> {
        Parser {
            s,
            it: s.char_indices().peekable(),
        }
    }

    fn eat(&mut self, target: char) -> io::Result<()> {
        match self.it.next() {
            Some((_, c)) if c == target => Ok(()),
            Some((i, c)) => {
                let m =
                    format!("unexpected character at byte {i}: expected `{target}` but got `{c}");
                Err(io::Error::new(io::ErrorKind::InvalidInput, m))
            }
            None => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "unexpected EOF",
            )),
        }
    }

    fn take_while<F>(&mut self, f: F) -> io::Result<&'a str>
    where
        F: Fn(char) -> bool,
    {
        let start = match self.it.peek() {
            Some(&(i, _)) => i,
            None => return Ok(""),
        };

        loop {
            match self.it.peek() {
                Some(&(_, c)) if f(c) => {
                    self.it.next();
                }
                Some(&(i, _)) => return Ok(&self.s[start..i]),
                None => return Ok(&self.s[start..]),
            }
        }
    }

    fn printable(&mut self) -> io::Result<&'a str> {
        self.take_while(|c| matches!(c, '\x21'..='\x2b' | '\x2d'..='\x7e'))
    }

    fn nonce(&mut self) -> io::Result<&'a str> {
        self.eat('r')?;
        self.eat('=')?;
        self.printable()
    }

    fn base64(&mut self) -> io::Result<&'a str> {
        self.take_while(|c| matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '/' | '+' | '='))
    }

    fn salt(&mut self) -> io::Result<&'a str> {
        self.eat('s')?;
        self.eat('=')?;
        self.base64()
    }

    fn posit_number(&mut self) -> io::Result<u32> {
        let n = self.take_while(|c| c.is_ascii_digit())?;
        n.parse()
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
    }

    fn iteration_count(&mut self) -> io::Result<u32> {
        self.eat('i')?;
        self.eat('=')?;
        self.posit_number()
    }

    fn eof(&mut self) -> io::Result<()> {
        match self.it.peek() {
            Some(&(i, _)) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unexpected trailing data at byte {i}"),
            )),
            None => Ok(()),
        }
    }

    fn server_first_message(&mut self) -> io::Result<ServerFirstMessage<'a>> {
        let nonce = self.nonce()?;
        self.eat(',')?;
        let salt = self.salt()?;
        self.eat(',')?;
        let iteration_count = self.iteration_count()?;
        self.eof()?;

        Ok(ServerFirstMessage {
            nonce,
            salt,
            iteration_count,
        })
    }

    fn value(&mut self) -> io::Result<&'a str> {
        self.take_while(|c| !matches!(c, '\0' | '=' | ','))
    }

    fn server_error(&mut self) -> io::Result<Option<&'a str>> {
        match self.it.peek() {
            Some(&(_, 'e')) => {}
            _ => return Ok(None),
        }

        self.eat('e')?;
        self.eat('=')?;
        self.value().map(Some)
    }

    fn verifier(&mut self) -> io::Result<&'a str> {
        self.eat('v')?;
        self.eat('=')?;
        self.base64()
    }

    fn server_final_message(&mut self) -> io::Result<ServerFinalMessage<'a>> {
        let message = match self.server_error()? {
            Some(error) => ServerFinalMessage::Error(error),
            None => ServerFinalMessage::Verifier(self.verifier()?),
        };
        self.eof()?;
        Ok(message)
    }
}

struct ServerFirstMessage<'a> {
    nonce: &'a str,
    salt: &'a str,
    iteration_count: u32,
}

enum ServerFinalMessage<'a> {
    Error(&'a str),
    Verifier(&'a str),
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn parse_server_first_message() {
        let message = "r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096";
        let message = Parser::new(message).server_first_message().unwrap();
        assert_eq!(message.nonce, "fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j");
        assert_eq!(message.salt, "QSXCR+Q6sek8bf92");
        assert_eq!(message.iteration_count, 4096);
    }

    #[test]
    fn parse_server_error_message() {
        let message = "e=invalid-proof";
        match Parser::new(message).server_final_message().unwrap() {
            ServerFinalMessage::Error(error) => assert_eq!(error, "invalid-proof"),
            ServerFinalMessage::Verifier(_) => panic!("expected server error"),
        }

        // the error value ends at the first '\0', '=' or ','
        for message in ["invalid-proof\0x", "invalid-proof=x", "invalid-proof,x"] {
            assert_eq!(Parser::new(message).value().unwrap(), "invalid-proof");
        }
    }

    // recorded auth exchange from psql
    #[test]
    fn exchange() {
        let password = "foobar";
        let nonce = "9IZ2O01zb9IgiIZ1WJ/zgpJB";

        let client_first = "n,,n=,r=9IZ2O01zb9IgiIZ1WJ/zgpJB";
        let server_first = "r=9IZ2O01zb9IgiIZ1WJ/zgpJBjx/oIRLs02gGSHcw1KEty3eY,s=fs3IXBy7U7+IvVjZ,i\
             =4096";
        let client_final = "c=biws,r=9IZ2O01zb9IgiIZ1WJ/zgpJBjx/oIRLs02gGSHcw1KEty3eY,p=AmNKosjJzS3\
             1NTlQYNs5BTeQjdHdk7lOflDo5re2an8=";
        let server_final = "v=U+ppxD5XUKtradnv8e2MkeupiA8FU87Sg8CXzXHDAzw=";

        let mut scram = ScramSha256::new_inner(
            password.as_bytes(),
            ChannelBinding::unsupported(),
            Mechanism::ScramSha256,
            Some(nonce.to_string()),
        );
        assert_eq!(str::from_utf8(scram.message()).unwrap(), client_first);

        scram.update(server_first.as_bytes()).unwrap();
        assert_eq!(str::from_utf8(scram.message()).unwrap(), client_final);

        scram.finish(server_final.as_bytes()).unwrap();
    }

    #[test]
    fn excessive_iteration_count_is_rejected() {
        // a malicious server cannot force an unbounded PBKDF2 loop; the iteration
        // count is rejected before `hi()` runs.
        let nonce = "9IZ2O01zb9IgiIZ1WJ/zgpJB";
        let server_first =
            "r=9IZ2O01zb9IgiIZ1WJ/zgpJBjx/oIRLs02gGSHcw1KEty3eY,s=fs3IXBy7U7+IvVjZ,i=1000000";

        let mut scram = ScramSha256::new_inner(
            b"foobar",
            ChannelBinding::unsupported(),
            Mechanism::ScramSha256,
            Some(nonce.to_string()),
        );
        assert!(scram.update(server_first.as_bytes()).is_err());
    }
}
