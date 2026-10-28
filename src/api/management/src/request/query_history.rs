// Copyright 2026 OpenObserve Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

use axum::{
    Json,
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use infra::table::{
    entity::query_history::Model,
    query_history::{
        self, DEFAULT_SOURCE, ListFilter, MAX_STARRED_PER_USER, NewRun, SOURCES, STATUS_ERROR,
        STATUS_OK, SetStarred,
    },
};
use openobserve_api_common::extractors::Headers;
use openobserve_core::auth::UserEmail;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::common::meta::http::HttpResponse as MetaHttpResponse;

/// Route body limit for record and star, so oversized bodies are refused before they are parsed.
pub const MAX_BODY_BYTES: usize = 128 * 1024;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_CONTEXT_BYTES: usize = 64 * 1024;
const MAX_STREAMS: usize = 50;
const DEFAULT_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 200;

#[derive(Deserialize, Serialize, ToSchema)]
pub struct QueryHistoryRequest {
    /// `logs`, `traces`, `metrics`, `dbm` or `profiles`; defaults to `metrics`.
    #[serde(default)]
    pub source: Option<String>,
    /// The query text, at most 16 KB and not blank.
    pub query: String,
    /// Runs with the same source and key merge into one entry; defaults to the query text.
    #[serde(default)]
    pub query_key: Option<String>,
    /// Streams the query ran on, at most 50, none containing a comma.
    #[serde(default)]
    pub streams: Vec<String>,
    /// `ok` or `error`; defaults to `ok`.
    #[serde(default)]
    pub status: Option<String>,
    /// What the page needs to restore the run, at most 64 KB; stored as given.
    pub context: serde_json::Value,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct QueryHistoryStarRequest {
    /// `true` stars the entry, `false` unstars it.
    pub starred: bool,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct QueryHistoryEntry {
    /// Entry id.
    pub id: String,
    /// Page the query ran on.
    pub source: String,
    /// The query text.
    pub query: String,
    /// Hex sha256 of the merge key; null on entries recorded before keys existed.
    pub query_key: Option<String>,
    /// Streams the query ran on.
    pub streams: Vec<String>,
    /// What the page needs to restore the run.
    pub context: serde_json::Value,
    /// `ok` or `error`, from the latest run.
    pub status: String,
    /// Starred entries are kept until deleted.
    pub starred: bool,
    /// How many runs merged into this entry.
    pub run_count: i64,
    /// First run, in microseconds since the epoch.
    pub created_at: i64,
    /// Latest run, in microseconds since the epoch.
    pub updated_at: i64,
}

impl From<Model> for QueryHistoryEntry {
    fn from(m: Model) -> Self {
        Self {
            streams: query_history::decode_streams(&m.streams),
            id: m.id,
            source: m.source,
            query: m.query,
            query_key: m.query_key,
            context: m.context,
            status: m.status,
            starred: m.starred,
            run_count: m.run_count,
            created_at: m.created_at,
            updated_at: m.updated_at,
        }
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct QueryHistoryListParams {
    /// One source or a comma-separated list; all sources when omitted.
    pub source: Option<String>,
    /// `ok` or `error`.
    pub status: Option<String>,
    /// Exact stream name the entry ran on.
    pub stream: Option<String>,
    /// Case-insensitive substring of the query text or the stream names.
    pub q: Option<String>,
    /// Only starred (`true`) or only unstarred (`false`) entries.
    pub starred: Option<bool>,
    /// Entries last run at or after this time, in microseconds.
    pub ran_from: Option<i64>,
    /// Entries last run at or before this time, in microseconds.
    pub ran_to: Option<i64>,
    /// Defaults to 50, at most 200.
    pub limit: Option<u64>,
    /// Entries to skip, for paging. Defaults to 0.
    pub offset: Option<u64>,
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct QueryHistoryClearParams {
    /// One source or a comma-separated list; all sources when omitted.
    pub source: Option<String>,
    /// Also delete starred entries. Defaults to false.
    pub include_starred: Option<bool>,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct QueryHistoryClearResponse {
    /// Number of entries deleted.
    pub deleted: u64,
}

/// RecordQueryHistory

#[utoipa::path(
    post,
    path = "/{org_id}/query_history",
    context_path = "/api",
    tag = "Query History",
    operation_id = "RecordQueryHistory",
    summary = "Record a query history entry",
    description = "Records a query the caller ran. A run with the same source and query_key as an existing entry of the caller merges into it: the run count goes up and the latest run, context, status and streams replace the old ones. Stores nothing and answers 204 when ZO_QUERY_HISTORY_ENABLED is false.",
    security(
        ("Authorization"= [])
    ),
    params(
        ("org_id" = String, Path, description = "Organization name"),
    ),
    request_body(content = QueryHistoryRequest, description = "Query and its context", content_type = "application/json"),
    responses(
        (status = 200, description = "Success", content_type = "application/json", body = QueryHistoryEntry),
        (status = 204, description = "Query history is disabled; nothing was stored"),
        (status = 400, description = "Unknown source or status, query empty, query or context too large, or too many streams", content_type = "application/json", body = ()),
        (status = 413, description = "Request body larger than 128 KB"),
        (status = 500, description = "Failure", content_type = "application/json", body = ()),
    ),
    extensions(
        ("x-o2-ratelimit" = json!({"module": "Query History", "operation": "create"})),
        ("x-o2-mcp" = json!({"enabled": false}))
    )
)]
pub async fn record(
    Path(org_id): Path<String>,
    Headers(user_email): Headers<UserEmail>,
    Json(req): Json<QueryHistoryRequest>,
) -> Response {
    record_entry(
        config::get_config().limit.query_history_enabled,
        &org_id,
        &user_email.user_id,
        req,
    )
    .await
}

/// ListQueryHistory

#[utoipa::path(
    get,
    path = "/{org_id}/query_history",
    context_path = "/api",
    tag = "Query History",
    operation_id = "ListQueryHistory",
    summary = "List query history",
    description = "Lists the caller's query history, most recently run first. Empty when ZO_QUERY_HISTORY_ENABLED is false.",
    security(
        ("Authorization"= [])
    ),
    params(
        ("org_id" = String, Path, description = "Organization name"),
        QueryHistoryListParams,
    ),
    responses(
        (status = 200, description = "Success", content_type = "application/json", body = Vec<QueryHistoryEntry>),
        (status = 400, description = "Unknown source or status", content_type = "application/json", body = ()),
        (status = 500, description = "Failure", content_type = "application/json", body = ()),
    ),
    extensions(
        ("x-o2-ratelimit" = json!({"module": "Query History", "operation": "list"})),
        ("x-o2-mcp" = json!({"enabled": false}))
    )
)]
pub async fn list(
    Path(org_id): Path<String>,
    Headers(user_email): Headers<UserEmail>,
    Query(params): Query<QueryHistoryListParams>,
) -> Response {
    list_entries(
        config::get_config().limit.query_history_enabled,
        &org_id,
        &user_email.user_id,
        params,
    )
    .await
}

/// ClearQueryHistory

#[utoipa::path(
    delete,
    path = "/{org_id}/query_history",
    context_path = "/api",
    tag = "Query History",
    operation_id = "ClearQueryHistory",
    summary = "Clear the caller's query history",
    description = "Deletes the caller's query history entries for the given sources, or all sources. Starred entries are kept unless include_starred is true.",
    security(
        ("Authorization"= [])
    ),
    params(
        ("org_id" = String, Path, description = "Organization name"),
        QueryHistoryClearParams,
    ),
    responses(
        (status = 200, description = "Success", content_type = "application/json", body = QueryHistoryClearResponse),
        (status = 400, description = "Unknown source", content_type = "application/json", body = ()),
        (status = 500, description = "Failure", content_type = "application/json", body = ()),
    ),
    extensions(
        ("x-o2-ratelimit" = json!({"module": "Query History", "operation": "delete"})),
        ("x-o2-mcp" = json!({"enabled": false}))
    )
)]
pub async fn clear(
    Path(org_id): Path<String>,
    Headers(user_email): Headers<UserEmail>,
    Query(params): Query<QueryHistoryClearParams>,
) -> Response {
    let sources = match parse_sources(params.source.as_deref()) {
        Ok(sources) => sources,
        Err(e) => return MetaHttpResponse::bad_request(e),
    };
    let include_starred = params.include_starred.unwrap_or(false);
    match query_history::clear(&org_id, &user_email.user_id, &sources, include_starred).await {
        Ok(deleted) => MetaHttpResponse::json(QueryHistoryClearResponse { deleted }),
        Err(e) => MetaHttpResponse::internal_error(e),
    }
}

/// StarQueryHistory

#[utoipa::path(
    patch,
    path = "/{org_id}/query_history/{id}",
    context_path = "/api",
    tag = "Query History",
    operation_id = "StarQueryHistory",
    summary = "Star or unstar a query history entry",
    description = "Starred entries are kept until deleted. A user can star at most 200 entries per organization, shared across Logs, Traces and Metrics.",
    security(
        ("Authorization"= [])
    ),
    params(
        ("org_id" = String, Path, description = "Organization name"),
        ("id" = String, Path, description = "Entry id"),
    ),
    request_body(content = QueryHistoryStarRequest, description = "Starred flag", content_type = "application/json"),
    responses(
        (status = 200, description = "Success", content_type = "application/json", body = QueryHistoryEntry),
        (status = 400, description = "Starred entry limit reached", content_type = "application/json", body = ()),
        (status = 404, description = "Not found", content_type = "application/json", body = ()),
        (status = 413, description = "Request body larger than 128 KB"),
        (status = 500, description = "Failure", content_type = "application/json", body = ()),
    ),
    extensions(
        ("x-o2-ratelimit" = json!({"module": "Query History", "operation": "update"})),
        ("x-o2-mcp" = json!({"enabled": false}))
    )
)]
pub async fn star(
    Path((org_id, id)): Path<(String, String)>,
    Headers(user_email): Headers<UserEmail>,
    Json(req): Json<QueryHistoryStarRequest>,
) -> Response {
    match query_history::set_starred(&org_id, &user_email.user_id, &id, req.starred).await {
        Ok(SetStarred::Updated(entry)) => MetaHttpResponse::json(QueryHistoryEntry::from(*entry)),
        Ok(SetStarred::NotFound) => MetaHttpResponse::not_found("query history entry not found"),
        Ok(SetStarred::StarredCapReached) => MetaHttpResponse::bad_request(format!(
            "at most {MAX_STARRED_PER_USER} query history entries can be starred across Logs, Traces and Metrics; unstar one first"
        )),
        Err(e) => MetaHttpResponse::internal_error(e),
    }
}

