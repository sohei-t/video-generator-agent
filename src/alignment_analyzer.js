#!/usr/bin/env node
/**
 * alignment_analyzer.js
 *
 * HTMLスライドと台本TXTの対応関係を分析し、動画生成前の品質チェックを行う。
 *
 * Usage:
 *   node src/alignment_analyzer.js --project /path/to/project --all
 *   node src/alignment_analyzer.js --project /path/to/project 01-01_api_wo_5fun_de_taiken
 */

const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { discoverTopics, findTopic, getTopicDir, DEFAULT_LIMIT, LEVEL_LABELS } = require('./topic_sort');

// ── CLI引数パーサー ────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let projectDir = null;
  let all = false;
  let limit = DEFAULT_LIMIT;
  let noLimit = false;
  const baseNames = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectDir = path.resolve(args[++i]);
    } else if (args[i] === '--all') {
      all = true;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--no-limit') {
      noLimit = true;
    } else if (!args[i].startsWith('--')) {
      baseNames.push(args[i]);
    }
  }

  return { projectDir, all, baseNames, limit, noLimit };
}

// ── 定数 ──────────────────────────────────────────
const MARKER = '次のスライドに進んでください。';
const VIEWPORT = { width: 1920, height: 1080 };
const FONT_WAIT_MS = 1500;
const SLIDE_ANIM_MS = 500;

// 判定閾値
const JACCARD_FAIL = 0.15;     // これ未満は MISMATCH_HIGH
const JACCARD_WARN = 0.30;     // 0.15〜0.30 は MISMATCH_LOW
const RATIO_SKEW_LIMIT = 0.25; // 1セグメントが全体の25%超
const MIN_SEGMENT_SEC = 3;     // 推定3秒未満は TOO_SHORT

// 日本語話速（文字/秒）
const CHARS_PER_SEC = 5;

// 日本語助詞フィルタ（キーワード抽出時に除外）
const STOP_WORDS = new Set([
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ',
  'さ', 'ある', 'いる', 'も', 'する', 'から', 'な', 'こと', 'として',
  'い', 'や', 'れる', 'など', 'なっ', 'なり', 'でき', 'これ', 'それ',
  'あり', 'ため', 'この', 'その', 'よう', 'また', 'もの', 'という',
  'あっ', 'よる', 'だっ', 'まし', 'ます', 'です', 'ませ', 'でし',
  'ましょ', 'ください', 'ところ', 'ほう', 'ほど', 'だけ', 'まで',
  'ない', 'なく', 'なか', 'なけれ', 'ここ', 'そこ', 'どう', 'どの',
]);

// ── ユーティリティ ─────────────────────────────────

