//! Web Fetch API compatible `Request` and `Response` implementations using `http_request`.
//!
//! Native buffered transport objects. The public Web-compatible facade is request.ts.
//! See https://developer.mozilla.org/en-US/docs/Web/API/Request and
//! https://developer.mozilla.org/en-US/docs/Web/API/Response
//!
//! # MDN `Request` conformance (native binding level)
//!
//! | Member | Status |
//! |--------|--------|
//! | `body: ReadableStream<Buffer> \| null` | ✅ getter; `null` when there is no body |
//! | `bodyUsed: boolean` | ✅ true only once a body consumer has run |
//! | `destination: string` | ✅ `""` for a constructed request (the spec's empty destination) |
//! | `signal: AbortFlag` | ✅ native abort handle shared with `start()` |
//! | `referrerPolicy: string` | ✅ validated against the Fetch `ReferrerPolicy` enum |
//! | `headers` | ⚠️ plain record (keys lower-cased); the TS facade wraps it in `Headers` |
//! | `getAll()` / `headerEntries()` | ✅ duplicate-preserving header accessors |
//! | `method` / `url` / `mode` / `credentials` / `cache` / `redirect` / `referrer` / `integrity` / `keepalive` | ✅ |
//! | `arrayBuffer()` / `bytes()` / `text()` / `json()` | ✅ `Body` mixin |
//! | `blob()` | ✅ `Blob` view using the `Content-Type` essence |
//! | `formData()` | ✅ urlencoded + multipart |
//! | `clone()` | ✅ throws once the body is consumed |
//!
//! ## Known limitations (native binding level)
//!
//! * `signal` is an `AbortFlag` (this module's native abort handle), not a Web
//!   `AbortSignal`. The JS facade in `request.ts` bridges a Web `AbortSignal` to
//!   `AbortFlag` for `fetch()`. A `#[napi(object)]` field cannot hold a class
//!   instance — napi-rs only implements `FromNapiValue` for
//!   `ClassInstance<'env, T>` and `&T`, both of which carry an env lifetime — so
//!   `RequestInit` has no `signal` field. The abort handle is passed through
//!   `fetch(input, init, abort)` / `start(abort)` and exposed on the request by
//!   the `signal` getter instead.
//! * `destination` is always `""`: a request built by the constructor has no
//!   fetch destination, and `RequestInit` has no `destination` in the spec.
//!   `headers` is a plain record, not a `Headers` instance.
//! * `body` yields a fresh `ReadableStream` per access (so `request.body ===
//!   request.body` is `false`); the shared `bodyUsed` flag still reflects
//!   consumption across every accessor, so `clone()` throws after any read.
//! * The constructor accepts `string | Buffer` bodies only (not `Blob`,
//!   `FormData`, `URLSearchParams`, or `ReadableStream`); those are handled by
//!   the JS facade.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::fs::{Blob, BlobPropertyBag};

use crate::response::{BodyStream, FORM_DATA_FACTORY, mime_essence, parse_form_entries};
pub use crate::response::{Response, ResponseInit, response_from_http_response};

/// One header name/value pair. Repeated names are preserved.
#[napi(object)]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

/// Options for constructing a [`Request`].
#[napi(object)]
#[derive(Default)]
pub struct RequestInit {
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    /// Full header list. When set, it replaces `headers` and keeps duplicate names.
    pub header_list: Option<Vec<HeaderPair>>,
    pub body: Option<Either<String, Buffer>>,
    pub mode: Option<String>,
    pub credentials: Option<String>,
    pub cache: Option<String>,
    pub redirect: Option<String>,
    pub referrer: Option<String>,
    /// A Fetch `ReferrerPolicy` enum value. Defaults to the empty string.
    pub referrer_policy: Option<String>,
    pub integrity: Option<String>,
    pub keepalive: Option<bool>,
    pub r#type: Option<String>,
}

/// Cooperative abort flag for an in-flight native fetch.
///
/// The blocking HTTP client cannot interrupt a socket read that has already
/// started; the flag is observed before each attempt and while waiting.
#[napi]
#[derive(Clone)]
pub struct AbortFlag {
    inner: Arc<AtomicBool>,
}

