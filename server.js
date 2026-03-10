const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve yt-dlp binary path
function getYtDlpPath() {
  const candidates = [
    '/Users/tyger/bin/yt-dlp',
    '/Users/tyger/Library/Python/3.9/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'yt-dlp';
}

// Middleware
app.use(cors());
app.use(express.json());

// GET / — serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST /api/info — fetch video metadata
app.post('/api/info', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const ytDlp = getYtDlpPath();
  const browser = req.body.browser || null;
  const args = [
    '--dump-json', '--no-playlist',
    '--extractor-retries', '3',
    '--no-warnings',
  ];
  if (browser && browser !== 'none') {
    args.push('--cookies-from-browser', browser);
  }
  args.push(url);
  const proc = spawn(ytDlp, args);

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({
        error: 'Failed to fetch video info',
        details: stderr.trim()
      });
    }

    try {
      const info = JSON.parse(stdout);

      // Build a clean list of formats with quality labels
      // Add special FB/SD/HD progressive formats first
      const fbProgressiveFormats = (info.formats || [])
        .filter(f => ['sd', 'hd'].includes(f.format_id) && f.url)
        .map(f => ({
          formatId: f.format_id,
          ext: 'mp4',
          quality: f.format_id === 'hd' ? '720p HD' : '480p SD',
          width: null, height: f.format_id === 'hd' ? 720 : 480,
          filesize: null, fps: null,
          vcodec: 'h264', acodec: 'aac'
        }));

      let formats = (info.formats || [])
        // Only H.264 (avc1) — skip VP9/AV1 which don't play in QuickTime
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.url &&
          (f.vcodec.startsWith('avc1') || f.vcodec.startsWith('h264')))
        .map((f) => ({
          formatId: f.format_id,
          ext: f.ext || 'mp4',
          quality: f.format_note || f.quality_label || (f.height ? `${f.height}p` : f.format_id),
          width: f.width || null,
          height: f.height || null,
          filesize: f.filesize || f.filesize_approx || null,
          fps: f.fps || null,
          vcodec: f.vcodec || null,
          acodec: f.acodec || null
        }))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      // Prepend FB progressive H.264 formats (sd/hd) if not already included
      if (fbProgressiveFormats.length > 0) {
        const existingIds = new Set(formats.map(f => f.formatId));
        for (const f of fbProgressiveFormats) {
          if (!existingIds.has(f.formatId)) formats.unshift(f);
        }
      }

      // If no formats found (e.g. Instagram single-format), create one from root info
      if (formats.length === 0) {
        formats = [{
          formatId: info.format_id || 'best',
          ext: info.ext || 'mp4',
          quality: info.format_note || (info.height ? `${info.height}p` : 'Best available'),
          width: info.width || null,
          height: info.height || null,
          filesize: info.filesize || info.filesize_approx || null,
          fps: info.fps || null,
          vcodec: info.vcodec || null,
          acodec: info.acodec || null
        }];
      }

      return res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel,
        webpage_url: info.webpage_url || url,
        formats
      });
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      return res.status(500).json({ error: 'Failed to parse video info' });
    }
  });

  proc.on('error', (err) => {
    console.error('spawn error:', err);
    return res.status(500).json({
      error: 'yt-dlp binary not found or failed to start',
      details: err.message
    });
  });
});

// POST /api/download — download to temp file then stream to client
app.post('/api/download', (req, res) => {
  const { url, formatId } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Force H.264 — avoids VP9 (not supported in QuickTime/many players)
  const format = formatId || 'hd/sd/bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[vcodec^=avc1][ext=mp4]/best[ext=mp4]/best';
  const browser = req.body.browser || null;
  const ytDlp = getYtDlpPath();
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `vdl_${Date.now()}.%(ext)s`);

  const args = [
    '-f', format,
    '--no-playlist',
    '--extractor-retries', '3',
    '--no-warnings',
    '--merge-output-format', 'mp4',
    '-o', tmpFile,
    url
  ];
  // Only add cookies if explicitly requested (Instagram/FB)
  if (browser && browser !== 'none') {
    args.splice(args.indexOf(url), 0, '--cookies-from-browser', browser);
  }

  console.log('Starting download:', url, 'format:', format);
  const proc = spawn(ytDlp, args);

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    stderr += line;
    process.stdout.write(line); // log progress
  });

  proc.on('error', (err) => {
    console.error('spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp failed to start', details: err.message });
    }
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp exit code:', code, stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed', details: stderr.slice(-500) });
      }
      return;
    }

    // Find the actual output file (yt-dlp resolves %(ext)s)
    const base = tmpFile.replace('.%(ext)s', '');
    const possibleExts = ['mp4', 'mkv', 'webm', 'mov', 'avi'];
    let actualFile = null;

    for (const ext of possibleExts) {
      const candidate = `${base}.${ext}`;
      if (fs.existsSync(candidate)) {
        actualFile = candidate;
        break;
      }
    }

    if (!actualFile) {
      return res.status(500).json({ error: 'Downloaded file not found' });
    }

    const stat = fs.statSync(actualFile);
    const ext = path.extname(actualFile).slice(1) || 'mp4';

    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', `video/${ext === 'mkv' ? 'x-matroska' : ext}`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(actualFile);
    stream.pipe(res);

    stream.on('close', () => {
      fs.unlink(actualFile, () => {}); // cleanup temp file
    });
  });

  // Kill yt-dlp only if client disconnects while streaming the response
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('Client disconnected, killing yt-dlp');
      proc.kill();
    }
  });
});

app.listen(PORT, () => {
  console.log(`Video downloader server running on http://localhost:${PORT}`);
  console.log(`yt-dlp binary: ${getYtDlpPath()}`);
});
