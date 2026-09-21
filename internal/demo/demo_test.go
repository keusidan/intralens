package demo

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestDemoIntranet(t *testing.T) {
	instance, err := Start()
	if err != nil {
		t.Fatalf("start demo: %v", err)
	}
	t.Cleanup(func() { _ = instance.Close() })

	resp, err := http.Post(instance.TokenURL, "application/x-www-form-urlencoded",
		strings.NewReader(url.Values{"grant_type": {"client_credentials"}}.Encode()))
	if err != nil {
		t.Fatalf("token request: %v", err)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	_ = resp.Body.Close()
	if token.AccessToken == "" {
		t.Fatal("demo intranet should issue a token")
	}

	if status := get(t, instance.ServerURL+"/users", ""); status != http.StatusUnauthorized {
		t.Errorf("unauthenticated call = %d, want 401", status)
	}

	req, _ := http.NewRequest(http.MethodGet, instance.ServerURL+"/users?page=2&per_page=10", nil)
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("users request: %v", err)
	}
	defer resp.Body.Close()

	var users []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		t.Fatalf("decode users: %v", err)
	}
	if len(users) != 10 {
		t.Errorf("got %d users, want a full page of 10", len(users))
	}
	if resp.Header.Get("X-Total") == "" || resp.Header.Get("X-Page") != "2" {
		t.Errorf("pagination headers = %v, want X-Page 2 and a total", resp.Header)
	}
}

func get(t *testing.T, target, token string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request %s: %v", target, err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}
