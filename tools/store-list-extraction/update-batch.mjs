// 確認できた店舗情報をシートへ反映する。引数でJSONファイルパスを受け取る。
// JSON形式: [{row, urlType, url, address, note}, ...]
import { google } from "googleapis";
import fs from "node:fs";

const KEY_PATH = "C:\\Users\\fkdka\\.secrets\\eyebrow-salon-ai-tool-a2493b9dda4c.json";
const SPREADSHEET_ID = "1gnE1r3X_-ZxMQpbUg6x6b2lCQymGCf7zaHeYOEBRmSc";
const SHEET_NAME = "店舗候補リスト";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("使い方: node update-batch.mjs <updates.json>");
  process.exit(1);
}
const updates = JSON.parse(fs.readFileSync(inputPath, "utf8"));

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const data = updates.map((u) => ({
    range: `${SHEET_NAME}!B${u.row}:F${u.row}`,
    values: [[u.urlType, "live(手動確認)", u.url, u.address, u.note]],
  }));

  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
  console.log(`更新完了: ${updates.length}件, 更新セル数: ${res.data.totalUpdatedCells}`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
