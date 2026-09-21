package server

import (
	"errors"
	"testing"

	intraoapi42 "github.com/42paris/intraoapi42"
	"github.com/keusidan/intralens/internal/spec"
)

func testDoc(t *testing.T) *spec.Document {
	t.Helper()
	doc, err := spec.Load()
	if err != nil {
		t.Fatalf("load spec: %v", err)
	}
	return doc
}

func TestRegistryMatchesSpec(t *testing.T) {
	doc := testDoc(t)
	for id := range registry {
		if _, ok := doc.Operations[id]; !ok {
			t.Errorf("registry exposes %q, which the spec does not describe", id)
		}
	}
	for id := range doc.Operations {
		if _, ok := registry[id]; !ok {
			t.Errorf("spec describes %q but the registry cannot call it", id)
		}
	}
}

func TestQueryValuesCoercion(t *testing.T) {
	doc := testDoc(t)
	call := callRequest{
		OperationID: "getUsers",
		Query: map[string]string{
			"sort":                      "-login",
			"per_page":                  "100",
			"page[number]":              "3",
			"filter[login]":             "pons",
			"filter[primary_campus_id]": "62",
			"range[pool_year]":          "2023,2024",
			"ignored":                   "   ", // blank values are dropped
		},
	}
	if err := call.bind(doc); err != nil {
		t.Fatalf("bind: %v", err)
	}

	values, err := call.queryValues()
	if err != nil {
		t.Fatalf("queryValues: %v", err)
	}

	if values["sort"] != "-login" {
		t.Errorf("sort = %v, want -login", values["sort"])
	}
	if values["per_page"] != 100 {
		t.Errorf("per_page = %#v, want the integer 100", values["per_page"])
	}
	if values["page[number]"] != 3 {
		t.Errorf("page[number] = %#v, want the integer 3", values["page[number]"])
	}

	filter, ok := values["filter"].(map[string]string)
	if !ok {
		t.Fatalf("filter = %#v, want a map", values["filter"])
	}
	if filter["login"] != "pons" || filter["primary_campus_id"] != "62" {
		t.Errorf("filter = %#v, want both bracket keys", filter)
	}
	if _, ok := values["ignored"]; ok {
		t.Error("blank values should be dropped before validation")
	}
}

func TestDecodeQueryFillsGeneratedParams(t *testing.T) {
	doc := testDoc(t)
	call := callRequest{
		OperationID: "getUsers",
		Query: map[string]string{
			"sort":          "-login",
			"per_page":      "100",
			"filter[login]": "pons",
		},
	}
	if err := call.bind(doc); err != nil {
		t.Fatalf("bind: %v", err)
	}

	var params intraoapi42.GetUsersParams
	if err := call.decodeQuery(&params); err != nil {
		t.Fatalf("decodeQuery: %v", err)
	}

	if params.Sort == nil || *params.Sort != "-login" {
		t.Errorf("Sort = %v, want -login", params.Sort)
	}
	if params.PerPage == nil || int(*params.PerPage) != 100 {
		t.Errorf("PerPage = %v, want 100", params.PerPage)
	}
	if params.Filter == nil || (*params.Filter)["login"] != "pons" {
		t.Errorf("Filter = %v, want login=pons", params.Filter)
	}
}

func TestQueryValuesRejectsBadInput(t *testing.T) {
	doc := testDoc(t)
	cases := map[string]map[string]string{
		"unknown parameter": {"nope": "1"},
		"not an integer":    {"per_page": "many"},
		"not a deepObject":  {"sort[login]": "pons"},
	}

	for name, query := range cases {
		t.Run(name, func(t *testing.T) {
			call := callRequest{OperationID: "getUsers", Query: query}
			if err := call.bind(doc); err != nil {
				t.Fatalf("bind: %v", err)
			}
			_, err := call.queryValues()
			if err == nil {
				t.Fatal("expected an error")
			}
			var bad badRequest
			if !errors.As(err, &bad) {
				t.Fatalf("error %v should be a badRequest", err)
			}
		})
	}
}

func TestPathParams(t *testing.T) {
	call := callRequest{Path: map[string]string{"id": " 42 ", "login": "pons"}}

	id, err := call.pathInt("id")
	if err != nil || id != 42 {
		t.Errorf("pathInt(id) = %d, %v; want 42, nil", id, err)
	}
	if _, err := call.pathInt("login"); err == nil {
		t.Error("pathInt should reject a non numeric value")
	}
	if _, err := call.pathString("missing"); err == nil {
		t.Error("pathString should reject a missing value")
	}
}

func TestBindRejectsUnknownOperation(t *testing.T) {
	doc := testDoc(t)
	call := callRequest{OperationID: "deleteEverything"}
	if err := call.bind(doc); err == nil {
		t.Fatal("unknown operations must be rejected")
	}
}
