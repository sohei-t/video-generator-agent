# 動画生成エージェント (Video Generator Agent)

## プロジェクト概要

HTMLスライド + MP3音声 → YouTube用MP4動画を自動生成するエージェントツール。
任意のコンテンツプロジェクトのルートパスを指定して使用する。

### 入力

コンテンツプロジェクトのルートパス（`--project` 引数で指定）

フラット構造とサブフォルダ構造の両方に対応:

```
<project>/
├── content/                          # フラット構造
│   ├── 01-01_xxx.html
│   ├── 01-01_xxx.txt
│   └── 01-01_xxx.mp3
├── videos/                           # ← 動画出力先（自動作成）
└── reports/                          # ← レポート出力先（自動作成）
```

```
<project>/
├── content/                          # サブフォルダ構造
│   ├── intro/
│   │   ├── intro-1-1_greeting.html
│   │   ├── intro-1-1_greeting.txt
│   │   └── intro-1-1_greeting.mp3
│   ├── basic/
│   │   ├── basic-1-1_variables.html
│   │   └── ...
│   └── advanced/
│       └── ...
├── videos/
└── reports/
```

### デフォルト動作: 視聴順で先頭5件を処理

`--all` 指定時、**視聴順（レベル→章→話）で先頭5件**のみを処理する。
全件処理するには `--no-limit`、件数を変更するには `--limit N` を指定する。

### 出力

- `<project>/videos/*.mp4` — YouTube用動画ファイル
- `<project>/reports/VIDEO_ALIGNMENT_REPORT.yaml` — アライメント分析レポート

### 前提条件

- Node.js がインストール済み
- ffmpeg がインストール済み（`brew install ffmpeg`）
- Playwright がインストール済み（`npm install`）
- HTMLスライドが `window.slideAPI.getTotalSlides()` / `window.slideAPI.showSlide(n)` を実装していること
- 台本TXTが「次のスライドに進んでください。」をスライド境界マーカーとして使用していること

---

## 🛡️ ワークスペース安全機構（最重要ルール）

**オリジナルの `content/` ディレクトリを直接変更してはならない。**

修正ループ（Phase 2）でHTML/TXTを編集する場合、必ずワークスペースを経由する。

### 仕組み

```
<project>/
├── content/                    # オリジナル（読み取り専用として扱う）
├── .video-work/
│   ├── content/                # ← 作業コピー（修正はここで行う）
│   └── tmp/                    # ← 一時ファイル
├── videos/                     # 動画出力（プロジェクト直下）
└── reports/                    # レポート出力（プロジェクト直下）
```

### ルール

1. **Phase 2（AI修正ループ）に入る前に、必ずワークスペースをセットアップすること**
2. `alignment_analyzer.js` と `video_generator.js` は `.video-work/content/` が存在すればそちらを自動的に使用する
3. **修正対象は `.video-work/content/` 内のファイルのみ。`content/` 直下のファイルを直接編集しない**
4. 全作業完了後、ユーザーに確認してからワークスペースを削除する

### コマンド

```bash
# 作業コピー作成（content/ → .video-work/content/）
node src/workspace.js --project <プロジェクトパス> setup

# 状態確認
node src/workspace.js --project <プロジェクトパス> status

# 作業領域を削除（完了後）
node src/workspace.js --project <プロジェクトパス> teardown
```

### 注意事項

- ワークスペースが既に存在する場合、setup は失敗する（先に teardown が必要）
- `videos/` と `reports/` はプロジェクト直下に出力される（ワークスペース外）
- TXTを修正した場合、音声再生成が必要（ユーザーに通知すること）

---

## トピックの視聴順ソートルール

publish_service.py と同一の並べ替えロジック。ソートキー: `(level, chapter, episode, base_name)`

### レベル順序

| レベル名 | 数値 | 日本語 |
|---|---|---|
| intro, introduction, beginner | 0 | 入門 |
| basic, elementary | 1 | 初級 |
| intermediate | 2 | 中級 |
| advanced | 3 | 上級 |
| （マッチなし） | 99 | — |

### ファイル名パターン（優先順に判定）

1. **Pattern A**: `intro-1-1_xxx`, `basic-2-3_yyy` → `(LEVEL_ORDER[prefix], ch, ep, name)`
2. **Pattern D**: `1-1-1_xxx` → `(num1, num2, num3, name)`
3. **Pattern C**: `01-01_xxx` → `(subfolder由来level, num1, num2, name)`
4. **マッチなし** → `(99, 0, 0, name)`

