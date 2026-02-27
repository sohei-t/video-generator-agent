# Video Generator Agent

HTMLスライド + MP3音声から YouTube用 MP4動画を自動生成する Claude Code エージェントツールです。

## 特徴

- **自動アライメント分析** — HTMLスライドと台本テキストの対応関係を自動チェックし、不整合を検出
- **Whisperベースのタイミング算出** — 音声中の「次のスライドに進んでください」マーカーを検出し、正確なスライド切替タイミングを実現
- **ハイブリッドタイミング** — Whisper検出が不完全な場合、検出済みアンカーと文字数比率を組み合わせて補間
- **ワークスペース保護** — オリジナルコンテンツを変更せず、作業コピー上で安全に修正・生成
- **視聴順ソート** — レベル（入門→初級→中級→上級）→ 章 → 話の順で自動並べ替え

## 動作イメージ

```
content/
├── 01-01_introduction.html   ← HTMLスライド
├── 01-01_introduction.txt    ← 台本テキスト
└── 01-01_introduction.mp3    ← 解説音声
          ↓
    [ Video Generator Agent ]
          ↓
videos/
└── 01-01_introduction.mp4    ← YouTube用動画（1920x1080, H.264, AAC）
```

## 前提条件

- **Node.js** (v18+)
- **ffmpeg** — `brew install ffmpeg`
- **Python 3** + **Whisper** — `pip install openai-whisper`（タイミング精度向上用、なくても動作可）
- **Claude Code** — エージェントとして実行する場合

## セットアップ

```bash
git clone https://github.com/sohei-t/video-generator-agent.git
cd video-generator-agent
npm install
npx playwright install chromium
```

## 使い方

### Claude Code エージェントとして実行（推奨）

`start.command` をダブルクリック、またはターミナルで:

```bash
cd video-generator-agent
claude
```

Claude Code にプロジェクトパスを伝えると、自動ワークフロー（分析 → 修正 → 動画生成 → 品質検証）を実行します。

### コマンドラインから直接実行

```bash
# 1. ワークスペースセットアップ（オリジナル保護）
node src/workspace.js --project /path/to/project setup

# 2. アライメント分析（デフォルト: 先頭5件）
node src/alignment_analyzer.js --project /path/to/project --all

# 3. 動画生成（デフォルト: 先頭5件）
node src/video_generator.js --project /path/to/project --all

# 4. クリーンアップ
node src/workspace.js --project /path/to/project teardown
```

## 自動ワークフロー

Claude Code エージェントとして実行すると、以下の4フェーズを自動で進行します。

### Phase 0: ワークスペースセットアップ

`content/` を `.video-work/content/` にコピーし、オリジナルを保護します。

### Phase 1: アライメント分析

Playwright で HTML を開き、スライドごとのテキストを抽出。台本 TXT のセグメントと照合して以下をチェック:

| チェック項目 | 判定 | 基準 |
|---|---|---|
| スライド数とセグメント数の一致 | FAIL | 不一致で動画生成不可 |
| スライド-セグメント間の対応 | WARN | Jaccard類似度 < 0.15 で高警告 |
| セグメント文字数バランス | WARN | 1セグメントが全体の25%超 |
| セグメント推定時間 | WARN | 推定3秒未満 |

### Phase 2: AI修正ループ（最大3回）

FAIL/WARN を検出した場合、Claude Code が `.video-work/content/` 内のファイルを修正し、再分析を繰り返します。

### Phase 3: 動画生成 + 品質検証

1. Whisper でマーカーの発話タイムスタンプを検出
2. Playwright で各スライドを PNG キャプチャ
3. ffmpeg でスライド画像 + MP3 → MP4 に合成
4. 再生時間・コーデック・解像度を自動検証

**出力仕様:** 1920x1080 / H.264 / AAC / 30fps

## コマンドリファレンス

### alignment_analyzer.js

```bash
node src/alignment_analyzer.js --project <path> --all            # 先頭5件を分析
node src/alignment_analyzer.js --project <path> --all --limit 10 # 10件を分析
node src/alignment_analyzer.js --project <path> --all --no-limit # 全件分析
node src/alignment_analyzer.js --project <path> <baseName>       # 単一トピック
```

### video_generator.js

```bash
node src/video_generator.js --project <path> --all               # 先頭5件の動画生成
node src/video_generator.js --project <path> --all --no-limit    # 全件生成
node src/video_generator.js --project <path> <baseName>          # 単一トピック
node src/video_generator.js --project <path> <baseName> --force  # 強制再生成
```

### workspace.js

```bash
node src/workspace.js --project <path> setup     # 作業コピー作成
node src/workspace.js --project <path> status    # 状態確認
node src/workspace.js --project <path> teardown  # 作業領域削除
```

## 入力コンテンツの要件

### HTMLスライド

- `window.slideAPI` をグローバルに公開
  - `slideAPI.getTotalSlides()` — 総スライド数を返す
  - `slideAPI.showSlide(n)` — n番目のスライドを表示
- 各スライドは `.slide` クラス、アクティブスライドは `.slide.active`

### 台本テキスト

- スライド境界マーカー: `次のスライドに進んでください。`
- マーカーで分割したセグメント数 = HTMLのスライド数

### ディレクトリ構造

フラット構造とサブフォルダ構造の両方に対応:

```
project/
├── content/           # フラット構造
│   ├── 01-01_xxx.html
│   ├── 01-01_xxx.txt
│   └── 01-01_xxx.mp3
├── videos/            # 動画出力先（自動作成）
└── reports/           # レポート出力先（自動作成）
```

```
project/
├── content/           # サブフォルダ構造
│   ├── intro/
│   │   ├── intro-1-1_greeting.html
│   │   ├── intro-1-1_greeting.txt
│   │   └── intro-1-1_greeting.mp3
│   └── basic/
│       └── ...
├── videos/
└── reports/
```

## 技術スタック

- **Playwright** — Chromium ヘッドレスブラウザでスライドキャプチャ
- **ffmpeg** — concat demuxer + libx264 で動画エンコード
- **OpenAI Whisper** — 音声認識による正確なマーカー検出
- **Node.js** — メインランタイム

## ライセンス

MIT
