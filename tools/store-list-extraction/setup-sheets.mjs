// 眉毛サロンAIツール: 店舗マスタ/変更履歴/ログ/設定の4シートを初期セットアップする一回限りのスクリプト
// サービスアカウントキーはパス経由でこのスクリプト自身が読み込む(Claudeはキーの中身を見ない)
// ヘッダーは2段構成: 1行目=日本語ラベル(表示用) / 2行目=英語キー(ツールが参照する技術名)
import { google } from "googleapis";
import fs from "node:fs";

const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!KEY_PATH || !fs.existsSync(KEY_PATH)) {
  throw new Error(`鍵ファイルが見つかりません: ${KEY_PATH}`);
}
if (!SPREADSHEET_ID) {
  throw new Error("SPREADSHEET_ID が未設定です");
}

// 各列: [日本語ラベル, 英語キー]
const SHEETS = {
  店舗マスタ: [
    ["店舗ID", "store_id"],
    ["店舗名", "store_name"],
    ["ホットペッパーURL", "hpb_url"],
    ["住所", "address"],
    ["営業時間", "business_hours"],
    ["定休日", "closed_days"],
    ["アクセス", "access"],
    ["電話番号", "phone_number"],
    ["支払方法", "payment_methods"],
    ["駐車場", "parking"],
    ["口コミ件数", "review_count"],
    ["評価", "rating"],
    ["初回料金", "first_visit_price"],
    ["通常料金", "regular_price"],
    ["メンズ料金", "mens_price"],
    ["学割", "student_discount"],
    ["人気メニュー", "popular_menu"],
    ["その他情報", "other_info"],
    ["最終確認日時", "last_checked_at"],
    ["最終更新日時", "last_updated_at"],
    ["ステータス", "status"],
    ["公式HP URL", "official_site_url"],
    ["情報源(公式HP補完項目)", "info_source_fields"],
  ],
  変更履歴: [
    ["検知日時", "detected_at"],
    ["店舗ID", "store_id"],
    ["店舗名", "store_name"],
    ["変更項目", "field"],
    ["旧値", "old_value"],
    ["新値", "new_value"],
    ["記事反映済み", "reflected_to_articles"],
    ["備考", "note"],
    ["承認(反映してよい)", "approved"],
  ],
  ログ: [
    ["実行日時", "run_at"],
    ["ツール名", "tool"],
    ["対象件数", "target_count"],
    ["成功件数", "success_count"],
    ["失敗件数", "fail_count"],
    ["差分検知件数", "diff_count"],
    ["処理時間(秒)", "duration_sec"],
    ["ログファイルパス", "log_file_path"],
    ["実行トリガー", "triggered_by"],
  ],
  設定: [
    ["設定キー", "key"],
    ["設定値", "value"],
    ["説明", "description"],
  ],
};

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = new Map(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  console.log("既存タブ:", [...existing.keys()]);

  const addRequests = [];
  for (const name of Object.keys(SHEETS)) {
    if (!existing.has(name)) {
      addRequests.push({ addSheet: { properties: { title: name } } });
    }
  }
  if (addRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: addRequests },
    });
    console.log("作成したタブ:", addRequests.map((r) => r.addSheet.properties.title));
  }

  // 2行ヘッダー(日本語ラベル/英語キー)を書き込み
  const valueData = Object.entries(SHEETS).map(([name, cols]) => ({
    range: `${name}!A1`,
    values: [cols.map((c) => c[0]), cols.map((c) => c[1])],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: valueData },
  });
  console.log("2行ヘッダー(日本語/英語キー)を設定しました。");

  // 最新のsheetId一覧を取得し、書式(太字・固定表示)を設定
  const meta2 = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const idMap = new Map(meta2.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));

  const formatRequests = [];
  for (const name of Object.keys(SHEETS)) {
    const sheetId = idMap.get(name);
    formatRequests.push(
      // 1行目(日本語ラベル)を太字に
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
      // 2行目(英語キー)をグレー・小さめの文字に
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
          cell: {
            userEnteredFormat: {
              textFormat: { fontSize: 8, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } },
            },
          },
          fields: "userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor",
        },
      },
      // 上2行を固定表示
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 2 } },
          fields: "gridProperties.frozenRowCount",
        },
      }
    );
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: formatRequests },
  });
  console.log("見出しの書式(太字/固定表示)を設定しました。");

  // デフォルトの空タブ(シート1 / Sheet1)が残っていれば削除する
  const defaultSheet = meta2.data.sheets.find((s) =>
    ["シート1", "Sheet1"].includes(s.properties.title)
  );
  if (defaultSheet) {
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${defaultSheet.properties.title}!A1:Z10`,
    });
    const isEmpty = !check.data.values || check.data.values.length === 0;
    if (isEmpty) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: defaultSheet.properties.sheetId } }],
        },
      });
      console.log(`空のデフォルトタブ「${defaultSheet.properties.title}」を削除しました。`);
    }
  }

  console.log("セットアップ完了。");
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