#[napi]
impl AbortFlag {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn abort(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    pub(crate) fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.inner)
    }

    pub(crate) fn is_aborted(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }
}

impl Default for AbortFlag {
    fn default() -> Self {
        Self::new()
    }
}

/// A Web Fetch API `Request` object.
///
/// Implements https://developer.mozilla.org/en-US/docs/Web/API/Request
#[napi]
pub struct Request {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    mode: String,
    credentials: String,
    cache: String,
    redirect: String,
    referrer: String,
    referrer_policy: String,
    integrity: String,
    keepalive: bool,
    signal: Arc<AtomicBool>,
    body_used: Arc<AtomicBool>,
}

/// The eight `ReferrerPolicy` tokens plus the spec's empty default.
const REFERRER_POLICIES: &[&str] = &[
    "",
    "no-referrer",
    "no-referrer-when-downgrade",
    "origin",
    "origin-when-cross-origin",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
];

fn validate_referrer_policy(value: &str) -> napi::Result<()> {
    if REFERRER_POLICIES.contains(&value) {
        Ok(())
    } else {
        Err(napi::Error::from_reason(format!(
            "invalid referrerPolicy: {value}"
        )))
    }
}

/// Case-insensitive lookup over the stored (lower-cased) header list.
fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[napi]
impl Request {
    /// Construct a new `Request`.
    ///
    /// Accepts a URL string or an existing `Request` instance, along with optional `RequestInit`.
    #[napi(constructor)]
    pub fn new(input: Either<String, &Request>, init: Option<RequestInit>) -> napi::Result<Self> {
        let mut init = init.unwrap_or_default();
        let mut inherited_signal: Option<Arc<AtomicBool>> = None;
        if let Either::B(request) = &input {
            if request.body.is_some() && request.body_used.swap(true, Ordering::SeqCst) {
                return Err(napi::Error::from_reason("body already consumed"));
            }
            init.mode = init.mode.or_else(|| Some(request.mode.clone()));
            init.credentials = init
                .credentials
                .or_else(|| Some(request.credentials.clone()));
            init.cache = init.cache.or_else(|| Some(request.cache.clone()));
            init.redirect = init.redirect.or_else(|| Some(request.redirect.clone()));
            init.referrer = init.referrer.or_else(|| Some(request.referrer.clone()));
            init.referrer_policy = init
                .referrer_policy
                .or_else(|| Some(request.referrer_policy.clone()));
            init.integrity = init.integrity.or_else(|| Some(request.integrity.clone()));
            init.keepalive = init.keepalive.or(Some(request.keepalive));
            inherited_signal = Some(Arc::clone(&request.signal));
        }
        let (url, default_method, default_headers, default_body) = match input {
            Either::A(u) => (u, "GET".to_string(), Vec::new(), None),
            Either::B(r) => (
                r.url.clone(),
                r.method.clone(),
                r.headers.clone(),
                r.body.clone(),
            ),
        };

        let method = init.method.take().unwrap_or(default_method).to_uppercase();

        // A supplied header list replaces the source request's headers entirely.
        let headers = if let Some(list) = init.header_list.take() {
            list.into_iter()
                .map(|pair| (pair.name.to_lowercase(), pair.value))
                .collect()
        } else if let Some(map) = init.headers.take() {
            map.into_iter()
                .map(|(key, value)| (key.to_lowercase(), value))
                .collect()
        } else {
            default_headers
        };

        let body = match init.body.take() {
            Some(Either::A(s)) => Some(s.into_bytes()),
            Some(Either::B(b)) => Some(b.to_vec()),
            None => default_body,
        };

        let referrer_policy = init.referrer_policy.take().unwrap_or_default();
        validate_referrer_policy(&referrer_policy)?;
        // An explicit `init.signal` is not representable in a `#[napi(object)]`
        // field; the handle is inherited from a source request or created fresh,
        // and can be reached through the `signal` getter.
        let signal = inherited_signal.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

        url::Url::parse(&url).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        if (method == "GET" || method == "HEAD") && body.is_some() {
            return Err(napi::Error::from_reason(
                "GET/HEAD requests cannot have a body",
            ));
        }
        Ok(Request {
            url,
            method,
            headers,
            body,
            mode: init.mode.unwrap_or_else(|| "cors".to_string()),
            credentials: init
                .credentials
                .unwrap_or_else(|| "same-origin".to_string()),
            cache: init.cache.unwrap_or_else(|| "default".to_string()),
            redirect: init.redirect.unwrap_or_else(|| "follow".to_string()),
            referrer: init.referrer.unwrap_or_else(|| "about:client".to_string()),
            referrer_policy,
            integrity: init.integrity.unwrap_or_default(),
            keepalive: init.keepalive.unwrap_or(false),
            signal,
            body_used: Arc::new(AtomicBool::new(false)),
        })
    }

