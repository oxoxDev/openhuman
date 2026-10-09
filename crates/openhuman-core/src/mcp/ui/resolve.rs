//! Turning one tool call into what the chat surface shows for it.
//!
//! Pure over the call's JSON: the tool descriptor's `_meta`, the result's
//! structured content, `_meta` and embedded resources, and its text. The one
//! side effect is caching an embedded widget document so the frame can load
//! it by id.

use base64::Engine as _;
use serde_json::Value;

use super::cache::{self, InlineEntry};
use super::links::extract_links;
use super::types::{
    McpUiPresentation, UiCallView, UiCsp, UiFlavor, UiResource, MCP_RESULT_KIND, MCP_UI_KIND,
};

/// The largest widget document served to a frame.
pub const MAX_RESOURCE_BYTES: usize = 2 * 1024 * 1024;
/// The largest structured content forwarded with a presentation.
pub const MAX_STRUCTURED_BYTES: usize = 64 * 1024;
const MAX_META_BYTES: usize = 16 * 1024;
const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_CSP_DOMAINS: usize = 32;

/// Where a frame's document comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum UiSource {
    /// A `ui://` resource on the tool's server.
    Uri { uri: String, flavor: UiFlavor },
    /// A document the result embedded.
    Embedded { resource: Value },
}

/// Whether `uri` is a widget resource URI.
#[must_use]
pub fn is_ui_uri(uri: &str) -> bool {
    uri.len() > "ui://".len()
        && uri
            .get(..5)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("ui://"))
}

fn is_html_mime(mime: &str) -> bool {
    let lowered = mime.trim().to_ascii_lowercase();
    lowered.starts_with("text/html")
}

fn meta_str<'a>(meta: Option<&'a Value>, path: &[&str]) -> Option<&'a str> {
    let mut cursor = meta?;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str()
}

/// The resource a tool's UI loads from, by precedence: `_meta.ui.resourceUri`,
/// the legacy `_meta["ui/resourceUri"]`, the Apps SDK
/// `_meta["openai/outputTemplate"]`, then an embedded `ui://` HTML resource.
#[must_use]
pub fn select_source(view: &UiCallView) -> Option<UiSource> {
    let metas = [view.tool_meta.as_ref(), view.result_meta.as_ref()];
    let candidates: [(&[&str], UiFlavor); 3] = [
        (&["ui", "resourceUri"], UiFlavor::McpApps),
        (&["ui/resourceUri"], UiFlavor::McpApps),
        (&["openai/outputTemplate"], UiFlavor::AppsSdk),
    ];
    for (path, flavor) in candidates {
        for meta in metas {
            if let Some(uri) = meta_str(meta, path).map(str::trim) {
                if is_ui_uri(uri) {
                    return Some(UiSource::Uri {
                        uri: uri.to_string(),
                        flavor,
                    });
                }
                tracing::debug!(tool = %view.tool, "[mcp_ui] ignored a non-ui:// resource URI");
            }
        }
    }
    view.resources
        .iter()
        .find(|resource| {
            let uri = resource.get("uri").and_then(Value::as_str).unwrap_or("");
            let mime = resource
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("");
            is_ui_uri(uri) && is_html_mime(mime)
        })
        .map(|resource| UiSource::Embedded {
            resource: resource.clone(),
        })
}

fn bounded(value: Option<&Value>, limit: usize) -> Option<Value> {
    let value = value.filter(|value| !value.is_null())?;
    let size = serde_json::to_vec(value).map(|bytes| bytes.len()).ok()?;
    if size > limit {
        tracing::debug!(size, limit, "[mcp_ui] dropped an oversized field");
        return None;
    }
    Some(value.clone())
}

