# 折り紙設計

CodexとOrieditaを使い、完成予想図・Oriedita検証結果・3Dモデル・折順をまとめて表示するウェブアプリです。文章に加えて画像、PDF、`.cp`、`.fold`、`.ori`、3Dモデルなどを添付できます。

## ローカル起動

```bash
npm install
npm start
```

起動後に <http://127.0.0.1:8787> を開き、ターミナルに表示されたアクセスキーを入力します。アクセスキーは初回起動時に `.codex-web-token` へ生成され、Gitには含まれません。

既定では親フォルダを作業領域にします。変更する場合:

```bash
CODEX_WORKSPACE="/path/to/origami-project" npm start
```

## 公開

別ターミナルでCloudflare Quick Tunnelを起動します。

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

表示された `https://...trycloudflare.com` が直接利用できる公開URLです。公開URLでもアクセスキーが必要です。

## 安全設定

- Codexの書き込み先は指定した作業領域内のみ
- ネットワークアクセスは既定で無効
- アップロードは12MB、4ファイルまで
- 成果物として開ける形式を折り紙・画像・文書・3D形式に限定
- APIアクセスはアクセスキーで保護

ネットワークを必要とする場合だけ `CODEX_NETWORK_ACCESS=1 npm start` で有効化できます。
