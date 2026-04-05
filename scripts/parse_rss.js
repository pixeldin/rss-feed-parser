#!/usr/bin/env node
/**
 * RSS 订阅解析脚本 — OpenClaw Skill 入口
 *
 * 用法:
 *   node parse_rss.js <source1> [source2 ...] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                                            [--keywords kw1,kw2] [--output file.json]
 *
 * <source> 可以是本地XML文件、目录、或在线RSS链接(http/https)，支持同时传入多个
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { XMLParser } = require("fast-xml-parser");

// ============ RSS 解析 ============

function unwrapCdata(val) {
  if (val && typeof val === "object" && val.__cdata !== undefined) {
    return String(val.__cdata).trim();
  }
  return val != null ? String(val).trim() : "";
}

function parseRSS(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: "__cdata",
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map((item) => ({
    title: unwrapCdata(item.title),
    link: unwrapCdata(item.link),
    pubDate: unwrapCdata(item.pubDate),
  }));
}

// ============ 过滤 ============

function filterArticles(articles, opts = {}) {
  return articles.filter((a) => {
    if (opts.since || opts.until) {
      const t = new Date(a.pubDate).getTime();
      if (isNaN(t)) return false;
      if (opts.since && t < new Date(opts.since).getTime()) return false;
      if (opts.until && t > new Date(opts.until).getTime()) return false;
    }
    if (opts.keywords && opts.keywords.length > 0) {
      const lower = a.title.toLowerCase();
      if (!opts.keywords.some((kw) => lower.includes(kw.toLowerCase()))) return false;
    }
    return true;
  });
}

// ============ HTTP 获取 ============

/** 修正 URL 中 Base64 padding 的等号数量（最多4个） */
function fixBase64Padding(url) {
  return url.replace(/=+$/, (match) => {
    return match.length > 4 ? "====" : match;
  });
}

function fetchUrlOnce(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Connection": "keep-alive",
    };
    client
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrlOnce(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

/**
 * 带 Base64 padding 容错的 fetch
 * 如果原始 URL 返回 404，自动尝试修正末尾等号数量（0~4个）
 */
async function fetchUrl(url) {
  const fixedUrl = fixBase64Padding(url);
  try {
    return await fetchUrlOnce(fixedUrl);
  } catch (err) {
    if (!err.message.includes("404")) throw err;
    // 404 时尝试不同的 padding
    const base = fixedUrl.replace(/=+$/, "");
    for (const padding of ["====", "===", "==", "=", ""]) {
      const tryUrl = base + padding;
      if (tryUrl === fixedUrl) continue;
      try {
        return await fetchUrlOnce(tryUrl);
      } catch (_) {
        continue;
      }
    }
    throw new Error(`HTTP 404 - 尝试了多种Base64 padding均失败: ${url}`);
  }
}

// ============ 主流程 ============

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const usage = {
      ok: false,
      error: "用法: node parse_rss.js <source1> [source2 ...] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--keywords kw1,kw2] [--output file.json]",
    };
    console.log(JSON.stringify(usage, null, 2));
    process.exit(2);
  }

  // 收集所有 source（非 -- 开头的参数）和可选参数
  // source 支持别名语法：别名@@地址，如 foo@@http://rss1.xml
  const sources = []; // [{ path, alias }]
  let since, until, keywords, output;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    else if (args[i] === "--until" && args[i + 1]) until = args[++i];
    else if (args[i] === "--keywords" && args[i + 1]) keywords = args[++i].split(",");
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
    else if (!args[i].startsWith("--")) {
      // 解析 别名@@地址 格式
      const sepIdx = args[i].indexOf("@@");
      if (sepIdx > 0) {
        sources.push({ alias: args[i].substring(0, sepIdx), path: args[i].substring(sepIdx + 2) });
      } else {
        sources.push({ alias: "", path: args[i] });
      }
    }
  }

  if (sources.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "至少需要提供一个 source" }, null, 2));
    process.exit(2);
  }

  try {
    let allArticles = [];

    for (const { path: source, alias } of sources) {
      if (source.startsWith("http://") || source.startsWith("https://")) {
        // 在线 RSS
        const xml = await fetchUrl(source);
        const articles = parseRSS(xml);
        // 优先用别名，其次用 channel title，最后用域名
        let sourceName = alias;
        if (!sourceName) {
          const parser2 = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata", trimValues: true });
          const doc = parser2.parse(xml);
          sourceName = unwrapCdata(doc?.rss?.channel?.title) || new URL(source).hostname.replace(/\./g, "_");
        }
        articles.forEach((a) => (a.source = sourceName));
        allArticles.push(...articles);
      } else {
        // 本地文件或目录
        const absPath = path.resolve(source);
        if (!fs.existsSync(absPath)) throw new Error(`路径不存在：${absPath}`);

        const files = [];
        if (fs.statSync(absPath).isDirectory()) {
          fs.readdirSync(absPath)
            .filter((f) => f.endsWith(".xml"))
            .forEach((f) => files.push(path.join(absPath, f)));
        } else {
          files.push(absPath);
        }
        if (files.length === 0) throw new Error("目录中未找到任何 .xml 文件");

        for (const file of files) {
          const xml = fs.readFileSync(file, "utf-8");
          const articles = parseRSS(xml);
          const name = alias || path.basename(file, ".xml");
          articles.forEach((a) => (a.source = name));
          allArticles.push(...articles);
        }
      }
    }

    const totalCount = allArticles.length;

    // 过滤
    if (since || until || (keywords && keywords.length > 0)) {
      allArticles = filterArticles(allArticles, { since, until, keywords });
    }

    // 按发布时间降序
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // 写入结果文件
    const sinceTag = since ? since.replace(/-/g, "") : "all";
    const outputFile = output || `result_since_${sinceTag}.json`;
    const outputDir = process.cwd();
    const outputPath = path.resolve(outputDir, outputFile);
    fs.writeFileSync(outputPath, JSON.stringify(allArticles, null, 2), "utf-8");

    // 输出结构化结果供 OpenClaw 读取
    const result = {
      ok: true,
      total: totalCount,
      filtered: allArticles.length,
      outputFile: outputPath,
      articles: allArticles,
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
