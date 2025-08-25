import { genTokenAudio } from './audio';
import * as fs from 'fs';
import * as path from 'path';
import * as wav from 'wav';
import * as os from 'os';
import { ExtensionContext } from 'vscode';
import { earconRaw } from './audio';
import { earconTokens, getTokenSound } from './tokens';

import { log, logWarning, logMemory } from './utils';

const concurrency = 5;

// Memory usage tracking
let totalPreloadedMemory = 0;
const MAX_PRELOAD_MEMORY_MB = 20; // Limit preloading to 20MB

/**
 * Log current cache memory usage
 */
function logCacheMemory(): void {
    const earconCacheSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
    const totalMB = earconCacheSize / (1024 * 1024);
    
    logMemory(`[Cache] Earcons: ${Object.keys(earconRaw).length} items (${(earconCacheSize / 1024 / 1024).toFixed(2)}MB), Total: ${totalMB.toFixed(2)}MB`);
}

/**
 * Clear old cache entries when memory limit is reached
 */
function clearOldCacheEntries(): void {
    const earconCacheSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
    const totalSizeMB = earconCacheSize / (1024 * 1024);
    
    if (totalSizeMB > MAX_PRELOAD_MEMORY_MB) {
        logWarning(`[Cache] Memory limit exceeded (${totalSizeMB.toFixed(2)}MB > ${MAX_PRELOAD_MEMORY_MB}MB), clearing 50% of earcon cache`);
        
        // Clear half of earcon cache  
        const earconKeys = Object.keys(earconRaw);
        const earconKeysToRemove = earconKeys.slice(0, Math.floor(earconKeys.length / 2));
        earconKeysToRemove.forEach(key => delete earconRaw[key]);
        
        logMemory(`[Cache] Cleared ${earconKeysToRemove.length} earcon cache entries`);
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
                    // No longer caching special characters - using direct TTS inference
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
    logWarning('[Preload] Skipping special word preloading - using direct TTS inference');
    
    // Clean up any existing cached special character files
    try {
        const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            const specialFiles = files.filter(f => f.startsWith('text_') || f.startsWith('special_'));
            for (const file of specialFiles) {
                try {
                    fs.unlinkSync(path.join(cacheDir, file));
                    log(`[preloadSpecialWords] Removed cached special file: ${file}`);
                } catch (err) {
                    // Ignore cleanup errors
                }
            }
            if (specialFiles.length > 0) {
                logWarning(`[preloadSpecialWords] Cleaned up ${specialFiles.length} cached special character files`);
            }
        }
    } catch (err) {
        log(`[preloadSpecialWords] Error cleaning special cache: ${err}`);
    }
    
    // No longer preloading special characters since we use direct TTS inference
    // This function is kept for compatibility but does nothing
    
    logMemory(`[Preload] No special words preloaded - using direct TTS inference`);
}

/**
 * Clean up all preloaded caches
 */
export function cleanupPreloadedCaches(): void {
    const beforeSize = Object.keys(earconRaw).length;
    logWarning(`[Cleanup] Clearing ${beforeSize} cached items`);
    
    // Clear earcon cache only (no special word cache since we use direct TTS)
    Object.keys(earconRaw).forEach(key => delete earconRaw[key]);
    
    const afterSize = Object.keys(earconRaw).length;
    logWarning(`[Cleanup] Cleared ${beforeSize - afterSize} items from cache`);
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