/** ffprobe で MP3 の再生秒数を取得 */
function getAudioDuration(mp3Path) {
  if (!fs.existsSync(mp3Path)) return null;
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`,
      { encoding: 'utf8' }
    );
    return parseFloat(out.trim());
  } catch {
    return null;
  }
}

/** テキストからキーワードを抽出 */
function extractKeywords(text) {
  const keywords = new Set();

  // CJK文字の2文字以上の連続を抽出
  const cjkPattern = /[\u3400-\u9FFF\uF900-\uFAFF]{2,}/g;
  let match;
  while ((match = cjkPattern.exec(text)) !== null) {
    const word = match[0];
    if (!STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  }

  // カタカナの2文字以上の連続を抽出
  const katakanaPattern = /[\u30A0-\u30FF]{2,}/g;
  while ((match = katakanaPattern.exec(text)) !== null) {
    const word = match[0];
    if (!STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  }

  // ASCII英数字の3文字以上の単語を抽出（小文字化）
  const asciiPattern = /[A-Za-z0-9]{3,}/g;
  while ((match = asciiPattern.exec(text)) !== null) {
    keywords.add(match[0].toLowerCase());
  }

  return keywords;
}

/** Jaccard類似度を算出 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1.0;
  return intersection.size / union.size;
}

/** YAML用に文字列をエスケープ */
function yamlStr(s) {
  if (typeof s !== 'string') return String(s);
  if (/[:\{\}\[\],&*#?|<>=!%@`"'\n]/.test(s) || s.startsWith(' ') || s.endsWith(' ')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** 配列をYAML形式で出力 */
function yamlArray(arr, indent) {
  if (arr.length === 0) return '[]';
  return '[' + arr.map(v => yamlStr(v)).join(', ') + ']';
}

// ── 分析処理 ─────────────────────────────────────

async function analyzeTopic(baseName, browser, contentDir) {
  const htmlPath = path.join(contentDir, `${baseName}.html`);
  const txtPath = path.join(contentDir, `${baseName}.txt`);
  const mp3Path = path.join(contentDir, `${baseName}.mp3`);

  console.log(`  🔍 Analyzing: ${baseName}`);

  // ── 台本をセグメントに分割 ──
  const scriptText = fs.readFileSync(txtPath, 'utf8');
  const segments = scriptText.split(MARKER);
  const txtSegments = segments.length;

  // ── Playwrightでスライドテキスト抽出 ──
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const fileUrl = `file://${htmlPath}`;
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(FONT_WAIT_MS);

  const totalSlides = await page.evaluate(() => window.slideAPI.getTotalSlides());

  const slideTexts = [];
  for (let i = 1; i <= totalSlides; i++) {
    await page.evaluate((n) => window.slideAPI.showSlide(n), i);
    await page.waitForTimeout(SLIDE_ANIM_MS);

    // SVGとscript要素を除去してテキスト抽出
    const text = await page.evaluate(() => {
      const active = document.querySelector('.slide.active');
      if (!active) return '';
      const clone = active.cloneNode(true);
      clone.querySelectorAll('svg, script, style').forEach(el => el.remove());
      return clone.textContent || '';
    });
    slideTexts.push(text.replace(/\s+/g, ' ').trim());
  }

  await context.close();

  // ── 音声時間取得 ──
  const audioDuration = getAudioDuration(mp3Path);

  // ── 構造チェック ──
  const structureMatch = totalSlides === txtSegments;

  // ── 各スライド-セグメント対応チェック ──
  const issues = [];
  const slideAnalysis = [];
  const totalChars = segments.reduce((sum, seg) => sum + seg.replace(/\s+/g, '').length, 0);

  const analysisCount = Math.min(totalSlides, txtSegments);

  for (let i = 0; i < analysisCount; i++) {
    const htmlKw = extractKeywords(slideTexts[i] || '');
    const txtKw = extractKeywords(segments[i] || '');
    const overlap = jaccardSimilarity(htmlKw, txtKw);

    const segChars = segments[i].replace(/\s+/g, '').length;
    const ratio = totalChars > 0 ? segChars / totalChars : 0;
    const estSec = audioDuration ? ratio * audioDuration : segChars / CHARS_PER_SEC;

    let alignment = 'OK';
    if (overlap < JACCARD_FAIL) {
      alignment = 'MISMATCH_HIGH';
      issues.push({
        type: 'MISMATCH_HIGH',
        slide: i + 1,
        detail: `Jaccard ${overlap.toFixed(2)} < ${JACCARD_FAIL}`,
      });
    } else if (overlap < JACCARD_WARN) {
      alignment = 'MISMATCH_LOW';
      issues.push({
        type: 'MISMATCH_LOW',
        slide: i + 1,
        detail: `Jaccard ${overlap.toFixed(2)} < ${JACCARD_WARN}`,
      });
    }

    if (ratio > RATIO_SKEW_LIMIT) {
      issues.push({
        type: 'RATIO_SKEW',
        slide: i + 1,
        detail: `Segment ratio ${(ratio * 100).toFixed(1)}% > ${RATIO_SKEW_LIMIT * 100}%`,
      });
    }

    if (estSec < MIN_SEGMENT_SEC) {
      issues.push({
        type: 'TOO_SHORT',
        slide: i + 1,
        detail: `Estimated ${estSec.toFixed(1)}s < ${MIN_SEGMENT_SEC}s`,
      });
    }

    slideAnalysis.push({
      index: i + 1,
      html_keywords: [...htmlKw].slice(0, 10),
      txt_keywords: [...txtKw].slice(0, 10),
      overlap: parseFloat(overlap.toFixed(2)),
      alignment,
      timing: {
        chars: segChars,
        ratio: parseFloat(ratio.toFixed(3)),
        sec: parseFloat(estSec.toFixed(1)),
      },
    });
  }

  if (!structureMatch) {
    issues.unshift({
      type: 'STRUCTURE_MISMATCH',
      slide: 0,
      detail: `HTML has ${totalSlides} slides but TXT has ${txtSegments} segments`,
    });
  }

  // ── 総合判定 ──
  let status = 'PASS';
  if (issues.some(i => i.type === 'STRUCTURE_MISMATCH')) {
    status = 'FAIL';
  } else if (issues.length > 0) {
    status = 'WARN';
  }

  return {
    base_name: baseName,
    status,
    structure: {
      html_slides: totalSlides,
      txt_segments: txtSegments,
      match: structureMatch,
    },
    audio_duration_sec: audioDuration ? parseFloat(audioDuration.toFixed(1)) : null,
    slides: slideAnalysis,
    issues,
  };
}

// ── YAML出力 ─────────────────────────────────────

function generateYaml(results) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;

  let yaml = '';
  yaml += `generated_at: "${now}"\n`;
  yaml += `summary:\n`;
  yaml += `  total: ${results.length}\n`;
  yaml += `  pass: ${passCount}\n`;
  yaml += `  warn: ${warnCount}\n`;
  yaml += `  fail: ${failCount}\n`;
  yaml += `topics:\n`;

  for (const r of results) {
    yaml += `  - base_name: ${yamlStr(r.base_name)}\n`;
    yaml += `    status: ${yamlStr(r.status)}\n`;
    yaml += `    structure:\n`;
    yaml += `      html_slides: ${r.structure.html_slides}\n`;
    yaml += `      txt_segments: ${r.structure.txt_segments}\n`;
    yaml += `      match: ${r.structure.match}\n`;
    yaml += `    audio_duration_sec: ${r.audio_duration_sec ?? 'null'}\n`;
    yaml += `    slides:\n`;

    for (const s of r.slides) {
      yaml += `      - index: ${s.index}\n`;
      yaml += `        html_keywords: ${yamlArray(s.html_keywords)}\n`;
      yaml += `        txt_keywords: ${yamlArray(s.txt_keywords)}\n`;
      yaml += `        overlap: ${s.overlap}\n`;
      yaml += `        alignment: ${yamlStr(s.alignment)}\n`;
      yaml += `        timing:\n`;
      yaml += `          chars: ${s.timing.chars}\n`;
      yaml += `          ratio: ${s.timing.ratio}\n`;
      yaml += `          sec: ${s.timing.sec}\n`;
    }

    yaml += `    issues:\n`;
    if (r.issues.length === 0) {
      yaml += `      []\n`;
    } else {
      for (const issue of r.issues) {
        yaml += `      - type: ${yamlStr(issue.type)}\n`;
        yaml += `        slide: ${issue.slide}\n`;
        yaml += `        detail: ${yamlStr(issue.detail)}\n`;
      }
    }
  }

  return yaml;
}

