//! Web Push delivery (RFC 8291 message encryption + RFC 8292 VAPID) for the dashboard PWA.
//!
//! Keys and subscriptions live on this machine in `.conductor/rust-backend/push.json`. The
//! backend talks to the browser vendor's push service directly; nothing is relayed through a
//! hosted Conductor service.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::Utc;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

use crate::state::AppState;

const PUSH_CONTACT_ENV: &str = "CONDUCTOR_PUSH_CONTACT";
const DEFAULT_PUSH_CONTACT: &str = "https://github.com/charannyk06/conductor-oss";
const PUSH_RECORD_SIZE: u32 = 4096;
const PUSH_TTL_SECONDS: u32 = 60 * 60 * 12;
const VAPID_TOKEN_LIFETIME_SECONDS: i64 = 60 * 60 * 12;
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_PAYLOAD_BYTES: usize = 3_000;
/// Push services browsers hand out. Anything else is refused so a subscription cannot be used
/// to make the backend call arbitrary hosts.
const ALLOWED_PUSH_HOST_SUFFIXES: [&str; 5] = [
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
    "push.apple.com",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushStore {
    /// base64url-encoded 32-byte P-256 private scalar.
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub subscriptions: Vec<PushSubscription>,
}

fn decode_b64(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim().trim_end_matches('='))
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(value.trim().trim_end_matches('='))
        })
        .context("invalid base64 value")
}

pub(crate) fn validate_push_endpoint(endpoint: &str) -> Result<Url> {
    let url = Url::parse(endpoint.trim()).context("Push endpoint is not a valid URL")?;
    if url.scheme() != "https" {
        bail!("Push endpoint must use https");
    }
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .context("Push endpoint has no host")?;
    let allowed = ALLOWED_PUSH_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")));
    if !allowed {
        bail!("Push endpoint host `{host}` is not a recognised browser push service");
    }
    Ok(url)
}

fn secret_key_from_store(store: &PushStore) -> Result<SecretKey> {
    let bytes = decode_b64(&store.private_key)?;
    SecretKey::from_slice(&bytes).map_err(|_| anyhow!("stored VAPID private key is invalid"))
}

fn public_key_bytes(secret: &SecretKey) -> Vec<u8> {
    secret
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec()
}

/// Encrypt `plaintext` for one subscription using the `aes128gcm` content coding.
pub(crate) fn encrypt_push_payload(
    plaintext: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>> {
    let ua_public_key =
        PublicKey::from_sec1_bytes(ua_public).map_err(|_| anyhow!("invalid p256dh key"))?;
    let as_public = public_key_bytes(as_secret);
    let shared =
        p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public_key.as_affine());

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(&as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| anyhow!("failed to derive push input keying material"))?;

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut content_key = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut content_key)
        .map_err(|_| anyhow!("failed to derive push content key"))?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| anyhow!("failed to derive push nonce"))?;

    // A single, final record: plaintext followed by the 0x02 delimiter.
    let mut record = plaintext.to_vec();
    record.push(0x02);
    let ciphertext = Aes128Gcm::new_from_slice(&content_key)
        .map_err(|_| anyhow!("invalid push content key"))?
        .encrypt(Nonce::from_slice(&nonce), record.as_ref())
        .map_err(|_| anyhow!("failed to encrypt push payload"))?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&PUSH_RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// Build the `Authorization: vapid ...` header value for a push service origin.
pub(crate) fn build_vapid_authorization(
    secret: &SecretKey,
    audience: &str,
    contact: &str,
    expires_at: i64,
) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        json!({ "aud": audience, "exp": expires_at, "sub": contact })
            .to_string()
            .as_bytes(),
    );
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = SigningKey::from(secret).sign(signing_input.as_bytes());
    format!(
        "vapid t={signing_input}.{}, k={}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        URL_SAFE_NO_PAD.encode(public_key_bytes(secret))
    )
}

fn push_contact() -> String {
    std::env::var(PUSH_CONTACT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("mailto:") || value.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_PUSH_CONTACT.to_string())
}

enum PushOutcome {
    Delivered,
    Gone,
    Failed(String),
}

