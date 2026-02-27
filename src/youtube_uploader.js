#!/usr/bin/env node
/**
 * youtube_uploader.js
 *
 * 生成済みMP4をYouTubeにアップロードする
 *
 * タイトル形式: "研修名_01-01_動画のタイトル"
 *   - 研修名: プロジェクトフォルダ名
 *   - 番号: ファイル名から抽出
 *   - 動画のタイトル: HTMLの<title>タグから抽出
 *
 * Usage:
 *   node src/youtube_uploader.js --project /path/to/project --all
 *   node src/youtube_uploader.js --project /path/to/project 01-01_xxx
 *   node src/youtube_uploader.js --project /path/to/project --all --privacy public
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { execSync } = require('child_process');
const { discoverTopics, findTopic, getTopicDir, DEFAULT_LIMIT, LEVEL_LABELS } = require('./topic_sort');

// ── 定数 ──────────────────────────────────────────
const CLIENT_SECRET_PATH = path.join(
  process.env.HOME, '.config/ai-agents/credentials/youtube/client_secret.json'
);
const TOKEN_PATH = path.join(
  process.env.HOME, '.config/ai-agents/credentials/youtube/token.json'
);
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];
const MARKER = '次のスライドに進んでください。';
const CALLBACK_PORT = 8901;

// ── CLI引数パーサー ────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let projectDir = null;
  let all = false;
  let limit = DEFAULT_LIMIT;
  let noLimit = false;
  let privacy = 'private';
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
    } else if (args[i] === '--privacy' && args[i + 1]) {
      privacy = args[++i];
    } else if (!args[i].startsWith('--')) {
      baseNames.push(args[i]);
    }
  }

  return { projectDir, all, baseNames, limit, noLimit, privacy };
}

// ── OAuth認証 ─────────────────────────────────────

async function authenticate() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(`OAuth クライアントシークレットが見つかりません: ${CLIENT_SECRET_PATH}`);
  }

  const credentials = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;
  const redirect_uri = `http://localhost:${CALLBACK_PORT}`;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  // トークン更新時に自動保存するヘルパー
  function setupTokenRefresh() {
    oauth2Client.on('tokens', (tokens) => {
      let current = {};
      try { current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch {}
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
    });
  }

  // 保存済みトークンがあれば使用
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);
    setupTokenRefresh();
    return oauth2Client;
  }

  // 新規認証フロー: ローカルサーバーでコールバックを受け取る
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.listen(CALLBACK_PORT, () => resolve());
    server.on('error', reject);
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('🔐 ブラウザで認証を行います...');
  try {
    execSync(`open "${authUrl}"`, { stdio: 'ignore' });
  } catch {
    console.log(`以下のURLをブラウザで開いてください:\n${authUrl}`);
  }

  console.log(`   認証コールバックを待機中 (port ${CALLBACK_PORT})...`);
  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>認証完了</h1><p>このタブを閉じてください。</p>');
        server.close();
        resolve(query.code);
      } else if (query.error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>認証エラー</h1><p>${query.error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${query.error}`));
      }
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // トークンを保存
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('   ✅ 認証トークンを保存しました');

  setupTokenRefresh();
  return oauth2Client;
}

// ── タイトル抽出 ──────────────────────────────────

/** HTMLの<title>タグから動画タイトルを抽出 */
function extractVideoTitle(htmlPath) {
  if (!fs.existsSync(htmlPath)) return null;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<title>(.*?)<\/title>/i);
  if (!match) return null;

  const fullTitle = match[1].trim();
  // "タイトル | 研修名" 形式 → タイトル部分を返す
  const parts = fullTitle.split('|');
  return parts[0].trim();
}

/** ファイル名から番号部分を抽出 (01-01, 02-03 等) */
function extractNumber(baseName) {
  const match = baseName.match(/^(\d+-\d+)/);
  return match ? match[1] : baseName;
}

