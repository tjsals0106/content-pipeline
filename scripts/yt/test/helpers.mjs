import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VALID = `channel: seonmin_mov
title: "테스트 영상"
description: |
  설명
tags: [a, b]
category_id: "22"
default_language: ko
made_for_kids: false
source:
  type: drive
  drive_file_name: "test.mp4"
publish_week: "2026-W48"
youtube_id: null
uploaded_at: null
published_at: null
`;

export function tmpVideosDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-videos-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
