'use strict';

const { spawn } = require('node:child_process');

// Encode locally: the original Tuấn Anh recording stays the sole narrator.
// Pipe bytes instead of creating files containing a recipient's private speech.
function encodeMp3(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '48k',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(new Error('Call audio encoding failed'));
      } else resolve({ audio_data: Buffer.concat(chunks, size), mime_type: 'audio/mpeg' });
    };
    const timer = setTimeout(() => finish(true), 5000);
    child.on('error', () => finish(true));
    child.stdin.on('error', () => finish(true));
    child.stdout.on('error', () => finish(true));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20_000_000) return finish(true);
      chunks.push(chunk);
    });
    child.on('close', (code) => finish(code !== 0 || size === 0));
    child.stdin.end(input);
  });
}

module.exports = { encodeMp3 };
