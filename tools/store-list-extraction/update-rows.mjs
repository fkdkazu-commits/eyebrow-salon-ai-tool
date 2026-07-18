// 確認済みの行だけをシートへ書き込む(B:F列)。updates.json を読み込んで反映する。
import { google } from "googleapis";
import fs from "node:fs";

const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "C:\\Users\\fkdka\\.secrets\\eyebrow-salon-ai-tool-a2493b9dda4c.json";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1gnE1r3X_-ZxMQpbUg6x6b2lCQymGCf7zaHeYOEBRmSc";
const SHEET_NAME = "店舗候補リスト";

if (!KEY_PATH || !fs.existsSync(KEY_PATH)) {
  throw new Error(`鍵ファイルが見つかりません: ${KEY_PATH}`);
}
if (!SPREADSHEET_ID) {
  throw new Error("SPREADSHEET_ID が未設定です");
}

const updatesFile = process.argv[2];
if (!updatesFile) {
  throw new Error("使い方: node update-rows.mjs <updates.json>");
}
const updates = JSON.parse(fs.readFileSync(updatesFile, "utf-8"));

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
  console.log(`更新完了: ${data.length}件`, res.data.totalUpdatedCells, "セル");
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
