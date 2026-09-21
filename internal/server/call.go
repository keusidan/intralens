package server

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/keusidan/intralens/internal/spec"
)

// callRequest is what the browser posts to /api/call. Values arrive as strings
// (they come from form inputs) and are coerced here using the spec, so that the
// generated `...Params` structs can be filled by the normal JSON decoder.
type callRequest struct {
	OperationID string            `json:"operationId"`
	Path        map[string]string `json:"path"`
	Query       map[string]string `json:"query"`

	op spec.Operation
}

// badRequest marks errors caused by the caller, which map to HTTP 400.
type badRequest struct{ err error }

func (b badRequest) Error() string { return b.err.Error() }

func errBadRequest(format string, args ...any) error {
	return badRequest{fmt.Errorf(format, args...)}
}

func (c *callRequest) bind(doc *spec.Document) error {
	if c.OperationID == "" {
		return errBadRequest("operationId is required")
	}
	op, ok := doc.Operations[c.OperationID]
	if !ok {
		return errBadRequest("unknown operationId %q", c.OperationID)
	}
	if _, ok := registry[c.OperationID]; !ok {
		return errBadRequest("operation %q is described by the spec but not implemented by the Go client", c.OperationID)
	}
	c.op = op
	return nil
}

// decodeQuery fills a generated `...Params` struct from the submitted values.
func (c *callRequest) decodeQuery(target any) error {
	values, err := c.queryValues()
	if err != nil {
		return err
	}
	if len(values) == 0 {
		return nil
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return errBadRequest("encode parameters: %v", err)
	}
	if err := json.Unmarshal(encoded, target); err != nil {
		return errBadRequest("parameters do not match %T: %v", target, err)
	}
	return nil
}

// queryValues turns {"per_page": "100", "filter[login]": "pons"} into
// {"per_page": 100, "filter": {"login": "pons"}} following the spec types.
func (c *callRequest) queryValues() (map[string]any, error) {
	values := map[string]any{}

	for key, raw := range c.Query {
		if strings.TrimSpace(raw) == "" {
			continue
		}

		// `page[number]` is a parameter name of its own, so try the full key first.
		if param, ok := c.op.Params[key]; ok && param.Kind != spec.KindObject {
			value, err := coerce(param, raw)
			if err != nil {
				return nil, err
			}
			values[key] = value
			continue
		}

		base, field, nested := splitBracket(key)
		param, ok := c.op.Params[base]
		if !ok {
			return nil, errBadRequest("%s does not accept a parameter named %q", c.op.ID, key)
		}
		if !nested || param.Kind != spec.KindObject {
			return nil, errBadRequest("parameter %q of %s is not a %s parameter", base, c.op.ID, spec.KindObject)
		}

		bucket, _ := values[base].(map[string]string)
		if bucket == nil {
			bucket = map[string]string{}
			values[base] = bucket
		}
		bucket[field] = raw
	}

	return values, nil
}

func coerce(param spec.Param, raw string) (any, error) {
	switch param.Kind {
	case spec.KindInteger:
		value, err := strconv.Atoi(raw)
		if err != nil {
			return nil, errBadRequest("parameter %q expects an integer, got %q", param.Name, raw)
		}
		return value, nil
	case spec.KindNumber:
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, errBadRequest("parameter %q expects a number, got %q", param.Name, raw)
		}
		return value, nil
	case spec.KindBoolean:
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errBadRequest("parameter %q expects a boolean, got %q", param.Name, raw)
		}
		return value, nil
	default:
		return raw, nil
	}
}

func splitBracket(key string) (base, field string, ok bool) {
	open := strings.IndexByte(key, '[')
	if open <= 0 || !strings.HasSuffix(key, "]") {
		return key, "", false
	}
	field = key[open+1 : len(key)-1]
	if field == "" {
		return key, "", false
	}
	return key[:open], field, true
}

// pathString returns a required path parameter as text.
func (c *callRequest) pathString(name string) (string, error) {
	value := strings.TrimSpace(c.Path[name])
	if value == "" {
		return "", errBadRequest("path parameter %q is required", name)
	}
	return value, nil
}

// pathInt returns a required numeric path parameter.
func (c *callRequest) pathInt(name string) (int, error) {
	raw, err := c.pathString(name)
	if err != nil {
		return 0, err
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, errBadRequest("path parameter %q expects an integer, got %q", name, raw)
	}
	return value, nil
}
