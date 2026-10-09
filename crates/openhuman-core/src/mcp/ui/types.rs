//! Wire types for tool-provided UI: the presentation a tool result carries to
//! the chat surface, and the payloads of the `mcp_ui` RPC namespace.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The `kind` a presentation carries in a tool result's metadata.
pub const MCP_UI_KIND: &str = "mcp_ui";

/// The `kind` of the result envelope `tinymcp` attaches to a tool result.
pub const MCP_RESULT_KIND: &str = "mcp_result";

/// The MIME type an MCP Apps resource declares.
pub const MCP_APP_MIME: &str = "text/html;profile=mcp-app";

/// The client capability extension that advertises MCP Apps support.
pub const MCP_APPS_EXTENSION: &str = "io.modelcontextprotocol/ui";

/// Which widget protocol the frame speaks to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiFlavor {
    /// MCP Apps (`ui/*` JSON-RPC over `postMessage`).
    McpApps,
    /// OpenAI Apps SDK (`window.openai`), bridged onto the same channel.
    AppsSdk,
    /// HTML supplied by the host itself (`show_ui`); no tool calls.
    HostInline,
}

/// How a link found in a tool result may be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiLinkKind {
    /// `http(s)`: opened in the system browser.
    External,
    /// Any other allowed scheme (`upi://`, `phonepe://`, ...): handed to a
    /// phone by QR code, never opened on this machine.
    Handoff,
}

/// A link a tool result offered, shown as an action under the call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiLink {
    pub url: String,
    pub kind: UiLinkKind,
}

/// What the chat surface renders for one tool call that offered UI.
///
/// Carried as the tool result's metadata. Never carries the widget's HTML:
/// the frame reads that through `openhuman.mcp_ui_resource_read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpUiPresentation {
    /// Always [`MCP_UI_KIND`].
    pub kind: String,
    pub flavor: UiFlavor,
    /// The server the tool belongs to; `None` for host-supplied UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub tool: String,
    /// The `ui://` resource the frame loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_uri: Option<String>,
    /// An in-memory inline resource the frame loads instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub tool_input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_meta: Option<Value>,
    #[serde(default)]
    pub links: Vec<UiLink>,
}

impl McpUiPresentation {
    /// Whether the presentation has a frame to show.
    #[must_use]
    pub fn has_frame(&self) -> bool {
        self.resource_uri.is_some() || self.inline_id.is_some()
    }

    /// The presentation as tool-result metadata.
    #[must_use]
    pub fn to_metadata(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// One tool call, reduced to what UI resolution reads.
#[derive(Debug, Clone, Default)]
pub struct UiCallView {
    pub server_id: String,
    pub tool: String,
    /// The tool descriptor's `_meta`.
    pub tool_meta: Option<Value>,
    pub tool_input: Value,
    pub structured_content: Option<Value>,
    /// The result's `_meta`.
    pub result_meta: Option<Value>,
    /// Embedded resources, as `{uri, mimeType, text?, _meta?}` objects.
    pub resources: Vec<Value>,
    /// The result's text, as the model saw it.
    pub text: String,
}

/// A widget document, ready for the frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiResource {
    pub html: String,
    pub mime_type: String,
    pub csp: UiCsp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Value>,
    #[serde(default)]
    pub prefers_border: bool,
}

/// The origins a widget may reach, already reduced to `https` only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiCsp {
    #[serde(default)]
    pub connect_domains: Vec<String>,
    #[serde(default)]
    pub resource_domains: Vec<String>,
}

/// What a widget-initiated tool call needs to know about its target tool.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UiToolDescriptor {
    pub meta: Option<Value>,
    pub annotations: Option<Value>,
}
