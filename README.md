# Video Generator Agent

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![ffmpeg](https://img.shields.io/badge/ffmpeg-Video%20Encoding-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An automated video production pipeline that converts HTML slide decks and MP3 narration audio into YouTube-ready MP4 videos. Designed to run as a Claude Code agent or as standalone CLI tools.

---

## Table of Contents

- [Overview](#overview)
- [Pipeline Phases](#pipeline-phases)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Command Reference](#command-reference)
- [Input Content Specifications](#input-content-specifications)
- [Configuration](#configuration)
- [Quality Validation](#quality-validation)
- [Error Handling](#error-handling)
- [Testing](#testing)
- [License](#license)

---

## Overview

Video Generator Agent automates the entire workflow of producing educational videos from structured content. Given a set of HTML slides, narration scripts (TXT), and pre-recorded audio (MP3), the system:

1. Analyzes alignment between slides and script segments
2. Detects slide transition markers in audio using OpenAI Whisper
3. Captures high-resolution screenshots of each slide via headless Chromium
4. Composites slides and audio into MP4 videos using ffmpeg
5. Validates output quality (codec, resolution, duration)
6. Uploads finished videos to YouTube with auto-generated metadata

```
content/
  01-01_introduction.html   <-- HTML slide deck
  01-01_introduction.txt    <-- Narration script
  01-01_introduction.mp3    <-- Recorded audio
          |
    [ Video Generator Agent ]
          |
videos/
  01-01_introduction.mp4    <-- YouTube-ready video (1920x1080, H.264, AAC)
```

---

## Pipeline Phases

The agent executes a 5-phase pipeline, either autonomously via Claude Code or step-by-step from the command line.

```
Phase 0        Phase 1          Phase 2           Phase 3             Phase 4          Phase 5
Workspace  --> Alignment    --> AI Correction --> Video Generation --> YouTube      --> Cleanup
Setup          Analysis         Loop (max 3x)     + Quality Check     Upload
   |              |                |                   |                  |              |
   v              v                v                   v                  v              v
 Copy content   Slide/script    Fix FAIL/WARN      Whisper timing     OAuth2 auth    Remove
 to safe work   structure       mismatches via      + Playwright       + auto         workspace
 directory      validation      automated edits     capture + ffmpeg   metadata
```

### Phase 0: Workspace Setup

Copies `content/` to `.video-work/content/` to protect original files. All subsequent modifications operate exclusively on the working copy.

### Phase 1: Alignment Analysis

- Opens each HTML file in headless Chromium via Playwright
- Extracts text content from every slide (excluding SVG/script elements)
- Splits narration scripts on slide boundary markers
- Validates structure and content alignment

| Check | Severity | Criteria |
|-------|----------|----------|
| Slide count vs. segment count | FAIL | Mismatch blocks video generation |
| Slide-segment content match | WARN | Jaccard similarity < 0.15 |
| Segment length balance | WARN | Single segment > 25% of total |
| Segment estimated duration | WARN | Estimated < 3 seconds |

### Phase 2: AI Correction Loop (max 3 iterations)

When FAIL or WARN issues are detected, the agent automatically edits the working copy to resolve mismatches, then re-runs analysis until all topics pass or the maximum retry count is reached.

### Phase 3: Video Generation + Quality Validation

1. **Whisper marker detection** -- Locates spoken slide transition cues in the audio to calculate precise timing
2. **Hybrid timing** -- Falls back to character-count ratio interpolation when Whisper detection is incomplete
3. **Slide capture** -- Playwright renders each slide to PNG at 1920x1080
4. **Video encoding** -- ffmpeg composites slide images + MP3 audio into H.264/AAC MP4
5. **Automated validation** -- Verifies duration, codec, resolution, and frame rate

### Phase 4: YouTube Upload

- OAuth 2.0 authentication (browser-based on first run, token auto-refresh thereafter)
- Automatic playlist creation and management (grouped by project name)
- Auto-generated titles and descriptions from HTML `<title>` tags and narration scripts
- Configurable privacy settings (private, unlisted, public)

### Phase 5: Cleanup

Removes the workspace after user confirmation. Modified files can be manually copied back to `content/` before teardown if needed.

---

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js 18+ | Main application runtime |
| Browser Automation | Playwright (Chromium) | Slide rendering and screenshot capture |
| Video Encoding | ffmpeg (libx264, AAC) | MP4 video compositing |
| Speech Recognition | OpenAI Whisper (Python) | Slide transition marker detection |
| Video Upload | YouTube Data API v3 | Automated YouTube publishing |
| AI Agent | Claude Code | Autonomous workflow orchestration |

---

## Prerequisites

- **Node.js** v18 or later
- **ffmpeg** -- `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)
- **Python 3** + **OpenAI Whisper** -- `pip install openai-whisper` (optional, improves timing accuracy)
- **Claude Code** -- Required only for autonomous agent mode

---

## Installation

```bash
git clone https://github.com/sohei-t/video-generator-agent.git
cd video-generator-agent
npm install
npx playwright install chromium
```

For YouTube upload functionality, place your OAuth client secret at:

```
~/.config/ai-agents/credentials/youtube/client_secret.json
```

---

## Usage

### Autonomous Agent Mode (Recommended)

Launch Claude Code in the project directory. The agent will execute all phases automatically.

```bash
cd video-generator-agent
claude
```

Alternatively, double-click `start.command` to launch.

### Command-Line Mode

```bash
# Phase 0: Set up workspace (protects original content)
node src/workspace.js --project /path/to/project setup

# Phase 1: Analyze alignment (default: first 5 topics in viewing order)
node src/alignment_analyzer.js --project /path/to/project --all

# Phase 3: Generate videos
node src/video_generator.js --project /path/to/project --all

# Phase 4: Upload to YouTube
node src/youtube_uploader.js --project /path/to/project --all

# Phase 5: Clean up workspace
node src/workspace.js --project /path/to/project teardown
```

---

## Command Reference

### workspace.js

```bash
node src/workspace.js --project <path> setup      # Create working copy
node src/workspace.js --project <path> status     # Check workspace state
node src/workspace.js --project <path> teardown   # Remove workspace
```

### alignment_analyzer.js

```bash
node src/alignment_analyzer.js --project <path> --all               # First 5 topics (default)
node src/alignment_analyzer.js --project <path> --all --limit 10    # First 10 topics
node src/alignment_analyzer.js --project <path> --all --no-limit    # All topics
node src/alignment_analyzer.js --project <path> <baseName>          # Single topic
```

### video_generator.js

```bash
node src/video_generator.js --project <path> --all                  # First 5 topics (default)
node src/video_generator.js --project <path> --all --no-limit       # All topics
node src/video_generator.js --project <path> <baseName>             # Single topic
node src/video_generator.js --project <path> <baseName> --force     # Force regeneration
```

### youtube_uploader.js

```bash
node src/youtube_uploader.js --project <path> --all                 # Upload first 5 (private)
node src/youtube_uploader.js --project <path> --all --no-limit      # Upload all
node src/youtube_uploader.js --project <path> --all --privacy public  # Set visibility
node src/youtube_uploader.js --project <path> <baseName>            # Single topic
```

---

## Input Content Specifications

### HTML Slides

- Must expose `window.slideAPI` globally:
  - `slideAPI.getTotalSlides()` -- Returns total slide count
  - `slideAPI.showSlide(n)` -- Displays the nth slide
- Each slide must use the `.slide` CSS class
- The active slide must have the `.slide.active` class

### Narration Scripts (TXT)

- Slide boundary marker: the exact string "next slide please" (in Japanese: "next slide ni susunde kudasai")
- Number of segments after splitting on markers must equal the HTML slide count

### Directory Structure

Both flat and subfolder layouts are supported:

```
project/
  content/              # Flat layout
    01-01_topic.html
    01-01_topic.txt
    01-01_topic.mp3
  videos/               # Output (auto-created)
  reports/              # Reports (auto-created)
```

```
project/
  content/              # Subfolder layout
    intro/
      intro-1-1_greeting.html
      intro-1-1_greeting.txt
      intro-1-1_greeting.mp3
    basic/
      ...
  videos/
  reports/
```

---

## Configuration

### Topic Ordering

Topics are automatically sorted in viewing order by: **Level > Chapter > Episode**

| Level Name | Priority | Description |
|-----------|----------|-------------|
| intro, introduction, beginner | 0 | Introductory |
| basic, elementary | 1 | Basic |
| intermediate | 2 | Intermediate |
| advanced | 3 | Advanced |
| (no match) | 99 | Unclassified |

### Output Specifications

| Parameter | Value |
|-----------|-------|
| Resolution | 1920 x 1080 |
| Video Codec | H.264 (libx264) |
| Audio Codec | AAC |
| Frame Rate | 30 fps |
| Container | MP4 |

---

## Quality Validation

After video generation, the pipeline automatically verifies:

- MP4 duration matches MP3 duration within +/- 1 second
- Video codec is H.264
- Audio codec is AAC
- Resolution is 1920x1080
- Frame rate is 30 fps

Manual verification:

```bash
# Check durations
for f in /path/to/project/videos/*.mp4; do
  echo "$(basename $f): $(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f")s"
done

# Check codecs
ffprobe -v quiet -show_streams -of json /path/to/project/videos/01-01_*.mp4 | head -30
```

---

## Error Handling

| Scenario | Resolution |
|----------|-----------|
| Alignment FAIL (structure mismatch) | Edit HTML/TXT to match slide and segment counts, then re-analyze |
| 3 correction attempts exhausted | Skip the failing topic, proceed with remaining |
| ffmpeg error | Check error logs, clear `tmp/` directory, retry with `--force` |
| Playwright capture failure | Inspect HTML for JavaScript errors |
| YouTube auth error (401/403) | Delete `~/.config/ai-agents/credentials/youtube/token.json` and re-authenticate |
| YouTube quota exceeded (403) | Wait until the next day (10,000 units/day limit) |

---

## Testing

```bash
# Run alignment analysis on a test project
node src/alignment_analyzer.js --project /path/to/test-project --all

# Generate a single test video
node src/video_generator.js --project /path/to/test-project test-topic-name

# Verify output
ffprobe -v quiet -show_format -show_streams /path/to/test-project/videos/test-topic-name.mp4
```

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
