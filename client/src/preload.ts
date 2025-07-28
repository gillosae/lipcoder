import { genTokenAudio } from './audio';
import * as fs from 'fs';
import * as path from 'path';
import * as wav from 'wav';
import * as os from 'os';
import { ExtensionContext } from 'vscode';
import { earconRaw, specialWordCache } from './audio';
import { earconTokens, getTokenSound } from './tokens';
import { specialCharMap } from './mapping';
import { log, logWarning, logMemory } from './utils';

const concurrency = 5;

// Memory usage tracking
let totalPreloadedMemory = 0;
const MAX_PRELOAD_MEMORY_MB = 20; // Limit preloading to 20MB

/**
 * Log current cache memory usage
 */
function logCacheMemory(): void {
    const specialCacheSize = Object.values(specialWordCache).reduce((total, item) => total + item.pcm.length, 0);
    const earconCacheSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
    const totalMB = (specialCacheSize + earconCacheSize) / (1024 * 1024);
    
    logMemory(`[Cache] Special: ${Object.keys(specialWordCache).length} items (${(specialCacheSize / 1024 / 1024).toFixed(2)}MB), Earcons: ${Object.keys(earconRaw).length} items (${(earconCacheSize / 1024 / 1024).toFixed(2)}MB), Total: ${totalMB.toFixed(2)}MB`);
}

/**
 * Clear old cache entries when memory limit is reached
 */
function clearOldCacheEntries(): void {
    const specialCacheSize = Object.values(specialWordCache).reduce((total, item) => total + item.pcm.length, 0);
    const earconCacheSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
    const totalSizeMB = (specialCacheSize + earconCacheSize) / (1024 * 1024);
    
    if (totalSizeMB > MAX_PRELOAD_MEMORY_MB) {
        logWarning(`[Cache] Memory limit exceeded (${totalSizeMB.toFixed(2)}MB > ${MAX_PRELOAD_MEMORY_MB}MB), clearing 50% of cache`);
        
        // Clear half of special word cache
        const specialKeys = Object.keys(specialWordCache);
        const keysToRemove = specialKeys.slice(0, Math.floor(specialKeys.length / 2));
        keysToRemove.forEach(key => delete specialWordCache[key]);
        
        // Clear half of earcon cache  
        const earconKeys = Object.keys(earconRaw);
        const earconKeysToRemove = earconKeys.slice(0, Math.floor(earconKeys.length / 2));
        earconKeysToRemove.forEach(key => delete earconRaw[key]);
        
        logWarning(`[Cache] Cleared ${keysToRemove.length} special words and ${earconKeysToRemove.length} earcons`);
        logCacheMemory();
    }
}

/**
 * Lazy load keywords only when needed instead of preloading all
 */
export async function preloadKeywordWavs(extRoot: string): Promise<void> {
    logWarning('[Preload] Skipping keyword preloading to save memory - using lazy loading instead');
    
    // Only preload a few most common keywords
    const essentialKeywords = ['if', 'for', 'while', 'def', 'class', 'import', 'return'];
    const keywordDirs = ['python', 'typescript'];
    
    let loadedCount = 0;
    
    for (const lang of keywordDirs) {
        const dir = path.join(extRoot, 'client', 'audio', lang);
        
        for (const keyword of essentialKeywords) {
            const pcmPath = path.join(dir, `${keyword}.pcm`);
            if (fs.existsSync(pcmPath)) {
                try {
                    const pcm = fs.readFileSync(pcmPath);
                    const fmt = {
                        channels: 2,      // stereo (from conversion script)
                        sampleRate: 24000, // 24kHz (matches actual audio files)
                        bitDepth: 16,     // 16-bit
                        signed: true,
                        float: false
                    };
                    specialWordCache[keyword] = { format: fmt, pcm };
                    totalPreloadedMemory += pcm.length;
                    loadedCount++;
                    
                    // Check memory limits
                    if (totalPreloadedMemory > MAX_PRELOAD_MEMORY_MB * 1024 * 1024) {
                        logWarning(`[Preload] Memory limit reached, stopping preload at ${loadedCount} keywords`);
                        return;
                    }
                } catch (e) {
                    log(`[keyword preload] Failed loading ${pcmPath}: ${e}`);
                }
            }
        }
    }
    
    logMemory(`[Preload] Loaded ${loadedCount} essential keywords (${(totalPreloadedMemory / 1024 / 1024).toFixed(2)}MB)`);
}

