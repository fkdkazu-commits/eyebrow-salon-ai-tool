// 名称の単純文字列一致には限界があるため、店舗名の各セグメント(いずれか一つでも本文に含まれるか)と
// 住所の数字/建物名トークンの一致を組み合わせて最終判定する
import * as cheerio from "cheerio";
import fs from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const GENERIC_WORDS = new Set([
  "アイブロウサロン", "メンズ眉毛サロン", "メンズ眉サロン", "メンズ専門", "眉毛専門店", "眉毛サロン",
  "まつげ眉毛サロン", "眉毛の", "eyelash", "eyebrow", "salon", "beauty", "private", "men's", "専門店",
  "サロン", "店", "支店", "本店", "駅前",
]);

function toHalfWidth(s) {
  return (s || "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
function norm(s) {
  return toHalfWidth(s || "").replace(/\s|　/g, "").toLowerCase();
}

// 名称をブラケット・スペース・記号で分割し、意味のあるセグメントに分ける
function splitSegments(name) {
  return (name || "")
    .split(/[【】\[\]（）()・,、\/／~〜\-－]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDistinctiveSegment(seg) {
  const n = norm(seg);
  if (n.length < 2) return false;
  if (GENERIC_WORDS.has(seg.trim())) return false;
  // 「◯◯店」等の支店表記だけのセグメントは除外しないが、それだけで判定根拠にはしない
  return true;
}

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
  const info = await fetchPageInfo(url);
  if (!info.ok) return { ...row, result: "fetch_failed", detail: `status=${info.status}` };
  if (info.title === "HotPepper Beauty　システムエラー" || info.status === 503) {
    return { ...row, result: "rate_limited_giveup" };
  }
  const normBody = norm(info.bodyText);

  // 名称セグメントのいずれかが本文に含まれるか
  const segments = splitSegments(name).filter(isDistinctiveSegment);
  const nameHit = segments.find((seg) => normBody.includes(norm(seg)));

  // 住所の数字トークン(丁目・番地等)が本文に含まれるか
  const normAddr = normalizeAddr(addr || "");
  const numTokens = (normAddr.match(/\d{2,}/g) || []).filter((t, i, a) => a.indexOf(t) === i);
  const addrHits = numTokens.filter((t) => normBody.includes(t));
  const addrMatch = numTokens.length > 0 && addrHits.length / numTokens.length >= 0.5;

  const matched = !!nameHit || addrMatch;
  return {
    ...row,
    result: matched ? "final_match" : "final_mismatch",
    nameHit: nameHit || null,
    addrMatch,
    addrHitRatio: numTokens.length ? `${addrHits.length}/${numTokens.length}` : "住所トークンなし",
    pageTitle: info.title,
  };
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
  const strictResults = JSON.parse(fs.readFileSync("check2-strict-results.json"));
  const target = strictResults.filter((r) => r.result === "strict_mismatch");
  const fullSheet = JSON.parse(fs.readFileSync("full-sheet-snapshot.json"));
  const items = target.map((r) => {
    const sheetRow = fullSheet[r.row - 3];
    return { row: r.row, data: [sheetRow[0], sheetRow[1], sheetRow[2], sheetRow[3], sheetRow[4]] };
  });
  console.log("最終検証対象件数:", items.length);

  const results = await runPool(items, 3, checkRow);
  fs.writeFileSync("check2-final-results.json", JSON.stringify(results, null, 1));

  const counts = {};
  results.forEach((r) => { counts[r.result] = (counts[r.result] || 0) + 1; });
  console.log("最終判定の内訳:", JSON.stringify(counts, null, 1));

  const finalMismatch = results.filter((r) => r.result === "final_mismatch");
  console.log("\n名称セグメントも住所も一致しない、本当に要確認な行:", finalMismatch.length, "件");
  finalMismatch.forEach((r) => {
    console.log(` 行${r.row} | A列:"${r.data[0]}" | 住所:"${r.data[4]}" | title:"${r.pageTitle}" | 住所一致:${r.addrHitRatio} | URL:${r.data[3]}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
