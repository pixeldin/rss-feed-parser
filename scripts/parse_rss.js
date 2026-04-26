#!/usr/bin/env node
/**
 * RSS 订阅解析脚本 — OpenClaw Skill 入口
 *
 * 用法:
 *   node parse_rss.js <source1> [source2 ...] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                                            [--keywords kw1,kw2] [--exclude kw1,kw2]
 *                                            [--target 主题名] [--min-length 300] [--output file.json]
 *
 * --target: 指定主题名（对应 target_rules.json 中的 topics 键名），
 *           启用正向关键词匹配，仅保留标题或正文命中主题关键词的文章
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
  return list.map((item) => {
    // 提取正文内容用于字数统计：优先 content:encoded，其次 description
    const rawContent = unwrapCdata(item["content:encoded"]) || unwrapCdata(item.description) || "";
    // 去除HTML标签后计算纯文本长度
    const plainText = rawContent.replace(/<[^>]*>/g, "").replace(/\s+/g, "").trim();
    return {
      title: unwrapCdata(item.title),
      link: unwrapCdata(item.link),
      pubDate: unwrapCdata(item.pubDate),
      contentLength: plainText.length,
      _plainText: plainText, // 内部使用，过滤后移除
    };
  });
}


// ============ 内置过滤规则 ============

function loadFilterRules() {
  const rulesPath = path.resolve(__dirname, "..", "rules", "filter_rules.json");
  if (fs.existsSync(rulesPath)) {
    try {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    } catch (_) {
      return {};
    }
  }
  return {};
}

// ============ 主题正向匹配规则 ============

function loadTargetRules(topicName) {
  const rulesPath = path.resolve(__dirname, "..", "rules", "target_rules.json");
  if (!fs.existsSync(rulesPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    const topic = data.topics && data.topics[topicName];
    if (!topic) {
      const available = data.topics ? Object.keys(data.topics).join(", ") : "无";
      console.error(`[target] 未找到主题 "${topicName}"，可用主题: ${available}`);
      return null;
    }
    return topic;
  } catch (_) {
    return null;
  }
}

// ============ 过滤 ============

function filterArticles(articles, opts = {}) {
  // 加载内置过滤规则
  const rules = loadFilterRules();
  const builtinExcludeTitle = rules.excludeTitle || [];
  const builtinExcludeContent = rules.excludeContent || [];

  // 加载主题正向匹配规则
  const targetTopic = opts.target ? loadTargetRules(opts.target) : null;
  const targetIncludeTitle = targetTopic ? (targetTopic.includeTitle || []) : [];
  const targetIncludeContent = targetTopic ? (targetTopic.includeContent || []) : [];

  return articles.filter((a) => {
    if (opts.since || opts.until) {
      const t = new Date(a.pubDate).getTime();
      if (isNaN(t)) return false;
      if (opts.since && t < new Date(opts.since).getTime()) return false;
      if (opts.until && t > new Date(opts.until).getTime()) return false;
    }

    const titleLower = a.title.toLowerCase();
    const textLower = (a._plainText || "").toLowerCase();

    // 内置规则：标题反向过滤
    if (builtinExcludeTitle.some((kw) => titleLower.includes(kw.toLowerCase()))) return false;
    // 内置规则：正文反向过滤
    if (builtinExcludeContent.some((kw) => textLower.includes(kw.toLowerCase()))) return false;

    // 主题正向匹配：标题或正文必须命中至少一个关键词，否则排除
    if (targetTopic) {
      const titleHit = targetIncludeTitle.some((kw) => titleLower.includes(kw.toLowerCase()));
      const contentHit = targetIncludeContent.some((kw) => textLower.includes(kw.toLowerCase()));
      if (!titleHit && !contentHit) return false;
      // 记录命中的关键词供参考
      a.targetMatched = true;
      const matchedKeywords = [];
      targetIncludeTitle.filter((kw) => titleLower.includes(kw.toLowerCase())).forEach((kw) => matchedKeywords.push(kw));
      targetIncludeContent.filter((kw) => textLower.includes(kw.toLowerCase())).forEach((kw) => {
        if (!matchedKeywords.includes(kw)) matchedKeywords.push(kw);
      });
      a.matchedKeywords = matchedKeywords;
    }

    // 命令行 --keywords：在正文中匹配，命中则标记，不命中不排除
    if (opts.keywords && opts.keywords.length > 0) {
      a.keywordMatched = opts.keywords.some((kw) => textLower.includes(kw.toLowerCase()));
    }
    // 命令行 --exclude：正文中匹配任一关键字则排除
    if (opts.exclude && opts.exclude.length > 0) {
      if (opts.exclude.some((kw) => textLower.includes(kw.toLowerCase()))) return false;
    }
    // 最小字数过滤：正文字数低于阈值则跳过
    if (opts.minLength && a.contentLength < opts.minLength) return false;
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
      error: "用法: node parse_rss.js <source1> [source2 ...] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--keywords kw1,kw2] [--exclude kw1,kw2] [--min-length 300] [--output file.json]",
    };
    console.log(JSON.stringify(usage, null, 2));
    process.exit(2);
  }

  // 收集所有 source（非 -- 开头的参数）和可选参数
  // source 支持别名语法：别名@@地址，如 foo@@http://rss1.xml
  const sources = []; // [{ path, alias }]
  let since, until, keywords, exclude, output, target, minLength = 300;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    else if (args[i] === "--until" && args[i + 1]) until = args[++i];
    else if (args[i] === "--keywords" && args[i + 1]) keywords = args[++i].split(",");
    else if (args[i] === "--exclude" && args[i + 1]) exclude = args[++i].split(",");
    else if (args[i] === "--target" && args[i + 1]) target = args[++i];
    else if (args[i] === "--min-length" && args[i + 1]) minLength = parseInt(args[++i], 10);
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
    const hasFilter = since || until || (keywords && keywords.length > 0) || (exclude && exclude.length > 0) || minLength > 0 || target;
    if (hasFilter) {
      allArticles = filterArticles(allArticles, { since, until, keywords, exclude, minLength, target });
    }

    // 按发布时间降序，keywords命中的排在前面
    allArticles.sort((a, b) => {
      // keywordMatched 优先
      if (a.keywordMatched !== b.keywordMatched) return a.keywordMatched ? -1 : 1;
      // targetMatched 次优先
      if (a.targetMatched !== b.targetMatched) return a.targetMatched ? -1 : 1;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

    // 清理内部字段
    allArticles.forEach((a) => delete a._plainText);

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
      target: target || null,
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
