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

    let client = crate::http_client_builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("addon HTTP client creation failed: {error}"))?;

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
}
