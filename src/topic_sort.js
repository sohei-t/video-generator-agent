/**
 * topic_sort.js
 *
 * コンテンツトピックの発見・ソート共通モジュール
 * publish_service.py の並べ替えルール（レベル→章→話）に準拠
 *
 * ソートキー: (level, chapter, episode, base_name)
 *
 * ファイル名パターン（優先順）:
 *   A: intro-1-1_xxx  → (LEVEL_ORDER[prefix], ch, ep, name)
 *   D: 1-1-1_xxx      → (num1, num2, num3, name)
 *   C: 01-01_xxx      → (subfolder由来level, num1, num2, name)
 *   なし              → (99, 0, 0, name)
 */

const fs = require('fs');
const path = require('path');

// デフォルトの処理件数
const DEFAULT_LIMIT = 5;

// レベル名 → 数値マッピング
const LEVEL_ORDER = {
  intro: 0, introduction: 0, beginner: 0, part1: 0,
  basic: 1, elementary: 1, part2: 1,
  intermediate: 2, part3: 2,
  advanced: 3, part4: 3,
};

// 数値 → 日本語ラベル
const LEVEL_LABELS = {
  0: '入門', 1: '初級', 2: '中級', 3: '上級',
};

/**
 * ファイル名とサブフォルダからソートキーを抽出する
 * @param {string} baseName - 拡張子なしのファイル名
 * @param {string} subfolder - サブフォルダ名（空文字列ならルート直下）
 * @returns {[number, number, number, string]} ソートキータプル
 */
function getTopicSortKey(baseName, subfolder = '') {
  // Pattern A: レベルプレフィックス付き (intro-1-1_greeting, basic_2-3)
  const matchA = baseName.match(/^([a-zA-Z]+)[-_](\d+)[-_](\d+)/);
  if (matchA) {
    const level = LEVEL_ORDER[matchA[1].toLowerCase()] ?? 99;
    return [level, parseInt(matchA[2], 10), parseInt(matchA[3], 10), baseName];
  }

  // Pattern D: 3階層数値 (1-1-1_title, 2-3-1_xxx)
  // 第3数値の直後に英字が続く場合は誤マッチ (例: 18-02_3dsekyua の "3d")
  const matchD = baseName.match(/^(\d+)[-_](\d+)[-_](\d+)(?![a-zA-Z])/);
  if (matchD) {
    return [parseInt(matchD[1], 10), parseInt(matchD[2], 10), parseInt(matchD[3], 10), baseName];
  }

  // Pattern C: 2階層数値 (01-01_title, 03-02_xxx)
  const matchC = baseName.match(/^(\d+)[-_](\d+)/);
  if (matchC) {
    const level = subfolder ? (LEVEL_ORDER[subfolder.toLowerCase()] ?? 99) : 0;
    return [level, parseInt(matchC[1], 10), parseInt(matchC[2], 10), baseName];
  }

  // マッチなし
  return [99, 0, 0, baseName];
}

/**
 * contentDir内の全トピックを発見し、視聴順にソートして返す
 * フラット構造（content/xxx.html）とサブフォルダ構造（content/intro/xxx.html）の両方に対応
 *
 * @param {string} contentDir - コンテンツディレクトリのパス
 * @param {Object} options
 * @param {boolean} options.requireMp3 - MP3必須かどうか（デフォルト: false）
 * @returns {Array<{baseName: string, subfolder: string, sortKey: number[]}>}
 */
function discoverTopics(contentDir, { requireMp3 = false } = {}) {
  const topics = [];

  function scanDir(dir, subfolder) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    const htmlSet = new Set();

    for (const f of files) {
      if (f.endsWith('.html') && f !== 'index.html') {
        htmlSet.add(f.replace('.html', ''));
      }
    }

    for (const base of htmlSet) {
      if (!fs.existsSync(path.join(dir, `${base}.txt`))) continue;
      if (requireMp3 && !fs.existsSync(path.join(dir, `${base}.mp3`))) continue;

      topics.push({
        baseName: base,
        subfolder,
        sortKey: getTopicSortKey(base, subfolder),
      });
    }
  }

  // ルート直下をスキャン
  scanDir(contentDir, '');

  // サブフォルダをスキャン
  const entries = fs.readdirSync(contentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      scanDir(path.join(contentDir, entry.name), entry.name);
    }
  }

  // 視聴順ソート: level → chapter → episode → baseName
  topics.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i];
    }
    return a.sortKey[3].localeCompare(b.sortKey[3]);
  });

  return topics;
}

/**
 * baseName からトピックを検索する（サブフォルダも探索）
 * @param {string} contentDir - コンテンツディレクトリのパス
 * @param {string} baseName - 検索するファイル名（拡張子なし）
 * @returns {{baseName: string, subfolder: string, sortKey: number[]}}
 */
function findTopic(contentDir, baseName) {
  // ルート直下を先にチェック
  if (fs.existsSync(path.join(contentDir, `${baseName}.html`))) {
    return { baseName, subfolder: '', sortKey: getTopicSortKey(baseName, '') };
  }

  // サブフォルダを探索
  const entries = fs.readdirSync(contentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      if (fs.existsSync(path.join(contentDir, entry.name, `${baseName}.html`))) {
        return { baseName, subfolder: entry.name, sortKey: getTopicSortKey(baseName, entry.name) };
      }
    }
  }

  // 見つからない場合（後続の存在チェックに任せる）
  return { baseName, subfolder: '', sortKey: getTopicSortKey(baseName, '') };
}

/**
 * トピックの実際のコンテンツディレクトリパスを取得
 * @param {string} contentDir - ベースのコンテンツディレクトリ
 * @param {{subfolder: string}} topic - トピックオブジェクト
 * @returns {string} 実際のファイルが置かれたディレクトリパス
 */
function getTopicDir(contentDir, topic) {
  return topic.subfolder ? path.join(contentDir, topic.subfolder) : contentDir;
}

module.exports = { DEFAULT_LIMIT, LEVEL_ORDER, LEVEL_LABELS, getTopicSortKey, discoverTopics, findTopic, getTopicDir };