async fn deliver(
    client: &reqwest::Client,
    secret: &SecretKey,
    subscription: &PushSubscription,
    payload: &[u8],
) -> PushOutcome {
    let endpoint = match validate_push_endpoint(&subscription.endpoint) {
        Ok(url) => url,
        Err(_) => return PushOutcome::Gone,
    };
    let (Ok(ua_public), Ok(auth)) = (
        decode_b64(&subscription.p256dh),
        decode_b64(&subscription.auth),
    ) else {
        return PushOutcome::Gone;
    };
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let ephemeral = SecretKey::random(&mut OsRng);
    let body = match encrypt_push_payload(payload, &ua_public, &auth, &ephemeral, &salt) {
        Ok(body) => body,
        Err(_) => return PushOutcome::Gone,
    };
    let audience = format!(
        "{}://{}",
        endpoint.scheme(),
        endpoint.host_str().unwrap_or_default()
    );
    let authorization = build_vapid_authorization(
        secret,
        &audience,
        &push_contact(),
        Utc::now().timestamp() + VAPID_TOKEN_LIFETIME_SECONDS,
    );
    let response = client
        .post(endpoint)
        .header("Authorization", authorization)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", PUSH_TTL_SECONDS.to_string())
        .header("Urgency", "high")
        .body(body)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => PushOutcome::Delivered,
        Ok(response) if matches!(response.status().as_u16(), 404 | 410) => PushOutcome::Gone,
        Ok(response) => PushOutcome::Failed(format!("push service returned {}", response.status())),
        Err(error) => PushOutcome::Failed(error.to_string()),
    }
}

impl AppState {
    fn push_store_path(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("push.json")
    }

