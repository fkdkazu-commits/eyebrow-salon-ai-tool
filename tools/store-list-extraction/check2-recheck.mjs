// v1で「システムエラー」「503」「不一致」となった行を、低速・低同時実行数+リトライ+正規化改善で再検証する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function toHalfWidth(s) {
  return (s || "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function norm(s) {
  return toHalfWidth(s || "")
    .replace(/[【】\[\]（）()'’"”“、,。.・\-‐－―]/g, "")
    .replace(/\s|　/g, "")
    .toLowerCase();
}

function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const setA = new Set(na);
  const setB = new Set(nb);
  const inter = [...setA].filter((c) => setB.has(c)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? inter / union : 0;
}

const DYNAMIC_HOSTS = ["instagram.com", "line.me", "linktr.ee", "lit.link"];

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
    let hpbName = "";
    $("th, dt, td").each((_, el) => {
      const t = $(el).text().trim();
      if (t === "サロン名" || t === "店舗名") {
        const next = $(el).next().text().trim();
        if (next) hpbName = next;
      }
    });
    const bodyText = $("body").text().replace(/\s+/g, "").slice(0, 8000);
    return { ok: true, title, hpbName, bodyText };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

async function fetchPageInfo(url) {
  let info = await fetchOnce(url);
  if (!info.ok || info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    await sleep(1500);
    info = await fetchOnce(url);
  }
  if (!info.ok || info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    await sleep(3000);
    info = await fetchOnce(url);
  }
  return info;
}

async function checkRow(row) {
  const [name, urlType, status, url] = row.data;
  if (!url) return { ...row, result: "url_empty" };
  if (/rentracks\.jp|fbclid=|liff\.referrer|google\.com\/url/.test(url)) {
    return { ...row, result: "tracking_link_skip" };
  }
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (DYNAMIC_HOSTS.some((h) => host.includes(h))) {
    return { ...row, result: "dynamic_unverifiable", note: "SNS/リンク集約ページのため本文照合不可" };
  }

  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };
  if (info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    return { ...row, result: "rate_limited_giveup" };
  }

  const candidates = [info.hpbName, info.title].filter(Boolean);
  let bestSim = 0;
  for (const c of candidates) {
    const s = similarity(name, c);
    if (s > bestSim) bestSim = s;
  }
  const coreToken = norm(name).slice(0, 6);
  const bodyMatch = coreToken.length >= 3 && norm(info.bodyText).includes(coreToken);
  // チェーン店公式サイト等、タイトルが会社名で店名を含まない場合の救済:本文に店舗名の核が含まれるか
  const matched = bestSim >= 0.5 || bodyMatch;
  return { ...row, result: matched ? "match" : "mismatch", sim: bestSim, bodyMatch, pageTitle: info.title, hpbName: info.hpbName };
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const targetRows = JSON.parse(fs.readFileSync("check2-recheck-targets.json"));
  const fullSheet = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const items = targetRows.map((rowNum) => {
    const r = fullSheet[rowNum - 3];
    return { row: rowNum, data: [r[0], r[1], r[2], r[3]] };
  });
  console.log("再検証対象件数:", items.length);

  const results = await runPool(items, 3, checkRow);
  fs.writeFileSync("check2-recheck-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("再検証後の内訳:", JSON.stringify(counts, null, 1));

  const mismatches = results.filter((r) => r.result === "mismatch");
  console.log("\n真の不一致(要確認):", mismatches.length, "件");
  mismatches.forEach((r) => {
    console.log(` 行${r.row} | A列:"${r.data[0]}" | sim=${r.sim.toFixed(2)} | title:"${r.pageTitle}" | URL:${r.data[3]}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
