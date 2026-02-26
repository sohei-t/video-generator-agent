#!/usr/bin/env node
/**
 * workspace.js
 *
 * 対象プロジェクトの content/ を .video-work/content/ にコピーし、
 * オリジナルを汚さずに動画生成ワークフローを進めるための作業領域を管理する。
 *
 * Usage:
 *   node src/workspace.js --project /path/to/project setup      # 作業コピー作成
 *   node src/workspace.js --project /path/to/project teardown   # 作業領域を削除
 *   node src/workspace.js --project /path/to/project status     # 状態確認
 */

const fs = require('fs');
const path = require('path');

const WORK_DIR_NAME = '.video-work';

function parseArgs() {
  const args = process.argv.slice(2);
  let projectDir = null;
  let command = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectDir = path.resolve(args[++i]);
    } else if (!args[i].startsWith('--')) {
      command = args[i];
    }
  }

  return { projectDir, command };
}

function setup(projectDir) {
  const srcContent = path.join(projectDir, 'content');
  const workDir = path.join(projectDir, WORK_DIR_NAME);
  const workContent = path.join(workDir, 'content');
  const workTmp = path.join(workDir, 'tmp');

  if (!fs.existsSync(srcContent)) {
    console.error(`❌ content/ ディレクトリが見つかりません: ${srcContent}`);
    process.exit(1);
  }

  if (fs.existsSync(workContent)) {
    console.log(`⚠️  作業領域は既に存在します: ${workContent}`);
    console.log('   上書きする場合は先に teardown を実行してください。');
    process.exit(1);
  }

  console.log('📁 作業領域をセットアップ中...');
  console.log(`   元: ${srcContent}`);
  console.log(`   先: ${workContent}`);

  // content/ を .video-work/content/ にコピー
  fs.cpSync(srcContent, workContent, { recursive: true });
  fs.mkdirSync(workTmp, { recursive: true });

  // コピーしたファイル数をカウント
  const files = fs.readdirSync(workContent);
  const htmlCount = files.filter(f => f.endsWith('.html')).length;
  const txtCount = files.filter(f => f.endsWith('.txt')).length;
  const mp3Count = files.filter(f => f.endsWith('.mp3')).length;

  console.log(`\n✅ セットアップ完了`);
  console.log(`   HTML: ${htmlCount} ファイル`);
  console.log(`   TXT:  ${txtCount} ファイル`);
  console.log(`   MP3:  ${mp3Count} ファイル`);
  console.log(`\n📌 これ以降の分析・修正はすべて .video-work/content/ 上で行われます。`);
  console.log(`   オリジナルの content/ は変更されません。`);
}

function teardown(projectDir) {
  const workDir = path.join(projectDir, WORK_DIR_NAME);

  if (!fs.existsSync(workDir)) {
    console.log('ℹ️  作業領域は存在しません。何もしません。');
    return;
  }

  console.log(`🗑️  作業領域を削除中: ${workDir}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log('✅ 削除完了');
}

function status(projectDir) {
  const workDir = path.join(projectDir, WORK_DIR_NAME);
  const workContent = path.join(workDir, 'content');
  const workTmp = path.join(workDir, 'tmp');

  if (!fs.existsSync(workDir)) {
    console.log('📌 作業領域: なし（オリジナル content/ を直接使用）');
    return;
  }

  console.log(`📌 作業領域: ${workDir}`);

  if (fs.existsSync(workContent)) {
    const files = fs.readdirSync(workContent);
    const htmlCount = files.filter(f => f.endsWith('.html')).length;
    const txtCount = files.filter(f => f.endsWith('.txt')).length;
    const mp3Count = files.filter(f => f.endsWith('.mp3')).length;
    console.log(`   content/ — HTML: ${htmlCount}, TXT: ${txtCount}, MP3: ${mp3Count}`);
  }

  if (fs.existsSync(workTmp)) {
    const tmpEntries = fs.readdirSync(workTmp);
    console.log(`   tmp/ — ${tmpEntries.length} エントリ`);
  }
}

// ── CLI ──

const { projectDir, command } = parseArgs();

if (!projectDir || !command) {
  console.log('Usage:');
  console.log('  node src/workspace.js --project /path/to/project setup');
  console.log('  node src/workspace.js --project /path/to/project teardown');
  console.log('  node src/workspace.js --project /path/to/project status');
  process.exit(1);
}

switch (command) {
  case 'setup':
    setup(projectDir);
    break;
  case 'teardown':
    teardown(projectDir);
    break;
  case 'status':
    status(projectDir);
    break;
  default:
    console.error(`❌ 不明なコマンド: ${command}`);
    console.log('   setup / teardown / status のいずれかを指定してください。');
    process.exit(1);
}
