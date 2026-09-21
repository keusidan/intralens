# intra-Lens

42 Intra API (api.intra.42.fr v2) を **ブラウザの GUI(Graphical User Interface) から叩く**ためのローカルツールです。
API 呼び出しは [42paris/intraoapi42](https://github.com/42paris/intraoapi42) の Go クライアントがそのまま担当します
(OAuth2 トークン取得・キャッシュ、429/5xx の自動リトライ、生成された型付きパラメータ)。

```
ブラウザ (web/)                intra-Lens サーバ (Go)              42 Intra API
  フォーム入力  ──POST /api/call──▶  registry → intraoapi42  ──HTTPS──▶  api.intra.42.fr/v2
  JSON ビューア ◀──── 結果 ────────  ステータス/ヘッダー/本文        (トークンはサーバ内のみ)
```

- 認証情報 (UID / SECRET) は**サーバ側だけ**が持ちます。ブラウザには一切渡りません。
- ブラウザから直接 42 API を叩けない CORS(Cross-Origin Resource Sharing) 制約も、この構成で解消されます。
- 呼び出せるのは spec に載っていて Go クライアントが実装している操作のみ。汎用プロキシではありません。

## できること

| | |
|---|---|
| エンドポイント一覧 | メソッド / パス / 概要 / operationId / scope を一覧・検索 |
| パラメータ入力 | 型・必須・enum・既定値つきのフォーム。`filter[login]` のような deepObject は行を追加して複数条件を指定 |
| フィールド補完 | `sort` / `filter` / `range` に使えるカラムを spec から抽出してチップ表示・絞り込み |
| 実行 | 「実行」ボタン (Ctrl+Enter) で即実行。ステータス・所要時間・サイズ・実際に叩いた URL を表示 |
| ページング | `X-Page` / `X-Per-Page` / `X-Total` を読んで「1 / 46 ページ」を表示、前後ページへワンクリック |
| レスポンス閲覧 | 折りたたみ JSON ツリー (配列は `#id login` のラベル付き) と生 JSON、コピー / ダウンロード |
| コード生成 | 同じリクエストの curl / Go (intraoapi42) / Python スニペット |
| モデル閲覧 | 24 個のスキーマをツリー表示。`$ref` はリンクで辿れ、「このモデルを返すエンドポイント」も逆引き |

## 必要なもの

- Go 1.25 以上 (それ未満でも `GOTOOLCHAIN=auto` なら自動で取得されます)
- 42 の API アプリケーション: https://profile.intra.42.fr/oauth/applications で作成し UID と SECRET を取得

## クイックスタート

```bash
# 1. 認証情報なしで GUI を試す (ダミーデータを返す内蔵イントラを使用)
make demo        # → http://127.0.0.1:4242/

# 2. 本物の 42 API に繋ぐ
cp .env.example .env    # .env に UID / SECRET を記入 (.env は git 管理外)
make run                # → http://127.0.0.1:4242/

# 環境変数でも可
INTRA42_UID=xxx INTRA42_SECRET=yyy make run
```

単一バイナリが欲しい場合は `make build` (UI は `embed` で埋め込まれるので配布はバイナリ 1 個で完結します)。

### よく使うオプション

```bash
intralens --addr 0.0.0.0:8080      # 待ち受けアドレス (既定は 127.0.0.1:4242)
intralens --scopes public,projects # 要求する OAuth2 スコープ
intralens --staging                # staging イントラに接続
intralens --demo                   # ダミーイントラ (認証不要)
intralens --web web --log debug    # web/ をディスクから配信 (フロント開発用)
```

## 画面の使い方

- `/` または `s` で検索、`j` / `k` で移動、`Enter` で開く、`Tab` でエンドポイント ⇄ モデル切り替え
- `Ctrl+Enter` でその場実行、`g` でトップ、`t` でテーマ切り替え、`?` でショートカット一覧
- URL は `#/op/getUsers` `#/model/UserResponse` の形式なので、そのまま共有できます

## 構成

```
cmd/intralens/main.go   CLI・設定・起動 (フラグ / .env / シグナル)
internal/server/        HTTP ルーティング、パラメータ変換、呼び出し許可リスト
  ├ server.go           /api/spec, /api/status, /api/call と静的配信
  ├ call.go             フォーム値 → 生成された ...Params への変換 (型は spec 由来)
  └ registry.go         operationId → intraoapi42 のメソッド (ここが許可リスト)
internal/spec/          openapi.yaml の埋め込みとパラメータ型インデックス
internal/demo/          認証情報なしで試すためのダミーイントラ
web/                    フロントエンド (依存ライブラリなしの HTML/CSS/JS)
```

### サーバが公開する API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/spec` | 埋め込み済み OpenAPI ドキュメント (JSON) |
| GET | `/api/status` | 認証済みか、接続先イントラ、スコープ、呼び出し可能な operationId |
| POST | `/api/call` | `{"operationId":"getUsers","path":{},"query":{"per_page":"100"}}` を受けて 42 API を呼ぶ |

`/api/call` はレスポンスのステータス・ヘッダー・本文をそのまま返します (404 も 404 のまま)。
不正なパラメータは 400、認証情報未設定は 503、上流への到達失敗は 502 です。

## 対応エンドポイントを増やす

`internal/spec/openapi.yaml` は上流の spec のコピーです。上流に新しい操作が入ったら:

1. `internal/spec/openapi.yaml` を最新版に差し替える
2. `go get -u github.com/42paris/intraoapi42` で生成クライアントを更新する
3. `internal/server/registry.go` に operationId → メソッドの対応を 1 つ追加する

`go test ./...` は spec と registry の双方向の突き合わせを検証するので、追加漏れはテストで落ちます。

## 開発

```bash
make check   # fmt + vet + test
make dev     # web/ をディスク配信し、リロードだけでフロントの変更を確認
```

## 注意

- `internal/spec/openapi.yaml` は 42 公式のものではなく、intraoapi42 が手書きで整備している非公式 spec です。カバー範囲は現在 8 エンドポイント。
- 42 API のレート制限は概ね 2 req/秒・1200 req/時です。429 は intraoapi42 が自動で再試行します。
- 既定では 127.0.0.1 にのみ待ち受けます。`--addr` で外部公開する場合、その端末の全員があなたの認証情報で API を叩けることになります。
