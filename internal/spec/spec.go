// Package spec embeds the unofficial OpenAPI description of the 42 Intra API
// and indexes the bits the server needs at runtime: which operations exist and
// what type each of their parameters has.
//
// The document is the single source of truth shared by the Go backend (for
// coercing incoming values) and the browser UI (for rendering the forms).
package spec

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed openapi.yaml
var source []byte

// Kind is the JSON type a parameter expects.
type Kind string

const (
	KindString  Kind = "string"
	KindInteger Kind = "integer"
	KindNumber  Kind = "number"
	KindBoolean Kind = "boolean"
	KindObject  Kind = "object" // deepObject parameters such as filter[login]
)

// Param describes one operation parameter.
type Param struct {
	Name string
	In   string
	Kind Kind
}

// Operation is one path + method pair from the document.
type Operation struct {
	ID     string
	Method string
	Path   string
	Params map[string]Param
}

// Document is the parsed spec plus the lookup tables built from it.
type Document struct {
	// JSON is the whole document, ready to be served to the browser.
	JSON       json.RawMessage
	Version    string
	ServerURL  string
	Operations map[string]Operation
}

var httpMethods = map[string]bool{
	"get": true, "post": true, "put": true, "patch": true, "delete": true, "head": true, "options": true,
}

// Load parses the embedded document. It is cheap enough to call once at boot.
func Load() (*Document, error) {
	return parse(source)
}

// Source returns the raw YAML, for tests and for `intralens --dump-spec`.
func Source() []byte { return source }

func parse(raw []byte) (*Document, error) {
	var root map[string]any
	if err := yaml.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("parse openapi.yaml: %w", err)
	}

	encoded, err := json.Marshal(root)
	if err != nil {
		return nil, fmt.Errorf("encode openapi document: %w", err)
	}

	doc := &Document{
		JSON:       encoded,
		Operations: map[string]Operation{},
	}

	if info, ok := root["info"].(map[string]any); ok {
		doc.Version, _ = info["version"].(string)
	}
	if servers, ok := root["servers"].([]any); ok && len(servers) > 0 {
		if first, ok := servers[0].(map[string]any); ok {
			doc.ServerURL, _ = first["url"].(string)
		}
	}

	paths, ok := root["paths"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi document has no paths")
	}

	for path, value := range paths {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		shared := paramList(item["parameters"])

		for method, rawOperation := range item {
			if !httpMethods[strings.ToLower(method)] {
				continue
			}
			operation, ok := rawOperation.(map[string]any)
			if !ok {
				continue
			}
			id, _ := operation["operationId"].(string)
			if id == "" {
				return nil, fmt.Errorf("%s %s has no operationId", strings.ToUpper(method), path)
			}
			if _, exists := doc.Operations[id]; exists {
				return nil, fmt.Errorf("duplicate operationId %q", id)
			}

			params := map[string]Param{}
			for _, entry := range append(shared, paramList(operation["parameters"])...) {
				param, ok := resolveParam(root, entry)
				if !ok {
					continue
				}
				params[param.Name] = param
			}

			doc.Operations[id] = Operation{
				ID:     id,
				Method: strings.ToUpper(method),
				Path:   path,
				Params: params,
			}
		}
	}

	return doc, nil
}

func paramList(value any) []any {
	list, _ := value.([]any)
	return list
}

func resolveParam(root map[string]any, entry any) (Param, bool) {
	node, ok := entry.(map[string]any)
	if !ok {
		return Param{}, false
	}
	if ref, ok := node["$ref"].(string); ok {
		resolved, ok := resolvePointer(root, ref)
		if !ok {
			return Param{}, false
		}
		node, ok = resolved.(map[string]any)
		if !ok {
			return Param{}, false
		}
	}

	name, _ := node["name"].(string)
	if name == "" {
		return Param{}, false
	}
	in, _ := node["in"].(string)

	param := Param{Name: name, In: in, Kind: KindString}
	if schema, ok := node["schema"].(map[string]any); ok {
		if kind, ok := schema["type"].(string); ok {
			param.Kind = Kind(kind)
		}
	}
	if style, _ := node["style"].(string); style == "deepObject" {
		param.Kind = KindObject
	}
	return param, true
}

// resolvePointer walks a local `#/a/b/c` JSON pointer.
func resolvePointer(root map[string]any, pointer string) (any, bool) {
	if !strings.HasPrefix(pointer, "#/") {
		return nil, false
	}
	var current any = root
	for _, part := range strings.Split(strings.TrimPrefix(pointer, "#/"), "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		node, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = node[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

// OperationIDs returns the ids in a stable order, for logs and tests.
func (d *Document) OperationIDs() []string {
	ids := make([]string, 0, len(d.Operations))
	for id := range d.Operations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
