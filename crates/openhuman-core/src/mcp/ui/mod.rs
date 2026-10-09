//! Tool-provided UI in the chat: MCP Apps widgets, OpenAI Apps SDK widgets,
//! skill views, and the links a tool result offers.
//!
//! - [`resolve`] reads one call's descriptor `_meta` and result into a
//!   [`types::McpUiPresentation`], the metadata the chat surface renders.
//! - [`decorate`] applies that to every MCP tool path.
//! - [`ops`] / `schemas` serve a widget its document and run the tool calls
//!   it asks for (`mcp_ui` namespace), through [`port::UiServerPort`].
//! - [`tools`] is `show_ui`, the host tool a skill renders HTML with.
//!
//! Widget HTML stays in [`cache`], in memory; events and transcripts carry
//! only the bounded presentation.

pub mod cache;
pub mod decorate;
pub mod discovery;
pub mod links;
pub mod ops;
pub mod port;
pub mod resolve;
mod schemas;
pub mod tools;
pub mod types;

pub use decorate::{decorate_result, UiAwareTool};
pub use schemas::{
    all_controller_schemas as all_mcp_ui_controller_schemas,
    all_registered_controllers as all_mcp_ui_registered_controllers,
};
pub use tools::ShowUiTool;

/// The `initialize` capabilities this host advertises: MCP Apps support.
#[must_use]
pub fn client_capabilities() -> serde_json::Value {
    let mut extensions = serde_json::Map::new();
    extensions.insert(
        types::MCP_APPS_EXTENSION.to_string(),
        serde_json::json!({ "mimeTypes": [types::MCP_APP_MIME] }),
    );
    serde_json::json!({ "extensions": extensions })
}
