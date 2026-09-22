# intra-Lens -- 42 Intra API を GUI から叩くためのローカルサーバ
GO      ?= go
BIN     := bin/intralens
ADDR    ?= 127.0.0.1:4242

# GitHub Pages 版から接続する場合に指定:
#   make run ALLOW_ORIGIN=https://<ユーザー名>.github.io
ALLOW_ORIGIN ?=
ORIGIN_FLAG  := $(if $(ALLOW_ORIGIN),--allow-origin $(ALLOW_ORIGIN))

.PHONY: help run demo dev build static test fmt vet check clean

help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

run: ## サーバを起動 (INTRA42_UID / INTRA42_SECRET または .env が必要)
	$(GO) run ./cmd/intralens --addr $(ADDR) $(ORIGIN_FLAG)

demo: ## 認証情報なしで試す (ダミーデータを返す内蔵イントラを使用)
	$(GO) run ./cmd/intralens --addr $(ADDR) --demo $(ORIGIN_FLAG)

dev: ## web/ をディスクから配信 (編集してリロードするだけで反映)
	$(GO) run ./cmd/intralens --addr $(ADDR) --web web --log debug $(ORIGIN_FLAG)

build: ## 単一バイナリをビルド (UI は埋め込み)
	$(GO) build -o $(BIN) ./cmd/intralens
	@echo "→ $(BIN)"

static: ## GitHub Pages と同じ静的版を dist/ に生成
	$(GO) run ./cmd/genstatic --out dist

test: ## テストを実行
	$(GO) test ./...

fmt: ## gofmt
	$(GO) fmt ./...

vet: ## go vet
	$(GO) vet ./...

check: fmt vet test ## fmt + vet + test

clean: ## 生成物を削除
	rm -rf bin dist