// ── CLI エントリポイント ─────────────────────────────

async function main() {
  const { projectDir, all, baseNames, limit, noLimit } = parseArgs();

  if (!projectDir) {
    console.log('Usage:');
    console.log('  node src/alignment_analyzer.js --project /path/to/project --all');
    console.log('  node src/alignment_analyzer.js --project /path/to/project <baseName>');
    console.log('');
    console.log('Options:');
    console.log('  --project <path>  コンテンツプロジェクトのルートパス（必須）');
    console.log('  --all             トピックを分析（デフォルト: 視聴順で先頭5件）');
    console.log('  --limit <N>       分析件数を指定（デフォルト: 5）');
    console.log('  --no-limit        全件分析');
    process.exit(1);
  }

  // ワークスペースが存在すれば自動的にそちらを使用
  const workContent = path.join(projectDir, '.video-work', 'content');
  const directContent = path.join(projectDir, 'content');
  const contentDir = fs.existsSync(workContent) ? workContent : directContent;
  const reportDir = path.join(projectDir, 'reports');
  const usingWorkspace = contentDir === workContent;

  if (!fs.existsSync(contentDir)) {
    console.error(`❌ content/ ディレクトリが見つかりません: ${directContent}`);
    process.exit(1);
  }

  if (!all && baseNames.length === 0) {
    console.log('Usage:');
    console.log('  node src/alignment_analyzer.js --project /path/to/project --all');
    console.log('  node src/alignment_analyzer.js --project /path/to/project <baseName>');
    process.exit(1);
  }

  let targets;
  if (all) {
    const allTopics = discoverTopics(contentDir, { requireMp3: false });
    targets = noLimit ? allTopics : allTopics.slice(0, limit);
    if (!noLimit && allTopics.length > targets.length) {
      console.log(`📋 視聴順で先頭 ${targets.length} / ${allTopics.length} 件を分析 (--no-limit で全件)`);
    }
  } else {
    targets = baseNames.map(name => findTopic(contentDir, name));
  }

  console.log(`🔍 Alignment Analyzer - ${targets.length} topic(s)`);
  console.log(`   Project: ${projectDir}`);
  console.log(`   Content: ${usingWorkspace ? '.video-work/content/ (安全モード)' : 'content/ (直接)'}`);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = LEVEL_LABELS[t.sortKey[0]] || '';
    const sub = t.subfolder ? ` [${t.subfolder}/]` : '';
    console.log(`   ${String(i + 1).padStart(3)}. ${t.baseName}${sub}${label ? ` (${label})` : ''}`);
  }
  console.log('');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const results = [];
    for (const topic of targets) {
      const topicDir = getTopicDir(contentDir, topic);
      try {
        const result = await analyzeTopic(topic.baseName, browser, topicDir);
        results.push(result);

        const icon = result.status === 'PASS' ? '✅' :
                     result.status === 'WARN' ? '⚠️' : '❌';
        console.log(`     ${icon} ${topic.baseName}: ${result.status} (${result.issues.length} issues)`);
      } catch (err) {
        console.error(`     ❌ ${topic.baseName}: ERROR - ${err.message}`);
        results.push({
          base_name: topic.baseName,
          status: 'FAIL',
          structure: { html_slides: 0, txt_segments: 0, match: false },
          audio_duration_sec: null,
          slides: [],
          issues: [{ type: 'ERROR', slide: 0, detail: err.message }],
        });
      }
    }

    await browser.close();
    browser = null;

    // レポート出力
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, 'VIDEO_ALIGNMENT_REPORT.yaml');
    const yaml = generateYaml(results);
    fs.writeFileSync(reportPath, yaml, 'utf8');

    // サマリー出力
    const passCount = results.filter(r => r.status === 'PASS').length;
    const warnCount = results.filter(r => r.status === 'WARN').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    console.log(`\n📊 Summary: ${passCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
    console.log(`📄 Report: ${reportPath}`);

    if (failCount > 0) process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