    #[napi(getter)]
    pub fn url(&self) -> String {
        self.url.clone()
    }

    #[napi(getter)]
    pub fn method(&self) -> String {
        self.method.clone()
    }

    /// Combined header map. Duplicate names are joined with `", "`.
    #[napi(getter)]
    pub fn headers(&self) -> HashMap<String, String> {
        combined_headers(&self.headers)
    }

    /// Every value stored for `name`, in insertion order.
    #[napi(js_name = "getAll")]
    pub fn get_all(&self, name: String) -> Vec<String> {
        let name = name.to_lowercase();
        self.headers
            .iter()
            .filter(|(key, _)| key == &name)
            .map(|(_, value)| value.clone())
            .collect()
    }

    /// Header list, including duplicate names.
    #[napi(js_name = "headerEntries")]
    pub fn header_entries(&self) -> Vec<(String, String)> {
        self.headers.clone()
    }

    #[napi(getter)]
    pub fn mode(&self) -> String {
        self.mode.clone()
    }

    #[napi(getter)]
    pub fn credentials(&self) -> String {
        self.credentials.clone()
    }

    #[napi(getter)]
    pub fn cache(&self) -> String {
        self.cache.clone()
    }

    #[napi(getter)]
    pub fn redirect(&self) -> String {
        self.redirect.clone()
    }

    #[napi(getter)]
    pub fn referrer(&self) -> String {
        self.referrer.clone()
    }

    /// The Fetch `ReferrerPolicy` token. Empty string for a default request.
    #[napi(getter)]
    pub fn referrer_policy(&self) -> String {
        self.referrer_policy.clone()
    }

    /// A constructed request has no fetch destination, so this is `""`.
    #[napi(getter)]
    pub fn destination(&self) -> String {
        String::new()
    }

    /// Native abort handle shared with `start()`. Call `abort()` to cancel an
    /// in-flight request. See the module docs for why this is an `AbortFlag`
    /// rather than a Web `AbortSignal`.
    #[napi(getter)]
    pub fn signal(&self) -> AbortFlag {
        AbortFlag {
            inner: Arc::clone(&self.signal),
        }
    }

    #[napi(getter)]
    pub fn integrity(&self) -> String {
        self.integrity.clone()
    }

    #[napi(getter)]
    pub fn keepalive(&self) -> bool {
        self.keepalive
    }

    #[napi(getter)]
    pub fn body_used(&self) -> bool {
        self.body.is_some() && self.body_used.load(Ordering::SeqCst)
    }

