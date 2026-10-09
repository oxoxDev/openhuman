use super::*;
use std::cell::RefCell;

fn flow_row(agent_id: Option<&str>) -> PendingApproval {
    PendingApproval {
        request_id: "req-1".to_string(),
        tool_name: "shell".to_string(),
        action_summary: "run it".to_string(),
        args_redacted: serde_json::json!({}),
        created_at: chrono::Utc::now(),
        expires_at: None,
        source_context: Some(ApprovalSourceContext::Flow {
            flow_id: "shared-flow".to_string(),
            run_id: "run-1".to_string(),
            node_id: None,
        }),
        tool_call_id: None,
        agent_id: agent_id.map(str::to_string),
    }
}

fn granted_by(row: &PendingApproval) -> Vec<(String, String)> {
    let granted = RefCell::new(Vec::new());
    let mut logs = Vec::new();
    persist_flow_trust(
        |flow_id, tool| {
            granted
                .borrow_mut()
                .push((flow_id.to_string(), tool.to_string()));
            Ok(())
        },
        row,
        &mut logs,
    );
    granted.into_inner()
}

#[test]
fn flow_trust_is_granted_for_the_process_but_never_for_an_agent_row() {
    assert_eq!(
        granted_by(&flow_row(None)),
        vec![("shared-flow".to_string(), "shell".to_string())]
    );
    assert!(
        granted_by(&flow_row(Some("agent-a"))).is_empty(),
        "an agent's decision must not grant trust another agent would inherit"
    );
}
