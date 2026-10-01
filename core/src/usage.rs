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
    /// "normal", "warning" or "critical" as the usage endpoint reports it; "normal" for status-line data.
    pub severity: String,
}

/// One row of the limits block: "5H", "7D" or a scoped weekly limit such as "7D Fable".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRow {
    pub kind: String,
    pub label: String,
    pub used_pct: f64,
    pub resets_at: Option<Value>,
    pub severity: String,
}

/// Extra usage (pay-as-you-go beyond the plan): amounts in minor units of `currency`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub enabled: bool,
    pub used_minor: i64,
    pub limit_minor: Option<i64>,
    pub currency: String,
    pub exponent: u32,
    pub disabled_reason: Option<String>,
    pub percent: Option<f64>,
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
    /// Every row of the limits block in display order: 5H, 7D, then the scoped limits.
    pub limits: Vec<LimitRow>,
    pub extra: Option<Extra>,
    pub source: UsageSource,
    pub updated_at: Option<i64>,
    /// Windows error: the last failed refresh or an empty status-line reading; cleared by the next good reading.
    pub error: Option<String>,
    /// When the usage endpoint last answered; scoped limits and extra usage are as old as this.
    pub oauth_updated_at: Option<i64>,
    /// The usage endpoint's last error. Only a successful endpoint response clears it.
    pub oauth_error: Option<String>,
    pub account: Option<Account>,
}

/// What the poll loop does now: apply a fresh status line reading and/or fetch the OAuth endpoint.
/// The endpoint is fetched every 10 minutes regardless of the status line, because only it
/// carries the scoped limits and the extra usage.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub statusline: Option<(Value, i64)>,
    pub fetch: bool,
}

pub fn parse_limit(v: &Value) -> Option<Limit> {
    let pct = v.get("used_percentage").or_else(|| v.get("utilization")).and_then(Value::as_f64)?;
    let resets_at = v.get("resets_at").filter(|r| !r.is_null()).cloned();
    let severity = v.get("severity").and_then(Value::as_str).unwrap_or("normal").to_string();
    Some(Limit { used_pct: pct, resets_at, severity })
}

pub fn parse_limits(v: &Value) -> (Option<Limit>, Option<Limit>) {
    (v.get("five_hour").and_then(parse_limit), v.get("seven_day").and_then(parse_limit))
}

fn row_from(kind: &str, label: String, l: &Limit) -> LimitRow {
    LimitRow { kind: kind.into(), label, used_pct: l.used_pct, resets_at: l.resets_at.clone(), severity: l.severity.clone() }
}

/// Reads the OAuth `limits` array. Returns `None` when the response has no such array.
/// Session and weekly_all rows get their plain labels; a scoped weekly row is labelled
/// "7D <model>" (or "7D <surface>"). Rows of unknown kinds are skipped.
pub fn parse_limit_rows(v: &Value) -> Option<Vec<LimitRow>> {
    let arr = v.get("limits")?.as_array()?;
    let mut rows = Vec::new();
    for item in arr {
        let Some(kind) = item.get("kind").and_then(Value::as_str) else { continue };
        let Some(pct) = item.get("percent").and_then(Value::as_f64) else { continue };
        let label = match kind {
            "session" => "5H".to_string(),
            "weekly_all" => "7D".to_string(),
            "weekly_scoped" => {
                let scope = item.get("scope");
                let name = |p: &str| scope.and_then(|s| s.pointer(p)).and_then(Value::as_str).filter(|n| !n.is_empty());
                match name("/model/display_name").or_else(|| name("/surface/display_name")).or_else(|| name("/surface")) {
                    Some(n) => format!("7D {n}"),
                    None => continue,
                }
            }
            _ => continue,
        };
        let severity = item.get("severity").and_then(Value::as_str).unwrap_or("normal").to_string();
        let resets_at = item.get("resets_at").filter(|r| !r.is_null()).cloned();
        rows.push(LimitRow { kind: kind.into(), label, used_pct: pct, resets_at, severity });
    }
    Some(rows)
}

fn round_minor(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))
}

/// An amount object `{amount_minor}` or a bare number; floats are rounded.
fn minor(v: &Value) -> Option<i64> {
    v.get("amount_minor").and_then(round_minor).or_else(|| round_minor(v))
}

/// Why extra usage is off, from the older `extra_usage` object: its reason, else "user_disabled".
fn legacy_reason(v: &Value) -> Option<String> {
    let e = v.get("extra_usage")?;
    e.get("disabled_reason")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| e.get("user_disabled").and_then(Value::as_bool).filter(|d| *d).map(|_| "user_disabled".to_string()))
}

