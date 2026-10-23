// バックエンドの設定。
// 空のままなら「ゲスト専用（ランキングなし）」で動きます（ローカル確認用）。
// 公開時は GitHub Actions の変数 API_BASE（Cloudflare WorkerのURL）を設定すると、
// デプロイ時にこのファイルが自動で Cloudflare 版の設定に置き換わります。
// 手元でサーバーに繋ぎたい場合: apiBase に URL を入れ、Worker側の ALLOW_LOCALHOST=1 にしてください。
window.HANT_CONFIG = {
  backend: "worker",
  apiBase: ""
};
