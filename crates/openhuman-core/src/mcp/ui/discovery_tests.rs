use super::*;
use serde_json::json;

#[test]
fn template_uri_precedence_and_scheme() {
    assert_eq!(
        template_uri(&json!({"ui": {"resourceUri": "ui://a"}, "openai/outputTemplate": "ui://b"})),
        Some("ui://a")
    );
    assert_eq!(
        template_uri(&json!({"openai/outputTemplate": "ui://b"})),
        Some("ui://b")
    );
    assert_eq!(
        template_uri(&json!({"ui": {"resourceUri": "https://x"}})),
        None
    );
}

#[test]
fn meta_keys_include_ui_members() {
    let keys = meta_keys(&json!({"ui": {"resourceUri": "ui://a", "visibility": ["app"]}, "x": 1}));
    assert!(keys.contains(&"ui".to_string()));
    assert!(keys.contains(&"ui.resourceUri".to_string()));
    assert!(keys.contains(&"x".to_string()));
}
