// 全406記事を再取得し、各H3見出しのテキストと、対応するテーブルの「店舗名」セルの値が
// 一致(類似)しているかを検証する監査スクリプト。
// 一致しない場合、ブロックの切り出しロジック自体に問題がある可能性がある。
import * as cheerio from "cheerio";

const WP_BASE = "https://eyebrow-navi.com";

function normalize(s) {
  return (s || "")
    .replace(/[【】\[\]（）()]/g, "")
    .replace(/\s|　/g, "")
    .toLowerCase();
}

// 見出しからテーブル店舗名を除いた「残り」部分を見て、末尾のエリア表記(◯◯区/◯◯丁目等)だけの差分かを判定
function similarity(heading, tableName) {
  const nh = normalize(heading);
  const nt = normalize(tableName);
  if (!nh || !nt) return 0;
  if (nh === nt) return 1;
  if (nh.startsWith(nt) || nt.startsWith(nh)) return 0.9; // 片方がもう片方の接頭辞(エリア表記の付加等)
  if (nh.includes(nt) || nt.includes(nh)) return 0.7;
  // それ以外は文字の重なり具合(Jaccard的な簡易指標)
  const setH = new Set(nh);
  const setT = new Set(nt);
  const inter = [...setH].filter((c) => setT.has(c)).length;
  const union = new Set([...setH, ...setT]).size;
  return union ? inter / union : 0;
}

async function fetchAllPosts() {
  const posts = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${WP_BASE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,link,content`);
    if (!res.ok) break;
    const batch = await res.json();
    if (batch.length === 0) break;
    posts.push(...batch);
    const totalPages = Number(res.headers.get("x-wp-totalpages") || "1");
    if (page >= totalPages) break;
    page++;
  }
  return posts;
}

function parseTableRows($, blockHtml) {
  const $$ = cheerio.load(`<div>${blockHtml}</div>`);
  const map = {};
  $$("table tr").each((_, tr) => {
    const tds = $$(tr).find("td");
    if (tds.length < 2) return;
    const label = $$(tds[0]).text().trim();
    map[label] = $$(tds[1]).text().trim();
  });
  return map;
}

async function main() {
  const posts = await fetchAllPosts();
  console.log(`記事件数: ${posts.length}`);

  const results = [];
  for (const post of posts) {
    const $ = cheerio.load(post.content.rendered);
    $("h3").each((_, el) => {
      const $el = $(el);
      const heading = $el.text().trim();
      if (!heading) return;

      let html = "";
      let sib = $el.next();
      while (sib.length && !["h2", "h3", "h4"].includes(sib.prop("tagName")?.toLowerCase())) {
        html += $.html(sib);
        sib = sib.next();
      }
      const rows = parseTableRows($, html);
      if (!rows["店舗名"]) return; // A-1の対象外(店舗ではない)

      const tableName = rows["店舗名"];
      const sim = similarity(heading, tableName);
      results.push({ articleUrl: post.link, heading, tableName, sim });
    });
  }

  console.log(`検証対象(店舗名テーブルを持つ見出し): ${results.length}件`);
  const buckets = { exact: 0, high: 0, medium: 0, low: 0 };
  for (const r of results) {
    if (r.sim === 1) buckets.exact++;
    else if (r.sim >= 0.7) buckets.high++;
    else if (r.sim >= 0.4) buckets.medium++;
    else buckets.low++;
  }
  console.log("一致度分布:", buckets);

  const lowSim = results.filter((r) => r.sim < 0.4).sort((a, b) => a.sim - b.sim);
  console.log(`\n乖離が大きいもの(sim<0.4): ${lowSim.length}件`);
  lowSim.slice(0, 30).forEach((r) => {
    console.log(`  sim=${r.sim.toFixed(2)} | 見出し="${r.heading}" | テーブル店舗名="${r.tableName}" | ${r.articleUrl}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
