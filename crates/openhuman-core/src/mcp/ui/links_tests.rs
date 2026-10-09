use super::*;
use serde_json::json;

fn urls(links: &[UiLink]) -> Vec<&str> {
    links.iter().map(|link| link.url.as_str()).collect()
}

#[test]
fn keeps_https_and_handoff_schemes() {
    let text =
        "Pay at https://pay.example.com/o/1 or phonepe://pay?id=1 or upi://pay?pa=a@b&am=10.";
    let links = extract_links(None, text);
    assert_eq!(
        urls(&links),
        vec![
            "https://pay.example.com/o/1",
            "phonepe://pay?id=1",
            "upi://pay?pa=a@b&am=10"
        ]
    );
    assert_eq!(links[0].kind, UiLinkKind::External);
    assert_eq!(links[1].kind, UiLinkKind::Handoff);
    assert_eq!(links[2].kind, UiLinkKind::Handoff);
}

#[test]
fn drops_dangerous_schemes() {
    let text = "javascript://x%0Aalert(1) data://text/html,hi file:///etc/passwd tauri://localhost ohwidget://x blob://y";
    assert!(extract_links(None, text).is_empty());
}

#[test]
fn classify_table() {
    assert_eq!(classify("https://a.com"), Some(UiLinkKind::External));
    assert_eq!(classify("http://a.com/x"), Some(UiLinkKind::External));
    assert_eq!(classify("tez://upi/pay"), Some(UiLinkKind::Handoff));
    assert_eq!(classify("JAVASCRIPT:alert(1)"), None);
    assert_eq!(classify("data:text/html,x"), None);
    assert_eq!(classify("https://"), None);
    assert_eq!(classify("nonsense"), None);
    assert_eq!(classify("1http://a.com"), None);
}

#[test]
fn structured_content_comes_first_and_dedupes() {
    let structured = json!({
        "order": {"a_payment_url": "https://pay.example.com/o/1", "b_deep": ["phonepe://pay?id=1"]}
    });
    let links = extract_links(
        Some(&structured),
        "See https://pay.example.com/o/1 and https://other.example.com.",
    );
    assert_eq!(
        urls(&links),
        vec![
            "https://pay.example.com/o/1",
            "phonepe://pay?id=1",
            "https://other.example.com"
        ]
    );
}

#[test]
fn caps_at_max_links() {
    let text = (0..10)
        .map(|i| format!("https://e{i}.example.com"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(extract_links(None, &text).len(), MAX_LINKS);
}

#[test]
fn trims_markdown_punctuation_and_unbalanced_parens() {
    let links = extract_links(
        None,
        "[pay](https://pay.example.com/x) (see https://a.example.com/p_(1)).",
    );
    assert_eq!(
        urls(&links),
        vec!["https://pay.example.com/x", "https://a.example.com/p_(1)"]
    );
}

#[test]
fn drops_image_assets() {
    let structured = json!({
        "a_image": "https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto/NI_CATALOG/IMAGES/CIW/2026/6/4/x_1",
        "b_photo": "https://cdn.example.com/products/bar_1.JPG",
        "c_page": "https://www.swiggy.com/instamart/item/123",
    });
    let text = "Logo https://cdn.example.com/logo.svg?v=2 and pay at upi://pay?pa=a@b.png";
    let links = extract_links(Some(&structured), text);
    assert_eq!(
        urls(&links),
        vec![
            "https://www.swiggy.com/instamart/item/123",
            "upi://pay?pa=a@b.png"
        ]
    );
}

#[test]
fn image_url_table() {
    assert!(is_image_url(
        "https://res.cloudinary.com/demo/image/upload/sample"
    ));
    assert!(is_image_url("https://cdn.example.com/a/b.webp"));
    assert!(!is_image_url("https://example.com/pngs/list"));
    assert!(!is_image_url("https://example.com/checkout"));
    assert!(!is_image_url("not a url"));
}
