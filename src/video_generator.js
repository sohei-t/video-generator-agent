#!/usr/bin/env node
/**
 * video_generator.js
 *
 * HTMLスライド + MP3音声 → YouTube用MP4動画 自動生成
 *
 * Usage:
 *   node src/video_generator.js --project /path/to/project --all
 *   node src/video_generator.js --project /path/to/project 01-01_api_wo_5fun_de_taiken
 *   node src/video_generator.js --project /path/to/project 01-01_xxx --force
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
  let force = false;
  let all = false;
  let limit = DEFAULT_LIMIT;
  let noLimit = false;
  const baseNames = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectDir = path.resolve(args[++i]);
    } else if (args[i] === '--force') {
      force = true;
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

  return { projectDir, force, all, baseNames, limit, noLimit };
}

// ── 定数 ──────────────────────────────────────────
const MARKER = '次のスライドに進んでください。';
const CAPTURE_VIEWPORT = { width: 1280, height: 720 };
const OUTPUT_RESOLUTION = '1920:1080';
const FONT_WAIT_MS = 1500;  // Google Fonts 読み込み待機
const SLIDE_ANIM_MS = 3000; // スライド表示完了待機（段階的アニメーション対応）

// ── ユーティリティ ─────────────────────────────────

/** ffprobe で MP3 の再生秒数を取得 */
function getAudioDuration(mp3Path) {
  const out = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`,
    { encoding: 'utf8' }
  );
  return parseFloat(out.trim());
}

/** Whisperでマーカー「次のスライドに進んでください」の発話タイムスタンプを検出 */
function detectMarkerTimestamps(mp3Path) {
  const scriptPath = path.join(__dirname, 'detect_markers.py');
  try {
    const out = execSync(
      `python3 "${scriptPath}" "${mp3Path}"`,
      { encoding: 'utf8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const timestamps = JSON.parse(out.trim());
    if (Array.isArray(timestamps) && timestamps.length > 0) {
      return timestamps;
    }
    return null;
  } catch {
    return null;
  }
}

/** 文字数比率によるフォールバック用タイミング算出 */
function calcCharBasedTimings(segments, totalDuration) {
  const markerLen = MARKER.length;
  const charCounts = segments.map((seg, i) => {
    const base = seg.replace(/\s+/g, '').length;
    return i < segments.length - 1 ? base + markerLen : base;
  });
  const totalChars = charCounts.reduce((a, b) => a + b, 0);
  return charCounts.map(c => Math.max((c / totalChars) * totalDuration, 0.5));
}

/**
 * ハイブリッドタイミング算出:
 * Whisperで検出されたマーカーをアンカーポイントとし、
 * 未検出の遷移境界は文字数比率で補間する。
 *
 * 例: 10セグメント(9遷移期待), Whisper8検出の場合
 *   → 8つのWhisperタイムスタンプで音声を9リージョンに分割
 *   → 未検出の1遷移を含むリージョン内だけ文字数比率で分配
 */
function calcHybridTimings(segments, totalDuration, whisperTimestamps) {
  const numSegments = segments.length;
  const numExpected = numSegments - 1; // 期待される遷移数
  const numWhisper = whisperTimestamps.length;

  // セグメントごとの文字数（マーカー長を含む）
  const markerLen = MARKER.length;
  const charCounts = segments.map((seg, i) => {
    const base = seg.replace(/\s+/g, '').length;
    return i < numSegments - 1 ? base + markerLen : base;
  });
  const totalChars = charCounts.reduce((a, b) => a + b, 0);

  // 各期待遷移点の累積文字比率
  const expectedRatios = [];
  let cumChars = 0;
  for (let i = 0; i < numExpected; i++) {
    cumChars += charCounts[i];
    expectedRatios.push(cumChars / totalChars);
  }

  // Whisperタイムスタンプの時間比率
  const whisperRatios = whisperTimestamps.map(t => t / totalDuration);

  // Whisperマーカーと期待マーカーの順序保持アライメント
  const matchedExpected = new Map(); // expectedIdx → whisperTimestamp

  if (numWhisper <= numExpected) {
    // Whisperが少ない/同数: 各Whisperを最適な期待マーカーに割り当て
    let ei = 0;
    for (let wi = 0; wi < numWhisper; wi++) {
      const remainingW = numWhisper - wi - 1;
      const maxEi = numExpected - remainingW - 1;

      let bestEi = ei;
      let bestDist = Math.abs(whisperRatios[wi] - expectedRatios[ei]);
      for (let j = ei + 1; j <= maxEi; j++) {
        const dist = Math.abs(whisperRatios[wi] - expectedRatios[j]);
        if (dist < bestDist) {
          bestDist = dist;
          bestEi = j;
        }
      }
      matchedExpected.set(bestEi, whisperTimestamps[wi]);
      ei = bestEi + 1;
    }
  } else {
    // Whisperが多い: 各期待マーカーを最適なWhisperに割り当て
    let wi = 0;
    for (let ei = 0; ei < numExpected; ei++) {
      const remainingE = numExpected - ei - 1;
      const maxWi = numWhisper - remainingE - 1;

      let bestWi = wi;
      let bestDist = Math.abs(expectedRatios[ei] - whisperRatios[wi]);
      for (let j = wi + 1; j <= maxWi; j++) {
        const dist = Math.abs(expectedRatios[ei] - whisperRatios[j]);
        if (dist < bestDist) {
          bestDist = dist;
          bestWi = j;
        }
      }
      matchedExpected.set(ei, whisperTimestamps[bestWi]);
      wi = bestWi + 1;
    }
  }

  // アンカーポイント構築: {time, segIdx} (segIdx = 次リージョンの先頭セグメント)
  const anchors = [{ time: 0, segIdx: 0 }];
  for (let i = 0; i < numExpected; i++) {
    if (matchedExpected.has(i)) {
      anchors.push({ time: matchedExpected.get(i), segIdx: i + 1 });
    }
  }
  anchors.push({ time: totalDuration, segIdx: numSegments });

  // 各リージョン内で文字数比率によるタイミング配分
  const timings = new Array(numSegments).fill(0);
  for (let r = 0; r < anchors.length - 1; r++) {
    const duration = anchors[r + 1].time - anchors[r].time;
    const firstSeg = anchors[r].segIdx;
    const lastSeg = anchors[r + 1].segIdx - 1;

    let regionChars = 0;
    for (let s = firstSeg; s <= lastSeg; s++) {
      regionChars += charCounts[s];
    }

    for (let s = firstSeg; s <= lastSeg; s++) {
      timings[s] = regionChars > 0
        ? Math.max((charCounts[s] / regionChars) * duration, 0.5)
        : Math.max(duration / (lastSeg - firstSeg + 1), 0.5);
    }
  }

  return timings;
}

/** テキストからスライドごとの表示秒数を算出（Whisperベース改良版） */
function calcTimings(scriptText, totalDuration, mp3Path) {
  const segments = scriptText.split(MARKER);
  const numSlides = segments.length;
  const numTransitions = numSlides - 1;

  // Whisperでマーカーの実際の発話タイムスタンプを取得
  if (mp3Path) {
    console.log('     🎙️  Running Whisper marker detection...');
    const markerTimestamps = detectMarkerTimestamps(mp3Path);

    if (markerTimestamps && markerTimestamps.length === numTransitions) {
      // 完全一致: Whisperタイミングをそのまま使用
      const timings = [];
      for (let i = 0; i < numSlides; i++) {
        const start = i === 0 ? 0 : markerTimestamps[i - 1];
        const end = i === numSlides - 1 ? totalDuration : markerTimestamps[i];
        timings.push(Math.max(end - start, 0.5));
      }

      console.log('     ✨ Using Whisper-based timing (exact marker detection)');
      return timings;
    }

    if (markerTimestamps && markerTimestamps.length > 0) {
      // 部分一致: ハイブリッドタイミング（Whisperアンカー + 文字数補間）
      console.log(`     ⚠️  Whisper detected ${markerTimestamps.length} markers, expected ${numTransitions}`);
      console.log('     🔀 Using hybrid timing (Whisper anchors + character-count interpolation)');
      return calcHybridTimings(segments, totalDuration, markerTimestamps);
    }

    if (markerTimestamps) {
      console.log(`     ⚠️  Whisper markers: 0, expected ${numTransitions}`);
    } else {
      console.log('     ⚠️  Whisper detection failed');
    }
  }

  // フォールバック: 文字数ベース
  console.log('     📝 Using character-count timing (fallback)');
  return calcCharBasedTimings(segments, totalDuration);
}

/** ディレクトリを再帰的に削除 */
function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── メイン処理 ─────────────────────────────────────

async function generateVideo(baseName, { force = false, contentDir, videoDir, tmpDir } = {}) {
  const htmlPath = path.join(contentDir, `${baseName}.html`);
  const txtPath = path.join(contentDir, `${baseName}.txt`);
  const mp3Path = path.join(contentDir, `${baseName}.mp3`);
  const mp4Path = path.join(videoDir, `${baseName}.mp4`);
  const tmpBase = path.join(tmpDir, baseName);

  // ── 入力チェック ──
  const missing = [];
  if (!fs.existsSync(htmlPath)) missing.push(htmlPath);
  if (!fs.existsSync(txtPath)) missing.push(txtPath);
  if (!fs.existsSync(mp3Path)) missing.push(mp3Path);
  if (missing.length > 0) {
    console.log(`⏭️  SKIP ${baseName}: missing ${missing.map(p => path.basename(p)).join(', ')}`);
    return false;
  }

  // ── 既存チェック ──
  if (!force && fs.existsSync(mp4Path)) {
    console.log(`⏭️  SKIP ${baseName}: MP4 already exists (use --force to overwrite)`);
    return false;
  }

  console.log(`\n🎬 Generating: ${baseName}`);

  // ── Step 1: タイミング算出 ──
  console.log('  📐 Step 1: Calculating timings...');
  const scriptText = fs.readFileSync(txtPath, 'utf8');
  const totalDuration = getAudioDuration(mp3Path);
  const timings = calcTimings(scriptText, totalDuration, mp3Path);
  const numSegments = timings.length;

  console.log(`     MP3 duration: ${totalDuration.toFixed(1)}s`);
  console.log(`     Segments: ${numSegments}`);
  console.log(`     Timings: [${timings.map(t => t.toFixed(1) + 's').join(', ')}]`);

  // ── Step 2: スライドキャプチャ ──
  console.log('  📸 Step 2: Capturing slides...');
  fs.mkdirSync(tmpBase, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT });
    const page = await context.newPage();

    const fileUrl = `file://${htmlPath}`;
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(FONT_WAIT_MS);

    // スライド数を検証
    const totalSlides = await page.evaluate(() => window.slideAPI.getTotalSlides());
    if (totalSlides !== numSegments) {
      throw new Error(
        `Slide count mismatch! HTML has ${totalSlides} slides but TXT has ${numSegments} segments. ` +
        `Fix the HTML/TXT alignment for ${baseName}.`
      );
    }
    console.log(`     Slides: ${totalSlides} (matches segments ✓)`);

    // 各スライドをキャプチャ
    for (let i = 1; i <= totalSlides; i++) {
      await page.evaluate((n) => window.slideAPI.showSlide(n), i);
      await page.waitForTimeout(SLIDE_ANIM_MS);
      const imgPath = path.join(tmpBase, `slide_${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: imgPath, type: 'png' });
      process.stdout.write(`     Captured slide ${i}/${totalSlides}\r`);
    }
    console.log(`     Captured all ${totalSlides} slides ✓`);

    await browser.close();
    browser = null;
  } finally {
    if (browser) await browser.close();
  }

  // ── Step 3: ffmpeg 動画合成 ──
  console.log('  🎞️  Step 3: Encoding video...');
  fs.mkdirSync(videoDir, { recursive: true });

  // concat demuxer ファイル生成
  const concatPath = path.join(tmpBase, 'concat.txt');
  let concatContent = '';
  for (let i = 0; i < numSegments; i++) {
    const imgFile = path.join(tmpBase, `slide_${String(i + 1).padStart(3, '0')}.png`);
    concatContent += `file '${imgFile}'\n`;
    concatContent += `duration ${timings[i].toFixed(4)}\n`;
  }
  // ffmpeg concat demuxer: 末尾画像を重複追加（最後のフレームが切れるのを防止）
  const lastImg = path.join(tmpBase, `slide_${String(numSegments).padStart(3, '0')}.png`);
  concatContent += `file '${lastImg}'\n`;
  fs.writeFileSync(concatPath, concatContent);

  // ffmpeg 実行
  const ffmpegCmd = [
    'ffmpeg -y',
    `-f concat -safe 0 -i "${concatPath}"`,
    `-i "${mp3Path}"`,
    `-c:v libx264 -vf "scale=${OUTPUT_RESOLUTION}:flags=lanczos,fps=30,format=yuv420p"`,
    '-preset medium -crf 18',
    '-c:a aac -b:a 192k',
    `-t ${totalDuration.toFixed(4)}`,
    '-shortest -movflags +faststart',
    `"${mp4Path}"`
  ].join(' ');

  try {
    execSync(ffmpegCmd, { stdio: 'pipe', timeout: 300000 });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr?.toString().split('\n').slice(-3).join('\n')}`);
  }

  // ── Step 4: クリーンアップ ──
  rmrf(tmpBase);

  const fileSize = fs.statSync(mp4Path).size;
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  console.log(`  ✅ Done: videos/${baseName}.mp4 (${sizeMB} MB)`);

  return true;
}

