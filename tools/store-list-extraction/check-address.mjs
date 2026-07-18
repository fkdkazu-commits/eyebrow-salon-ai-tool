// J列(電話番号)でOKになっていない行を対象に、住所(E列)とURL先ページ本文を照合する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function normalizeAddr(s) {
  return (s || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−―‐]/g, "-")
    .replace(/\s|　/g, "")
    .replace(/丁目/g, "-")
    .replace(/番地?/g, "-")
    .replace(/号/g, "");
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
  const [name, urlType, status, url, addr] = row.data;
  if (!url) return { ...row, result: "url_empty" };
  if (/rentracks\.jp|fbclid=|liff\.referrer|google\.com\/url/.test(url)) {
    return { ...row, result: "tracking_link_skip" };
  }
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (["instagram.com", "line.me", "linktr.ee", "lit.link"].some((h) => host.includes(h))) {
    return { ...row, result: "dynamic_unverifiable" };
  }
  const normAddr = normalizeAddr(addr || "");
  const numTokens = (normAddr.match(/\d{2,}/g) || []).filter((t, i, a) => a.indexOf(t) === i);
  if (numTokens.length === 0) return { ...row, result: "no_addr_token" };

  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };
  if (info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    return { ...row, result: "rate_limited_giveup" };
  }
  const normBody = info.bodyText
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const hits = numTokens.filter((t) => normBody.includes(t));
  const ratio = hits.length / numTokens.length;
  const matched = ratio >= 0.5;
  return { ...row, result: matched ? "addr_match" : "addr_mismatch", ratio: `${hits.length}/${numTokens.length}`, pageTitle: info.title };
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
      if (done % 50 === 0) console.log(`進捗: ${done}/${items.length}`);
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const fullSheet = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const jValues = JSON.parse(fs.readFileSync("phone-j-column-values-ok.json"));

  const targetRows = [];
  jValues.forEach((v, i) => {
    if (v[0] !== "OK") targetRows.push(i + 3);
  });
  console.log("対象件数(J列で未確定):", targetRows.length);

  const items = targetRows.map((rowNum) => {
    const s = fullSheet[rowNum - 3];
    return { row: rowNum, data: [s[0], s[1], s[2], s[3], s[4]] };
  });

  const results = await runPool(items, 4, checkRow);
  fs.writeFileSync("check-address-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("結果内訳:", JSON.stringify(counts, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
