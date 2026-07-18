// 全1385行について、記事側の電話番号(phone-map.json)とURL先ページに書かれた電話番号を照合する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function norm(s) {
  return (s || "").replace(/[【】\[\]（）()]/g, "").replace(/\s|　/g, "").toLowerCase();
}

function normalizePhone(s) {
  return (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "");
}

const PHONE_REGEX = /0\d{1,4}[-−ーー\s]?\d{1,4}[-−ーー\s]?\d{3,4}/g;

function extractPhones(text) {
  const matches = text.match(PHONE_REGEX) || [];
  return [...new Set(matches.map(normalizePhone).filter((p) => p.length >= 9 && p.length <= 11))];
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
    const bodyText = $("body").text();
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
  const sourcePhone = row.sourcePhone ? normalizePhone(row.sourcePhone) : "";

  if (!url) return { ...row, result: "url_empty" };
  if (/rentracks\.jp|fbclid=|liff\.referrer|google\.com\/url/.test(url)) {
    return { ...row, result: "tracking_link_skip" };
  }
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (["instagram.com", "line.me", "linktr.ee", "lit.link"].some((h) => host.includes(h))) {
    return { ...row, result: "dynamic_unverifiable" };
  }
  if (!sourcePhone) return { ...row, result: "no_source_phone" };

  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };
  if (info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    return { ...row, result: "rate_limited_giveup" };
  }

  const destPhones = extractPhones(info.bodyText);
  if (destPhones.length === 0) return { ...row, result: "no_dest_phone" };

  const matched = destPhones.includes(sourcePhone);
  return { ...row, result: matched ? "phone_match" : "phone_mismatch", sourcePhone, destPhones };
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      done++;
      if (done % 100 === 0) console.log(`進捗: ${done}/${items.length}`);
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function normName(s) {
  return norm(s);
}

async function main() {
  const fullSheet = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const phoneMap = JSON.parse(fs.readFileSync("phone-map.json"));

  const items = fullSheet.map((r, i) => {
    const rowNum = i + 3;
    const key = normName(r[0]);
    const sourcePhone = phoneMap[key] || "";
    return { row: rowNum, data: [r[0], r[1], r[2], r[3]], sourcePhone };
  });
  console.log("対象件数:", items.length);
  console.log("電話番号ソースあり:", items.filter((i) => i.sourcePhone).length);

  const results = await runPool(items, 4, checkRow);
  fs.writeFileSync("check-phone-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("結果内訳:", JSON.stringify(counts, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
