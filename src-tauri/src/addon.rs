use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const ADDON_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const ADDON_DEFAULT_TIMEOUT_MS: u64 = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonHttpRequestInput {
    url: String,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonHttpResponse {
    status: u16,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonLengthProbe {
    #[serde(skip_serializing_if = "Option::is_none")]
    content_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    accepts_ranges: bool,
}

/// Whether a plain-`http` host is a local or private-network literal.
fn is_local_or_private_host(parsed: &url::Url) -> bool {
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Rejects anything the addon transport must never fetch, without echoing the URL.
fn validate_addon_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|_| "The addon URL is not valid.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Addon URLs must use http or https.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Addon URLs must not contain embedded credentials.".to_string());
    }
    if parsed.host().is_none() {
        return Err("The addon URL has no host.".to_string());
    }
    if parsed.scheme() == "http" && !is_local_or_private_host(&parsed) {
        return Err(
            "Plain http is only allowed for localhost or a private network address.".to_string(),
        );
    }
    Ok(())
}

/// `scheme://host[:port]/***` — the only form of an addon URL that may be logged.
pub(crate) fn redacted_url(raw: &str) -> String {
    let Ok(parsed) = url::Url::parse(raw) else {
        return "<invalid addon URL>".to_string();
    };
    let Some(host) = parsed.host_str() else {
        return "<invalid addon URL>".to_string();
    };
    match parsed.port() {
        Some(port) => format!("{}://{host}:{port}/***", parsed.scheme()),
        None => format!("{}://{host}/***", parsed.scheme()),
    }
}

/// Same three-hop ceiling as `Policy::limited(3)`, but every hop must also pass the same
/// scheme/credential/private-host rules as the initial URL — a permitted HTTPS addon must not
/// be able to downgrade to public plaintext or bounce into localhost/private `http`.
fn should_follow_redirect(previous_len: usize, target: &str) -> bool {
    previous_len <= 3 && validate_addon_url(target).is_ok()
}

fn declared_body_too_large(content_length: Option<u64>) -> bool {
    content_length.is_some_and(|length| length > ADDON_MAX_BODY_BYTES as u64)
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

fn header_value(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// The one client policy every addon request uses: the app trust store, redirects only through
/// `should_follow_redirect`, and a caller-chosen timeout.
fn addon_client(timeout_ms: u64) -> Result<reqwest::Client, String> {
    crate::http_client_builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if should_follow_redirect(attempt.previous().len(), attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.error("addon redirect blocked")
            }
        }))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("addon HTTP client creation failed: {error}"))
}

fn parse_content_length(value: Option<&str>) -> Option<u64> {
    value?.trim().parse().ok()
}

fn accepts_ranges(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.to_ascii_lowercase().contains("bytes"))
}

/// Addon source ids double as keyring account names; only a lowercase UUID keeps them inert.
fn valid_source_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

fn addon_secret_entry(source_id: &str) -> Result<keyring::Entry, String> {
    if !valid_source_id(source_id) {
        return Err("The addon source id is not valid.".to_string());
    }
    keyring::Entry::new(crate::KEYRING_SERVICE, &format!("addon:{source_id}"))
        .map_err(|error| format!("credential store unavailable: {error}"))
}

/// Reads a stream's size without downloading it.
///
/// The length is best-effort: a server that refuses `HEAD`, ignores `Range`, or simply does not
/// say is still a usable stream, so only transport failures are `Err`.
#[tauri::command]
pub(crate) async fn addon_probe_length(url: String) -> Result<AddonLengthProbe, String> {
    validate_addon_url(&url)?;
    let started_at = Instant::now();
    let client = addon_client(ADDON_DEFAULT_TIMEOUT_MS)?;

    let head = client
        .head(&url)
        .header(reqwest::header::USER_AGENT, "Zuno/1.4.0")
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|error| format!("addon length probe failed: {}", error.without_url()))?;

    let mut status = head.status().as_u16();
    let mut content_type = header_value(&head, reqwest::header::CONTENT_TYPE);
    let mut supports_ranges =
        accepts_ranges(header_value(&head, reqwest::header::ACCEPT_RANGES).as_deref());
    let mut content_length = parse_content_length(
        header_value(&head, reqwest::header::CONTENT_LENGTH).as_deref(),
    );

    if content_length.is_none() || matches!(status, 405 | 501) {
        let ranged = client
            .get(&url)
            .header(reqwest::header::USER_AGENT, "Zuno/1.4.0")
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|error| format!("addon length probe failed: {}", error.without_url()))?;

        status = ranged.status().as_u16();
        content_type = header_value(&ranged, reqwest::header::CONTENT_TYPE).or(content_type);
        supports_ranges = supports_ranges
            || accepts_ranges(header_value(&ranged, reqwest::header::ACCEPT_RANGES).as_deref());
        content_length = match status {
            206 => header_value(&ranged, reqwest::header::CONTENT_RANGE)
                .as_deref()
                .and_then(parse_content_range_total),
            200 => parse_content_length(
                header_value(&ranged, reqwest::header::CONTENT_LENGTH).as_deref(),
            ),
            _ => None,
        };
    }

    eprintln!(
        "[internal][addon][info] addon_probe_length url={} status={} content_length={:?} elapsed_ms={}",
        redacted_url(&url),
        status,
        content_length,
        started_at.elapsed().as_millis()
    );

    Ok(AddonLengthProbe {
        content_length,
        content_type,
        accepts_ranges: supports_ranges,
    })
}

