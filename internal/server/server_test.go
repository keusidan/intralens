package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	intraoapi42 "github.com/42paris/intraoapi42"
	"github.com/keusidan/intralens/internal/spec"
)

// fakeIntra stands in for api.intra.42.fr: it hands out a token and echoes the
// request it received, so tests can assert on the URL the Go client built.
type fakeIntra struct {
	server      *httptest.Server
	lastPath    string
	lastRawPath string
	lastQuery   string
	lastAuth    string
	status      int
	body        string
	headers     map[string]string
}

func newFakeIntra(t *testing.T) *fakeIntra {
	t.Helper()
	fake := &fakeIntra{
		status:  http.StatusOK,
		body:    `[{"id":1,"login":"pons"}]`,
		headers: map[string]string{"X-Page": "2", "X-Per-Page": "100", "X-Total": "250"},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"test-token","token_type":"bearer","expires_in":7200}`))
	})
	mux.HandleFunc("/v2/", func(w http.ResponseWriter, r *http.Request) {
		fake.lastPath = r.URL.Path
		fake.lastRawPath = r.URL.EscapedPath()
		fake.lastQuery = r.URL.RawQuery
		fake.lastAuth = r.Header.Get("Authorization")
		for name, value := range fake.headers {
			w.Header().Set(name, value)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fake.status)
		_, _ = w.Write([]byte(fake.body))
	})

	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

func newTestServer(t *testing.T, fake *fakeIntra, configured bool) http.Handler {
	t.Helper()

	config := intraoapi42.ProductionConfig.
		WithClientCredentials("uid", "secret").
		WithScopes("public")
	config.ServerURL = fake.server.URL + "/v2"
	config.Config.TokenURL = fake.server.URL + "/oauth/token"

	client, err := intraoapi42.New(config)
	if err != nil {
		t.Fatalf("create client: %v", err)
	}

	doc, err := spec.Load()
	if err != nil {
		t.Fatalf("load spec: %v", err)
	}

	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>ok")}}
	srv, err := New(Options{
		Client:     client,
		Doc:        doc,
		Static:     fs.FS(static),
		ServerURL:  config.ServerURL,
		Scopes:     []string{"public"},
		Configured: configured,
	})
	if err != nil {
		t.Fatalf("create server: %v", err)
	}
	return srv.Handler()
}

func post(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/call", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func TestCallForwardsThroughGeneratedClient(t *testing.T) {
	fake := newFakeIntra(t)
	handler := newTestServer(t, fake, true)

	recorder := post(t, handler, `{
		"operationId": "getUsers",
		"query": {"sort": "-login", "per_page": "100", "page": "2", "filter[login]": "pons"}
	}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	var payload callPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}

	if payload.Status != http.StatusOK {
		t.Errorf("upstream status = %d, want 200", payload.Status)
	}
	if fake.lastPath != "/v2/users" {
		t.Errorf("upstream path = %q, want /v2/users", fake.lastPath)
	}
	if fake.lastAuth != "Bearer test-token" {
		t.Errorf("Authorization = %q, want the OAuth2 token added by the client", fake.lastAuth)
	}
	for _, want := range []string{"sort=-login", "per_page=100", "page=2", "login", "pons"} {
		if !strings.Contains(fake.lastQuery, want) {
			t.Errorf("query %q does not contain %q", fake.lastQuery, want)
		}
	}
	if payload.Pagination == nil || payload.Pagination.Total != 250 || payload.Pagination.TotalPages != 3 {
		t.Errorf("pagination = %#v, want total 250 over 3 pages", payload.Pagination)
	}
	if string(payload.Body) != fake.body {
		t.Errorf("body = %s, want it passed through untouched", payload.Body)
	}
	if payload.Headers["X-Total"] != "250" {
		t.Errorf("headers = %#v, want X-Total to be exposed", payload.Headers)
	}
}

func TestCallWithPathParameter(t *testing.T) {
	fake := newFakeIntra(t)
	fake.body = `{"id":77640,"login":"tmatis"}`
	handler := newTestServer(t, fake, true)

	recorder := post(t, handler, `{"operationId": "getUserById", "path": {"id": "tmatis"}}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if fake.lastPath != "/v2/users/tmatis" {
		t.Errorf("upstream path = %q, want /v2/users/tmatis", fake.lastPath)
	}
}

func TestCallPropagatesUpstreamErrors(t *testing.T) {
	fake := newFakeIntra(t)
	fake.status = http.StatusNotFound
	fake.body = `{"error":"Not Found"}`
	handler := newTestServer(t, fake, true)

	recorder := post(t, handler, `{"operationId": "getUserById", "path": {"id": "ghost"}}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("the proxy itself should succeed, got %d", recorder.Code)
	}

	var payload callPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Status != http.StatusNotFound {
		t.Errorf("status = %d, want the upstream 404 to be reported", payload.Status)
	}
}

func TestCallValidation(t *testing.T) {
	fake := newFakeIntra(t)
	handler := newTestServer(t, fake, true)

	cases := map[string]string{
		"unknown operation": `{"operationId": "dropDatabase"}`,
		"missing path":      `{"operationId": "getUserById"}`,
		"bad integer":       `{"operationId": "getUsers", "query": {"per_page": "lots"}}`,
		"unknown parameter": `{"operationId": "getUsers", "query": {"admin": "true"}}`,
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			recorder := post(t, handler, body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (%s)", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestCallRequiresCredentials(t *testing.T) {
	fake := newFakeIntra(t)
	handler := newTestServer(t, fake, false)

	recorder := post(t, handler, `{"operationId": "getUsers"}`)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when credentials are missing", recorder.Code)
	}
}

func TestSpecAndStatusEndpoints(t *testing.T) {
	fake := newFakeIntra(t)
	handler := newTestServer(t, fake, true)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/spec", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("/api/spec status = %d", recorder.Code)
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("/api/spec is not JSON: %v", err)
	}
	if _, ok := document["paths"]; !ok {
		t.Error("/api/spec should serve the OpenAPI document")
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	var status statusPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatalf("/api/status is not JSON: %v", err)
	}
	if !status.Configured || len(status.Operations) != len(registry) {
		t.Errorf("status = %#v, want every registry operation to be advertised", status)
	}
}