/// DeleteQueryHistory

#[utoipa::path(
    delete,
    path = "/{org_id}/query_history/{id}",
    context_path = "/api",
    tag = "Query History",
    operation_id = "DeleteQueryHistory",
    summary = "Delete a query history entry",
    description = "Deletes one of the caller's query history entries.",
    security(
        ("Authorization"= [])
    ),
    params(
        ("org_id" = String, Path, description = "Organization name"),
        ("id" = String, Path, description = "Entry id"),
    ),
    responses(
        (status = 200, description = "Success", content_type = "application/json", body = ()),
        (status = 404, description = "Not found", content_type = "application/json", body = ()),
        (status = 500, description = "Failure", content_type = "application/json", body = ()),
    ),
    extensions(
        ("x-o2-ratelimit" = json!({"module": "Query History", "operation": "delete"})),
        ("x-o2-mcp" = json!({"enabled": false}))
    )
)]
pub async fn delete(
    Path((org_id, id)): Path<(String, String)>,
    Headers(user_email): Headers<UserEmail>,
) -> Response {
    match query_history::delete(&org_id, &user_email.user_id, &id).await {
        Ok(true) => MetaHttpResponse::ok("query history entry deleted"),
        Ok(false) => MetaHttpResponse::not_found("query history entry not found"),
        Err(e) => MetaHttpResponse::internal_error(e),
    }
}

