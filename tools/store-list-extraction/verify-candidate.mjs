// 候補のHPB店舗URLについて、実際にページへアクセスして住所を取得し、
// リスト側の住所(参考)と機械的に照合するスクリプト。
// 「AIの要約文を信用する」のではなく、実データの文字列比較で確認する。
import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// 住所文字列を比較用に正規化(全角/半角・記号ゆれを吸収)
function normalizeAddr(s) {
  return (s || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−―‐]/g, "-")
    .replace(/\s|　/g, "")
    .replace(/丁目/g, "-")
    .replace(/番地?/g, "-")
    .replace(/号/g, "");
}

// 住所の「丁目-番地」等の数字トークン列がどれだけ一致するかで類似度を出す
function addressSimilarity(a, b) {
  const na = normalizeAddr(a);
  const nb = normalizeAddr(b);
  if (!na || !nb) return 0;
  // 市区町村名(最初の10文字程度)が含まれているか
  const cityToken = na.slice(0, 8);
  const cityMatch = nb.includes(cityToken) || na.includes(nb.slice(0, 8));
  // 数字列(番地等)の一致
  const numsA = na.match(/\d+/g) || [];
  const numsB = nb.match(/\d+/g) || [];
  const numMatches = numsA.filter((n) => numsB.includes(n)).length;
  const numScore = numsA.length ? numMatches / numsA.length : 0;
  return { cityMatch, numScore, na, nb };
}

async function fetchHpbAddress(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return { ok: false, status: res.status };
  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $("title").text().trim();
  // ホットペッパーの店舗ページは通常「住所」ラベルの近くに所在地が入る(複数パターンに対応)
  let address = "";
  $("th, dt, td").each((_, el) => {
    const t = $(el).text().trim();
    if (t === "住所" || t === "所在地") {
      const next = $(el).next().text().trim();
      if (next && next.length > address.length) address = next;
    }
  });
  if (!address) {
    // fallback: og:description等から抽出できないか
    const m = html.match(/"address"\s*:\s*"([^"]+)"/);
    if (m) address = m[1];
  }
  return { ok: true, title, address };
}

export async function verifyCandidate(candidateUrl, targetAddress) {
  const info = await fetchHpbAddress(candidateUrl);
  if (!info.ok) return { url: candidateUrl, result: "fetch_failed", status: info.status };
  const sim = addressSimilarity(info.address, targetAddress);
  const confirmed = sim.cityMatch && sim.numScore >= 0.5;
  return {
    url: candidateUrl,
    title: info.title,
    hpbAddress: info.address,
    targetAddress,
    cityMatch: sim.cityMatch,
    numScore: sim.numScore,
    confirmed,
  };
}

// CLI実行: node verify-candidate.mjs <url> <targetAddress>
if (process.argv[2]) {
  const result = await verifyCandidate(process.argv[2], process.argv[3] || "");
  console.log(JSON.stringify(result, null, 2));
}
