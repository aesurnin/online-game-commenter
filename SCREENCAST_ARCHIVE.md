# Screencast Module Archive

This module was responsible for recording online game replays using Puppeteer and FFmpeg.

## Core Components
- **Worker (`apps/backend/src/workers/screencast.ts`)**: Used `puppeteer-stream` or Docker (X11 + FFmpeg) to capture browser tabs.
- **Recording Flow**:
  1. Resolved target URL.
  2. Launched Puppeteer with specific viewport (1920x1080).
  3. Injected CSS/JS to hide UI bars and lock scrolling.
  4. Clicked Play button (via ID or text fallback).
  5. Streamed video/audio to FFmpeg.
  6. Encoded to MP4 and uploaded to Cloudflare R2 via AWS SDK.
- **Live Preview (`apps/backend/src/lib/live-preview-store.ts`)**: Stored JPEG frames in memory for real-time viewing in the frontend.
- **Queue (`BullMQ`)**: Managed jobs for asynchronous recording.

## Known Challenges (Lessons Learned)
- **Viewport/Cropping**: Chrome's tab capture is often limited to 1080p regardless of viewport size. CSS `zoom` or `transform: scale` were used to fit 1440p design into 1080p frame.
- **Interactions**: Clicks on toggle-style Play buttons needed precise handling via `evaluate` to avoid re-pausing or missing coordinates due to zoom.
- **Network/SSL**: `curl` was unstable for R2 uploads on some systems; native AWS SDK was more reliable.
- **Jerking**: Initial capture frames can be unstable; a "warm-up" period or removal of JS scroll-locks helped stabilize the image.

## Dependencies (To be removed if not used elsewhere)
- `puppeteer`
- `puppeteer-stream`
- `aws-sdk` (S3 client)
- `ffmpeg` (system dependency)
