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

// Decode each independent recording before joining it. Concatenating encoded
// buffers/RIFF headers can make a player stop at the first segment.
function concatenateMp3(inputs) {
  if (!Array.isArray(inputs) || !inputs.length)
    return Promise.reject(new Error('No audio segments'));
  if (inputs.length === 1)
    return Promise.resolve({ audio_data: inputs[0], mime_type: 'audio/mpeg' });
  return new Promise((resolve, reject) => {
    const arguments_ = ['-hide_banner', '-loglevel', 'error'];
    for (let index = 0; index < inputs.length; index++) arguments_.push('-i', `pipe:${index + 3}`);
    const filters = inputs.map(
      (_, index) =>
        `[${index}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,asetpts=PTS-STARTPTS[a${index}]`
    );
    filters.push(
      inputs.map((_, index) => `[a${index}]`).join('') + `concat=n=${inputs.length}:v=0:a=1[joined]`
    );
    arguments_.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[joined]',
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
      'pipe:1'
    );
    const child = spawn('ffmpeg', arguments_, {
      stdio: ['ignore', 'pipe', 'ignore', ...inputs.map(() => 'pipe')],
    });
    const chunks = [];
    let bytes = 0,
      settled = false;
    const finish = (failed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) {
        child.kill('SIGKILL');
        reject(new Error('Conclusion audio joining failed'));
      } else resolve({ audio_data: Buffer.concat(chunks, bytes), mime_type: 'audio/mpeg' });
    };
    const timer = setTimeout(() => finish(true), 15000);
    child.on('error', () => finish(true));
    child.stdout.on('error', () => finish(true));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 20_000_000) return finish(true);
      chunks.push(chunk);
    });
    child.on('close', (code) => finish(code !== 0 || !bytes));
    for (const [index, input] of inputs.entries()) {
      child.stdio[index + 3].on('error', () => finish(true));
      child.stdio[index + 3].end(input);
    }
  });
}

module.exports = { encodeMp3, concatenateMp3 };