fn list_limit(limit: Option<u64>) -> u64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// Splits a comma list of sources; empty means all, an unknown name is an error.
fn parse_sources(sources: Option<&str>) -> Result<Vec<String>, String> {
    let mut parsed = Vec::new();
    for source in sources.unwrap_or("").split(',').map(str::trim) {
        if source.is_empty() {
            continue;
        }
        if !SOURCES.contains(&source) {
            return Err(format!("unknown source: {source}"));
        }
        parsed.push(source.to_string());
    }
    Ok(parsed)
}

fn parse_status(status: Option<&str>) -> Result<Option<String>, String> {
    match status.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s == STATUS_OK || s == STATUS_ERROR => Ok(Some(s.to_string())),
        Some(s) => Err(format!("unknown status: {s}")),
    }
}

/// The source and status a record stores, or why the request is refused.
fn validate_record(req: &QueryHistoryRequest) -> Result<(String, String), String> {
    let source = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SOURCE);
    if !SOURCES.contains(&source) {
        return Err(format!("unknown source: {source}"));
    }
    let status = parse_status(req.status.as_deref())?.unwrap_or_else(|| STATUS_OK.to_string());
    if req.query.trim().is_empty() {
        return Err("query is empty".to_string());
    }
    if req.query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds 16 KB".to_string());
    }
    if req.context.to_string().len() > MAX_CONTEXT_BYTES {
        return Err("context exceeds 64 KB".to_string());
    }
    if req.streams.len() > MAX_STREAMS {
        return Err(format!("at most {MAX_STREAMS} streams"));
    }
    if req.streams.iter().any(|s| s.is_empty() || s.contains(',')) {
        return Err("stream names must be non-empty and contain no comma".to_string());
    }
    Ok((source.to_string(), status))
}

