// Package server exposes the 42 Intra API to a browser UI through a small,
// fixed set of endpoints backed by the intraoapi42 Go client.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	intraoapi42 "github.com/42paris/intraoapi42"
	"github.com/keusidan/intralens/internal/spec"
)

const (
	defaultTimeout = 30 * time.Second
	defaultMaxBody = 16 << 20 // 16 MiB
)

// Options configures a Server.
type Options struct {
	Client     intraoapi42.ClientInterface
	Doc        *spec.Document
	Static     fs.FS
	Logger     *slog.Logger
	Timeout    time.Duration
	MaxBody    int64
	ServerURL  string
	Scopes     []string
	Configured bool // client credentials were supplied

	// AllowedOrigins may drive this server cross-origin (see withCORS).
	AllowedOrigins []string
}

// Server serves the UI and brokers calls to the 42 API.
type Server struct {
	opts Options
	log  *slog.Logger
}

// New validates the options and returns a ready server.
func New(opts Options) (*Server, error) {
	if opts.Client == nil {
		return nil, errors.New("server: a client is required")
	}
	if opts.Doc == nil {
		return nil, errors.New("server: a spec document is required")
	}
	if opts.Static == nil {
		return nil, errors.New("server: a static file system is required")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	if opts.MaxBody <= 0 {
		opts.MaxBody = defaultMaxBody
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Server{opts: opts, log: opts.Logger}, nil
}

// Handler returns the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/spec", s.handleSpec)
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("POST /api/call", s.handleCall)
	mux.Handle("/", http.FileServerFS(s.opts.Static))
	return s.withLogging(withCORS(mux, s.opts.AllowedOrigins))
}

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		s.log.Debug("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", recorder.status,
			"duration", time.Since(start).Round(time.Millisecond),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

/* --------------------------------------------------------------- endpoints */

func (s *Server) handleSpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(s.opts.Doc.JSON)
}

type statusPayload struct {
	Configured  bool     `json:"configured"`
	ServerURL   string   `json:"serverUrl"`
	Scopes      []string `json:"scopes"`
	SpecVersion string   `json:"specVersion"`
	Operations  []string `json:"operations"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	operations := SupportedOperations()
	sort.Strings(operations)
	writeJSON(w, http.StatusOK, statusPayload{
		Configured:  s.opts.Configured,
		ServerURL:   s.opts.ServerURL,
		Scopes:      s.opts.Scopes,
		SpecVersion: s.opts.Doc.Version,
		Operations:  operations,
	})
}

type pagination struct {
	Page       int `json:"page,omitempty"`
	PerPage    int `json:"perPage,omitempty"`
	Total      int `json:"total,omitempty"`
	TotalPages int `json:"totalPages,omitempty"`
}

type callPayload struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	DurationMS int64             `json:"durationMs"`
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers"`
	Pagination *pagination       `json:"pagination,omitempty"`
	Bytes      int               `json:"bytes"`
	Truncated  bool              `json:"truncated,omitempty"`
	Body       json.RawMessage   `json:"body,omitempty"`
	BodyText   string            `json:"bodyText,omitempty"`
}

func (s *Server) handleCall(w http.ResponseWriter, r *http.Request) {
	if !s.opts.Configured {
		writeError(w, http.StatusServiceUnavailable,
			"42 API の認証情報が設定されていません。INTRA42_UID と INTRA42_SECRET を設定して再起動してください。")
		return
	}

	var call callRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&call); err != nil {
		writeError(w, http.StatusBadRequest, "リクエストを解釈できません: "+err.Error())
		return
	}
	if err := call.bind(s.opts.Doc); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.opts.Timeout)
	defer cancel()

	started := time.Now()
	resp, err := registry[call.OperationID](ctx, s.opts.Client, &call)
	elapsed := time.Since(started)
	if err != nil {
		var bad badRequest
		if errors.As(err, &bad) {
			writeError(w, http.StatusBadRequest, bad.Error())
			return
		}
		s.log.Warn("upstream call failed", "operation", call.OperationID, "error", err)
		writeError(w, http.StatusBadGateway, "42 API の呼び出しに失敗しました: "+err.Error())
		return
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	body, truncated, err := readBody(resp.Body, s.opts.MaxBody)
	if err != nil {
		writeError(w, http.StatusBadGateway, "レスポンスの読み取りに失敗しました: "+err.Error())
		return
	}

	payload := callPayload{
		Status:     resp.StatusCode,
		StatusText: resp.Status,
		DurationMS: elapsed.Milliseconds(),
		Headers:    collectHeaders(resp.Header),
		Pagination: readPagination(resp.Header),
		Bytes:      len(body),
		Truncated:  truncated,
	}
	if resp.Request != nil && resp.Request.URL != nil {
		payload.URL = resp.Request.URL.String()
	}
	if json.Valid(body) {
		payload.Body = body
	} else {
		payload.BodyText = string(body)
	}

	s.log.Info("call",
		"operation", call.OperationID,
		"status", resp.StatusCode,
		"duration", elapsed.Round(time.Millisecond),
		"bytes", len(body),
	)
	writeJSON(w, http.StatusOK, payload)
}

/* ----------------------------------------------------------------- helpers */

func readBody(r io.Reader, limit int64) ([]byte, bool, error) {
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(body)) > limit {
		return body[:limit], true, nil
	}
	return body, false, nil
}

// collectHeaders copies the response headers, minus anything session-like.
func collectHeaders(header http.Header) map[string]string {
	out := make(map[string]string, len(header))
	for name, values := range header {
		switch http.CanonicalHeaderKey(name) {
		case "Set-Cookie", "Authorization":
			continue
		}
		out[http.CanonicalHeaderKey(name)] = values[0]
	}
	return out
}

func readPagination(header http.Header) *pagination {
	page := headerInt(header, "X-Page")
	perPage := headerInt(header, "X-Per-Page")
	total := headerInt(header, "X-Total")
	if page == 0 && perPage == 0 && total == 0 {
		return nil
	}
	result := &pagination{Page: page, PerPage: perPage, Total: total}
	if perPage > 0 && total > 0 {
		result.TotalPages = (total + perPage - 1) / perPage
	}
	return result
}

func headerInt(header http.Header, name string) int {
	value, err := strconv.Atoi(header.Get(name))
	if err != nil {
		return 0
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Default().Error("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

/* --------------------------------------------------------------------- CORS */

// withCORS lets a page served from another origin (for example the read-only
// copy on GitHub Pages) drive a locally running intra-Lens. Only the origins
// passed on the command line are accepted: the browser would otherwise let any
// site issue calls with this machine's 42 credentials.
func withCORS(next http.Handler, allowed []string) http.Handler {
	if len(allowed) == 0 {
		return next
	}
	index := make(map[string]bool, len(allowed))
	for _, origin := range allowed {
		index[strings.TrimSuffix(origin, "/")] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSuffix(r.Header.Get("Origin"), "/")
		if origin != "" && index[origin] {
			header := w.Header()
			header.Set("Access-Control-Allow-Origin", origin)
			header.Set("Access-Control-Allow-Headers", "Content-Type")
			header.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			header.Set("Access-Control-Max-Age", "600")
			header.Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
