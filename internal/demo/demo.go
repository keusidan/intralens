// Package demo runs a tiny stand-in for api.intra.42.fr so the GUI can be tried
// without 42 API credentials. It speaks just enough of the protocol: an OAuth2
// client-credentials token endpoint and the handful of documented GET routes,
// including the pagination headers the UI relies on.
package demo

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const totalUsers = 137

// Instance is a running demo intranet.
type Instance struct {
	ServerURL string
	TokenURL  string

	listener net.Listener
	server   *http.Server
}

// Start listens on a random loopback port and serves the fake intranet.
func Start() (*Instance, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("demo: listen: %w", err)
	}

	base := "http://" + listener.Addr().String()
	instance := &Instance{
		ServerURL: base + "/v2",
		TokenURL:  base + "/oauth/token",
		listener:  listener,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/token", handleToken)
	mux.HandleFunc("GET /v2/users", handleUsers)
	mux.HandleFunc("GET /v2/users/{id}", handleUser)
	mux.HandleFunc("GET /v2/users/{id}/user_candidature", handleCandidature)
	mux.HandleFunc("GET /v2/users/{id}/closes", handleCloses)
	mux.HandleFunc("GET /v2/closes", handleCloses)
	mux.HandleFunc("GET /v2/closes/{id}", handleClose)
	mux.HandleFunc("GET /v2/internships", handleInternships)
	mux.HandleFunc("GET /v2/languages/{id}", handleLanguage)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, nil, map[string]string{"error": "Not Found"})
	})

	instance.server = &http.Server{Handler: authenticated(mux), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = instance.server.Serve(listener) }()
	return instance, nil
}

// Close stops the demo intranet.
func (i *Instance) Close() error { return i.server.Close() }

// authenticated mirrors the real API: everything but the token endpoint needs a
// bearer token, which proves the client really did the OAuth2 dance.
func authenticated(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/oauth/") && r.Header.Get("Authorization") == "" {
			writeJSON(w, http.StatusUnauthorized, nil, map[string]string{"error": "The access token is invalid"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleToken(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, nil, map[string]any{
		"access_token": "demo-token",
		"token_type":   "bearer",
		"expires_in":   7200,
		"scope":        "public",
		"created_at":   time.Now().Unix(),
	})
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
	page := intParam(r, "page", 1)
	perPage := intParam(r, "per_page", 30)
	if perPage > 100 {
		perPage = 100
	}

	start := (page - 1) * perPage
	users := []map[string]any{}
	for i := start; i < start+perPage && i < totalUsers; i++ {
		users = append(users, lightUser(i))
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"X-Page":     strconv.Itoa(page),
		"X-Per-Page": strconv.Itoa(perPage),
		"X-Total":    strconv.Itoa(totalUsers),
	}, users)
}

func handleUser(w http.ResponseWriter, r *http.Request) {
	login := r.PathValue("id")
	user := lightUser(7)
	user["login"] = login
	user["displayname"] = "Demo " + login
	user["cursus_users"] = []map[string]any{{
		"id": 1, "level": 8.42, "grade": "Learner", "begin_at": "2024-09-30T08:42:00.000Z",
		"cursus": map[string]any{"id": 21, "name": "42cursus", "slug": "42cursus"},
	}}
	user["projects_users"] = []map[string]any{{
		"id": 3141, "final_mark": 115, "status": "finished", "validated?": true,
		"project": map[string]any{"id": 1337, "name": "ft_printf", "slug": "ft_printf"},
	}}
	writeJSON(w, http.StatusOK, nil, user)
}

func handleCandidature(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, nil, map[string]any{
		"id": 4242, "user_id": 1007, "birth_date": "2003-04-02", "birth_city": "Tokyo",
		"postal_street": "hidden", "postal_city": "Tokyo", "postal_zip_code": "1000001",
		"meetup_at": "2024-06-01T10:00:00.000Z", "gender": "undefined", "language": "ja",
	})
}

func handleCloses(w http.ResponseWriter, r *http.Request) {
	closes := []map[string]any{
		demoClose(1, "black_hole", "close"),
		demoClose(2, "other", "unclose"),
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"X-Page": "1", "X-Per-Page": "30", "X-Total": strconv.Itoa(len(closes)),
	}, closes)
}

func handleClose(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, nil, map[string]string{"error": "Not Found"})
		return
	}
	writeJSON(w, http.StatusOK, nil, demoClose(id, "other", "close"))
}

func handleInternships(w http.ResponseWriter, r *http.Request) {
	internships := []map[string]any{{
		"id": 11, "duration": 6, "contract_type": "internship", "company_name": "42 Lab",
		"begin_at": "2026-03-01T00:00:00.000Z", "end_at": "2026-09-01T00:00:00.000Z",
		"created_at": "2026-01-10T09:00:00.000Z", "updated_at": "2026-01-10T09:00:00.000Z",
		"user": lightUser(3),
	}}
	writeJSON(w, http.StatusOK, map[string]string{
		"X-Page": "1", "X-Per-Page": "30", "X-Total": "1",
	}, internships)
}

func handleLanguage(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, nil, map[string]any{
		"id": 3, "name": "Japanese", "identifier": "ja",
		"created_at": "2017-11-22T13:00:00.000Z", "updated_at": "2017-11-22T13:00:00.000Z",
	})
}

func demoClose(id int, kind, state string) map[string]any {
	return map[string]any{
		"id": id, "reason": "demo data", "state": state, "kind": kind,
		"created_at": "2026-02-01T12:00:00.000Z", "updated_at": "2026-02-02T12:00:00.000Z",
		"community_services": []any{}, "user": lightUser(id), "closer": lightUser(id + 1),
	}
}

func lightUser(index int) map[string]any {
	login := fmt.Sprintf("demo%03d", index)
	return map[string]any{
		"id": 100000 + index, "login": login, "email": login + "@student.42.fr",
		"first_name": "Demo", "last_name": fmt.Sprintf("User%03d", index),
		"usual_first_name": nil, "usual_full_name": "Demo User", "last_name_display": nil,
		"url": "https://api.intra.42.fr/v2/users/" + login, "phone": "hidden",
		"displayname": fmt.Sprintf("Demo User%03d", index), "kind": "student",
		"image": map[string]any{
			"link": "https://cdn.intra.42.fr/users/" + login + ".jpg",
			"versions": map[string]any{
				"large":  "https://cdn.intra.42.fr/users/large_" + login + ".jpg",
				"medium": "https://cdn.intra.42.fr/users/medium_" + login + ".jpg",
				"small":  "https://cdn.intra.42.fr/users/small_" + login + ".jpg",
				"micro":  "https://cdn.intra.42.fr/users/micro_" + login + ".jpg",
			},
		},
		"staff?": false, "correction_point": 4 + index%9, "pool_month": "september",
		"pool_year": "2024", "location": nil, "wallet": 100 + index,
		"anonymize_date": "2029-09-01T00:00:00.000Z", "data_erasure_date": "2029-09-01T00:00:00.000Z",
		"created_at": "2024-09-01T08:00:00.000Z", "updated_at": "2026-09-01T08:00:00.000Z",
		"alumnized_at": nil, "alumni?": false, "active?": true,
	}
}

func intParam(r *http.Request, name string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, headers map[string]string, payload any) {
	for name, value := range headers {
		w.Header().Set(name, value)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload != nil {
		_ = json.NewEncoder(w).Encode(payload)
	}
}