async fn record_entry(
    enabled: bool,
    org_id: &str,
    user_email: &str,
    req: QueryHistoryRequest,
) -> Response {
    if !enabled {
        return StatusCode::NO_CONTENT.into_response();
    }
    let (source, status) = match validate_record(&req) {
        Ok(valid) => valid,
        Err(e) => return MetaHttpResponse::bad_request(e),
    };
    let run = NewRun {
        org_id,
        user_email,
        source: &source,
        query: &req.query,
        query_key: req.query_key.as_deref(),
        streams: &req.streams,
        status: &status,
        context: req.context,
        now_us: config::utils::time::now_micros(),
    };
    match query_history::record(run).await {
        Ok(entry) => MetaHttpResponse::json(QueryHistoryEntry::from(entry)),
        Err(e) => MetaHttpResponse::internal_error(e),
    }
}

async fn list_entries(
    enabled: bool,
    org_id: &str,
    user_email: &str,
    params: QueryHistoryListParams,
) -> Response {
    if !enabled {
        return MetaHttpResponse::json(Vec::<QueryHistoryEntry>::new());
    }
    let filter = match list_filter(&params) {
        Ok(filter) => filter,
        Err(e) => return MetaHttpResponse::bad_request(e),
    };
    match query_history::list(
        org_id,
        user_email,
        &filter,
        list_limit(params.limit),
        params.offset.unwrap_or(0),
    )
    .await
    {
        Ok(entries) => MetaHttpResponse::json(
            entries
                .into_iter()
                .map(QueryHistoryEntry::from)
                .collect::<Vec<_>>(),
        ),
        Err(e) => MetaHttpResponse::internal_error(e),
    }
}

