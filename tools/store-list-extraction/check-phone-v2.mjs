// 「電話番号」「TEL」ラベルの隣接値・tel:リンクを対象にした、より正確な電話番号抽出で再検証する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function norm(s) {
  return (s || "").replace(/[【】\[\]（）()]/g, "").replace(/\s|　/g, "").toLowerCase();
}
function normalizePhone(s) {
  return (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "");
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
    return { ok: true, html };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

async function fetchPageInfo(url) {
  let info = await fetchOnce(url);
  for (let i = 0; i < 2 && (!info.ok); i++) {
    await sleep(1500 * (i + 1));
    info = await fetchOnce(url);
  }
  if (info.ok) {
    const $ = cheerio.load(info.html);
    const title = $("title").text().trim();
    if (title === "HotPepper Beauty　システムエラー") {
      await sleep(3000);
      info = await fetchOnce(url);
    }
  }
  return info;
}

function extractLabeledPhones($) {
  const found = [];
  // tel:リンク
  $("a[href^='tel:']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const p = normalizePhone(href.replace("tel:", ""));
    if (p.length >= 9 && p.length <= 11) found.push(p);
  });
  // ラベル(電話番号/TEL/Tel)の隣接セル
  $("th, dt, td, dd, span, div").each((_, el) => {
    const t = $(el).text().trim();
    if (t === "電話番号" || t === "TEL" || t === "Tel" || t === "電話") {
      const next = $(el).next().text().trim();
      const p = normalizePhone(next);
      if (p.length >= 9 && p.length <= 11) found.push(p);
    }
  });
  return [...new Set(found)];
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

  const $ = cheerio.load(info.html);
  if ($("title").text().trim() === "HotPepper Beauty　システムエラー") {
    return { ...row, result: "rate_limited_giveup" };
  }
  const destPhones = extractLabeledPhones($);
  if (destPhones.length === 0) return { ...row, result: "no_dest_phone_label" };

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

async function main() {
  const fullSheet = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const phoneMap = JSON.parse(fs.readFileSync("phone-map.json"));

  const items = fullSheet.map((r, i) => {
    const rowNum = i + 3;
    const key = norm(r[0]);
    const sourcePhone = phoneMap[key] || "";
    return { row: rowNum, data: [r[0], r[1], r[2], r[3]], sourcePhone };
  });
  console.log("対象件数:", items.length);

  const results = await runPool(items, 4, checkRow);
  fs.writeFileSync("check-phone-v2-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("結果内訳:", JSON.stringify(counts, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
