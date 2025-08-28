#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function speakToFile(text, outFile, voice = 'en-us', speed = 175, pitch = 50, amplitude = 100, gap = 0) {
  const args = ['-v', voice, '-s', String(speed), '-p', String(pitch), '-a', String(amplitude), '-g', String(gap), '-w', outFile, text];
  const res = spawnSync('espeak-ng', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`[espeak-ng] Failed for "${text}" → ${outFile}:`, res.stderr || res.stdout);
    return false;
  }
  return true;
}

function wavToPcm(inFile, outFile, sampleRate = 24000, channels = 2) {
  const args = ['-y', '-i', inFile, '-f', 's16le', '-ac', String(channels), '-ar', String(sampleRate), outFile];
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`[ffmpeg] Failed PCM convert ${inFile} → ${outFile}:`, res.stderr || res.stdout);
    return false;
  }
  return true;
}

function basenameNoExt(file) {
  return path.basename(file, path.extname(file));
}

// Optional per-token overrides: { [basename]: { voice, speed, pitch, amplitude, gap } }
function genFromSourceDir(srcDir, dstDir, voice = 'en-us', overrides = {}, options = {}) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(dstDir);
  const entries = fs.readdirSync(srcDir).filter(f => f.endsWith('.pcm') || f.endsWith('.wav'));
  for (const file of entries) {
    const base = basenameNoExt(file);
    const override = overrides[base] || {};
    const phrase = (override.phrase || base).replace(/_/g, ' ');
    const outWav = path.join(dstDir, `${base}.wav`);
    const outPcm = path.join(dstDir, `${base}.pcm`);

    // Decide whether to (re)generate WAV
    const mustRegenWav = options.force || !!override || !fs.existsSync(outWav);
    if ((options.force || override) && fs.existsSync(outWav)) {
      try { fs.unlinkSync(outWav); } catch {}
    }

    if (mustRegenWav) {
      const params = {
        voice: override.voice || voice,
        speed: override.speed ?? 175,
        pitch: override.pitch ?? 50,
        amplitude: override.amplitude ?? 100,
        gap: override.gap ?? 0,
      };
      speakToFile(phrase, outWav, params.voice, params.speed, params.pitch, params.amplitude, params.gap);
    }

    // Always ensure a PCM exists and matches target format
    if (fs.existsSync(outWav)) {
      // Overwrite PCM to ensure consistency with latest WAV/params
      wavToPcm(outWav, outPcm, 24000, 2);
    }
  }
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const audioRoot = path.join(repoRoot, 'client', 'audio');
  
  // Make special-character operators calmer by default
  const SPECIAL_OVERRIDES = {
    // Much lower pitch, slower and softer; use singular phrase
    equals: { phrase: 'equal', voice: 'en-us', pitch: 45, speed: 160, amplitude: 90, gap: 0 },
  };

  // Alphabet
  genFromSourceDir(path.join(audioRoot, 'alphabet_silero'), path.join(audioRoot, 'alphabet_espeak'), 'en-us');
  // Numbers
  genFromSourceDir(path.join(audioRoot, 'number_silero'), path.join(audioRoot, 'number_espeak'), 'en-us');
  // Specials (operator names like greater_than_or_equal)
  genFromSourceDir(path.join(audioRoot, 'special_silero'), path.join(audioRoot, 'special_espeak'), 'en-us', SPECIAL_OVERRIDES);
  // Python keywords (use female voice and force regeneration)
  genFromSourceDir(
    path.join(audioRoot, 'python_silero'),
    path.join(audioRoot, 'python_espeak'),
    'en+f2',
    { pitch: 55, speed: 170, amplitude: 105 },
    { force: true }
  );
  // TypeScript keywords (use female voice and force regeneration)
  genFromSourceDir(
    path.join(audioRoot, 'typescript_silero'),
    path.join(audioRoot, 'typescript_espeak'),
    'en+f2',
    { pitch: 55, speed: 170, amplitude: 105 },
    { force: true }
  );

  console.log('✅ Espeak assets generated (where missing).');
}

main();