/** YouTube用タイトルを組み立て: "研修名_番号_動画タイトル" */
function buildYouTubeTitle(courseName, baseName, htmlPath) {
  const number = extractNumber(baseName);
  const videoTitle = extractVideoTitle(htmlPath) || baseName;
  return `${courseName}_${number}_${videoTitle}`;
}

// ── 概要文生成 ─────────────────────────────────────

/** TXTから概要文を自動生成 */
function generateDescription(txtPath, courseName, videoTitle) {
  if (!fs.existsSync(txtPath)) return '';

  const scriptText = fs.readFileSync(txtPath, 'utf8');
  const segments = scriptText.split(MARKER);

  // 冒頭セグメントから概要を抽出（最初の3文程度）
  const firstSegment = segments[0].trim();
  const sentences = firstSegment.split(/(?<=[。！？])/);
  const summary = sentences.slice(0, 4).join('').trim();

  // 各セグメントのトピックを抽出（最初の1文）
  const chapters = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].trim();
    if (!seg) continue;
    const firstSentence = seg.split(/(?<=[。！？])/)[0].trim();
    // 30文字以内に切り詰め
    const label = firstSentence.length > 40
      ? firstSentence.substring(0, 40) + '...'
      : firstSentence;
    chapters.push(`${i + 1}. ${label}`);
  }

  const lines = [];
  lines.push(summary);
  lines.push('');
  lines.push(`📚 ${courseName}`);
  lines.push('');
  lines.push('【内容】');
  lines.push(...chapters);
  lines.push('');
  lines.push('#生成AI #AI入門 #ChatGPT');

  return lines.join('\n');
}

// ── 再生リスト ────────────────────────────────────

/** 再生リストを検索し、なければ作成する */
async function findOrCreatePlaylist(youtube, playlistTitle, privacy) {
  // 既存の再生リストを検索
  let nextPageToken;
  do {
    const res = await youtube.playlists.list({
      part: ['snippet'],
      mine: true,
      maxResults: 50,
      pageToken: nextPageToken || undefined,
    });
    for (const item of res.data.items) {
      if (item.snippet.title === playlistTitle) {
        console.log(`   📂 既存の再生リストを使用: ${playlistTitle} (${item.id})`);
        return item.id;
      }
    }
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);

  // なければ新規作成
  const res = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: playlistTitle,
        description: `${playlistTitle} の動画一覧`,
      },
      status: {
        privacyStatus: privacy,
      },
    },
  });
  console.log(`   📂 再生リストを作成: ${playlistTitle} (${res.data.id})`);
  return res.data.id;
}

/** 動画を再生リストに追加 */
async function addToPlaylist(youtube, playlistId, videoId) {
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId,
        },
      },
    },
  });
}

// ── アップロード ──────────────────────────────────

async function uploadVideo(youtube, mp4Path, title, description, privacy) {
  const fileSize = fs.statSync(mp4Path).size;
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);

  console.log(`     📤 Uploading: ${path.basename(mp4Path)} (${sizeMB} MB)`);
  console.log(`     📝 Title: ${title}`);
  console.log(`     🔒 Privacy: ${privacy}`);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: '27', // Education
        defaultLanguage: 'ja',
        defaultAudioLanguage: 'ja',
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(mp4Path),
    },
  });

  return res.data;
}

// ── CLI エントリポイント ─────────────────────────────