    async fn persist_push_store(&self, store: &PushStore) -> Result<()> {
        let path = self.push_store_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temporary = path.with_extension("json.tmp");
        tokio::fs::write(&temporary, serde_json::to_string_pretty(store)?).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                .await;
        }
        tokio::fs::rename(&temporary, &path).await?;
        Ok(())
    }

    /// Run `apply` against the push store (loading it, and creating VAPID keys, on first use)
    /// and persist the store when `apply` reports a change.
    async fn with_push_store<T>(
        &self,
        apply: impl FnOnce(&mut PushStore) -> Result<(T, bool)>,
    ) -> Result<T> {
        let mut cached = self.push_store.lock().await;
        if cached.is_none() {
            let mut store = match tokio::fs::read_to_string(self.push_store_path()).await {
                Ok(content) => serde_json::from_str::<PushStore>(&content).unwrap_or_default(),
                Err(_) => PushStore::default(),
            };
            if secret_key_from_store(&store).is_err() {
                let secret = SecretKey::random(&mut OsRng);
                store.private_key = URL_SAFE_NO_PAD.encode(secret.to_bytes());
                // Subscriptions are bound to the old public key, so they cannot be reused.
                store.subscriptions.clear();
                self.persist_push_store(&store).await?;
            }
            *cached = Some(store);
        }
        let store = cached.as_mut().context("push store unavailable")?;
        let (output, changed) = apply(store)?;
        if changed {
            let snapshot = store.clone();
            self.persist_push_store(&snapshot).await?;
        }
        Ok(output)
    }

    pub(crate) async fn push_public_key(&self) -> Result<String> {
        self.with_push_store(|store| {
            let secret = secret_key_from_store(store)?;
            Ok((URL_SAFE_NO_PAD.encode(public_key_bytes(&secret)), false))
        })
        .await
    }

    pub(crate) async fn add_push_subscription(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
    ) -> Result<()> {
        let endpoint = validate_push_endpoint(endpoint)?.to_string();
        let ua_public = decode_b64(p256dh)?;
        PublicKey::from_sec1_bytes(&ua_public).map_err(|_| anyhow!("invalid p256dh key"))?;
        if decode_b64(auth)?.len() != 16 {
            bail!("invalid auth secret");
        }
        let record = PushSubscription {
            endpoint: endpoint.clone(),
            p256dh: p256dh.trim().to_string(),
            auth: auth.trim().to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        self.with_push_store(move |store| {
            store
                .subscriptions
                .retain(|existing| existing.endpoint != endpoint);
            store.subscriptions.push(record);
            if store.subscriptions.len() > MAX_SUBSCRIPTIONS {
                let overflow = store.subscriptions.len() - MAX_SUBSCRIPTIONS;
                store.subscriptions.drain(0..overflow);
            }
            Ok(((), true))
        })
        .await
    }

    pub(crate) async fn remove_push_subscription(&self, endpoint: &str) -> Result<()> {
        let endpoint = endpoint.trim().to_string();
        self.with_push_store(move |store| {
            let before = store.subscriptions.len();
            store
                .subscriptions
                .retain(|existing| existing.endpoint != endpoint);
            Ok(((), store.subscriptions.len() != before))
        })
        .await
    }

    /// Send a notification to every subscribed device. Returns how many were accepted.
    pub(crate) async fn send_push_notification(
        self: &Arc<Self>,
        title: &str,
        body: &str,
        url: &str,
        tag: &str,
    ) -> usize {
        let loaded = self
            .with_push_store(|store| {
                if store.subscriptions.is_empty() {
                    return Ok((None, false));
                }
                let secret = secret_key_from_store(store)?;
                Ok((Some((secret, store.subscriptions.clone())), false))
            })
            .await;
        let (secret, subscriptions) = match loaded {
            Ok(Some(loaded)) => loaded,
            Ok(None) => return 0,
            Err(error) => {
                tracing::warn!(error = %error, "push store unavailable");
                return 0;
            }
        };

        let mut payload = json!({ "title": title, "body": body, "url": url, "tag": tag });
        if payload.to_string().len() > MAX_PAYLOAD_BYTES {
            let shortened = body.chars().take(400).collect::<String>();
            payload["body"] = json!(shortened);
        }
        let payload = payload.to_string();
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(error = %error, "failed to build push client");
                return 0;
            }
        };

        let mut delivered = 0;
        let mut gone = Vec::new();
        for subscription in &subscriptions {
            match deliver(&client, &secret, subscription, payload.as_bytes()).await {
                PushOutcome::Delivered => delivered += 1,
                PushOutcome::Gone => gone.push(subscription.endpoint.clone()),
                PushOutcome::Failed(reason) => {
                    tracing::warn!(reason, "push notification was not accepted");
                }
            }
        }
        if !gone.is_empty() {
            let _ = self
                .with_push_store(move |store| {
                    store
                        .subscriptions
                        .retain(|existing| !gone.contains(&existing.endpoint));
                    Ok(((), true))
                })
                .await;
        }
        delivered
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    fn b64(value: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value).unwrap()
    }

    /// RFC 8291 Appendix A.
    #[test]
    fn encrypts_rfc8291_test_vector() {
        let as_secret =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_push_payload(
            b"When I grow up, I want to be a watermelon",
            &ua_public,
            &auth,
            &as_secret,
            &salt,
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn vapid_header_is_a_verifiable_es256_token() {
        let secret = SecretKey::random(&mut OsRng);
        let header = build_vapid_authorization(
            &secret,
            "https://fcm.googleapis.com",
            "https://example.com/contact",
            1_900_000_000,
        );
        let token = header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split(", k=").next())
            .unwrap();
        let key = header.split(", k=").nth(1).unwrap();
        assert_eq!(b64(key), public_key_bytes(&secret));

        let parts = token.split('.').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&b64(parts[1])).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_900_000_000i64);
        let signature = Signature::from_slice(&b64(parts[2])).unwrap();
        VerifyingKey::from(secret.public_key())
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn push_endpoints_are_limited_to_browser_push_services() {
        assert!(validate_push_endpoint("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(
            validate_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x").is_ok()
        );
        assert!(validate_push_endpoint("https://web.push.apple.com/abc").is_ok());
        assert!(validate_push_endpoint("https://db5p.notify.windows.com/w/?token=1").is_ok());
        assert!(validate_push_endpoint("http://fcm.googleapis.com/fcm/send/abc").is_err());
        assert!(validate_push_endpoint("https://127.0.0.1/hook").is_err());
        assert!(validate_push_endpoint("https://evilfcm.googleapis.com.attacker.dev/x").is_err());
        assert!(validate_push_endpoint("https://notfcm.googleapis.com.example/x").is_err());
    }
}