// ── CLI エントリポイント ─────────────────────────────

async function main() {
  const { projectDir, force, all, baseNames, limit, noLimit } = parseArgs();

  if (!projectDir) {
    console.log('Usage:');
    console.log('  node src/video_generator.js --project /path/to/project --all');
    console.log('  node src/video_generator.js --project /path/to/project <baseName>');
    console.log('  node src/video_generator.js --project /path/to/project <baseName> --force');
    console.log('');
    console.log('Options:');
    console.log('  --project <path>  コンテンツプロジェクトのルートパス（必須）');
    console.log('  --all             動画を生成（デフォルト: 視聴順で先頭5件）');
    console.log('  --limit <N>       処理件数を指定（デフォルト: 5）');
    console.log('  --no-limit        全件処理');
    console.log('  --force           既存MP4を上書き');
    process.exit(1);
  }

  // ワークスペースが存在すれば自動的にそちらを使用（オリジナル保護）
  const workContent = path.join(projectDir, '.video-work', 'content');
  const directContent = path.join(projectDir, 'content');
  const contentDir = fs.existsSync(workContent) ? workContent : directContent;
  const videoDir = path.join(projectDir, 'videos');
  const usingWorkspace = contentDir === workContent;
  const tmpDir = usingWorkspace
    ? path.join(projectDir, '.video-work', 'tmp')
    : path.join(projectDir, 'tmp');

  if (!fs.existsSync(contentDir)) {
    console.error(`❌ content/ ディレクトリが見つかりません: ${contentDir}`);
    process.exit(1);
  }

  if (!all && baseNames.length === 0) {
    console.log('Usage:');
    console.log('  node src/video_generator.js --project /path/to/project --all');
    console.log('  node src/video_generator.js --project /path/to/project <baseName>');
    process.exit(1);
  }

  let targets;
  if (all) {
    const allTopics = discoverTopics(contentDir, { requireMp3: true });
    targets = noLimit ? allTopics : allTopics.slice(0, limit);
    if (!noLimit && allTopics.length > targets.length) {
      console.log(`📋 視聴順で先頭 ${targets.length} / ${allTopics.length} 件を処理 (--no-limit で全件)`);
    }
  } else {
    targets = baseNames.map(name => findTopic(contentDir, name));
  }

  console.log(`🎬 Video Generator - ${targets.length} topic(s)`);
  console.log(`   Project: ${projectDir}`);
  console.log(`   Content: ${usingWorkspace ? '.video-work/content/ (安全モード)' : 'content/ (直接)'}`);
  console.log(`   Force: ${force}`);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = LEVEL_LABELS[t.sortKey[0]] || '';
    const sub = t.subfolder ? ` [${t.subfolder}/]` : '';
    console.log(`   ${String(i + 1).padStart(3)}. ${t.baseName}${sub}${label ? ` (${label})` : ''}`);
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const topic of targets) {
    const topicDir = getTopicDir(contentDir, topic);
    try {
      const generated = await generateVideo(topic.baseName, { force, contentDir: topicDir, videoDir, tmpDir });
      if (generated) success++;
      else skipped++;
    } catch (err) {
      console.error(`  ❌ FAIL ${topic.baseName}: ${err.message}`);
      // クリーンアップ
      rmrf(path.join(tmpDir, topic.baseName));
      failed++;
    }
  }

  console.log(`\n📊 Summary: ${success} generated, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