Pattern C ではサブフォルダ名（intro, basic 等）がレベルとして使われる。

---

## ワークフロー

ユーザーからプロジェクトパスを受け取ったら、以下のフェーズを順番に実行する。
デフォルトでは **視聴順で先頭5件** のみを対象とする。

### Phase 0: ワークスペースセットアップ

```bash
node src/workspace.js --project <プロジェクトパス> setup
```

オリジナルの `content/` を `.video-work/content/` にコピーする。
以降の分析・修正・動画生成はすべてこの作業コピーを対象に行う。

### Phase 1: アライメント分析

```bash
# デフォルト: 視聴順で先頭5件を分析
node src/alignment_analyzer.js --project <プロジェクトパス> --all

# 件数を指定する場合
node src/alignment_analyzer.js --project <プロジェクトパス> --all --limit 10

# 全件分析する場合
node src/alignment_analyzer.js --project <プロジェクトパス> --all --no-limit
```

**分析内容:**
1. Playwrightで各HTMLを開き、各スライドのテキストを抽出（SVG/script除去）
2. TXTを「次のスライドに進んでください。」で分割してセグメント化
3. 構造チェック: スライド数 == セグメント数
4. コンテンツ対応チェック: 各スライド-セグメント間のキーワードJaccard類似度
5. タイミングバランスチェック: セグメント文字数比率の偏り検出

**判定基準:**
- 構造不一致 → FAIL（動画生成不可）
- Jaccard < 0.15 → MISMATCH_HIGH（WARN）
- Jaccard 0.15〜0.30 → MISMATCH_LOW（WARN）
- 1セグメント > 全体の25% → RATIO_SKEW（WARN）
- セグメント推定時間 < 3秒 → TOO_SHORT（WARN）

**レポート確認:**
```bash
cat <プロジェクトパス>/reports/VIDEO_ALIGNMENT_REPORT.yaml
```

### Phase 2: AI修正ループ（最大3回）

レポートにFAIL/WARNがあれば修正する。

⚠️ **修正対象は `.video-work/content/` 内のファイルのみ。オリジナルの `content/` を直接編集しないこと。**

```
for attempt in 1..3:
  1. VIDEO_ALIGNMENT_REPORT.yaml を読む
  2. FAIL トピック:
     - HTMLのスライド数とTXTのセグメント数を一致させる
     - HTML側のスライド追加/削除、またはTXT側のマーカー調整
  3. WARN (MISMATCH_HIGH / MISMATCH_LOW) トピック:
     - 該当スライドの内容と台本の対応を確認
     - 台本のセグメント順序がスライド順序と合っているか確認
     - 必要に応じてTXT内の文言を修正
  4. WARN (RATIO_SKEW) トピック:
     - 長すぎるセグメントを分割（スライドも追加が必要な場合あり）
     - 短すぎるセグメントに説明を追加
  5. WARN (TOO_SHORT) トピック:
     - 該当セグメントの説明を充実させる
  6. TXT変更があった場合 → 音声再生成が必要（ユーザーに通知）
  7. 再分析:
     node src/alignment_analyzer.js --project <プロジェクトパス> --all
  8. 全トピック PASS なら終了、そうでなければ次のループへ
```

### Phase 3: 動画一括生成 + 品質検証

```bash
# デフォルト: 視聴順で先頭5件の動画を生成
node src/video_generator.js --project <プロジェクトパス> --all

# 件数を指定する場合
node src/video_generator.js --project <プロジェクトパス> --all --limit 10

# 全件生成する場合
node src/video_generator.js --project <プロジェクトパス> --all --no-limit

# 個別トピックの生成
node src/video_generator.js --project <プロジェクトパス> 01-01_xxx

# 強制再生成（既存MP4を上書き）
node src/video_generator.js --project <プロジェクトパス> 01-01_xxx --force
```

**品質検証:**

```bash
# 再生時間チェック
for f in <プロジェクトパス>/videos/*.mp4; do
  echo "$(basename $f): $(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f")s"
done

# コーデックチェック
ffprobe -v quiet -show_streams -of json <プロジェクトパス>/videos/01-01_*.mp4 | head -30

# サンプル再生（目視確認）
open <プロジェクトパス>/videos/01-01_*.mp4
```

