//! The account's 5-hour and 7-day limits. Preferred source: `rate_limits` in the
//! status-line JSON. Fallback: Claude Code's own OAuth usage endpoint.

use serde::Serialize;
use serde_json::Value;

pub const STATUSLINE_FRESH_MS: i64 = 15 * 60_000;
pub const OAUTH_EVERY_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub used_pct: f64,
    pub resets_at: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub email: Option<String>,
    pub org: Option<String>,
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    Statusline,
    Oauth,
    #[default]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
    pub source: UsageSource,
    pub updated_at: Option<i64>,
    pub error: Option<String>,
    pub account: Option<Account>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    UseStatusline(Value, i64),
    Fetch,
    Keep,
}

pub fn parse_limit(v: &Value) -> Option<Limit> {
    let pct = v.get("used_percentage").or_else(|| v.get("utilization")).and_then(Value::as_f64)?;
    let resets_at = v.get("resets_at").filter(|r| !r.is_null()).cloned();
    Some(Limit { used_pct: pct, resets_at })
}

pub fn parse_limits(v: &Value) -> (Option<Limit>, Option<Limit>) {
    (v.get("five_hour").and_then(parse_limit), v.get("seven_day").and_then(parse_limit))
}

fn pretty_plan(raw: &str) -> String {
    let words: Vec<String> = raw
        .trim_start_matches("claude_")
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect();
    words.join(" ")
}

pub fn parse_account(claude_json: &Value) -> Option<Account> {
    let o = claude_json.get("oauthAccount")?;
    let get = |k: &str| o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let plan = get("seatTier").or_else(|| get("organizationType")).or_else(|| get("billingType")).map(|p| pretty_plan(&p));
    Some(Account { email: get("emailAddress"), org: get("organizationName"), plan })
}

pub fn token_from_credentials(v: &Value) -> Option<String> {
    v.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

pub fn decide(rate_limits: Option<&(Value, i64)>, last_fetch: i64, now: i64) -> Plan {
    if let Some((v, at)) = rate_limits {
        if now - at < STATUSLINE_FRESH_MS {
            return Plan::UseStatusline(v.clone(), *at);
        }
    }
    if now - last_fetch >= OAUTH_EVERY_MS { Plan::Fetch } else { Plan::Keep }
}

pub fn apply_statusline(u: &mut Usage, v: &Value, at: i64) {
    let (f, s) = parse_limits(v);
    u.five_hour = f;
    u.seven_day = s;
    u.source = UsageSource::Statusline;
    u.updated_at = Some(at);
    u.error = None;
}

pub fn apply_oauth(u: &mut Usage, v: &Value, at: i64) {
    let (f, s) = parse_limits(v);
    u.five_hour = f;
    u.seven_day = s;
    u.source = UsageSource::Oauth;
    u.updated_at = Some(at);
    u.error = None;
}

pub fn apply_error(u: &mut Usage, err: String) {
    u.error = Some(err);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_both_shapes() {
        let status = json!({"five_hour": {"used_percentage": 42.0, "resets_at": 1790000000}, "seven_day": {"used_percentage": 18}});
        let (f, s) = parse_limits(&status);
        assert_eq!(f, Some(Limit { used_pct: 42.0, resets_at: Some(json!(1790000000)) }));
        assert_eq!(s, Some(Limit { used_pct: 18.0, resets_at: None }));
        let oauth = json!({"five_hour": {"utilization": 7.5, "resets_at": "2026-10-01T14:30:00Z"}, "seven_day": null});
        let (f, s) = parse_limits(&oauth);
        assert_eq!(f.unwrap().resets_at, Some(json!("2026-10-01T14:30:00Z")));
        assert!(s.is_none());
    }

    #[test]
    fn account_label_fields() {
        let cj = json!({"oauthAccount": {"emailAddress": "wolfgang@private.de", "organizationName": "Wolfgang's Individual Org", "organizationType": "claude_max"}});
        assert_eq!(
            parse_account(&cj),
            Some(Account { email: Some("wolfgang@private.de".into()), org: Some("Wolfgang's Individual Org".into()), plan: Some("Max".into()) })
        );
        let team = json!({"oauthAccount": {"emailAddress": "w@finodata.de", "organizationName": "finodata", "seatTier": "team_standard"}});
        assert_eq!(parse_account(&team).unwrap().plan.as_deref(), Some("Team Standard"));
        assert!(parse_account(&json!({})).is_none());
    }

    #[test]
    fn token_from_both_credential_stores() {
        assert_eq!(token_from_credentials(&json!({"claudeAiOauth": {"accessToken": "sk-ant-oat-x"}})).as_deref(), Some("sk-ant-oat-x"));
        assert!(token_from_credentials(&json!({})).is_none());
    }

    #[test]
    fn prefers_fresh_status_line_then_fetches_every_10_minutes() {
        let now = 100 * 60_000;
        let rl = (json!({"five_hour": {"used_percentage": 1}}), now - 60_000);
        assert_eq!(decide(Some(&rl), 0, now), Plan::UseStatusline(rl.0.clone(), rl.1));
        let old = (rl.0.clone(), now - STATUSLINE_FRESH_MS - 1);
        assert_eq!(decide(Some(&old), now - OAUTH_EVERY_MS, now), Plan::Fetch);
        assert_eq!(decide(None, now - OAUTH_EVERY_MS + 1, now), Plan::Keep);
        assert_eq!(decide(None, i64::MIN / 2, now), Plan::Fetch);
    }

    #[test]
    fn errors_keep_the_last_values() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &json!({"five_hour": {"utilization": 30}}), 5);
        apply_error(&mut u, "usage endpoint returned 429".into());
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 30.0);
        assert_eq!(u.updated_at, Some(5));
        assert_eq!(u.error.as_deref(), Some("usage endpoint returned 429"));
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 31}}), 9);
        assert_eq!(u.source, UsageSource::Statusline);
        assert!(u.error.is_none());
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["fiveHour"]["usedPct"], 31.0);
        assert_eq!(v["source"], "statusline");
    }
}