    /// `request.body` — a `ReadableStream` of the buffered body, or `null`.
    #[napi(getter)]
    pub fn body<'env>(&self, env: &'env Env) -> napi::Result<Option<ReadableStream<'env, Buffer>>> {
        let Some(bytes) = self.body.clone() else {
            return Ok(None);
        };
        Ok(Some(ReadableStream::new(
            env,
            BodyStream {
                flag: Arc::clone(&self.body_used),
                data: Some(bytes),
            },
        )?))
    }

    #[napi]
    pub fn clone(&self) -> napi::Result<Self> {
        if self.body_used() {
            return Err(napi::Error::from_reason("body already consumed"));
        }
        Ok(Request {
            url: self.url.clone(),
            method: self.method.clone(),
            headers: self.headers.clone(),
            body: self.body.clone(),
            mode: self.mode.clone(),
            credentials: self.credentials.clone(),
            cache: self.cache.clone(),
            redirect: self.redirect.clone(),
            referrer: self.referrer.clone(),
            referrer_policy: self.referrer_policy.clone(),
            integrity: self.integrity.clone(),
            keepalive: self.keepalive,
            signal: Arc::clone(&self.signal),
            body_used: Arc::new(AtomicBool::new(false)),
        })
    }

    fn consume_body(&self) -> napi::Result<Option<Vec<u8>>> {
        if self.body.is_some() && self.body_used.swap(true, Ordering::SeqCst) {
            return Err(napi::Error::from_reason("body already consumed"));
        }
        Ok(self.body.clone())
    }
    #[napi]
    pub async fn text(&self) -> napi::Result<String> {
        let bytes = self.consume_body()?.unwrap_or_default();
        let slice = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            &bytes[3..]
        } else {
            &bytes[..]
        };
        Ok(String::from_utf8_lossy(slice).into_owned())
    }
    #[napi(js_name = "json")]
    pub async fn parse_json(&self) -> napi::Result<serde_json::Value> {
        serde_json::from_str(&self.text().await?)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }
    #[napi]
    pub async fn array_buffer(&self) -> napi::Result<Buffer> {
        Ok(self.consume_body()?.unwrap_or_default().into())
    }
    #[napi]
    pub async fn bytes(&self) -> napi::Result<Buffer> {
        self.array_buffer().await
    }

    /// `request.blob()` — `Blob` view of the body, using the `Content-Type` essence.
    #[napi]
    pub async fn blob(&self) -> napi::Result<Blob> {
        let bytes = self.consume_body()?.unwrap_or_default();
        let mime = header_value(&self.headers, "content-type")
            .map(mime_essence)
            .unwrap_or_default();
        Ok(Blob::new(
            Some(vec![Either::B(bytes.into())]),
            Some(BlobPropertyBag {
                r#type: Some(mime),
                endings: None,
            }),
        ))
    }

    /// `request.formData()` — parse `application/x-www-form-urlencoded` or `multipart/form-data`.
    ///
    /// Returns a platform `FormData` promise. The body is disturbed even when parsing fails.
    #[napi(ts_return_type = "Promise<FormData>")]
    pub fn form_data(&self, env: Env) -> napi::Result<Unknown<'_>> {
        let bytes = self.consume_body()?.unwrap_or_default();
        let content_type = header_value(&self.headers, "content-type");
        let entries = parse_form_entries(content_type, &bytes)?;
        let payload = serde_json::Value::Array(entries).to_string();
        let factory: Function<String, Unknown> = env.run_script(FORM_DATA_FACTORY)?;
        factory.call(payload)
    }

    /// Instance method `start` using `http_request` to execute this Request.
    ///
    /// An explicit `abort` flag takes precedence; otherwise the request's own
    /// `signal` handle is observed for the lifetime of the operation.
    #[napi]
    pub async fn start(&self, abort: Option<&AbortFlag>) -> napi::Result<Response> {
        let own = AbortFlag {
            inner: Arc::clone(&self.signal),
        };
        if own.is_aborted() || abort.is_some_and(|flag| flag.is_aborted()) {
            return Err(napi::Error::from_reason("The operation was aborted"));
        }
        let body = self.consume_body()?;
        let flag = abort.map(AbortFlag::flag).unwrap_or_else(|| own.flag());
        execute_http_request_with_redirect(
            &self.method,
            &self.url,
            &self.headers,
            body.as_deref(),
            &self.redirect,
            Some(flag),
        )
        .await
    }
}

fn combined_headers(headers: &[(String, String)]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (key, value) in headers {
        map.entry(key.clone())
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.clone());
    }
    map
}

fn remove_headers(headers: &mut Vec<(String, String)>, name: &str) {
    headers.retain(|(key, _)| key != name);
}

pub(crate) async fn execute_http_request(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
) -> napi::Result<Response> {
    execute_http_request_with_redirect(method, url, headers, body, "follow", None).await
}