/// The presentation for one call, or `None` when it offered neither a widget
/// nor a link.
#[must_use]
pub fn presentation_from_view(view: &UiCallView) -> Option<McpUiPresentation> {
    let links = extract_links(view.structured_content.as_ref(), &view.text);
    let source = select_source(view);
    let (resource_uri, inline_id, flavor) = match source {
        Some(UiSource::Uri { uri, flavor }) => {
            if let Some(embedded) = view
                .resources
                .iter()
                .find(|resource| resource.get("uri").and_then(Value::as_str) == Some(uri.as_str()))
            {
                if let Ok(resource) = resource_from_contents(std::slice::from_ref(embedded), &uri) {
                    cache::put_read(&view.server_id, &uri, resource);
                }
            }
            (Some(uri), None, flavor)
        }
        Some(UiSource::Embedded { resource }) => {
            let uri = resource
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match resource_from_contents(std::slice::from_ref(&resource), &uri) {
                Ok(document) => {
                    let id = cache::put_inline(InlineEntry {
                        server_id: Some(view.server_id.clone()),
                        resource: document,
                    });
                    (None, Some(id), UiFlavor::McpApps)
                }
                Err(error) => {
                    tracing::debug!(tool = %view.tool, %error, "[mcp_ui] embedded widget rejected");
                    (None, None, UiFlavor::McpApps)
                }
            }
        }
        None => (None, None, UiFlavor::McpApps),
    };
    if resource_uri.is_none() && inline_id.is_none() && links.is_empty() {
        return None;
    }
    tracing::debug!(
        server_id = %view.server_id,
        tool = %view.tool,
        frame = resource_uri.is_some() || inline_id.is_some(),
        links = links.len(),
        "[mcp_ui] tool call offered UI"
    );
    Some(McpUiPresentation {
        kind: MCP_UI_KIND.to_string(),
        flavor,
        server_id: Some(view.server_id.clone()),
        tool: view.tool.clone(),
        resource_uri,
        inline_id,
        title: None,
        tool_input: bounded(Some(&view.tool_input), MAX_INPUT_BYTES).unwrap_or(Value::Null),
        structured_content: bounded(view.structured_content.as_ref(), MAX_STRUCTURED_BYTES),
        result_meta: bounded(view.result_meta.as_ref(), MAX_META_BYTES),
        links,
    })
}

fn normalize_resource_entry(entry: &Value) -> Value {
    match entry.get("type").and_then(Value::as_str) {
        Some("resource") => entry.get("resource").cloned().unwrap_or(Value::Null),
        _ => entry.clone(),
    }
}

fn resources_from_content(content: Option<&Value>) -> Vec<Value> {
    content
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("resource"))
                .map(normalize_resource_entry)
                .collect()
        })
        .unwrap_or_default()
}

fn text_from_content(content: Option<&Value>) -> String {
    content
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// A view over a server's raw `tools/call` reply.
#[must_use]
pub fn view_from_raw_result(
    server_id: &str,
    tool: &str,
    tool_meta: Option<Value>,
    tool_input: Value,
    raw: &Value,
) -> UiCallView {
    UiCallView {
        server_id: server_id.to_string(),
        tool: tool.to_string(),
        tool_meta,
        tool_input,
        structured_content: raw.get("structuredContent").cloned(),
        result_meta: raw.get("_meta").cloned(),
        resources: resources_from_content(raw.get("content")),
        text: text_from_content(raw.get("content")),
    }
}

/// A view over the `mcp_result` envelope a tool result's metadata carries.
///
/// `None` when `metadata` is not that envelope.
#[must_use]
pub fn view_from_envelope(
    metadata: &Value,
    tool_meta: Option<Value>,
    tool_input: Value,
    text: &str,
) -> Option<UiCallView> {
    if metadata.get("kind").and_then(Value::as_str) != Some(MCP_RESULT_KIND) {
        return None;
    }
    let server_id = metadata.get("server").and_then(Value::as_str)?;
    let tool = metadata.get("tool").and_then(Value::as_str)?;
    let resources = metadata
        .get("resources")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().map(normalize_resource_entry).collect())
        .unwrap_or_default();
    Some(UiCallView {
        server_id: server_id.to_string(),
        tool: tool.to_string(),
        tool_meta,
        tool_input,
        structured_content: metadata
            .get("structured_content")
            .filter(|value| !value.is_null())
            .cloned(),
        result_meta: metadata
            .get("meta")
            .filter(|value| !value.is_null())
            .cloned(),
        resources,
        text: text.to_string(),
    })
}