async function main() {
  const { projectDir, all, baseNames, limit, noLimit, privacy } = parseArgs();

  if (!projectDir) {
    console.log('Usage:');
    console.log('  node src/youtube_uploader.js --project /path/to/project --all');
    console.log('  node src/youtube_uploader.js --project /path/to/project <baseName>');
    console.log('');
    console.log('Options:');
    console.log('  --project <path>   コンテンツプロジェクトのルートパス（必須）');
    console.log('  --all              動画をアップロード（デフォルト: 視聴順で先頭5件）');
    console.log('  --limit <N>        処理件数を指定（デフォルト: 5）');
    console.log('  --no-limit         全件処理');
    console.log('  --privacy <status> public / unlisted / private（デフォルト: private）');
    process.exit(1);
  }

  // コンテンツディレクトリ（ワークスペース優先）
  const workContent = path.join(projectDir, '.video-work', 'content');
  const directContent = path.join(projectDir, 'content');
  const contentDir = fs.existsSync(workContent) ? workContent : directContent;
  const videoDir = path.join(projectDir, 'videos');
  const usingWorkspace = contentDir === workContent;

  if (!fs.existsSync(videoDir)) {
    console.error('❌ videos/ ディレクトリが見つかりません。先に動画を生成してください。');
    process.exit(1);
  }

  if (!all && baseNames.length === 0) {
    console.log('Usage:');
    console.log('  node src/youtube_uploader.js --project /path/to/project --all');
    console.log('  node src/youtube_uploader.js --project /path/to/project <baseName>');
    process.exit(1);
  }

  // 研修名（プロジェクトフォルダ名）
  const courseName = path.basename(projectDir);

  // 対象トピック
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

  // MP4が存在するトピックのみに絞る
  const uploadTargets = targets.filter(t => {
    const mp4Path = path.join(videoDir, `${t.baseName}.mp4`);
    return fs.existsSync(mp4Path);
  });

  if (uploadTargets.length === 0) {
    console.log('⚠️  アップロード対象の動画がありません。先に動画を生成してください。');
    process.exit(1);
  }

  console.log(`📤 YouTube Uploader - ${uploadTargets.length} video(s)`);
  console.log(`   Project: ${projectDir}`);
  console.log(`   Course: ${courseName}`);
  console.log(`   Privacy: ${privacy}`);
  for (let i = 0; i < uploadTargets.length; i++) {
    const t = uploadTargets[i];
    const topicDir = getTopicDir(contentDir, t);
    const htmlPath = path.join(topicDir, `${t.baseName}.html`);
    const title = buildYouTubeTitle(courseName, t.baseName, htmlPath);
    console.log(`   ${String(i + 1).padStart(3)}. ${title}`);
  }
  console.log('');

  // 認証
  console.log('🔐 YouTube APIに認証中...');
  const auth = await authenticate();
  const youtube = google.youtube({ version: 'v3', auth });
  console.log('   ✅ 認証OK\n');

  // 再生リスト（研修名で自動作成/既存を使用）
  console.log('📂 再生リストを準備中...');
  const playlistId = await findOrCreatePlaylist(youtube, courseName, privacy);
  console.log('');

  // アップロード
  let success = 0;
  let failed = 0;

  for (const topic of uploadTargets) {
    const topicDir = getTopicDir(contentDir, topic);
    const mp4Path = path.join(videoDir, `${topic.baseName}.mp4`);
    const htmlPath = path.join(topicDir, `${topic.baseName}.html`);
    const txtPath = path.join(topicDir, `${topic.baseName}.txt`);

    const title = buildYouTubeTitle(courseName, topic.baseName, htmlPath);
    const videoTitle = extractVideoTitle(htmlPath) || topic.baseName;
    const description = generateDescription(txtPath, courseName, videoTitle);

    try {
      const result = await uploadVideo(youtube, mp4Path, title, description, privacy);
      console.log(`     ✅ Uploaded: https://youtu.be/${result.id}`);

      // 再生リストに追加
      try {
        await addToPlaylist(youtube, playlistId, result.id);
        console.log(`     📂 再生リストに追加しました`);
      } catch (plErr) {
        console.warn(`     ⚠️  再生リストへの追加に失敗: ${plErr.message}`);
      }

      success++;
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`     ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary: ${success} uploaded, ${failed} failed`);
  console.log(`📂 Playlist: ${courseName} (${playlistId})`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
