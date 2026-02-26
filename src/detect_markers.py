#!/usr/bin/env python3
"""
detect_markers.py - Whisperを使用して台本マーカーの発話タイムスタンプを検出

Usage:
    python3 src/detect_markers.py <mp3_path> [--model small]

Output:
    JSON array of transition timestamps (seconds)
    各タイムスタンプは「次のスライドに進んでください。」の発話終了時点

Example:
    python3 src/detect_markers.py content/01-01_xxx.mp3
    # => [35.76, 99.18, 148.50, 205.68, 254.80, 311.24, 360.24]
"""

import whisper
import json
import sys
import os


def detect_marker_timestamps(mp3_path, model_name='small'):
    """MP3音声からスライド遷移マーカーのタイムスタンプを検出"""

    model = whisper.load_model(model_name)
    result = model.transcribe(mp3_path, language='ja', word_timestamps=True)

    transitions = []

    for seg in result['segments']:
        text = seg['text']
        words = seg.get('words', [])

        # マーカーを含まないセグメントはスキップ
        if 'スライド' not in text:
            continue

        if not words:
            continue

        # Whisperはサブワード単位でトークン化する（例: "ス" "ライ" "ド"）ため、
        # 個別トークンではなく、先行トークンの結合テキストでマーカーを判定する。
        # また「進んで」が「するんで」等に誤認識される場合があるため、
        # 「スライド」の存在のみで判定する（十分に特異的な単語）。
        found = False
        for i, w in enumerate(words):
            if 'ください' not in w['word']:
                continue

            # この「ください」の直前8ワードを結合してマーカーパターンを確認
            preceding = ''.join(
                words[j]['word'] for j in range(max(0, i - 8), i)
            )
            if 'スライド' in preceding:
                transitions.append(round(w['end'], 2))
                found = True
                break

        if found:
            continue

    return transitions


def main():
    if len(sys.argv) < 2:
        print('Usage: python3 src/detect_markers.py <mp3_path> [--model small]',
              file=sys.stderr)
        sys.exit(1)

    mp3_path = sys.argv[1]

    # --model オプション
    model_name = 'small'
    for i, arg in enumerate(sys.argv[2:], 2):
        if arg == '--model' and i + 1 < len(sys.argv):
            model_name = sys.argv[i + 1]

    if not os.path.exists(mp3_path):
        print(json.dumps({"error": f"File not found: {mp3_path}"}))
        sys.exit(1)

    timestamps = detect_marker_timestamps(mp3_path, model_name)
    print(json.dumps(timestamps))


if __name__ == '__main__':
    main()
