import { genTokenAudio } from './audio';
import * as fs from 'fs';
import * as path from 'path';
import * as wav from 'wav';
import * as os from 'os';
import { ExtensionContext } from 'vscode';
import { earconRaw, specialWordCache } from './audio';
import { earconTokens, getTokenSound } from './tokens';
import { specialCharMap } from './mapping';
import { log } from './utils';


const concurrency = 5;

export async function preloadKeywordWavs(extRoot: string): Promise<void> {
    const keywordDirs = ['python', 'typescript'];
    for (const lang of keywordDirs) {
        const dir = path.join(extRoot, 'client', 'audio', lang);
        let files: string[];
        try {
            files = await fs.promises.readdir(dir);
        } catch (e) {
            log(`[keyword preload] Failed to read dir ${dir}: ${e}`);
            continue;
        }
        let index = 0;
        async function worker() {
            while (index < files.length) {
                const file = files[index++];
                if (!file.endsWith('.pcm')) continue;
                const token = file.replace(/\.pcm$/, '');
                const pcmPath = path.join(dir, file);
                try {
                    // PCM files are raw data, no parsing needed
                    const pcm = fs.readFileSync(pcmPath);
                    const fmt = {
                        channels: 2,      // stereo (from conversion script)
                        sampleRate: 48000, // 48kHz (matches actual audio files)
                        bitDepth: 16,     // 16-bit
                        signed: true,
                        float: false
                    };
                    specialWordCache[token] = { format: fmt, pcm };
                } catch (e) {
                    log(`[keyword preload] Failed loading ${pcmPath}: ${e}`);
                }
            }
        }
        Array.from({ length: concurrency }).forEach(() => { worker(); });
    }
    log('[keyword preload] Launched batch keyword WAV preloading');
}

export async function preloadEarcons() {
    log("Start preloadEarcons (raw buffers)");
    const start = Date.now();
    for (const token of earconTokens) {
        const file = getTokenSound(token);
        if (!file) {
            console.log(`no "${file}`);
            return Promise.resolve();
        }
        try {
            const buf = fs.readFileSync(file);
            earconRaw[token] = buf;
            log(`  loaded "${token}" (${buf.length} bytes)`);
        } catch (e) {
            log(`  failed to load "${token}": ${e}`);
        }
    }
    const total = Date.now() - start;
    log(`ALL earcons loaded in ${total}ms`);
}

export async function preloadSpecialWords() {
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    const words = Object.values(specialCharMap);
    log(`[preloadSpecialWords] Starting preload of ${words.length} words with concurrency=${concurrency}`);
    const startTotal = Date.now();

    let idx = 0;
    async function worker() {
        while (true) {
            const word = words[idx++];
            if (!word) break;
            const t0 = Date.now();
            const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const file = path.join(cacheDir, `text_${sanitized}.pcm`);
            await new Promise<void>((resolve, reject) => {
                const reader = new wav.Reader();
                const bufs: Buffer[] = [];
                let fmt: any;
                reader.on('format', f => { fmt = f; });
                reader.on('data', d => bufs.push(d));
                reader.on('end', () => {
                    specialWordCache[word] = { format: fmt, pcm: Buffer.concat(bufs) };
                    resolve();
                });
                reader.on('error', reject);
                fs.createReadStream(file).pipe(reader);
            });
            const elapsed = Date.now() - t0;
            log(`[preloadSpecialWords] Loaded "${word}" in ${elapsed}ms`);
        }
    }

    // Kick off workers
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    const totalElapsed = Date.now() - startTotal;
    log(`[preloadSpecialWords] Completed loading all words in ${totalElapsed}ms`);
}

export async function preloadEverything(context: ExtensionContext) {
    await preloadEarcons();
    log('[DEBUG] Starting special-word TTS preload');
    preloadSpecialWords()
        .then(() => log('[DEBUG] Completed special-word TTS preload'))
        .catch(err => log(`[DEBUG] preloadSpecialWords error: ${err}`));
    // Pre-generate TTS for the word 'line'
    try {
        await genTokenAudio('line', 'literal');
        log('[DEBUG] Preloaded TTS for "line"');
    } catch (e) {
        log(`[DEBUG] Failed to preload "line": ${e}`);
    }
    // ── 0.2) Preload Python/TS keyword WAVs in batches (non-blocking) ─────────
    await preloadKeywordWavs(context.extensionPath);
}