/// The widget document for `uri` among a `resources/read` reply's contents.
///
/// # Errors
///
/// When no entry matches, the entry is not HTML, has no text, or is larger
/// than [`MAX_RESOURCE_BYTES`].
pub fn resource_from_contents(contents: &[Value], uri: &str) -> Result<UiResource, String> {
    let entry = contents
        .iter()
        .find(|entry| entry.get("uri").and_then(Value::as_str) == Some(uri))
        .or_else(|| (contents.len() == 1).then(|| &contents[0]))
        .ok_or_else(|| "the server returned no document for this URI".to_string())?;
    let mime_type = entry
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !is_html_mime(&mime_type) {
        return Err(format!("unsupported widget type `{mime_type}`"));
    }
    let html = match (
        entry.get("text").and_then(Value::as_str),
        entry.get("blob").and_then(Value::as_str),
    ) {
        (Some(text), _) => {
            if text.len() > MAX_RESOURCE_BYTES {
                return Err("the widget document is too large".to_string());
            }
            text.to_string()
        }
        (None, Some(blob)) => {
            if blob.len() > MAX_RESOURCE_BYTES * 4 / 3 + 4 {
                return Err("the widget document is too large".to_string());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(blob.trim())
                .map_err(|_| "the widget document is not valid base64".to_string())?;
            String::from_utf8(bytes).map_err(|_| "the widget document is not UTF-8".to_string())?
        }
        (None, None) => return Err("the widget document is empty".to_string()),
    };
    if html.len() > MAX_RESOURCE_BYTES {
        return Err("the widget document is too large".to_string());
    }
    let meta = entry.get("_meta");
    Ok(UiResource {
        html,
        mime_type,
        csp: csp_from_meta(meta),
        permissions: meta
            .and_then(|meta| meta.pointer("/ui/permissions"))
            .filter(|value| value.is_object())
            .cloned(),
        prefers_border: meta
            .and_then(|meta| {
                meta.pointer("/ui/prefersBorder")
                    .or_else(|| meta.get("openai/widgetPrefersBorder"))
            })
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn csp_from_meta(meta: Option<&Value>) -> UiCsp {
    let Some(meta) = meta else {
        return UiCsp::default();
    };
    let (connect, resource) = if let Some(csp) = meta.pointer("/ui/csp") {
        (csp.get("connectDomains"), csp.get("resourceDomains"))
    } else if let Some(csp) = meta.get("openai/widgetCSP") {
        (csp.get("connect_domains"), csp.get("resource_domains"))
    } else {
        (None, None)
    };
    UiCsp {
        connect_domains: https_origins(connect),
        resource_domains: https_origins(resource),
    }
}

/// Each declared origin that is `https`, reduced to `https://host[:port]`;
/// a leading `*.` wildcard label is kept.
#[must_use]
pub fn https_origins(value: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(items) = value.and_then(Value::as_array) else {
        return out;
    };
    for item in items.iter().filter_map(Value::as_str) {
        if out.len() >= MAX_CSP_DOMAINS {
            break;
        }
        if let Some(origin) = https_origin(item) {
            if !out.contains(&origin) {
                out.push(origin);
            }
        }
    }
    out
}

fn https_origin(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let rest = raw
        .get(..8)
        .filter(|prefix| prefix.eq_ignore_ascii_case("https://"))
        .map(|_| &raw[8..])?;
    let authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), Some(port.to_string()))
        }
        Some(_) => return None,
        None => (authority.clone(), None),
    };
    let bare = host.strip_prefix("*.").unwrap_or(&host);
    let labels_ok = !bare.is_empty()
        && bare.contains('.')
        && bare.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if !labels_ok {
        return None;
    }
    Some(match port {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
