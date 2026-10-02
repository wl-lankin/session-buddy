//! A confirmation the island shows without a session behind it, e.g. "Start a session in Nexa".
//! Answered through the same `answer` command as every other interaction: `{"allow": bool, "folder"?, "host"?}`.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub label: String,
    pub value: String,
}

/// A folder the user may change with the native dialog; `options` are other matches for the model's name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderChoice {
    pub path: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HostOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HostChoice {
    pub value: String,
    pub options: Vec<HostOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    /// Set by the hub.
    pub request_id: String,
    pub title: String,
    pub rows: Vec<Row>,
    /// The full text to review, e.g. the prompt.
    pub body: Option<String>,
    pub folder: Option<FolderChoice>,
    pub host: Option<HostChoice>,
    /// Epoch ms, set by the hub.
    pub deadline: i64,
}

impl ActionRequest {
    pub fn new(title: &str) -> Self {
        Self { request_id: String::new(), title: title.to_string(), rows: Vec::new(), body: None, folder: None, host: None, deadline: 0 }
    }

    pub fn row(mut self, label: &str, value: impl Into<String>) -> Self {
        self.rows.push(Row { label: label.to_string(), value: value.into() });
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shape_is_the_front_end_contract() {
        let mut a = ActionRequest::new("Start a session").row("Project", "Nexa");
        a.request_id = "a1".into();
        a.body = Some("fix it".into());
        a.folder = Some(FolderChoice { path: "/p/Nexa".into(), options: vec!["/p/Nexa".into(), "/q/Nexa".into()] });
        a.host = Some(HostChoice { value: "background".into(), options: vec![HostOption { id: "background".into(), label: "Background".into() }] });
        a.deadline = 99;
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            json!({
                "requestId": "a1",
                "title": "Start a session",
                "rows": [{"label": "Project", "value": "Nexa"}],
                "body": "fix it",
                "folder": {"path": "/p/Nexa", "options": ["/p/Nexa", "/q/Nexa"]},
                "host": {"value": "background", "options": [{"id": "background", "label": "Background"}]},
                "deadline": 99,
            })
        );
    }

    #[test]
    fn empty_parts_are_null() {
        let v = serde_json::to_value(ActionRequest::new("Stop")).unwrap();
        assert_eq!(v["body"], json!(null));
        assert_eq!(v["folder"], json!(null));
        assert_eq!(v["host"], json!(null));
        assert_eq!(v["rows"], json!([]));
    }
}