fn list_filter(params: &QueryHistoryListParams) -> Result<ListFilter, String> {
    Ok(ListFilter {
        sources: parse_sources(params.source.as_deref())?,
        status: parse_status(params.status.as_deref())?,
        stream: params.stream.clone(),
        q: params.q.clone(),
        starred: params.starred,
        ran_from: params.ran_from,
        ran_to: params.ran_to,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    async fn setup() {
        static TABLE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        TABLE
            .get_or_init(|| async {
                infra::db::create_table().await.unwrap();
                let conn = infra::db::get_orm_client_rw().await;
                query_history::create_table_for_tests(conn).await.unwrap();
            })
            .await;
    }

    fn user() -> String {
        format!("{}@example.com", config::ider::uuid())
    }

    fn headers(user: &str) -> Headers<UserEmail> {
        Headers(UserEmail {
            user_id: user.to_string(),
        })
    }

    fn request(query: &str, context: Value) -> QueryHistoryRequest {
        QueryHistoryRequest {
            source: None,
            query: query.to_string(),
            query_key: None,
            streams: Vec::new(),
            status: None,
            context,
        }
    }

    async fn parts(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post_req(org: &str, user: &str, req: QueryHistoryRequest) -> (StatusCode, Value) {
        parts(record(Path(org.to_string()), headers(user), Json(req)).await).await
    }

    async fn post(org: &str, user: &str, query: &str, context: Value) -> (StatusCode, Value) {
        post_req(org, user, request(query, context)).await
    }

    async fn get(org: &str, user: &str, params: &str) -> Vec<Value> {
        let (status, body) = get_raw(org, user, params).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body.as_array().unwrap().clone()
    }

    async fn get_raw(org: &str, user: &str, params: &str) -> (StatusCode, Value) {
        let params: QueryHistoryListParams = parse_params(params);
        parts(list(Path(org.to_string()), headers(user), Query(params)).await).await
    }

    fn parse_params<T: serde::de::DeserializeOwned>(params: &str) -> T {
        let uri: axum::http::Uri = format!("/?{params}").parse().unwrap();
        Query::try_from_uri(&uri).unwrap().0
    }

    async fn patch(org: &str, user: &str, id: &str, starred: bool) -> (StatusCode, Value) {
        let path = Path((org.to_string(), id.to_string()));
        let req = Json(QueryHistoryStarRequest { starred });
        parts(star(path, headers(user), req).await).await
    }

    async fn remove(org: &str, user: &str, id: &str) -> StatusCode {
        let path = Path((org.to_string(), id.to_string()));
        parts(delete(path, headers(user)).await).await.0
    }

    async fn clear_all(org: &str, user: &str, params: &str) -> (StatusCode, Value) {
        let params: QueryHistoryClearParams = parse_params(params);
        parts(clear(Path(org.to_string()), headers(user), Query(params)).await).await
    }

    fn queries(rows: Vec<Value>) -> Vec<String> {
        rows.iter()
            .map(|e| e["query"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn test_another_users_entry_is_not_found() {
        setup().await;
        let (a, b) = (user(), user());
        let (status, entry) = post("default", &a, "up", json!({"chart": "line"})).await;
        assert_eq!(status, StatusCode::OK);
        let id = entry["id"].as_str().unwrap();

        assert_eq!(
            patch("default", &b, id, true).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(remove("default", &b, id).await, StatusCode::NOT_FOUND);
        assert_eq!(remove("other", &a, id).await, StatusCode::NOT_FOUND);
        assert!(get("default", &b, "").await.is_empty());
        assert_eq!(get("default", &a, "").await[0]["starred"], false);

        let (status, starred) = patch("default", &a, id, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(starred["starred"], true);
        assert_eq!(remove("default", &a, id).await, StatusCode::OK);
        assert_eq!(remove("default", &a, id).await, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_starring_past_the_cap_is_a_bad_request() {
        setup().await;
        let a = user();
        let mut last = String::new();
        for i in 0..=MAX_STARRED_PER_USER {
            let (_, entry) = post("default", &a, &format!("q{i}"), json!({})).await;
            last = entry["id"].as_str().unwrap().to_string();
            if i < MAX_STARRED_PER_USER {
                assert_eq!(patch("default", &a, &last, true).await.0, StatusCode::OK);
            }
        }
        let (status, body) = patch("default", &a, &last, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["message"].as_str().unwrap().contains("200"), "{body}");
        assert_eq!(
            get("default", &a, "starred=true&limit=200").await.len(),
            200
        );
    }

    #[tokio::test]
    async fn test_an_old_client_without_source_or_key_merges_by_query_into_metrics() {
        setup().await;
        let a = user();
        post("default", &a, "up", json!({"chart": "line"})).await;
        let (_, entry) = post("default", &a, "up", json!({"chart": "bar"})).await;
        assert_eq!(entry["source"], "metrics");
        assert_eq!(entry["status"], "ok");
        assert_eq!(entry["run_count"], 2);
        assert_eq!(entry["streams"], json!([]));
        assert_eq!(entry["query_key"].as_str().unwrap().len(), 64);
        let listed = get("default", &a, "").await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["context"]["chart"], "bar");
        assert!(listed[0]["updated_at"].as_i64() >= listed[0]["created_at"].as_i64());
    }

    #[tokio::test]
    async fn test_a_new_day_key_starts_a_new_entry() {
        setup().await;
        let a = user();
        for day in ["2026-10-27", "2026-10-27", "2026-10-28"] {
            let req = QueryHistoryRequest {
                source: Some("logs".to_string()),
                query_key: Some(format!("k8s|sql|up||{day}")),
                streams: vec!["k8s".to_string()],
                ..request("up", json!({}))
            };
            assert_eq!(post_req("default", &a, req).await.0, StatusCode::OK);
        }
        let rows = get("default", &a, "source=logs").await;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["run_count"], 2);
        assert_eq!(rows[0]["streams"], json!(["k8s"]));
    }

    #[tokio::test]
    async fn test_record_validation() {
        setup().await;
        let a = user();
        let refused = [
            QueryHistoryRequest {
                source: Some("dashboards".to_string()),
                ..request("up", json!({}))
            },
            QueryHistoryRequest {
                status: Some("timeout".to_string()),
                ..request("up", json!({}))
            },
            QueryHistoryRequest {
                streams: (0..=MAX_STREAMS).map(|i| format!("s{i}")).collect(),
                ..request("up", json!({}))
            },
            QueryHistoryRequest {
                streams: vec!["a,b".to_string()],
                ..request("up", json!({}))
            },
            request(&"x".repeat(MAX_QUERY_BYTES + 1), json!({})),
            request("up", json!({"d": "x".repeat(MAX_CONTEXT_BYTES)})),
            request("", json!({})),
            request("  \n\t ", json!({})),
        ];
        for req in refused {
            assert_eq!(
                post_req("default", &a, req).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(get("default", &a, "").await.is_empty());

        let accepted = QueryHistoryRequest {
            source: Some("traces".to_string()),
            status: Some("error".to_string()),
            streams: (0..MAX_STREAMS).map(|i| format!("s{i}")).collect(),
            ..request(&"x".repeat(MAX_QUERY_BYTES), json!({}))
        };
        let (status, entry) = post_req("default", &a, accepted).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        assert_eq!(entry["status"], "error");
        assert_eq!(entry["source"], "traces");
    }

    #[tokio::test]
    async fn test_list_applies_filters() {
        setup().await;
        let a = user();
        for (source, query, stream, status) in [
            ("metrics", "up", None, "ok"),
            ("logs", "level = 'error'", Some("k8s_logs"), "error"),
            ("traces", "service = 'cart'", Some("default"), "ok"),
            ("metrics", "sum(http_total)", None, "ok"),
        ] {
            let req = QueryHistoryRequest {
                source: Some(source.to_string()),
                streams: stream.map(|s| vec![s.to_string()]).unwrap_or_default(),
                status: Some(status.to_string()),
                ..request(query, json!({}))
            };
            post_req("default", &a, req).await;
        }
        assert_eq!(
            queries(get("default", &a, "source=logs,traces").await),
            vec!["service = 'cart'", "level = 'error'"]
        );
        assert_eq!(
            queries(get("default", &a, "status=error").await),
            vec!["level = 'error'"]
        );
        assert_eq!(
            queries(get("default", &a, "stream=k8s_logs").await),
            vec!["level = 'error'"]
        );
        assert_eq!(
            queries(get("default", &a, "q=K8S").await),
            vec!["level = 'error'"]
        );
        assert_eq!(
            queries(get("default", &a, "source=metrics&limit=1").await),
            vec!["sum(http_total)"]
        );
        assert_eq!(
            queries(get("default", &a, "source=metrics&offset=1").await),
            vec!["up"]
        );
        assert!(get("default", &a, "ran_from=1&ran_to=2").await.is_empty());
        assert_eq!(get("default", &a, "ran_from=1").await.len(), 4);
        assert!(get("default", &a, "starred=true").await.is_empty());
        assert_eq!(
            get_raw("default", &a, "source=dashboards").await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get_raw("default", &a, "status=partial").await.0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn test_clear_my_history() {
        setup().await;
        let (a, b) = (user(), user());
        for (source, query) in [
            ("logs", "a"),
            ("logs", "b"),
            ("traces", "c"),
            ("metrics", "d"),
        ] {
            let req = QueryHistoryRequest {
                source: Some(source.to_string()),
                ..request(query, json!({}))
            };
            post_req("default", &a, req).await;
        }
        post("default", &b, "up", json!({})).await;
        let starred = get("default", &a, "source=logs").await[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        patch("default", &a, &starred, true).await;

        let (status, body) = clear_all("default", &a, "source=logs").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": 1}));
        assert_eq!(clear_all("default", &a, "").await.1, json!({"deleted": 2}));
        assert_eq!(queries(get("default", &a, "").await), vec!["b"]);
        assert_eq!(
            clear_all("default", &a, "include_starred=true").await.1,
            json!({"deleted": 1})
        );
        assert!(get("default", &a, "").await.is_empty());
        assert_eq!(get("default", &b, "").await.len(), 1);
        assert_eq!(
            clear_all("default", &a, "source=nope").await.0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn test_disabled_collection_stores_nothing_and_lists_nothing() {
        setup().await;
        let a = user();
        post("default", &a, "up", json!({})).await;
        let req = request("rate(x[5m])", json!({}));
        let (status, body) = parts(record_entry(false, "default", &a, req).await).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(body, Value::Null, "204 carries no body");
        let (status, body) =
            parts(list_entries(false, "default", &a, parse_params("")).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!([]));
        let stored = get("default", &a, "").await;
        assert_eq!(stored.len(), 1, "the disabled record stored nothing");
        assert_eq!(stored[0]["query"], "up");
    }

    #[test]
    fn test_list_limit_defaults_to_50_and_caps_at_200() {
        assert_eq!(list_limit(None), 50);
        assert_eq!(list_limit(Some(10)), 10);
        assert_eq!(list_limit(Some(500)), 200);
        assert_eq!(list_limit(Some(0)), 1);
    }

    #[test]
    fn test_sources_parse_as_a_comma_list_of_known_pages() {
        assert_eq!(parse_sources(None), Ok(vec![]));
        assert_eq!(
            parse_sources(Some("logs, traces,")),
            Ok(vec!["logs".to_string(), "traces".to_string()])
        );
        assert!(parse_sources(Some("logs,alerts")).is_err());
    }
}
