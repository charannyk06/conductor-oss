use anyhow::Result;
use conductor_core::config::WebhookConfig;
use conductor_core::event::Event;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Emit an event to all configured webhooks.
pub async fn emit_webhook(configs: &[WebhookConfig], event: &Event) -> Result<()> {
    let payload = serde_json::to_string(event)?;

    for config in configs {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let mut request = client.post(&config.url).header("Content-Type", "application/json");

        // Add HMAC signature if secret is configured.
        if let Some(secret) = &config.secret {
            let signature = sign_payload(secret, &payload);
            request = request.header("X-Conductor-Signature", format!("sha256={signature}"));
        }

        // Fire and forget with retry.
        let url = config.url.clone();
        let req = request.body(payload.clone());
        tokio::spawn(async move {
            for attempt in 0..3 {
                let Some(cloned) = req.try_clone() else {
                    tracing::error!("Failed to clone webhook request for {url}");
                    return;
                };
                match cloned.send().await {
                    Ok(resp) if resp.status().is_success() => {
                        tracing::debug!("Webhook delivered to {url}");
                        return;
                    }
                    Ok(resp) => {
                        tracing::warn!(
                            "Webhook {url} returned {}, attempt {}/3",
                            resp.status(),
                            attempt + 1
                        );
                    }
                    Err(e) => {
                        tracing::warn!("Webhook {url} failed: {e}, attempt {}/3", attempt + 1);
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1))).await;
            }
            tracing::error!("Webhook {url} failed after 3 attempts");
        });
    }

    Ok(())
}

fn sign_payload(secret: &str, payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