fn percent_of(used: i64, limit: Option<i64>) -> Option<f64> {
    limit.filter(|l| *l > 0).map(|l| used as f64 * 100.0 / l as f64)
}

/// Extra usage from `spend` (preferred) or the older `extra_usage` object.
pub fn parse_extra(v: &Value) -> Option<Extra> {
    let spend = v.get("spend").and_then(|sp| Some((sp, sp.get("used").filter(|u| u.is_object())?, minor(sp.get("used")?)?)));
    if let Some((sp, used, used_minor)) = spend {
        let limit_minor = sp.get("limit").filter(|l| !l.is_null()).and_then(minor);
        let currency = used.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string();
        let exponent = used.get("exponent").and_then(Value::as_u64).unwrap_or(2) as u32;
        let percent = sp.get("percent").and_then(Value::as_f64).or_else(|| percent_of(used_minor, limit_minor));
        let enabled = sp.get("enabled").and_then(Value::as_bool).unwrap_or(false);
        let mut disabled_reason = sp.get("disabled_reason").and_then(Value::as_str).map(str::to_string);
        if disabled_reason.is_none() && !enabled {
            disabled_reason = legacy_reason(v);
        }
        return Some(Extra { enabled, used_minor, limit_minor, currency, exponent, disabled_reason, percent });
    }
    let e = v.get("extra_usage").filter(|e| e.is_object())?;
    let enabled = e.get("is_enabled").and_then(Value::as_bool).unwrap_or(false);
    let used_minor = e.get("used_credits").and_then(Value::as_f64).map(|c| c.round() as i64).unwrap_or(0);
    let limit_minor = e.get("monthly_limit").and_then(Value::as_f64).map(|c| c.round() as i64);
    let currency = e.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string();
    let exponent = e.get("decimal_places").and_then(Value::as_u64).unwrap_or(2) as u32;
    let percent = e.get("utilization").and_then(Value::as_f64).or_else(|| percent_of(used_minor, limit_minor));
    let disabled_reason = legacy_reason(v);
    Some(Extra { enabled, used_minor, limit_minor, currency, exponent, disabled_reason, percent })
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
    let plan = get("organizationType").or_else(|| get("seatTier")).map(|p| pretty_plan(&p)).filter(|p| !p.is_empty());
    Some(Account { email: get("emailAddress"), org: get("organizationName"), plan })
}

