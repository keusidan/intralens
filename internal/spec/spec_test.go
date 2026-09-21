package spec

import "testing"

func TestLoadIndexesOperations(t *testing.T) {
	doc, err := Load()
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	if doc.ServerURL != "https://api.intra.42.fr/v2" {
		t.Errorf("ServerURL = %q, want the production v2 endpoint", doc.ServerURL)
	}
	if len(doc.Operations) == 0 {
		t.Fatal("no operations were indexed")
	}

	users, ok := doc.Operations["getUsers"]
	if !ok {
		t.Fatal("getUsers is missing from the index")
	}
	if users.Method != "GET" || users.Path != "/users" {
		t.Errorf("getUsers = %s %s, want GET /users", users.Method, users.Path)
	}

	tests := map[string]Kind{
		"sort":         KindString,
		"filter":       KindObject, // deepObject
		"range":        KindObject,
		"page":         KindInteger,
		"per_page":     KindInteger,
		"page[number]": KindInteger,
	}
	for name, want := range tests {
		param, ok := users.Params[name]
		if !ok {
			t.Errorf("getUsers has no parameter %q", name)
			continue
		}
		if param.Kind != want {
			t.Errorf("parameter %q kind = %q, want %q", name, param.Kind, want)
		}
	}

	byID, ok := doc.Operations["getUserById"]
	if !ok {
		t.Fatal("getUserById is missing from the index")
	}
	if _, ok := byID.Params["id"]; !ok {
		t.Error("getUserById should expose its path parameter")
	}
}

func TestJSONIsServable(t *testing.T) {
	doc, err := Load()
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}
	if len(doc.JSON) == 0 || doc.JSON[0] != '{' {
		t.Fatal("Document.JSON should hold a JSON object")
	}
}