export async function preloadSpecialWords() {
    logWarning('[Preload] Using minimal special word preloading to save memory');
    
    // Only preload the most common special characters
    const essentialChars = [' ', '.', ',', ';', ':', '(', ')', '[', ']', '{', '}', '"', "'"];
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    
    let loadedCount = 0;
    
    for (const char of essentialChars) {
        if (totalPreloadedMemory > MAX_PRELOAD_MEMORY_MB * 1024 * 1024) {
            logWarning(`[Preload] Memory limit reached, stopping special word preload at ${loadedCount} items`);
            break;
        }
        
        const word = specialCharMap[char];
        if (!word) continue;
        
        const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const file = path.join(cacheDir, `text_${sanitized}.pcm`);
        
        if (fs.existsSync(file)) {
            try {
                await new Promise<void>((resolve, reject) => {
                    const reader = new wav.Reader();
                    const bufs: Buffer[] = [];
                    let fmt: any;
                    reader.on('format', f => { fmt = f; });
                    reader.on('data', d => bufs.push(d));
                    reader.on('end', () => {
                        const pcm = Buffer.concat(bufs);
                        specialWordCache[word] = { format: fmt, pcm };
                        totalPreloadedMemory += pcm.length;
                        loadedCount++;
                        resolve();
                    });
                    reader.on('error', reject);
                    fs.createReadStream(file).pipe(reader);
                });
            } catch (e) {
                log(`[preloadSpecialWords] Failed loading ${file}: ${e}`);
            }
        }
    }
    
    logMemory(`[Preload] Loaded ${loadedCount} essential special words (${(totalPreloadedMemory / 1024 / 1024).toFixed(2)}MB total)`);
    clearOldCacheEntries();
    logCacheMemory();
}

/**
 * Clean up all preloaded caches
 */
export function cleanupPreloadedCaches(): void {
    const beforeSize = Object.keys(specialWordCache).length + Object.keys(earconRaw).length;
    
    // Clear all caches
    Object.keys(specialWordCache).forEach(key => delete specialWordCache[key]);
    Object.keys(earconRaw).forEach(key => delete earconRaw[key]);
    
    totalPreloadedMemory = 0;
    
    logWarning(`[Preload] Cleared all caches (${beforeSize} items removed)`);
    
    // Clean up TTS cache directory
    try {
        const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            files.forEach(file => {
                try {
                    fs.unlinkSync(path.join(cacheDir, file));
                } catch (err) {
                    // Ignore cleanup errors
                }
            });
            logWarning(`[Preload] Cleaned up ${files.length} TTS cache files`);
        }
    } catch (err) {
        log(`[Preload] Error cleaning TTS cache: ${err}`);
    }
}

export async function preloadEverything(context: ExtensionContext) {
    logWarning('[Preload] Using memory-optimized preloading (lazy loading for earcons)');
    
    // Skip earcon preloading - use lazy loading instead
    // await preloadEarcons(); // DISABLED for memory optimization
    
    log('[DEBUG] Starting minimal special-word TTS preload');
    preloadSpecialWords()
        .then(() => log('[DEBUG] Completed minimal special-word TTS preload'))
        .catch(err => log(`[DEBUG] preloadSpecialWords error: ${err}`));
        
    // Pre-generate TTS for only the most essential word
    try {
        await genTokenAudio('line', 'literal');
        log('[DEBUG] Preloaded TTS for "line"');
    } catch (e) {
        log(`[DEBUG] Failed to preload "line": ${e}`);
    }
    
    // ── 0.2) Preload only essential keywords (memory optimized) ─────────
    await preloadKeywordWavs(context.extensionPath);
    
    logMemory('[Preload] Memory-optimized preloading complete');
}