pub(crate) async fn execute_http_request_with_redirect(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    redirect_policy: &str,
    abort: Option<Arc<AtomicBool>>,
) -> napi::Result<Response> {
    use http_request::{Body, HttpRequest, Method};
    if !matches!(redirect_policy, "follow" | "manual" | "error") {
        return Err(napi::Error::from_reason("invalid redirect policy"));
    }
    let mut current_url =
        url::Url::parse(url).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut current_method = method.to_uppercase();
    if current_method.is_empty()
        || !current_method
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
    {
        return Err(napi::Error::from_reason("invalid HTTP method"));
    }

    let mut headers = headers.to_vec();
    let mut body = body.map(<[u8]>::to_vec);
    let mut redirected = false;
    for count in 0..=20 {
        if !matches!(current_url.scheme(), "http" | "https")
            || !current_url.username().is_empty()
            || current_url.password().is_some()
        {
            return Err(napi::Error::from_reason(
                "expected an HTTP(S) URL without credentials",
            ));
        }
        current_url.set_fragment(None);
        let mut request = HttpRequest::get(current_url.as_str());
        request.set_method(match current_method.as_str() {
            "GET" => Method::Get,
            "HEAD" => Method::Head,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "DELETE" => Method::Delete,
            "PATCH" => Method::Patch,
            "OPTIONS" => Method::Options,
            "CONNECT" | "TRACE" | "TRACK" => {
                return Err(napi::Error::from_reason("forbidden request method"));
            }
            other => Method::Unknown(other.to_owned()),
        });
        for (key, value) in combined_headers(&headers) {
            if !matches!(
                key.as_str(),
                "content-length" | "transfer-encoding" | "connection"
            ) {
                request.set_header(key, value);
            }
        }
        request.set_header("connection", "close");
        request.set_header(
            "host",
            &current_url[url::Position::BeforeHost..url::Position::AfterPort],
        );
        if let Some(bytes) = &body {
            request.set_body(Body::from_bytes(bytes.clone()));
        }
        // Honor platform/SSL_CERT_FILE trust in addition to the bundled roots.
        for cert in rustls_native_certs::load_native_certs().certs {
            request
                .add_root_certificate(cert)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        }
        request.get_mut_config().set_timeout(30_000);
        request.get_mut_config().set_redirect(false);
        let outcome = drive_send(request, abort.clone()).await?;
        let mut response = response_from_http_response(outcome, current_url.to_string());
        response.set_redirected(redirected);
        let status = response.status();
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let headers_map = response.headers();
        let Some(location) = headers_map.get("location") else {
            return Ok(response);
        };
        if redirect_policy == "manual" {
            return Ok(response);
        }
        if redirect_policy == "error" {
            return Err(napi::Error::from_reason("redirect error"));
        }
        if count == 20 {
            return Err(napi::Error::from_reason("maximum redirect limit exceeded"));
        }
        let next = current_url
            .join(location)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        if abort
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Err(napi::Error::from_reason("The operation was aborted"));
        }
        if next.origin() != current_url.origin() {
            for key in ["authorization", "proxy-authorization", "cookie", "host"] {
                remove_headers(&mut headers, key);
            }
        }
        if ((status == 301 || status == 302) && current_method == "POST")
            || (status == 303 && current_method != "GET" && current_method != "HEAD")
        {
            current_method = "GET".to_owned();
            body = None;
            for key in [
                "content-type",
                "content-length",
                "content-encoding",
                "content-language",
                "content-location",
            ] {
                remove_headers(&mut headers, key);
            }
        }
        current_url = next;
        redirected = true;
    }
    unreachable!()
}

async fn drive_send(
    mut request: http_request::HttpRequest,
    abort: Option<Arc<AtomicBool>>,
) -> napi::Result<http_request::HttpResponse> {
    if abort
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return Err(napi::Error::from_reason("The operation was aborted"));
    }
    let task = tokio::task::spawn_blocking(move || request.send());
    let Some(flag) = abort else {
        return task
            .await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .map_err(|e| napi::Error::from_reason(format!("http request failed: {e:?}")));
    };
    tokio::pin!(task);
    loop {
        tokio::select! {
            biased;
            joined = &mut task => {
                return joined
                    .map_err(|e| napi::Error::from_reason(e.to_string()))?
                    .map_err(|e| napi::Error::from_reason(format!("http request failed: {e:?}")));
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                if flag.load(Ordering::SeqCst) {
                    return Err(napi::Error::from_reason("The operation was aborted"));
                }
            }
        }
    }
}

pub type RequestOpts = RequestInit;
