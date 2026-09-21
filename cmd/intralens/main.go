// Command intralens serves a browser GUI for the 42 Intra API.
//
// The browser never sees the OAuth2 credentials: it posts an operation id plus
// parameters to this server, which forwards the call through the intraoapi42 Go
// client (token handling, retries and typed parameters included).
//
// Usage:
//
//	INTRA42_UID=... INTRA42_SECRET=... intralens
//	intralens --addr :4242 --scopes public,projects
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	intraoapi42 "github.com/42paris/intraoapi42"
	intralens "github.com/keusidan/intralens"
	"github.com/keusidan/intralens/internal/demo"
	"github.com/keusidan/intralens/internal/server"
	"github.com/keusidan/intralens/internal/spec"
)

type options struct {
	addr     string
	demo     bool
	webDir   string
	scopes   string
	envFile  string
	timeout  time.Duration
	staging  bool
	logLevel string
	origins  string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "intralens:", err)
		os.Exit(1)
	}
}

func run() error {
	var opts options
	flag.StringVar(&opts.addr, "addr", "127.0.0.1:4242", "listen address")
	flag.StringVar(&opts.webDir, "web", "", "serve the UI from this directory instead of the embedded copy (development)")
	flag.StringVar(&opts.scopes, "scopes", "public", "comma separated OAuth2 scopes")
	flag.StringVar(&opts.envFile, "env-file", ".env", "file with INTRA42_UID / INTRA42_SECRET (optional)")
	flag.DurationVar(&opts.timeout, "timeout", 30*time.Second, "per-call timeout towards the 42 API")
	flag.BoolVar(&opts.staging, "staging", false, "talk to the staging intranet instead of production")
	flag.BoolVar(&opts.demo, "demo", false, "serve sample data from a bundled fake intranet (no credentials needed)")
	flag.StringVar(&opts.origins, "allow-origin", "", "comma separated origins allowed to call this server cross-origin, e.g. https://user.github.io")
	flag.StringVar(&opts.logLevel, "log", "info", "log level: debug, info, warn, error")
	flag.Parse()

	logger := newLogger(opts.logLevel)
	slog.SetDefault(logger)

	loadEnvFile(opts.envFile, logger)

	document, err := spec.Load()
	if err != nil {
		return err
	}

	static, err := staticFS(opts.webDir)
	if err != nil {
		return err
	}

	uid, secret := credentials()
	scopes := splitScopes(opts.scopes)

	config := baseConfig(opts.staging).
		WithClientCredentials(uid, secret).
		WithScopes(scopes...)
	applyEndpointOverrides(&config)

	configured := uid != "" && secret != ""

	if opts.demo {
		instance, err := demo.Start()
		if err != nil {
			return err
		}
		defer func() { _ = instance.Close() }()

		config.ServerURL = instance.ServerURL
		config.Config.TokenURL = instance.TokenURL
		config.ClientID, config.ClientSecret = "demo", "demo"
		configured = true
		logger.Info("demo mode: serving sample data, nothing reaches the real intranet", "upstream", instance.ServerURL)
	}

	client, err := intraoapi42.New(config)
	if err != nil {
		return fmt.Errorf("create 42 API client: %w", err)
	}

	if !configured {
		logger.Warn("no credentials found: the UI will open but calls are disabled",
			"hint", "export INTRA42_UID / INTRA42_SECRET, or put them in .env")
	}

	origins := splitList(opts.origins)
	if len(origins) > 0 {
		logger.Info("cross-origin calls enabled", "origins", origins)
	}

	srv, err := server.New(server.Options{
		Client:         client,
		Doc:            document,
		Static:         static,
		Logger:         logger,
		Timeout:        opts.timeout,
		ServerURL:      config.ServerURL,
		Scopes:         scopes,
		Configured:     configured,
		AllowedOrigins: origins,
	})
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:              opts.addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("intra-Lens ready",
			"url", "http://"+opts.addr+"/",
			"api", config.ServerURL,
			"operations", len(server.SupportedOperations()),
			"credentials", configured,
		)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	}
	return nil
}

func newLogger(level string) *slog.Logger {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed}))
}

func staticFS(dir string) (fs.FS, error) {
	if dir != "" {
		if _, err := os.Stat(dir); err != nil {
			return nil, fmt.Errorf("--web %s: %w", dir, err)
		}
		return os.DirFS(dir), nil
	}
	return fs.Sub(intralens.WebFS, "web")
}

func baseConfig(staging bool) intraoapi42.Config {
	if staging {
		return intraoapi42.StagingConfig
	}
	return intraoapi42.ProductionConfig
}

// applyEndpointOverrides lets tests (and the staging intranet) point the client
// somewhere else without touching the rest of the wiring.
func applyEndpointOverrides(config *intraoapi42.Config) {
	if url := os.Getenv("INTRALENS_SERVER_URL"); url != "" {
		config.ServerURL = url
	}
	if url := os.Getenv("INTRALENS_TOKEN_URL"); url != "" {
		config.Config.TokenURL = url
	}
}

func credentials() (uid, secret string) {
	uid = firstEnv("INTRA42_UID", "INTRA42_CLIENT_ID", "FT_UID")
	secret = firstEnv("INTRA42_SECRET", "INTRA42_CLIENT_SECRET", "FT_SECRET")
	return uid, secret
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func splitScopes(raw string) []string { return splitList(raw) }

func splitList(raw string) []string {
	var items []string
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// loadEnvFile reads simple KEY=VALUE lines. Existing environment variables win,
// so `INTRA42_UID=... intralens` still overrides the file.
func loadEnvFile(path string, logger *slog.Logger) {
	if path == "" {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logger.Warn("could not read env file", "path", path, "error", err)
		}
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
	if err := scanner.Err(); err != nil {
		logger.Warn("could not parse env file", "path", path, "error", err)
	}
	logger.Debug("loaded env file", "path", path)
}