**検証基準:**
- MP4の再生時間がMP3の再生時間と±1秒以内
- 映像コーデック: H.264 (libx264)
- 音声コーデック: AAC
- 解像度: 1920x1080
- フレームレート: 30fps

### Phase 4: クリーンアップ

動画生成と品質検証が完了したら、ユーザーに確認してからワークスペースを削除する。

```bash
# 作業領域の状態確認
node src/workspace.js --project <プロジェクトパス> status

# ユーザーに確認後、作業領域を削除
node src/workspace.js --project <プロジェクトパス> teardown
```

⚠️ **必ずユーザーの確認を取ってから teardown すること。** 修正したHTML/TXTをオリジナルに反映したい場合は、teardown 前に手動コピーが必要。

---

## コマンドリファレンス

### workspace.js

```bash
# 作業コピー作成
node src/workspace.js --project /path/to/project setup

# 状態確認
node src/workspace.js --project /path/to/project status

# 作業領域削除
node src/workspace.js --project /path/to/project teardown
```

### alignment_analyzer.js

```bash
# 視聴順で先頭5件を分析（デフォルト）
node src/alignment_analyzer.js --project /path/to/project --all

# 件数指定
node src/alignment_analyzer.js --project /path/to/project --all --limit 10

# 全件分析
node src/alignment_analyzer.js --project /path/to/project --all --no-limit

# 単一トピック分析
node src/alignment_analyzer.js --project /path/to/project 01-01_api_wo_5fun_de_taiken
```

### video_generator.js

```bash
# 視聴順で先頭5件の動画を生成（デフォルト）
node src/video_generator.js --project /path/to/project --all

# 件数指定
node src/video_generator.js --project /path/to/project --all --limit 10

# 全件生成
node src/video_generator.js --project /path/to/project --all --no-limit

# 単一トピック動画生成
node src/video_generator.js --project /path/to/project 01-01_api_wo_5fun_de_taiken

# 強制再生成（既存MP4上書き）
node src/video_generator.js --project /path/to/project 01-01_api_wo_5fun_de_taiken --force
```

---

## エラーハンドリング

```yaml
alignment_fail:
  構造不一致(FAIL): HTML/TXTを修正して再分析
  修正3回で解消しない: 該当トピックのみスキップして動画生成

ffmpeg_fail:
  ffmpegエラー: エラーログ確認、tmp/を削除して再実行
  タイムアウト: --force で個別再生成

playwright_fail:
  スライドキャプチャ失敗: HTMLのJSエラーを確認
```

---

## トラブルシューティング

### ffmpegが見つからない
```bash
brew install ffmpeg
ffmpeg -version
```

### Playwrightが動かない
```bash
cd /path/to/video-generator-agent
npm install
npx playwright install chromium
```

### アライメント分析でFAILが出る
```bash
# レポート確認
cat <project>/reports/VIDEO_ALIGNMENT_REPORT.yaml

# スライド数とセグメント数を確認
# HTMLのスライド数: ブラウザで開いてスライド遷移で確認
# TXTのセグメント数: マーカーの出現回数 + 1
grep -c "次のスライドに進んでください" <project>/content/01-01_*.txt
```

### 動画の音ズレが気になる
原因: セグメント文字数の偏りによるタイミング算出のズレ

対策:
1. `node src/alignment_analyzer.js --project <path> --all` でRATIO_SKEWを確認
2. 長すぎるセグメントを分割（台本に「次のスライドに進んでください。」を追加）
3. 対応するHTMLにもスライドを追加
4. 音声を再生成して動画を再生成

### 一時ファイルが残っている
```bash
rm -rf <project>/tmp/
```

---

## 入力コンテンツの仕様

### HTMLスライドの要件

- `window.slideAPI` をグローバルに公開すること
  - `slideAPI.getTotalSlides()`: 総スライド数を返す
  - `slideAPI.showSlide(n)`: n番目のスライドを表示
- 各スライドは `.slide` クラスを持つ要素
- アクティブスライドは `.slide.active` クラス

### 台本TXTの要件

- スライド境界マーカー: `次のスライドに進んでください。`
- マーカーで分割したセグメント数 = HTMLのスライド数と一致すること
- 純粋な話し言葉テキスト（SSMLタグ不要）
