// Package intralens embeds the browser UI so that `go build` produces a single,
// self-contained binary.
package intralens

import "embed"

// WebFS holds the static UI. Use fs.Sub(WebFS, "web") to serve it at the root.
//
//go:embed all:web
var WebFS embed.FS