#[tauri::command]
pub(crate) fn addon_secret_get(source_id: String) -> Result<Option<String>, String> {
    match addon_secret_entry(&source_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("addon secret load failed: {error}")),
    }
}

#[tauri::command]
pub(crate) fn addon_secret_set(source_id: String, value: String) -> Result<(), String> {
    addon_secret_entry(&source_id)?
        .set_password(&value)
        .map_err(|error| format!("addon secret save failed: {error}"))
}

#[tauri::command]
pub(crate) fn addon_secret_delete(source_id: String) -> Result<(), String> {
    match addon_secret_entry(&source_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("addon secret delete failed: {error}")),
    }
}

/// GET-only JSON transport for addon endpoints.
///
/// Every HTTP status is returned to the caller with its body, because an addon's 404/429/5xx
/// are protocol answers, not transport failures. Only network, parse, UTF-8, or size-cap
/// failures are `Err`.
#[tauri::command]
pub(crate) async fn addon_http_request(
    input: AddonHttpRequestInput,
) -> Result<AddonHttpResponse, String> {
    validate_addon_url(&input.url)?;
    let started_at = Instant::now();
    let timeout_ms = input.timeout_ms.unwrap_or(ADDON_DEFAULT_TIMEOUT_MS);

    let client = addon_client(timeout_ms)?;

    let mut response = client
        .get(&input.url)
        .header(reqwest::header::USER_AGENT, "Zuno/1.4.0")
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("addon request failed: {}", error.without_url()))?;

    let status = response.status().as_u16();
    let content_type = header_value(&response, reqwest::header::CONTENT_TYPE);
    let retry_after = header_value(&response, reqwest::header::RETRY_AFTER);

    if declared_body_too_large(response.content_length()) {
        return Err(format!(
            "addon response body exceeds {ADDON_MAX_BODY_BYTES} bytes."
        ));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("addon response read failed: {}", error.without_url()))?
    {
        if body.len() + chunk.len() > ADDON_MAX_BODY_BYTES {
            return Err(format!(
                "addon response body exceeds {ADDON_MAX_BODY_BYTES} bytes."
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(body)
        .map_err(|_| "addon response body was not valid UTF-8.".to_string())?;

    eprintln!(
        "[internal][addon][info] addon_http_request url={} status={} elapsed_ms={}",
        redacted_url(&input.url),
        status,
        started_at.elapsed().as_millis()
    );

    Ok(AddonHttpResponse {
        status,
        body,
        content_type,
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_path_and_query() {
        assert_eq!(
            redacted_url("https://host.example/secret/audio?token=abc"),
            "https://host.example/***"
        );
        assert_eq!(redacted_url("http://localhost:8787/dev"), "http://localhost:8787/***");
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_addon_url("file:///tmp/x").is_err());
        assert!(validate_addon_url("data:application/json,{}").is_err());
        assert!(validate_addon_url("ftp://host/x").is_err());
    }

    #[test]
    fn permits_http_only_for_local_or_private_literals() {
        assert!(validate_addon_url("http://localhost:8787/dev").is_ok());
        assert!(validate_addon_url("http://127.0.0.1:8787/dev").is_ok());
        assert!(validate_addon_url("http://[::1]:8787/dev").is_ok());
        assert!(validate_addon_url("http://192.168.1.5/dev").is_ok());
        assert!(validate_addon_url("http://example.com/dev").is_err());
        assert!(validate_addon_url("https://example.com/dev").is_ok());
    }

    #[test]
    fn rejects_credentials() {
        assert!(validate_addon_url("https://user:pass@host/dev").is_err());
    }

    #[test]
    fn rejects_oversized_declared_body() {
        assert!(declared_body_too_large(Some((2 * 1024 * 1024 + 1) as u64)));
        assert!(!declared_body_too_large(Some(1024)));
        assert!(!declared_body_too_large(None));
    }

    #[test]
    fn parses_content_range_total() {
        assert_eq!(parse_content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
    }

    #[test]
    fn accepts_only_uuid_source_ids() {
        assert!(valid_source_id("3f1c2a44-1111-4222-8333-444455556666"));
        assert!(!valid_source_id(""));
        assert!(!valid_source_id("../../x"));
        assert!(!valid_source_id("3F1C2A44-1111-4222-8333-444455556666"));
    }

    #[test]
    fn parses_content_length_and_accept_ranges() {
        assert_eq!(parse_content_length(Some("12345")), Some(12345));
        assert_eq!(parse_content_length(Some("nope")), None);
        assert!(accepts_ranges(Some("bytes")));
        assert!(!accepts_ranges(None));
    }

    #[test]
    fn restricts_redirect_targets_and_count() {
        assert!(should_follow_redirect(1, "https://public.example/x"));
        assert!(!should_follow_redirect(1, "http://public.example/x"));
        assert!(should_follow_redirect(1, "http://localhost:8787/dev"));
        assert!(should_follow_redirect(1, "http://127.0.0.1/x"));
        assert!(!should_follow_redirect(4, "https://public.example/x"));
    }
}