pub fn token_from_credentials(v: &Value) -> Option<String> {
    v.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

pub fn decide(rate_limits: Option<&(Value, i64)>, last_fetch: i64, now: i64) -> Plan {
    let statusline = rate_limits.filter(|(_, at)| now - at < STATUSLINE_FRESH_MS).cloned();
    Plan { statusline, fetch: now - last_fetch >= OAUTH_EVERY_MS }
}

/// Rebuilds the 5H / 7D rows from the window fields; scoped rows stay where they are.
fn sync_window_rows(u: &mut Usage) {
    u.limits.retain(|r| r.kind != "session" && r.kind != "weekly_all");
    let mut head = Vec::new();
    if let Some(l) = &u.five_hour {
        head.push(row_from("session", "5H".into(), l));
    }
    if let Some(l) = &u.seven_day {
        head.push(row_from("weekly_all", "7D".into(), l));
    }
    head.append(&mut u.limits);
    u.limits = head;
}

fn set_windows(u: &mut Usage, f: Option<Limit>, s: Option<Limit>) {
    if f.is_some() {
        u.five_hour = f;
    }
    if s.is_some() {
        u.seven_day = s;
    }
    sync_window_rows(u);
}

/// Status line `rate_limits`: only the 5H and 7D windows. An empty response is an error and
/// leaves the previous values untouched; a single present window only replaces its own side.
pub fn apply_statusline(u: &mut Usage, v: &Value, at: i64) {
    let (f, s) = parse_limits(v);
    if f.is_none() && s.is_none() {
        u.error = Some("usage response had no limits".into());
        return;
    }
    set_windows(u, f, s);
    u.source = UsageSource::Statusline;
    u.updated_at = Some(at);
    u.error = None;
}

/// OAuth usage response. Scoped limits and extra usage always come from here; the 5H / 7D
/// windows only when no fresh status line already provides them.
pub fn apply_oauth(u: &mut Usage, v: &Value, at: i64) {
    let rows = parse_limit_rows(v);
    let (mut f, mut s) = parse_limits(v);
    if let Some(rows) = &rows {
        let pick = |kind: &str| rows.iter().find(|r| r.kind == kind).map(|r| Limit { used_pct: r.used_pct, resets_at: r.resets_at.clone(), severity: r.severity.clone() });
        f = pick("session").or(f);
        s = pick("weekly_all").or(s);
    }
    let extra = parse_extra(v);
    let scoped_present = rows.as_ref().is_some_and(|r| r.iter().any(|x| x.kind == "weekly_scoped"));
    if f.is_none() && s.is_none() && !scoped_present && extra.is_none() {
        apply_error(u, "usage response had no limits".into());
        return;
    }
    if let Some(rows) = rows {
        u.limits.retain(|r| r.kind != "weekly_scoped");
        u.limits.extend(rows.into_iter().filter(|r| r.kind == "weekly_scoped"));
    }
    if extra.is_some() {
        u.extra = extra;
    }
    let statusline_fresh = u.source == UsageSource::Statusline && u.updated_at.is_some_and(|t| at - t < STATUSLINE_FRESH_MS);
    if !statusline_fresh && (f.is_some() || s.is_some()) {
        set_windows(u, f, s);
        u.source = UsageSource::Oauth;
        u.updated_at = Some(at);
    }
    u.error = None;
    u.oauth_error = None;
    u.oauth_updated_at = Some(at);
}

/// A failed endpoint refresh. Every value stays; the status line clears `error` on its next
/// reading but not `oauth_error`, which tells the UI the scoped limits and extra usage are stale.
pub fn apply_error(u: &mut Usage, err: String) {
    u.oauth_error = Some(err.clone());
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
        assert_eq!(f, Some(Limit { used_pct: 42.0, resets_at: Some(json!(1790000000)), severity: "normal".into() }));
        assert_eq!(s, Some(Limit { used_pct: 18.0, resets_at: None, severity: "normal".into() }));
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
        let real_team = json!({"oauthAccount": {"emailAddress": "w@finodata.de", "organizationType": "claude_team", "seatTier": "team_tier_1", "billingType": "stripe_subscription"}});
        assert_eq!(parse_account(&real_team).unwrap().plan.as_deref(), Some("Team"));
        let seat_only = json!({"oauthAccount": {"seatTier": "team_tier_1"}});
        assert_eq!(parse_account(&seat_only).unwrap().plan.as_deref(), Some("Team Tier 1"));
        let billing_only = json!({"oauthAccount": {"emailAddress": "a@b.de", "billingType": "stripe_subscription"}});
        assert_eq!(parse_account(&billing_only).unwrap().plan, None);
    }

    #[test]
    fn token_from_credentials_json() {
        assert_eq!(token_from_credentials(&json!({"claudeAiOauth": {"accessToken": "sk-ant-oat-x"}})).as_deref(), Some("sk-ant-oat-x"));
        assert!(token_from_credentials(&json!({})).is_none());
    }

    #[test]
    fn fetches_every_10_minutes_even_with_a_fresh_status_line() {
        let now = 100 * 60_000;
        let rl = (json!({"five_hour": {"used_percentage": 1}}), now - 60_000);
        assert_eq!(decide(Some(&rl), now - OAUTH_EVERY_MS + 1, now), Plan { statusline: Some(rl.clone()), fetch: false });
        assert_eq!(decide(Some(&rl), now - OAUTH_EVERY_MS, now), Plan { statusline: Some(rl.clone()), fetch: true });
        let old = (rl.0.clone(), now - STATUSLINE_FRESH_MS - 1);
        assert_eq!(decide(Some(&old), 0, now), Plan { statusline: None, fetch: true });
        assert_eq!(decide(None, now - OAUTH_EVERY_MS + 1, now), Plan { statusline: None, fetch: false });
        assert_eq!(decide(None, i64::MIN / 2, now), Plan { statusline: None, fetch: true });
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

    #[test]
    fn empty_response_is_an_error_and_keeps_values() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &json!({"five_hour": {"utilization": 30}, "seven_day": {"utilization": 10}}), 5);
        apply_oauth(&mut u, &json!({}), 9);
        apply_statusline(&mut u, &json!({"five_hour": null}), 10);
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 30.0);
        assert_eq!(u.seven_day.as_ref().unwrap().used_pct, 10.0);
        assert_eq!(u.source, UsageSource::Oauth);
        assert_eq!(u.updated_at, Some(5));
        assert_eq!(u.error.as_deref(), Some("usage response had no limits"));
    }

    #[test]
    fn one_window_keeps_the_other() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &json!({"five_hour": {"utilization": 30}, "seven_day": {"utilization": 10}}), 5);
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 50}}), 9);
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 50.0);
        assert_eq!(u.seven_day.as_ref().unwrap().used_pct, 10.0);
        assert_eq!(u.source, UsageSource::Statusline);
        assert_eq!(u.updated_at, Some(9));
        assert!(u.error.is_none());
    }

    fn real_response() -> Value {
        json!({
            "five_hour": {"utilization": 7.0, "resets_at": "2026-10-01T14:00:00Z", "limit_dollars": null, "locked_reason": null},
            "seven_day": {"utilization": 30.0, "resets_at": "2026-10-05T00:00:00Z"},
            "seven_day_opus": null,
            "limits": [
                {"kind": "session", "group": "session", "percent": 7, "severity": "normal", "resets_at": "2026-10-01T14:00:00Z", "scope": null, "is_active": true},
                {"kind": "weekly_all", "group": "weekly", "percent": 30, "severity": "normal", "resets_at": "2026-10-05T00:00:00Z", "scope": null},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 0, "severity": "normal", "resets_at": "2026-10-05T00:00:00Z", "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 12, "severity": "warning", "resets_at": null, "scope": {"model": null, "surface": "Design"}},
                {"kind": "mystery", "percent": 1}
            ],
            "extra_usage": {"is_enabled": false, "monthly_limit": null, "used_credits": 0, "utilization": null, "currency": "EUR", "decimal_places": 2, "disabled_reason": "out_of_credits", "user_disabled": false, "spend_limit_reached": false},
            "spend": {"used": {"amount_minor": 1240, "currency": "EUR", "exponent": 2}, "limit": {"amount_minor": 5000, "currency": "EUR", "exponent": 2}, "percent": 24.8, "severity": "normal", "enabled": true, "disabled_reason": null, "cap": null, "balance": null}
        })
    }

    fn labels(u: &Usage) -> Vec<&str> {
        u.limits.iter().map(|r| r.label.as_str()).collect()
    }

    #[test]
    fn parses_limit_rows_generically() {
        let rows = parse_limit_rows(&real_response()).unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(names, ["5H", "7D", "7D Fable", "7D Design"]);
        assert_eq!(rows[2].used_pct, 0.0);
        assert_eq!(rows[2].resets_at, Some(json!("2026-10-05T00:00:00Z")));
        assert_eq!(rows[3].severity, "warning");
        assert!(rows[3].resets_at.is_none());
        assert!(parse_limit_rows(&json!({"five_hour": {"utilization": 1}})).is_none());
    }

    #[test]
    fn parses_extra_from_spend_then_extra_usage() {
        let e = parse_extra(&real_response()).unwrap();
        assert_eq!(
            e,
            Extra { enabled: true, used_minor: 1240, limit_minor: Some(5000), currency: "EUR".into(), exponent: 2, disabled_reason: None, percent: Some(24.8) }
        );
        let mut only = real_response();
        only.as_object_mut().unwrap().remove("spend");
        let e = parse_extra(&only).unwrap();
        assert!(!e.enabled);
        assert_eq!((e.used_minor, e.limit_minor, e.percent), (0, None, None));
        assert_eq!(e.disabled_reason.as_deref(), Some("out_of_credits"));
        let user = json!({"extra_usage": {"is_enabled": false, "used_credits": 250, "monthly_limit": 1000, "currency": "USD", "decimal_places": 2, "user_disabled": true}});
        let e = parse_extra(&user).unwrap();
        assert_eq!((e.disabled_reason.as_deref(), e.percent), (Some("user_disabled"), Some(25.0)));
        assert!(parse_extra(&json!({"five_hour": null})).is_none());
    }

    #[test]
    fn oauth_fills_rows_and_extra() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &real_response(), 5);
        assert_eq!(labels(&u), ["5H", "7D", "7D Fable", "7D Design"]);
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 7.0);
        assert_eq!(u.source, UsageSource::Oauth);
        assert_eq!(u.extra.as_ref().unwrap().used_minor, 1240);
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["limits"][2]["label"], "7D Fable");
        assert_eq!(v["extra"]["usedMinor"], 1240);
    }

    #[test]
    fn legacy_response_falls_back_to_the_window_fields() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &json!({"five_hour": {"utilization": 30}, "seven_day": {"utilization": 10}}), 5);
        assert_eq!(labels(&u), ["5H", "7D"]);
        assert!(u.extra.is_none());
    }

    #[test]
    fn fresh_status_line_wins_the_windows_but_oauth_adds_scoped_and_extra() {
        let mut u = Usage::default();
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 50}, "seven_day": {"used_percentage": 60}}), 100);
        apply_oauth(&mut u, &real_response(), 200);
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 50.0);
        assert_eq!(u.seven_day.as_ref().unwrap().used_pct, 60.0);
        assert_eq!(u.source, UsageSource::Statusline);
        assert_eq!(u.updated_at, Some(100));
        let rows: Vec<(&str, f64)> = u.limits.iter().map(|r| (r.label.as_str(), r.used_pct)).collect();
        assert_eq!(rows, [("5H", 50.0), ("7D", 60.0), ("7D Fable", 0.0), ("7D Design", 12.0)]);
        assert!(u.extra.is_some());
        // Once the status line is stale, the endpoint takes over the windows.
        apply_oauth(&mut u, &real_response(), 100 + STATUSLINE_FRESH_MS);
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 7.0);
        assert_eq!(u.source, UsageSource::Oauth);
        // A later status line reading replaces only the windows.
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 9}}), 100 + STATUSLINE_FRESH_MS + 1);
        let rows: Vec<(&str, f64)> = u.limits.iter().map(|r| (r.label.as_str(), r.used_pct)).collect();
        assert_eq!(rows, [("5H", 9.0), ("7D", 30.0), ("7D Fable", 0.0), ("7D Design", 12.0)]);
    }

    #[test]
    fn severity_from_the_endpoint_reaches_the_window_rows() {
        let mut u = Usage::default();
        let v = json!({"limits": [
            {"kind": "session", "percent": 92, "severity": "critical", "resets_at": null},
            {"kind": "weekly_all", "percent": 75, "severity": "warning", "resets_at": null}
        ]});
        apply_oauth(&mut u, &v, 5);
        assert_eq!(u.limits[0].severity, "critical");
        assert_eq!(u.limits[1].severity, "warning");
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 10}}), 6);
        assert_eq!(u.limits[0].severity, "normal", "status-line data carries no severity");
        assert_eq!(u.limits[1].severity, "warning");
    }

    #[test]
    fn extra_accepts_float_amounts_and_falls_back_when_spend_has_none() {
        let floats = json!({"spend": {"used": {"amount_minor": 1239.6, "currency": "EUR", "exponent": 2}, "limit": {"amount_minor": 5000.0}, "enabled": true}});
        let e = parse_extra(&floats).unwrap();
        assert_eq!((e.used_minor, e.limit_minor), (1240, Some(5000)));
        let broken = json!({
            "spend": {"used": {"currency": "EUR"}, "enabled": true},
            "extra_usage": {"is_enabled": true, "used_credits": 300, "monthly_limit": 1000, "currency": "EUR", "decimal_places": 2, "utilization": 30.0}
        });
        let e = parse_extra(&broken).unwrap();
        assert_eq!((e.used_minor, e.limit_minor, e.percent), (300, Some(1000), Some(30.0)));
    }

    #[test]
    fn a_missing_spend_reason_comes_from_extra_usage() {
        let v = json!({
            "spend": {"used": {"amount_minor": 0, "currency": "EUR", "exponent": 2}, "enabled": false, "disabled_reason": null},
            "extra_usage": {"is_enabled": false, "user_disabled": true}
        });
        assert_eq!(parse_extra(&v).unwrap().disabled_reason.as_deref(), Some("user_disabled"));
        let own = json!({"spend": {"used": {"amount_minor": 0, "currency": "EUR", "exponent": 2}, "enabled": false, "disabled_reason": "out_of_credits"}, "extra_usage": {"user_disabled": true}});
        assert_eq!(parse_extra(&own).unwrap().disabled_reason.as_deref(), Some("out_of_credits"));
        let on = json!({"spend": {"used": {"amount_minor": 5, "currency": "EUR", "exponent": 2}, "enabled": true}, "extra_usage": {"user_disabled": true}});
        assert_eq!(parse_extra(&on).unwrap().disabled_reason, None);
    }

    #[test]
    fn the_status_line_does_not_hide_an_endpoint_error() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &real_response(), 5);
        apply_error(&mut u, "usage endpoint returned 429".into());
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 20}}), 9);
        assert!(u.error.is_none(), "the windows are fine");
        assert_eq!(u.oauth_error.as_deref(), Some("usage endpoint returned 429"));
        assert_eq!(u.oauth_updated_at, Some(5));
        apply_oauth(&mut u, &real_response(), 700_000);
        assert!(u.oauth_error.is_none());
        assert_eq!(u.oauth_updated_at, Some(700_000));
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["oauthUpdatedAt"], 700_000);
    }

    #[test]
    fn an_error_keeps_scoped_rows_and_extra() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &real_response(), 5);
        apply_error(&mut u, "usage endpoint returned 500".into());
        assert_eq!(u.limits.len(), 4);
        assert!(u.extra.is_some());
    }
}
