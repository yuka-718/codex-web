# Codex Web

GitHub Pagesの画面から、このMacでログイン済みのCodexへプロンプトを送る小さなウェブアプリです。実行サーバーは `127.0.0.1` にだけ接続し、インターネットには公開しません。

## 起動

```bash
npm install
npm start
```

起動後に <http://127.0.0.1:8787> を開きます。GitHub Pages版も、同じMacでサーバーが動いているときだけCodexへ接続します。

別の作業フォルダでCodexを動かす場合:

```bash
CODEX_WORKSPACE="/path/to/project" npm start
```

初期設定では、Codexが書き込めるのは指定した作業フォルダ内だけで、ネットワーク接続は無効です。必要な場合だけ次のように有効化できます。

```bash
CODEX_NETWORK_ACCESS=1 npm start
```

## 構成

- `docs/`: GitHub Pagesに公開する静的UI
- `server.mjs`: Codex SDKを使うローカルブリッジ

Codex SDKは、ローカルのCodex認証を引き継いで動きます。APIキーをブラウザやGitHubへ置く必要はありません。

Codexの実行ファイルを自動で見つけられない場合は、`CODEX_BIN=/path/to/codex npm start` のように指定できます。
