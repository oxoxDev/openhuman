//! Links a tool result offers: payment pages, deep links, sign-in URLs.
//!
//! Found in the structured content and the text, classified, and capped. A
//! scheme that could run script or reach this process is dropped outright.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::types::{UiLink, UiLinkKind};

/// The most links one result surfaces.
pub const MAX_LINKS: usize = 5;

const MAX_URL_LEN: usize = 2048;

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico", "heic", "heif", "tif", "tiff",
];
const MAX_WALK_DEPTH: usize = 8;
const MAX_WALK_STRINGS: usize = 512;

const BLOCKED_SCHEMES: &[&str] = &[
    "javascript",
    "data",
    "vbscript",
    "file",
    "blob",
    "about",
    "tauri",
    "ipc",
    "asset",
    "ohwidget",
    "filesystem",
    "chrome",
    "chrome-extension",
    "view-source",
    "ws",
    "wss",
    "ftp",
    "openhuman",
];

static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b([a-z][a-z0-9+.\-]{1,31})://[^\s"'<>\x60{}|\\^\[\]]+"#)
        .expect("link pattern compiles")
});

/// How a link is treated, by scheme. `None` for a blocked or malformed one.
#[must_use]
pub fn classify(url: &str) -> Option<UiLinkKind> {
    let (scheme, rest) = url.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
    {
        return None;
    }
    if BLOCKED_SCHEMES.contains(&scheme.as_str()) || rest.trim().is_empty() {
        return None;
    }
    if url.chars().any(char::is_control) || url.len() > MAX_URL_LEN {
        return None;
    }
    match scheme.as_str() {
        "http" | "https" => {
            let parsed = url::Url::parse(url).ok()?;
            parsed.host_str().filter(|host| !host.is_empty())?;
            Some(UiLinkKind::External)
        }
        _ => Some(UiLinkKind::Handoff),
    }
}

/// Every allowed link in `structured` and `text`, deduplicated, at most
/// [`MAX_LINKS`], structured content first.
#[must_use]
pub fn extract_links(structured: Option<&Value>, text: &str) -> Vec<UiLink> {
    let mut out: Vec<UiLink> = Vec::new();
    let mut strings = Vec::new();
    if let Some(value) = structured {
        collect_strings(value, 0, &mut strings);
    }
    strings.push(text);
    for haystack in strings {
        for found in URL_RE.find_iter(haystack) {
            if out.len() >= MAX_LINKS {
                return out;
            }
            let url = trim_trailing(found.as_str());
            let Some(kind) = classify(url) else {
                tracing::trace!("[mcp_ui] dropped a blocked link");
                continue;
            };
            if kind == UiLinkKind::External && is_image_url(url) {
                continue;
            }
            if out.iter().any(|link| link.url == url) {
                continue;
            }
            out.push(UiLink {
                url: url.to_string(),
                kind,
            });
        }
    }
    out
}

/// Whether an `http(s)` URL points at an image asset rather than a page.
#[must_use]
pub fn is_image_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let path = parsed.path().to_ascii_lowercase();
    if path.contains("/image/upload/") {
        return true;
    }
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| !ext.contains('/') && IMAGE_EXTENSIONS.contains(&ext))
}

fn collect_strings<'a>(value: &'a Value, depth: usize, out: &mut Vec<&'a str>) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_WALK_STRINGS {
        return;
    }
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_strings(item, depth + 1, out)),
        Value::Object(map) => map
            .values()
            .for_each(|item| collect_strings(item, depth + 1, out)),
        _ => {}
    }
}

fn trim_trailing(url: &str) -> &str {
    let mut end = url.len();
    loop {
        let trimmed = &url[..end];
        let Some(last) = trimmed.chars().last() else {
            return trimmed;
        };
        let unbalanced_paren =
            last == ')' && trimmed.matches('(').count() < trimmed.matches(')').count();
        if matches!(last, '.' | ',' | ';' | ':' | '!' | '?' | '*') || unbalanced_paren {
            end -= last.len_utf8();
        } else {
            return trimmed;
        }
    }
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
