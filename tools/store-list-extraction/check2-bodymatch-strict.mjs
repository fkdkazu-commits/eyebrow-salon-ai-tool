// bodyMatch(先頭6文字部分一致)のみで通過した671件を、業界共通語を除いた「店舗固有トークン」で
// 本文全文と照合しなおす、より厳密な再検証スクリプト
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const GENERIC_WORDS = [
  "アイブロウサロン", "メンズ眉毛サロン", "メンズ眉サロン", "メンズ専門", "眉毛専門店", "眉毛サロン",
  "まつげ眉毛サロン", "眉毛の", "アイブロウ×まつ毛パーマ専門店", "アイブロウ&アイラッシュ", "アイブロウ＆アイラッシュ",
  "eyelash salon", "eyebrow salon", "beauty salon", "private salon", "salon de", "men's eyebrow salon",
  "まつ毛パーマ&眉専門店", "まつ毛パーマ&眉毛サロン専門店", "まつげと眉の専門店", "眉とまつげパーマ専門店",
  "完全個室", "専門店", "サロン", "beauty", "salon",
];

function toHalfWidth(s) {
  return (s || "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
function norm(s) {
  return toHalfWidth(s || "")
    .replace(/[【】\[\]（）()'’"”"、,。.・\-‐－―~〜]/g, "")
    .replace(/\s|　/g, "")
    .toLowerCase();
}

// 店舗名から業界共通語を除去し、残った「固有名」部分を抽出
function extractDistinctiveToken(name) {
  let core = norm(name);
  const normGeneric = GENERIC_WORDS.map(norm).sort((a, b) => b.length - a.length);
  for (const g of normGeneric) {
    if (g.length >= 2) core = core.split(g).join("");
  }
  // 支店名(◯◯店・◯◯駅前等)も末尾から除去して、ブランド名の核だけ残す試み
  core = core.replace(/(店|支店|本店|駅前|号店)$/g, "");
  return core;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, status: res.status };
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $("title").text().trim();
    const bodyText = $("body").text().replace(/\s+/g, "");
    return { ok: true, title, bodyText };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

async function fetchPageInfo(url) {
  let info = await fetchOnce(url);
  for (let i = 0; i < 2 && (!info.ok || info.title === "HotPepper Beauty　システムエラー" || info.status === 503); i++) {
    await sleep(1500 * (i + 1));
    info = await fetchOnce(url);
  }
  return info;
}

async function checkRow(row) {
  const [name, urlType, status, url] = row.data;
  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };
  if (info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    return { ...row, result: "rate_limited_giveup" };
  }
  const token = extractDistinctiveToken(name);
  const normBody = norm(info.bodyText);
  const strictMatch = token.length >= 2 && normBody.includes(token);
  return { ...row, result: strictMatch ? "strict_match" : "strict_mismatch", token, pageTitle: info.title };
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const list = JSON.parse(fs.readFileSync("bodymatch-only-list.json"));
  const items = list.map((r) => ({ row: r.row, data: r.data }));
  console.log("再検証対象件数:", items.length);

  const results = await runPool(items, 3, checkRow);
  fs.writeFileSync("check2-strict-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("厳密再検証の内訳:", JSON.stringify(counts, null, 1));

  const strictMismatch = results.filter((r) => r.result === "strict_mismatch");
  console.log("\n厳密基準でも不一致(要確認):", strictMismatch.length, "件");
  strictMismatch.forEach((r) => {
    console.log(` 行${r.row} | A列:"${r.data[0]}" | 固有トークン:"${r.token}" | title:"${r.pageTitle}" | URL:${r.data[3]}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
