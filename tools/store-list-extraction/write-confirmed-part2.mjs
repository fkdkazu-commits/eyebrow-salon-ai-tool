// part2バッチの確認済み結果をシートに書き込む
// 入力: confirmed-part2-batchN.json (配列: [{row, urlType, url, address, note}])
import { google } from "googleapis";
import fs from "node:fs";

const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "C:\\Users\\fkdka\\.secrets\\eyebrow-salon-ai-tool-a2493b9dda4c.json";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1gnE1r3X_-ZxMQpbUg6x6b2lCQymGCf7zaHeYOEBRmSc";
const SHEET_NAME = "店舗候補リスト";

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("使い方: node write-confirmed-part2.mjs <batch.json>");
  process.exit(1);
}
const items = JSON.parse(fs.readFileSync(inputFile, "utf8"));

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const data = items.map((it) => ({
    range: `${SHEET_NAME}!B${it.row}:F${it.row}`,
    values: [[it.urlType, "live(手動確認)", it.url, it.address, it.note]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
  console.log(`書き込み完了: ${items.length}件`, items.map((i) => i.row));
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
