// 全行について、D列URLへ実際にフェッチし、ページ内の店舗名がA列の店舗名と一致するかを機械的に照合する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function norm(s) {
  return (s || "")
    .replace(/[【】\[\]（）()]/g, "")
    .replace(/\s|　/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
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

async function fetchPageInfo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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
    const bodyText = $("body").text().replace(/\s+/g, "").slice(0, 5000);
    return { ok: true, title, hpbName, bodyText };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

async function checkRow(row) {
  const [name, urlType, status, url] = row.data;
  if (!url) return { ...row, result: "url_empty" };
  if (/rentracks\.jp|fbclid=|liff\.referrer/.test(url)) {
    return { ...row, result: "tracking_link_skip" };
  }
  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };

  const candidates = [info.hpbName, info.title].filter(Boolean);
  let bestSim = 0;
  for (const c of candidates) {
    const s = similarity(name, c);
    if (s > bestSim) bestSim = s;
  }
  // タイトルに一致しなくても本文に店名の核となる部分が含まれるか(タイトルが汎用的な場合の救済)
  const coreToken = norm(name).slice(0, 6);
  const bodyMatch = coreToken.length >= 3 && info.bodyText.includes(coreToken);

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
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const items = rows.map((r, i) => ({ row: i + 3, data: [r[0], r[1], r[2], r[3]] }));
  console.log("対象件数:", items.length);

  const results = await runPool(items, 10, checkRow);
  fs.writeFileSync("check2-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("結果内訳:", JSON.stringify(counts, null, 1));

  const mismatches = results.filter((r) => r.result === "mismatch");
  console.log("\n不一致(要確認):", mismatches.length, "件");
  mismatches.forEach((r) => {
    console.log(` 行${r.row} | A列:"${r.data[0]}" | sim=${r.sim.toFixed(2)} | ページtitle:"${r.pageTitle}" | HPB店名:"${r.hpbName}" | URL:${r.data[3]}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
