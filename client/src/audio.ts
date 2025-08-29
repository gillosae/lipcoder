import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as wav from 'wav';
// import Speaker from 'speaker'; // Dynamically loaded to avoid extension host issues
import { spawn, ChildProcess } from 'child_process';

// Dynamic Speaker loading to avoid extension host issues
let Speaker: any = null;
try {
    Speaker = require('speaker');
} catch (err) {
    logError(`[Audio] Failed to load speaker module: ${err}`);
    // Create a dummy Speaker class that does nothing
    Speaker = class DummySpeaker {
        constructor(options: any) {
            logWarning('[Audio] Using dummy speaker - no audio output');
        }
        on(event: string, callback: Function) {
            if (event === 'close') {
                setTimeout(callback, 10); // Simulate immediate close
            }
        }
        write(data: any) {
            // Do nothing
        }
        end() {
            // Do nothing
        }
    };
}
import { Readable } from 'stream';
import { log, logWarning, logInfo, logError, logSuccess } from './utils';
import { config, sileroConfig, openaiTTSConfig } from './config';
import { isAlphabet, isNumber, getSpecialCharSpoken, isEarcon } from './mapping';
import { logTTSStart, logAudioEvent } from './activity_logger';

// Import from the new modules
import { playEarcon, stopEarconPlayback, isEarconToken, findTokenSound, earconRaw } from './earcon';
import { genTokenAudio, playSpecial, isTTSRequired, getSpeakerForCategory } from './tts';

// Import word logic for universal application
import { splitWordChunks, splitCommentChunks } from './features/word_logic';

// Import language detection for Korean optimization
import { containsKorean } from './language_detection';

// Re-export functions that other modules expect from audio.ts
export { genTokenAudio, playSpecial } from './tts';
export { playEarcon, earconRaw } from './earcon';

// Track active GPT TTS requests to prevent delayed responses
export let activeGPTTTSController: AbortController | null = null;
let lastGPTTTSTime = 0;

// Function to stop GPT TTS controller from external modules
export function stopGPTTTS(): void {
    if (activeGPTTTSController) {
        console.log('[stopGPTTTS] Aborting active GPT TTS controller');
        activeGPTTTSController.abort();
        activeGPTTTSController = null;
    }
}

// ===============================
// PITCH-PRESERVING TIME STRETCHING
// ===============================

/**
 * Validate if a cached audio file is not corrupted
 */
async function validateCachedAudioFile(filePath: string): Promise<boolean> {
    try {
        const stats = fs.statSync(filePath);
        
        // Check if file has reasonable size (at least 1KB, less than 10MB)
        if (stats.size < 1024 || stats.size > 10 * 1024 * 1024) {
            log(`[validateCache] File size invalid: ${stats.size} bytes for ${path.basename(filePath)}`);
            return false;
        }
        
        // For WAV files, do a basic header validation
        if (filePath.toLowerCase().endsWith('.wav')) {
            const buffer = fs.readFileSync(filePath);
            
            // Check for RIFF header (first 4 bytes)
            if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) !== 'RIFF') {
                log(`[validateCache] Invalid WAV header for ${path.basename(filePath)}`);
                return false;
            }
            
            // Check for WAVE format (bytes 8-12)
            if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) !== 'WAVE') {
                log(`[validateCache] Invalid WAVE format for ${path.basename(filePath)}`);
                return false;
            }
        }
        
        log(`[validateCache] File validation passed for ${path.basename(filePath)}`);
        return true;
    } catch (error) {
        log(`[validateCache] Validation failed for ${path.basename(filePath)}: ${error}`);
        return false;
    }
}

/**
 * Apply volume boost to an audio file using FFmpeg
 * Returns path to the processed file (cached for efficiency)
 */
async function applyVolumeBoost(inputFilePath: string, volumeBoost: number): Promise<string> {
    // Skip processing if volume boost is 1.0 (no change needed)
    if (Math.abs(volumeBoost - 1.0) < 0.01) {
        return inputFilePath;
    }
    
    // Generate cache key based on file and volume boost
    const inputBasename = path.basename(inputFilePath, path.extname(inputFilePath));
    const volumeKey = volumeBoost.toFixed(3).replace('.', '_');
    
    // Handle long filenames by truncating or hashing to prevent "File name too long" errors
    let safeBasename = inputBasename;
    const maxBaseLength = 100; // Conservative limit to avoid filesystem issues
    
    if (inputBasename.length > maxBaseLength) {
        // For very long filenames, use a hash of the original name plus a truncated version
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(inputBasename).digest('hex').substring(0, 8);
        const truncated = inputBasename.substring(0, 50); // Keep first 50 chars for readability
        safeBasename = `${truncated}_${hash}`;
        log(`[volumeBoost] Long filename detected, using safe name: ${safeBasename}`);
    }
    
    const outputFileName = `${safeBasename}_vol${volumeKey}.wav`;
    const outputFilePath = path.join(os.tmpdir(), 'lipcoder_volume', outputFileName);
    
    // Create cache directory if it doesn't exist
    const cacheDir = path.dirname(outputFilePath);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // Return cached file if it exists, is newer than input, and is valid
    if (fs.existsSync(outputFilePath)) {
        const inputStat = fs.statSync(inputFilePath);
        const outputStat = fs.statSync(outputFilePath);
        if (outputStat.mtime > inputStat.mtime) {
            // Validate the cached file before using it
            if (await validateCachedAudioFile(outputFilePath)) {
                log(`[volumeBoost] Using cached volume-boosted file: ${outputFileName}`);
                return outputFilePath;
            } else {
                log(`[volumeBoost] Cached file is corrupted, regenerating: ${outputFileName}`);
                // Delete the corrupted file and continue to regenerate
                try {
                    fs.unlinkSync(outputFilePath);
                } catch (e) {
                    // Ignore deletion errors
                }
            }
        }
    }
    
    log(`[volumeBoost] Applying ${volumeBoost}x volume boost to: ${path.basename(inputFilePath)}`);
    
    // Check if input file exists
    if (!fs.existsSync(inputFilePath)) {
        const error = new Error(`Input file does not exist: ${inputFilePath}`);
        logError(`[volumeBoost] ${error.message}`);
        return Promise.reject(error);
    }
    
    return new Promise((resolve, reject) => {
        // FFmpeg command: -af "volume=boost" to adjust volume
        const volumeFilter = `volume=${volumeBoost.toFixed(6)}`;
        
        // Check if input is a PCM file and add format specifications
        const isPcmFile = inputFilePath.toLowerCase().endsWith('.pcm');
        let ffmpegArgs: string[];
        
        if (isPcmFile) {
            // For PCM files, specify the format explicitly using standard PCM format
            log(`[volumeBoost] PCM file detected, using format: ${STANDARD_PCM_FORMAT.channels}ch, ${STANDARD_PCM_FORMAT.sampleRate}Hz, 16-bit`);
            ffmpegArgs = [
                '-f', 's16le',                                    // 16-bit signed little-endian
                '-ar', STANDARD_PCM_FORMAT.sampleRate.toString(), // Sample rate from constant
                '-ac', STANDARD_PCM_FORMAT.channels.toString(),   // Channels from constant
                '-i', inputFilePath,
                '-af', volumeFilter,
                '-y', // Overwrite output file
                outputFilePath
            ];
        } else {
            // For other audio files (WAV, MP3, etc.), use standard approach
            ffmpegArgs = [
                '-i', inputFilePath,
                '-af', volumeFilter,
                '-y', // Overwrite output file
                outputFilePath
            ];
        }
        
        log(`[volumeBoost] Running: ffmpeg ${ffmpegArgs.join(' ')}`);
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, { 
            stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
        });
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log(`[volumeBoost] Successfully created volume-boosted file: ${outputFileName}`);
                resolve(outputFilePath);
            } else {
                logError(`[volumeBoost] FFmpeg failed with code ${code}. stderr: ${stderr}`);
                reject(new Error(`FFmpeg volume boost failed: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            logError(`[volumeBoost] FFmpeg spawn error: ${err}`);
            reject(err);
        });
    });
}

/**
 * Apply pitch-preserving time stretching and/or volume boost to an audio file using FFmpeg
 * Returns path to the processed file (cached for efficiency)
 */
async function applyAudioProcessingWithOriginal(inputFilePath: string, playSpeed: number, volumeBoost?: number, originalFilePath?: string): Promise<string> {
    // Skip processing if no changes needed
    const needsSpeedChange = Math.abs(playSpeed - 1.0) > 0.01;
    const needsVolumeChange = volumeBoost && Math.abs(volumeBoost - 1.0) > 0.01;
    
    if (!needsSpeedChange && !needsVolumeChange) {
        return inputFilePath;
    }
    
    // Use original file for cache key and modification time comparison
    const cacheKeyFile = originalFilePath || inputFilePath;
    const inputBasename = path.basename(cacheKeyFile, path.extname(cacheKeyFile));
    const speedKey = playSpeed.toFixed(3).replace('.', '_');
    const volumeKey = volumeBoost ? volumeBoost.toFixed(3).replace('.', '_') : '1_000';
    
    // Handle long filenames by truncating or hashing to prevent "File name too long" errors
    let safeBasename = inputBasename;
    const maxBaseLength = 100; // Conservative limit to avoid filesystem issues
    
    if (inputBasename.length > maxBaseLength) {
        // For very long filenames, use a hash of the original name plus a truncated version
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(inputBasename).digest('hex').substring(0, 8);
        const truncated = inputBasename.substring(0, 50); // Keep first 50 chars for readability
        safeBasename = `${truncated}_${hash}`;
        log(`[audioProcessing] Long filename detected, using safe name: ${safeBasename}`);
    }
    
    const outputFileName = `${safeBasename}_speed${speedKey}_vol${volumeKey}.wav`;
    const outputFilePath = path.join(os.tmpdir(), 'lipcoder_audio_processing', outputFileName);
    
    // Create cache directory if it doesn't exist
    const cacheDir = path.dirname(outputFilePath);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // Return cached file if it exists and is valid
    if (fs.existsSync(outputFilePath)) {
        // For alphabet/earcon PCM files, always use cache if valid (they never change)
        // For other files, check modification time
        const compareFilePath = originalFilePath || inputFilePath;
        const isAlphabetOrEarcon = compareFilePath.includes('/alphabet/') || compareFilePath.includes('/earcon/') || compareFilePath.includes('/special/');
        
        let shouldUseCache = isAlphabetOrEarcon; // Always use cache for alphabet/earcon files
        
        if (!shouldUseCache) {
            // For other files, check if cached file is newer than original
            const inputStat = fs.statSync(compareFilePath);
            const outputStat = fs.statSync(outputFilePath);
            shouldUseCache = outputStat.mtime > inputStat.mtime;
        }
        
        if (shouldUseCache) {
            // Validate the cached file before using it
            if (await validateCachedAudioFile(outputFilePath)) {
                log(`[audioProcessing] Using cached processed file: ${outputFileName}`);
                return outputFilePath;
            } else {
                log(`[audioProcessing] Cached file is corrupted, regenerating: ${outputFileName}`);
                // Delete the corrupted file and continue to regenerate
                try {
                    fs.unlinkSync(outputFilePath);
                } catch (e) {
                    // Ignore deletion errors
                }
            }
        }
    }
    
    const processingDesc = [];
    if (needsSpeedChange) processingDesc.push(`${playSpeed}x speed`);
    if (needsVolumeChange) processingDesc.push(`${volumeBoost}x volume`);
    log(`[audioProcessing] Applying ${processingDesc.join(' + ')} to: ${path.basename(inputFilePath)}`);
    
    // Check if input file exists
    if (!fs.existsSync(inputFilePath)) {
        const error = new Error(`Input file does not exist: ${inputFilePath}`);
        logError(`[audioProcessing] ${error.message}`);
        return Promise.reject(error);
    }
    
    return new Promise((resolve, reject) => {
        // Build filter chain
        let filters: string[] = [];
        
        // Add time stretching filters if needed
        if (needsSpeedChange) {
            // Use atempo filter for time stretching (preserves pitch)
            // atempo filter has a range limit of 0.5-100.0, so we may need to chain multiple filters
            let remainingSpeed = playSpeed;
            while (remainingSpeed > 2.0) {
                filters.push('atempo=2.0');
                remainingSpeed /= 2.0;
            }
            while (remainingSpeed < 0.5) {
                filters.push('atempo=0.5');
                remainingSpeed /= 0.5;
            }
            if (Math.abs(remainingSpeed - 1.0) > 0.01) {
                filters.push(`atempo=${remainingSpeed.toFixed(6)}`);
            }
        }
        
        // Add volume filter if needed
        if (needsVolumeChange) {
            filters.push(`volume=${volumeBoost}`);
        }
        
        const filterString = filters.length > 0 ? ['-af', filters.join(',')] : [];
        
        const ffmpegArgs = [
            '-i', inputFilePath,
            ...filterString,
            '-y', // Overwrite output file
            outputFilePath
        ];
        
        log(`[audioProcessing] Running: ffmpeg ${ffmpegArgs.join(' ')}`);
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log(`[audioProcessing] Successfully created processed file: ${outputFileName}`);
                resolve(outputFilePath);
            } else {
                const error = new Error(`FFmpeg failed with code ${code}: ${stderr}`);
                logError(`[audioProcessing] ${error.message}`);
                reject(error);
            }
        });
        
        ffmpeg.on('error', (err) => {
            const error = new Error(`FFmpeg spawn error: ${err.message}`);
            logError(`[audioProcessing] ${error.message}`);
            reject(error);
        });
    });
}

async function applyAudioProcessing(inputFilePath: string, playSpeed: number, volumeBoost?: number): Promise<string> {
    // Skip processing if no changes needed
    const needsSpeedChange = Math.abs(playSpeed - 1.0) > 0.01;
    const needsVolumeChange = volumeBoost && Math.abs(volumeBoost - 1.0) > 0.01;
    
    if (!needsSpeedChange && !needsVolumeChange) {
        return inputFilePath;
    }
    
    // Generate cache key based on file, playspeed, and volume boost
    const inputBasename = path.basename(inputFilePath, path.extname(inputFilePath));
    const speedKey = playSpeed.toFixed(3).replace('.', '_');
    const volumeKey = volumeBoost ? volumeBoost.toFixed(3).replace('.', '_') : '1_000';
    
    // Handle long filenames by truncating or hashing to prevent "File name too long" errors
    let safeBasename = inputBasename;
    const maxBaseLength = 100; // Conservative limit to avoid filesystem issues
    
    if (inputBasename.length > maxBaseLength) {
        // For very long filenames, use a hash of the original name plus a truncated version
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(inputBasename).digest('hex').substring(0, 8);
        const truncated = inputBasename.substring(0, 50); // Keep first 50 chars for readability
        safeBasename = `${truncated}_${hash}`;
        log(`[audioProcessing] Long filename detected, using safe name: ${safeBasename}`);
    }
    
    const outputFileName = `${safeBasename}_speed${speedKey}_vol${volumeKey}.wav`;
    const outputFilePath = path.join(os.tmpdir(), 'lipcoder_audio_processing', outputFileName);
    
    // Create cache directory if it doesn't exist
    const cacheDir = path.dirname(outputFilePath);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // Return cached file if it exists, is newer than input, and is valid
    if (fs.existsSync(outputFilePath)) {
        const inputStat = fs.statSync(inputFilePath);
        const outputStat = fs.statSync(outputFilePath);
        if (outputStat.mtime > inputStat.mtime) {
            // Validate the cached file before using it
            if (await validateCachedAudioFile(outputFilePath)) {
                log(`[audioProcessing] Using cached processed file: ${outputFileName}`);
                return outputFilePath;
            } else {
                log(`[audioProcessing] Cached file is corrupted, regenerating: ${outputFileName}`);
                // Delete the corrupted file and continue to regenerate
                try {
                    fs.unlinkSync(outputFilePath);
                } catch (e) {
                    // Ignore deletion errors
                }
            }
        }
    }
    
    const processingDesc = [];
    if (needsSpeedChange) processingDesc.push(`${playSpeed}x speed`);
    if (needsVolumeChange) processingDesc.push(`${volumeBoost}x volume`);
    log(`[audioProcessing] Applying ${processingDesc.join(' + ')} to: ${path.basename(inputFilePath)}`);
    
    // Check if input file exists
    if (!fs.existsSync(inputFilePath)) {
        const error = new Error(`Input file does not exist: ${inputFilePath}`);
        logError(`[audioProcessing] ${error.message}`);
        return Promise.reject(error);
    }
    
    return new Promise((resolve, reject) => {
        // Build filter chain
        let filters: string[] = [];
        
        // Add time stretching filters if needed
        if (needsSpeedChange) {
            // FFmpeg command: -af "atempo=speed" preserves pitch while changing tempo
            // atempo filter has limits (0.5-100.0), so we may need to chain multiple filters for extreme speeds
            let atempoFilters: string[] = [];
            let remainingSpeed = playSpeed;
            
            // Chain atempo filters if speed is outside single filter range
            while (remainingSpeed > 2.0) {
                atempoFilters.push('atempo=2.0');
                remainingSpeed /= 2.0;
            }
            while (remainingSpeed < 0.5) {
                atempoFilters.push('atempo=0.5');
                remainingSpeed /= 0.5;
            }
            
            // Add final adjustment
            if (Math.abs(remainingSpeed - 1.0) > 0.01) {
                atempoFilters.push(`atempo=${remainingSpeed.toFixed(6)}`);
            }
            
            filters.push(...atempoFilters);
        }
        
        // Add volume filter if needed
        if (needsVolumeChange) {
            filters.push(`volume=${volumeBoost!.toFixed(6)}`);
        }
        
        const filterChain = filters.join(',');
        
        // Check if input is a PCM file and add format specifications
        const isPcmFile = inputFilePath.toLowerCase().endsWith('.pcm');
        let ffmpegArgs: string[];
        
        if (isPcmFile) {
            // For PCM files, specify the format explicitly using standard PCM format
            log(`[audioProcessing] PCM file detected, using format: ${STANDARD_PCM_FORMAT.channels}ch, ${STANDARD_PCM_FORMAT.sampleRate}Hz, 16-bit`);
            ffmpegArgs = [
                '-f', 's16le',                                    // 16-bit signed little-endian
                '-ar', STANDARD_PCM_FORMAT.sampleRate.toString(), // Sample rate from constant
                '-ac', STANDARD_PCM_FORMAT.channels.toString(),   // Channels from constant
                '-i', inputFilePath,
                '-af', filterChain,
                '-y', // Overwrite output file
                outputFilePath
            ];
        } else {
            // For other audio files (WAV, MP3, etc.), use standard approach
            ffmpegArgs = [
                '-i', inputFilePath,
                '-af', filterChain,
                '-y', // Overwrite output file
                outputFilePath
            ];
        }
        
        log(`[audioProcessing] Running: ffmpeg ${ffmpegArgs.join(' ')}`);
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, { 
            stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
        });
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log(`[audioProcessing] Successfully created processed file: ${outputFileName}`);
                resolve(outputFilePath);
            } else {
                logError(`[audioProcessing] FFmpeg failed with code ${code}. stderr: ${stderr}`);
                reject(new Error(`FFmpeg audio processing failed: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            logError(`[audioProcessing] FFmpeg spawn error: ${err}`);
            reject(err);
        });
    });
}

/**
 * Backward compatibility function for pitch-preserving time stretching
 */
async function applyPitchPreservingTimeStretch(inputFilePath: string, playSpeed: number): Promise<string> {
    return applyAudioProcessing(inputFilePath, playSpeed);
}

/**
 * Pitch-preserving time stretching with original file for cache comparison
 */
async function applyPitchPreservingTimeStretchWithOriginal(inputFilePath: string, playSpeed: number, originalFilePath: string): Promise<string> {
    return applyAudioProcessingWithOriginal(inputFilePath, playSpeed, undefined, originalFilePath);
}

// ===============================
// AUDIO FORMAT CONSTANTS
// ===============================

const STANDARD_PCM_FORMAT = {
    channels: 2,        // stereo (converted from mono)
    sampleRate: 24000,   // 24kHz (original sample rate)
    bitDepth: 16,       // 16-bit
    signed: true,
    float: false
};

// ===============================
// AUDIO CACHE MANAGEMENT
// ===============================

class AudioCache {
    private cache: Record<string, { format: any; pcm: Buffer }> = {};
    private accessTimes: Record<string, number> = {};
    private currentSize = 0;
    private readonly maxSizeMB = 15;

    add(filePath: string, format: any, pcm: Buffer): void {
        const sizeInMB = pcm.length / (1024 * 1024);
        
        if (this.currentSize + sizeInMB > this.maxSizeMB) {
            this.evictOldEntries();
        }
        
        this.cache[filePath] = { format, pcm };
        this.accessTimes[filePath] = Date.now();
        this.currentSize += sizeInMB;
        logInfo(`📦 Added to PCM cache: ${path.basename(filePath)} (${sizeInMB.toFixed(2)}MB, total: ${this.currentSize.toFixed(2)}MB)`);
    }

    get(filePath: string): { format: any; pcm: Buffer } | null {
        const entry = this.cache[filePath];
        if (entry) {
            this.accessTimes[filePath] = Date.now();
            return entry;
        }
        return null;
    }

    private evictOldEntries(): void {
        logWarning(`🧹 PCM cache size limit reached (${this.currentSize.toFixed(2)}MB), clearing old entries`);
        
        const entries = Object.entries(this.accessTimes).sort(([,a], [,b]) => a - b);
        const entriesToRemove = Math.ceil(entries.length / 2);
        
        for (let i = 0; i < entriesToRemove && i < entries.length; i++) {
            const [key] = entries[i];
            if (this.cache[key]) {
                this.currentSize -= this.cache[key].pcm.length / (1024 * 1024);
                delete this.cache[key];
                delete this.accessTimes[key];
            }
        }
        
        logInfo(`📦 Removed ${entriesToRemove} old cache entries, new size: ${this.currentSize.toFixed(2)}MB`);
    }

    clear(): void {
        Object.keys(this.cache).forEach(key => delete this.cache[key]);
        Object.keys(this.accessTimes).forEach(key => delete this.accessTimes[key]);
        this.currentSize = 0;
    }

    loadAndCache(filePath: string): { format: any; pcm: Buffer } {
        let entry = this.get(filePath);
        if (!entry) {
            const pcm = fs.readFileSync(filePath);
            // Since we converted all PCM files to 24kHz stereo, use the correct format
            const format = STANDARD_PCM_FORMAT; // This is already 24kHz stereo
            this.add(filePath, format, pcm);
            entry = this.get(filePath)!;
        }
        return entry;
    }
}

// ===============================
// FALLBACK PLAYER MANAGEMENT
// ===============================

class FallbackPlayerManager {
    private activeProcesses = new Set<ChildProcess>();

    createPlayer(filePath: string): Promise<void> {
        this.killAll();
        
        const { cmd, args } = this.getPlayerCommand(filePath);
        const cp = this.spawnProcess(cmd, args);
        
        return new Promise<void>((resolve, reject) => {
            cp.on('close', (code) => {
                this.activeProcesses.delete(cp);
                if (code === 0 || code === null) {
                    resolve();
                } else {
                    reject(new Error(`fallback player exited with code ${code}`));
                }
            });
        });
    }

    private getPlayerCommand(filePath: string): { cmd: string; args: string[] } {
        if (process.platform === 'darwin') {
            return { cmd: 'afplay', args: [filePath] };
        } else if (process.platform === 'win32') {
            return { 
                cmd: 'powershell', 
                args: ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`] 
            };
        } else {
            return { cmd: 'play', args: [filePath] };
        }
    }

    private spawnProcess(cmd: string, args: string[]): ChildProcess {
        const cp = spawn(cmd, args, { stdio: 'ignore' });
        this.activeProcesses.add(cp);
        
        cp.on('exit', () => this.activeProcesses.delete(cp));
        cp.on('error', err => {
            log(`🔊 player "error" event: ${err.stack || err}`);
            this.activeProcesses.delete(cp);
        });
        
        if (cp.stderr) {
            cp.stderr.on('data', chunk => {
                log(`🔊 player stderr: ${chunk.toString().trim()}`);
            });
        }
        
        return cp;
    }

    killAll(): void {
        if (this.activeProcesses.size === 0) return;
        
        logWarning(`🛑 Force killing ${this.activeProcesses.size} active child processes...`);
        
        for (const cp of this.activeProcesses) {
            try {
                if (!cp.killed) {
                    cp.kill('SIGKILL');
                }
            } catch (error) {
                logError(`Failed to kill child process: ${error}`);
            }
        }
        
        this.activeProcesses.clear();
        logSuccess('🛑 All child processes killed');
    }
}

// ===============================
// AUDIO UTILITIES
// ===============================

class AudioUtils {
        static applyPanning(pcm: Buffer, format: any, pan: number): Buffer {
        log(`[AudioUtils.applyPanning] Input: ${pcm.length} bytes, channels: ${format.channels}, pan: ${pan}`);
        
        if (format.channels !== 2 || pan === 0) {
            log(`[AudioUtils.applyPanning] No panning needed, returning original`);
            return pcm;
        }
        
        pan = Math.max(-1, Math.min(1, pan));
        const leftGain = pan <= 0 ? 1 : 1 - pan;
        const rightGain = pan <= 0 ? 1 + pan : 1;
        
        log(`[AudioUtils.applyPanning] Gains: left=${leftGain}, right=${rightGain}`);
        
        const pannedPcm = Buffer.alloc(pcm.length);
        const bytesPerSample = format.bitDepth / 8;
        
        log(`[AudioUtils.applyPanning] Processing ${pcm.length} bytes with ${bytesPerSample} bytes per sample`);
        
        for (let i = 0; i < pcm.length; i += bytesPerSample * 2) {
            if (format.bitDepth === 16) {
                const leftSample = Math.round(pcm.readInt16LE(i) * leftGain);
                const rightSample = Math.round(pcm.readInt16LE(i + 2) * rightGain);
                pannedPcm.writeInt16LE(leftSample, i);
                pannedPcm.writeInt16LE(rightSample, i + 2);
            } else {
                pcm.copy(pannedPcm, i, i, i + bytesPerSample * 2);
            }
        }
        
        log(`[AudioUtils.applyPanning] Panning completed, returning ${pannedPcm.length} bytes`);
        return pannedPcm;
    }

    static isWavFile(data: Buffer): boolean {
        return data.length >= 4 && data.toString('ascii', 0, 4) === 'RIFF';
    }

    static parseWavFormat(buf: Buffer): { format: any; pcm: Buffer } {
        const channels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitDepth = buf.readUInt16LE(34);

        const dataIdx = buf.indexOf(Buffer.from('data'));
        if (dataIdx < 0) throw new Error('No data chunk found in WAV file');
        const pcm = buf.slice(dataIdx + 8);

        return {
            format: {
                channels,
                sampleRate,
                bitDepth,
                signed: true,
                float: false
            },
            pcm
        };
    }
}

// ===============================
// MAIN AUDIO PLAYER
// ===============================

class AudioPlayer {
    private currentSpeaker: any | null = null;
    private currentReader: wav.Reader | null = null;
    private currentFileStream: fs.ReadStream | null = null;
    private currentFallback: ChildProcess | null = null;
    private playQueue = Promise.resolve();
    private isStopping = false; // Flag to prevent new audio during stop
    private stoppingTimeout: NodeJS.Timeout | null = null;

    private cache = new AudioCache();
    private fallbackManager = new FallbackPlayerManager();

    // Preload a PCM file into the in-memory cache without playing
    public preloadPcm(filePath: string): void {
        try {
            if (!fs.existsSync(filePath)) {
                return;
            }
            this.cache.loadAndCache(filePath);
        } catch (err) {
            logWarning(`[preloadPcm] Failed to preload ${path.basename(filePath)}: ${err}`);
        }
    }

    async playPcmCached(filePath: string, panning?: number): Promise<void> {
        // Check if we're in the middle of stopping - abort immediately  
        if (this.isStopping) {
            log(`[playPcmCached] Aborted - stopping in progress for: ${path.basename(filePath)}`);
            return;
        }
        
        // Check if this is an alphabet character - bypass pitch-preserving for instant playback
        const isAlphabetChar = filePath.includes('/alphabet/') || filePath.includes('\\alphabet\\');
        
        // Use pitch-preserving for all audio when enabled and speed is not 1.0, 
        // BUT skip it for alphabet characters to avoid delay
        const shouldUsePitchPreserving = config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01 && !isAlphabetChar;
        
        if (isAlphabetChar && config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01) {
            log(`[playPcmCached] Using FAST sample-rate method for alphabet char (bypassing pitch-preserving): ${path.basename(filePath)}`);
        }
        
        // For pitch-preserving PCM playback, convert to WAV and use time stretching
        if (shouldUsePitchPreserving) {
            log(`[playPcmCached] Using pitch-preserving time stretching for: ${path.basename(filePath)}`);
            try {
                // Load PCM data and convert to temporary WAV
                const originalEntry = this.cache.loadAndCache(filePath);
                const pcmData = originalEntry.pcm;
                const format = originalEntry.format;
                
                // Create temporary WAV file for FFmpeg processing - use consistent name for caching
                const baseName = path.basename(filePath, '.pcm');
                const tempWavPath = path.join(os.tmpdir(), `pcm_${baseName}.wav`);
                
                // Create WAV header for the PCM data
                const wavHeader = Buffer.alloc(44);
                wavHeader.write('RIFF', 0);
                wavHeader.writeUInt32LE(36 + pcmData.length, 4);
                wavHeader.write('WAVE', 8);
                wavHeader.write('fmt ', 12);
                wavHeader.writeUInt32LE(16, 16); // fmt chunk size
                wavHeader.writeUInt16LE(1, 20);  // PCM format
                wavHeader.writeUInt16LE(format.channels, 22);
                wavHeader.writeUInt32LE(format.sampleRate, 24);
                wavHeader.writeUInt32LE(format.sampleRate * format.channels * (format.bitDepth / 8), 28);
                wavHeader.writeUInt16LE(format.channels * (format.bitDepth / 8), 32);
                wavHeader.writeUInt16LE(format.bitDepth, 34);
                wavHeader.write('data', 36);
                wavHeader.writeUInt32LE(pcmData.length, 40);
                
                const wavData = Buffer.concat([wavHeader, pcmData]);
                fs.writeFileSync(tempWavPath, wavData);
                
                // Use pitch-preserving time stretching with original PCM file for cache key
                const processedFilePath = await applyPitchPreservingTimeStretchWithOriginal(tempWavPath, config.playSpeed, filePath);
                
                // Play the processed file
                const processedData = fs.readFileSync(processedFilePath);
                const parsed = AudioUtils.parseWavFormat(processedData);
                
                let finalPcm = parsed.pcm;
                let finalFormat = parsed.format;
                
                // Apply panning if needed
                if (panning !== undefined && panning !== 0) {
                    finalPcm = AudioUtils.applyPanning(parsed.pcm, parsed.format, panning);
                    log(`[playPcmCached] Applied panning ${panning.toFixed(3)} to pitch-preserving audio`);
                }
                
                return new Promise<void>((resolve, reject) => {
                    this.stopCurrentPlayback();
                    
                    // Use original format since time stretching is already applied
                    const speaker = new Speaker({ ...finalFormat, samplesPerFrame: 512 } as any);
                    this.currentSpeaker = speaker;
                    
                    speaker.on('close', () => {
                        log(`[playPcmCached] Pitch-preserving playback completed: ${path.basename(filePath)}`);
                        resolve();
                    });
                    speaker.on('error', reject);
                    
                    log(`[playPcmCached] Writing ${finalPcm.length} bytes (pitch-preserving)`);
                    speaker.write(finalPcm);
                    speaker.end();
                }).finally(() => {
                    // Clean up temp files
                    try { fs.unlinkSync(tempWavPath); } catch { }
                    if (processedFilePath !== tempWavPath) {
                        try { fs.unlinkSync(processedFilePath); } catch { } // Clean up if not cached
                    }
                });
                
            } catch (pitchError) {
                log(`[playPcmCached] Pitch-preserving failed: ${pitchError}, falling back to sample rate adjustment`);
                // Fall through to original method below
            }
        }
        
        // Original method with sample rate adjustment (changes pitch)
        // Generate cache key that includes panning for pre-processed PCM
        const baseName = path.basename(filePath, '.pcm');
        const panKey = panning !== undefined && panning !== 0 ? `_pan${panning.toFixed(3)}` : '';
        const cacheKey = `${baseName}${panKey}`;
        
        let cachedEntry = this.cache.get(cacheKey);
        
        if (!cachedEntry) {
            // Load original file
            const originalEntry = this.cache.loadAndCache(filePath);
            let finalPcm = originalEntry.pcm;
            let finalFormat = originalEntry.format;
            
            // Pre-apply panning if needed and cache the result
            if (panning !== undefined && panning !== 0) {
                finalPcm = AudioUtils.applyPanning(originalEntry.pcm, originalEntry.format, panning);
                log(`[playPcmCached] Pre-applied panning ${panning.toFixed(3)} and caching: ${cacheKey}`);
            }
            
            // Cache the pre-processed result
            this.cache.add(cacheKey, finalFormat, finalPcm);
            cachedEntry = this.cache.get(cacheKey)!;
        } else {
            log(`[playPcmCached] Using pre-cached panned PCM: ${cacheKey}`);
        }
        
        return new Promise<void>((resolve, reject) => {
            this.stopCurrentPlayback();
            
            // Apply global playspeed to cached PCM playback (changes pitch)
            const adjustedFormat = { 
                ...cachedEntry.format, 
                sampleRate: Math.floor(cachedEntry.format.sampleRate * config.playSpeed) 
            };
            log(`[playPcmCached] Using sample rate adjustment: playspeed ${config.playSpeed}x - adjusted sample rate to ${adjustedFormat.sampleRate}Hz (pitch will change)`);
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...adjustedFormat, samplesPerFrame: 512 } as any);
            this.currentSpeaker = speaker;
            
            speaker.on('close', resolve);
            speaker.on('error', reject);
            
            log(`[playPcmCached] Writing ${cachedEntry.pcm.length} bytes of pre-processed PCM: ${path.basename(filePath)}`);
            speaker.write(cachedEntry.pcm);
            speaker.end();
        });
    }

    async playPcmFile(filePath: string, opts?: { rate?: number; panning?: number }): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                const fileData = fs.readFileSync(filePath);
                
                if (AudioUtils.isWavFile(fileData)) {
                    return this.playWavFromBuffer(fileData, opts).then(resolve).catch(reject);
                }
                
                this.playRawPcm(fileData, opts).then(resolve).catch(reject);
            } catch (err) {
                log(`🛑 PCM playback error: ${err}`);
                reject(err);
            }
        });
    }

    private async playRawPcm(data: Buffer, opts?: { rate?: number; panning?: number }): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let format = { ...STANDARD_PCM_FORMAT };
            
            if (opts?.rate !== undefined) {
                format.sampleRate = Math.floor(format.sampleRate * opts.rate);
            }
            
            this.stopCurrentPlayback();
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...format, samplesPerFrame: 512 } as any);
            this.currentSpeaker = speaker;
            
            speaker.on('close', resolve);
            speaker.on('error', reject);
            
            let finalData = data;
            if (opts?.panning !== undefined && opts.panning !== 0) {
                finalData = AudioUtils.applyPanning(data, format, opts.panning);
                log(`[playRawPcm] Applied panning ${opts.panning.toFixed(2)} to PCM audio`);
            }
            
            speaker.write(finalData);
            speaker.end();
        });
    }

        private async playWavFromBuffer(data: Buffer, opts?: { rate?: number; panning?: number }): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const reader = new wav.Reader();
            this.currentReader = reader;
            let fallback = false;

            const doFallback = (err: any) => {
                log(`🛑 wav-stream error in playWavFromBuffer: ${err.stack || err}`);
                if (fallback) return;
                fallback = true;
                reader.removeAllListeners();
                // Use fallback player for error recovery
                const tempFile = path.join(os.tmpdir(), `temp_audio_${Date.now()}.wav`);
                fs.writeFileSync(tempFile, data);
                this.fallbackManager.createPlayer(tempFile)
                    .then(() => {
                        try { fs.unlinkSync(tempFile); } catch {}
                        resolve();
                    })
                    .catch(reject);
            };

            reader.on('format', (format: any) => {
                try {
                    const adjusted = { ...format };
                    if (opts?.rate !== undefined) {
                        adjusted.sampleRate = Math.floor(format.sampleRate * opts.rate);
                    }
                    
                    this.stopCurrentPlayback();
                    
                    // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
                    const speaker = new Speaker({ ...adjusted, samplesPerFrame: 512 } as any);
                    this.currentSpeaker = speaker;
                    
                    speaker.on('close', resolve);
                    speaker.on('error', reject);
                    
                    if (opts?.panning !== undefined && opts.panning !== 0 && format.channels === 2) {
                        this.handlePannedPlayback(reader, speaker, format, opts.panning);
    } else {
                        reader.pipe(speaker);
                    }
                } catch (err) {
                    doFallback(err);
                }
            });
            
            reader.on('error', doFallback);
            
            const stream = new Readable();
            stream.push(data);
            stream.push(null);
            stream.pipe(reader);
        });
    }

    private async playWavFileDirectBuffer(filePath: string, opts?: { rate?: number; panning?: number }): Promise<void> {
        log(`[playWavFileDirectBuffer] FAST playback for: ${path.basename(filePath)}`);
        
        return new Promise<void>((resolve, reject) => {
            try {
                // Read file directly as buffer
                const data = fs.readFileSync(filePath);
                log(`[playWavFileDirectBuffer] Read ${data.length} bytes from file`);
                
                // Parse WAV format directly
                const parsed = AudioUtils.parseWavFormat(data);
                log(`[playWavFileDirectBuffer] Parsed format: channels=${parsed.format.channels}, rate=${parsed.format.sampleRate}, bits=${parsed.format.bitDepth}`);
                
                let finalFormat = { ...parsed.format };
                let finalPcm = parsed.pcm;
                
                // Apply rate adjustment if needed
                if (opts?.rate !== undefined) {
                    finalFormat.sampleRate = Math.floor(parsed.format.sampleRate * opts.rate);
                    log(`[playWavFileDirectBuffer] Adjusted sample rate to: ${finalFormat.sampleRate}`);
                }
                
                // Apply panning if needed
                if (opts?.panning !== undefined && opts.panning !== 0) {
                    finalPcm = AudioUtils.applyPanning(parsed.pcm, parsed.format, opts.panning);
                    log(`[playWavFileDirectBuffer] Applied panning ${opts.panning.toFixed(2)}`);
                }
                
                this.stopCurrentPlayback();
                
                // Create speaker and play directly
                // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
                const speaker = new Speaker({ ...finalFormat, samplesPerFrame: 512 } as any);
                this.currentSpeaker = speaker;
                
                speaker.on('close', () => {
                    log(`[playWavFileDirectBuffer] FAST playback completed for: ${path.basename(filePath)}`);
                    resolve();
                });
                speaker.on('error', (err: any) => {
                    log(`[playWavFileDirectBuffer] Speaker error: ${err}`);
                    reject(err);
                });
                
                log(`[playWavFileDirectBuffer] Writing ${finalPcm.length} bytes to speaker`);
                speaker.write(finalPcm);
                speaker.end();
                
            } catch (err) {
                log(`[playWavFileDirectBuffer] Error in direct buffer playback: ${err}`);
                // Fallback to regular WAV file playback
                this.playWavFileInternal(filePath, opts).then(resolve).catch(reject);
            }
        });
    }

    private handlePannedPlayback(reader: wav.Reader, speaker: any, format: any, panning: number): void {
        log(`[handlePannedPlayback] Applying panning ${panning.toFixed(2)} to WAV audio`);
        const pcmChunks: Buffer[] = [];
        let dataReceived = false;
        let finished = false;
        
        const finishPlayback = () => {
            if (finished) return;
            finished = true;
            
            log(`[handlePannedPlayback] Finishing playback with ${pcmChunks.length} chunks`);
            if (pcmChunks.length === 0) {
                log(`[handlePannedPlayback] No data received, ending speaker immediately`);
                speaker.end();
                return;
            }
            
            const allPcm = Buffer.concat(pcmChunks);
            log(`[handlePannedPlayback] Total PCM data: ${allPcm.length} bytes`);
            const pannedPcm = AudioUtils.applyPanning(allPcm, format, panning);
            log(`[handlePannedPlayback] Panning applied, writing to speaker`);
            speaker.write(pannedPcm);
            speaker.end();
            log(`[handlePannedPlayback] Speaker data written and ended`);
        };
        
        // Set a timeout in case the 'end' event never fires
        const timeout = setTimeout(() => {
            log(`[handlePannedPlayback] TIMEOUT: Reader did not end within 3 seconds, forcing completion`);
            finishPlayback();
        }, 3000);
        
        reader.on('data', (chunk: Buffer) => {
            log(`[handlePannedPlayback] Received data chunk: ${chunk.length} bytes`);
            pcmChunks.push(chunk);
            dataReceived = true;
        });
        
        reader.on('end', () => {
            clearTimeout(timeout);
            log(`[handlePannedPlayback] Reader ended naturally`);
            finishPlayback();
        });
        
        reader.on('close', () => {
            clearTimeout(timeout);
            log(`[handlePannedPlayback] Reader closed`);
            if (dataReceived && !finished) {
                log(`[handlePannedPlayback] Reader closed with data but no end event, forcing completion`);
                finishPlayback();
            }
        });
        
        reader.on('error', (err) => {
            clearTimeout(timeout);
            log(`[handlePannedPlayback] Reader error: ${err}`);
            finishPlayback();
        });
    }

    async playWavFile(filePath: string, opts?: { isEarcon?: boolean; rate?: number; immediate?: boolean; panning?: number }): Promise<void> {
        // Check if we're in the middle of stopping - abort immediately  
        if (this.isStopping) {
            // log(`[playWavFile] Aborted - stopping in progress for: ${path.basename(filePath)}`);
            return;
        }
        
        // log(`[playWavFile] Starting playback for: ${path.basename(filePath)}, opts: ${JSON.stringify(opts)}`);
        
        if (!fs.existsSync(filePath)) {
            // log(`🔕 playWavFile skipping missing file: ${filePath}`);
            return Promise.resolve();
        }

        const isPcmFile = filePath.toLowerCase().endsWith('.pcm');
        // log(`[playWavFile] File type: ${isPcmFile ? 'PCM' : 'WAV'}`);
        
        if (isPcmFile) {
            // log(`[playWavFile] Delegating to playPcmFile`);
            return this.playPcmFile(filePath, opts);
        }
        
        // Use immediate fallback player only if no panning is needed
        if (opts?.immediate && (opts?.panning === undefined || opts?.panning === 0)) {
            // log(`[playWavFile] Using immediate fallback player (no panning)`);
            const p = this.fallbackManager.createPlayer(filePath);
            this.playQueue = p.catch(() => {});
            return p;
        }
        
        // FAST PATH: For immediate playback with panning, use direct buffer approach
        if (opts?.immediate && opts?.panning !== undefined && opts?.panning !== 0) {
            // log(`[playWavFile] Using FAST direct buffer playback with panning: ${opts.panning}`);
            return this.playWavFileDirectBuffer(filePath, opts);
        }
        
        // Use immediate WAV reader for other cases
        if (opts?.immediate) {
            // log(`[playWavFile] Using immediate WAV reader (no panning)`);
            return this.playWavFileInternal(filePath, opts);
        }
        
        if (opts?.isEarcon) {
            // log(`[playWavFile] Playing earcon via raw PCM cache: ${filePath}`);
            const fname = path.basename(filePath, '.pcm');
            if (findTokenSound(fname)) {
                return playEarcon(fname, 0);
            }
        }

        // log(`[playWavFile] Using WAV reader with queueing, panning: ${opts?.panning}`);
        this.playQueue = this.playQueue.then(() => {
            // log(`[playWavFile] Queue executing for: ${path.basename(filePath)}`);
            return this.playWavFileInternal(filePath, opts);
        });
        return this.playQueue;
    }

    private async playWavFileInternal(filePath: string, opts?: { rate?: number; panning?: number }): Promise<void> {
        // log(`[playWavFileInternal] Starting internal playback for: ${path.basename(filePath)}`);
        
        return new Promise<void>((resolve, reject) => {
            //  log(`[playWavFileInternal] Creating file stream and WAV reader`);
            const fileStream = fs.createReadStream(filePath);
            this.currentFileStream = fileStream;
            const reader = new wav.Reader();
            this.currentReader = reader;
            let fallback = false;

            const doFallback = (err: any) => {
                // log(`🛑 wav-stream error: ${err.stack || err}`);
                if (fallback) return;
                fallback = true;
                reader.removeAllListeners();
                fileStream.unpipe(reader);
                fileStream.destroy();
                
                // log(`[playWavFileInternal] Falling back to external player`);
                this.fallbackManager.createPlayer(filePath)
                    .then(() => {
                        // log(`[playWavFileInternal] Fallback player completed for: ${path.basename(filePath)}`);
                        resolve();
                    })
                    .catch(reject);
            };

            reader.on('format', (format: any) => {
                // log(`🔊 got format: ${JSON.stringify(format)}`);
                // log(`[playWavFileInternal] Processing format for: ${path.basename(filePath)}`);
                try {
                    const adjusted = { ...format };
                    if (opts?.rate !== undefined) {
                        adjusted.sampleRate = Math.floor(format.sampleRate * opts.rate);
                        // log(`[playWavFileInternal] Adjusted sample rate to: ${adjusted.sampleRate}`);
                    }
                    
                    // log(`[playWavFileInternal] Stopping current playback before starting new`);
                    this.stopCurrentPlayback();
                    
                    // log(`[playWavFileInternal] Creating Speaker with format: ${JSON.stringify(adjusted)}`);
                    // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
                    const speaker = new Speaker({ ...adjusted, samplesPerFrame: 512 } as any);
                    this.currentSpeaker = speaker;
                    
                    speaker.on('close', () => {
                        // log(`[playWavFileInternal] Speaker closed for: ${path.basename(filePath)}`);
                        resolve();
                    });
                    speaker.on('error', (err: any) => {
                        // log(`[playWavFileInternal] Speaker error for ${path.basename(filePath)}: ${err}`);
                        reject(err);
                    });
                    
                    if (opts?.panning !== undefined && opts.panning !== 0 && format.channels === 2) {
                        // log(`[playWavFileInternal] Using panned playback with panning: ${opts.panning}`);
                        this.handlePannedPlayback(reader, speaker, format, opts.panning);
                    } else if (opts?.panning !== undefined && opts.panning !== 0 && format.channels === 1) {
                        // log(`[playWavFileInternal] Mono file with panning requested - converting to stereo on-the-fly`);
                        // For mono files with panning, we need to handle it differently
                        const pcmChunks: Buffer[] = [];
                        reader.on('data', (chunk: Buffer) => {
                            pcmChunks.push(chunk);
                        });
                        reader.on('end', () => {
                            log(`[playWavFileInternal] Converting mono to stereo and applying panning`);
                            const monoPcm = Buffer.concat(pcmChunks);
                            // Convert mono to stereo by duplicating samples
                            const stereoPcm = Buffer.alloc(monoPcm.length * 2);
                            for (let i = 0; i < monoPcm.length; i += 2) {
                                const sample = monoPcm.readInt16LE(i);
                                stereoPcm.writeInt16LE(sample, i * 2);     // Left channel
                                stereoPcm.writeInt16LE(sample, i * 2 + 2); // Right channel
                            }
                            // Apply panning to the stereo data
                            const pan = opts.panning!;
                            const leftGain = pan <= 0 ? 1 : 1 - pan;
                            const rightGain = pan <= 0 ? 1 + pan : 1;
                            
                            for (let i = 0; i < stereoPcm.length; i += 4) {
                                const leftSample = Math.round(stereoPcm.readInt16LE(i) * leftGain);
                                const rightSample = Math.round(stereoPcm.readInt16LE(i + 2) * rightGain);
                                stereoPcm.writeInt16LE(leftSample, i);
                                stereoPcm.writeInt16LE(rightSample, i + 2);
                            }
                            
                            // Create new speaker with stereo format
                            const stereoFormat = { ...format, channels: 2 };
                            // @ts-ignore
                            const stereoSpeaker = new Speaker({ ...stereoFormat, samplesPerFrame: 512 } as any);
                            this.currentSpeaker = stereoSpeaker;
                            
                            stereoSpeaker.on('close', () => {
                                log(`[playWavFileInternal] Stereo speaker closed for: ${path.basename(filePath)}`);
                                resolve();
                            });
                                                         stereoSpeaker.on('error', (err: any) => {
                                log(`[playWavFileInternal] Stereo speaker error: ${err}`);
                                reject(err);
                            });
                            
                            stereoSpeaker.write(stereoPcm);
                            stereoSpeaker.end();
                        });
                    } else {
                        log(`[playWavFileInternal] Using direct reader->speaker pipe`);
                        reader.pipe(speaker);
                    }
                } catch (err) {
                    log(`[playWavFileInternal] Exception in format handler: ${err}`);
                    doFallback(err);
                }
            });
            
            reader.on('error', (err) => {
                log(`[playWavFileInternal] WAV reader error: ${err}`);
                doFallback(err);
            });
            fileStream.on('error', (err) => {
                log(`[playWavFileInternal] File stream error: ${err}`);
                doFallback(err);
            });
            
            log(`[playWavFileInternal] Starting to pipe file stream to reader`);
            fileStream.pipe(reader);
        });
    }

    stopCurrentPlayback(immediate: boolean = false): void {
        this.isStopping = true; // Prevent new audio from starting
        
        if (this.currentSpeaker) {
            try {
                if (immediate || !config.gentleAudioStopping) {
                    // Immediate/aggressive stopping: destroy the speaker immediately
                    log(`[AudioPlayer] Using immediate/aggressive stopping for current speaker`);
                    this.currentSpeaker.destroy();
                } else {
                    // Gentler stopping: end the stream instead of destroying it abruptly
                    log(`[AudioPlayer] Using gentle stopping for current speaker`);
                    this.currentSpeaker.end();
                }
            } catch {}
            this.currentSpeaker = null;
        }
        
        if (this.currentFallback) {
            try {
                this.currentFallback.kill('SIGKILL');
            } catch {}
            this.currentFallback = null;
        }
        
        if (this.currentReader) {
            try {
                this.currentReader.destroy();
            } catch {}
            this.currentReader = null;
        }
        
        if (this.currentFileStream) {
            try {
                this.currentFileStream.destroy();
            } catch {}
            this.currentFileStream = null;
        }
        
        this.playQueue = Promise.resolve();
        
        // Reset the stopping flag immediately for faster recovery
        this.stoppingTimeout = setTimeout(() => {
            this.isStopping = false;
            this.stoppingTimeout = null;
        }, 1); // Reduced to 1ms for immediate recovery
    }

    stopAll(): void {
        stopEarconPlayback();
        this.stopCurrentPlayback(true); // Use immediate stopping for emergency stops
        this.fallbackManager.killAll();
        
        // Clear any pending timeout and immediately reset stopping flag
        if (this.stoppingTimeout) {
            clearTimeout(this.stoppingTimeout);
            this.stoppingTimeout = null;
        }
        this.isStopping = false;
    }

    clearStoppingState(): void {
        // Cancel any pending timeout that might reset the flag
        if (this.stoppingTimeout) {
            clearTimeout(this.stoppingTimeout);
            this.stoppingTimeout = null;
        }
        this.isStopping = false;
        log('[AudioPlayer] Stopping state cleared - ready for new audio');
    }

    private async createTruncatedKoreanTTS(wavFilePath: string): Promise<string> {
        try {
            // OPTIMIZATION: For Korean TTS, don't truncate - use the full audio for better user experience
            // The truncation was causing Korean phrases to be cut off prematurely
            log(`[createTruncatedKoreanTTS] Korean TTS optimization: using full audio instead of truncating`);
            return wavFilePath; // Return original file without truncation
            
            // The original truncation logic is commented out to prevent Korean TTS cutoff
            /*
            // Create a truncated version that's only 0.5 seconds long for immediate stopping
            const truncatedPath = wavFilePath.replace('.wav', '_truncated.wav');
            
            // Check if truncated version already exists and is newer than original
            if (fs.existsSync(truncatedPath)) {
                try {
                    const originalStat = fs.statSync(wavFilePath);
                    const truncatedStat = fs.statSync(truncatedPath);
                    if (truncatedStat.mtime >= originalStat.mtime) {
                        log(`[createTruncatedKoreanTTS] Using cached truncated Korean TTS: ${path.basename(truncatedPath)}`);
                        return truncatedPath;
                    }
                } catch (statError) {
                    // If stat fails, continue with regeneration
                    log(`[createTruncatedKoreanTTS] Stat error on cached file, regenerating: ${statError}`);
                }
            }
            
            // Use FFmpeg to truncate the audio to 0.5 seconds
            const { spawn } = require('child_process');
            
            return new Promise<string>((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', [
                    '-i', wavFilePath,
                    '-t', '0.5', // Truncate to 0.5 seconds
                    '-y', // Overwrite output
                    truncatedPath
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
                
                let stderr = '';
                ffmpeg.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
                
                ffmpeg.on('close', (code: number) => {
                    if (code === 0) {
                        log(`[createTruncatedKoreanTTS] Created truncated Korean TTS: ${path.basename(truncatedPath)}`);
                        resolve(truncatedPath);
                    } else {
                        log(`[createTruncatedKoreanTTS] FFmpeg failed, using original file: ${stderr}`);
                        resolve(wavFilePath); // Fallback to original
                    }
                });
                
                ffmpeg.on('error', (error: Error) => {
                    log(`[createTruncatedKoreanTTS] FFmpeg error, using original file: ${error}`);
                    resolve(wavFilePath); // Fallback to original
                });
            });
            */
        } catch (error) {
            log(`[createTruncatedKoreanTTS] Error in Korean TTS optimization, using original: ${error}`);
            return wavFilePath; // Fallback to original
        }
    }

    async playTtsAsPcm(wavFilePath: string, panning?: number): Promise<void> {
        // ULTRA-AGGRESSIVE stopping check - abort immediately if stopping or line reading inactive
        if (this.isStopping) {
            log(`[playTtsAsPcm] Aborted - stopping in progress for: ${path.basename(wavFilePath)}`);
            return;
        }
        
        // Check if this is Korean TTS and optimize for full playback
        let finalWavPath = wavFilePath;
        const isKoreanTTS = wavFilePath.includes('openai_ko_ko') || wavFilePath.includes('korean');
        if (isKoreanTTS) {
            log(`[playTtsAsPcm] Korean TTS detected - optimizing for full phrase playback`);
            const optimizeStartTime = Date.now();
            finalWavPath = await this.createTruncatedKoreanTTS(wavFilePath);
            const optimizeTime = Date.now() - optimizeStartTime;
            log(`[playTtsAsPcm] Korean TTS optimization completed in ${optimizeTime}ms`);
        }
        
        // Note: Removed overly aggressive line token reading check here
        // The isStopping flag and abort signals should be sufficient
        
        log(`[playTtsAsPcm] SIMPLE FAST TTS playback: ${path.basename(wavFilePath)}, panning: ${panning}`);
        
        // Use pitch-preserving time stretching if enabled and playspeed != 1.0
        if (config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01) {
            try {
                log(`[playTtsAsPcm] Using pitch-preserving time stretching for playspeed ${config.playSpeed}x`);
                const processedFilePath = await applyPitchPreservingTimeStretch(finalWavPath, config.playSpeed);
                
                // Play the time-stretched file at normal rate since tempo is already adjusted
                const wavData = fs.readFileSync(processedFilePath);
                const parsed = AudioUtils.parseWavFormat(wavData);
                
                let finalPcm = parsed.pcm;
                let finalFormat = parsed.format; // Use original format since time stretching is already applied
                
                // Apply panning if needed
                if (panning !== undefined && panning !== 0) {
                    if (parsed.format.channels === 1) {
                        // Convert mono to stereo first
                        const stereoPcm = Buffer.alloc(parsed.pcm.length * 2);
                        for (let i = 0; i < parsed.pcm.length; i += 2) {
                            const sample = parsed.pcm.readInt16LE(i);
                            stereoPcm.writeInt16LE(sample, i * 2);     // Left
                            stereoPcm.writeInt16LE(sample, i * 2 + 2); // Right
                        }
                        finalFormat = { ...parsed.format, channels: 2 };
                        finalPcm = stereoPcm;
                    }
                    
                    // Apply panning
                    finalPcm = AudioUtils.applyPanning(finalPcm, finalFormat, panning);
                    log(`[playTtsAsPcm] Applied panning ${panning.toFixed(3)}`);
                }
                
                log(`[playTtsAsPcm] Using pitch-preserving processed file - no sample rate adjustment needed`);
                
                return new Promise<void>((resolve, reject) => {
                    this.stopCurrentPlayback();
                    
                    // @ts-ignore: samplesPerFrame used for low-latency and immediate stopping
                    const bufferSize = config.aggressiveAudioPipeline ? 128 : 256;
                    const waterMark = config.aggressiveAudioPipeline ? 512 : 1024;
                    const speaker = new Speaker({ ...finalFormat, samplesPerFrame: bufferSize, highWaterMark: waterMark } as any);
                    this.currentSpeaker = speaker;
                    
                    let resolved = false;
                    
                    speaker.on('close', () => {
                        if (!resolved) {
                            log(`[playTtsAsPcm] Pitch-preserving playback completed: ${path.basename(wavFilePath)}`);
                            resolved = true;
                            resolve();
                        }
                    });
                    
                    // For reduced inter-token delay, resolve slightly before audio finishes
                    if (config.reduceInterTokenDelay) {
                        const estimatedDuration = (finalPcm.length / (finalFormat.sampleRate * finalFormat.channels * 2)) * 1000; // ms
                        const earlyResolveDelay = Math.max(50, estimatedDuration * 0.85); // Resolve at 85% completion, min 50ms
                        setTimeout(() => {
                            if (!resolved) {
                                log(`[playTtsAsPcm] Early resolve for reduced latency: ${path.basename(wavFilePath)}`);
                                resolved = true;
                                resolve();
                            }
                        }, earlyResolveDelay);
                    }
                    
                    speaker.on('error', (err: any) => {
                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        }
                    });
                    
                    log(`[playTtsAsPcm] Writing ${finalPcm.length} bytes to speaker (pitch-preserving with small buffer)`);
                    speaker.write(finalPcm);
                    speaker.end();
                });
                
            } catch (pitchError) {
                log(`[playTtsAsPcm] Pitch-preserving failed: ${pitchError}, falling back to sample rate adjustment`);
                // Fall through to original method below
            }
        }
        
        // Original method with sample rate adjustment (changes pitch)
        try {
            // Read and parse WAV file directly
            const wavData = fs.readFileSync(finalWavPath);
            const parsed = AudioUtils.parseWavFormat(wavData);
            
            let finalPcm = parsed.pcm;
            let finalFormat = parsed.format;
            
            // If panning needed, apply it (same as earcons)
            if (panning !== undefined && panning !== 0) {
                if (parsed.format.channels === 1) {
                    // Convert mono to stereo first
                    const stereoPcm = Buffer.alloc(parsed.pcm.length * 2);
                    for (let i = 0; i < parsed.pcm.length; i += 2) {
                        const sample = parsed.pcm.readInt16LE(i);
                        stereoPcm.writeInt16LE(sample, i * 2);     // Left
                        stereoPcm.writeInt16LE(sample, i * 2 + 2); // Right
                    }
                    finalFormat = { ...parsed.format, channels: 2 };
                    finalPcm = stereoPcm;
                }
                
                // Apply panning
                finalPcm = AudioUtils.applyPanning(finalPcm, finalFormat, panning);
                log(`[playTtsAsPcm] Applied panning ${panning.toFixed(3)}`);
            }
            
            // Apply global playspeed to TTS playback (changes pitch)
            const adjustedFormat = { 
                ...finalFormat, 
                sampleRate: Math.floor(finalFormat.sampleRate * config.playSpeed) 
            };
            log(`[playTtsAsPcm] Using sample rate adjustment: playspeed ${config.playSpeed}x - adjusted sample rate to ${adjustedFormat.sampleRate}Hz (pitch will change)`);
            
            // Use the exact same simple approach as playPcmCached
            return new Promise<void>((resolve, reject) => {
                this.stopCurrentPlayback();
                
                // @ts-ignore: samplesPerFrame used for low-latency and immediate stopping
                const bufferSize = config.aggressiveAudioPipeline ? 128 : 256;
                const waterMark = config.aggressiveAudioPipeline ? 512 : 1024;
                const speaker = new Speaker({ ...adjustedFormat, samplesPerFrame: bufferSize, highWaterMark: waterMark } as any);
                this.currentSpeaker = speaker;
                
                let resolved = false;
                
                speaker.on('close', () => {
                    if (!resolved) {
                        log(`[playTtsAsPcm] Sample rate adjustment playback completed: ${path.basename(wavFilePath)}`);
                        resolved = true;
                        resolve();
                    }
                });
                
                // For reduced inter-token delay, resolve slightly before audio finishes
                if (config.reduceInterTokenDelay) {
                    const estimatedDuration = (finalPcm.length / (adjustedFormat.sampleRate * adjustedFormat.channels * 2)) * 1000; // ms
                    const earlyResolveDelay = Math.max(50, estimatedDuration * 0.85); // Resolve at 85% completion, min 50ms
                    setTimeout(() => {
                        if (!resolved) {
                            log(`[playTtsAsPcm] Early resolve for reduced latency (fallback): ${path.basename(wavFilePath)}`);
                            resolved = true;
                            resolve();
                        }
                    }, earlyResolveDelay);
                }
                
                speaker.on('error', (err: any) => {
                    if (!resolved) {
                        resolved = true;
                        reject(err);
                    }
                });
                
                log(`[playTtsAsPcm] Writing ${finalPcm.length} bytes to speaker (sample rate adjustment with small buffer)`);
                speaker.write(finalPcm);
                speaker.end();
            });
            
        } catch (error) {
            log(`[playTtsAsPcm] Error, falling back to WAV playback: ${error}`);
            // Fallback to the working WAV approach
            return this.playWavFile(wavFilePath, { immediate: true, panning });
        }
    }

    cleanup(): void {
        logWarning('🧹 Cleaning up audio resources...');
        this.stopAll();
        this.cache.clear();
        
        // Reset stopping flag after cleanup to allow new audio
        this.isStopping = false;
        
        if (global.gc) {
            try {
                global.gc();
                logInfo('🗑️ Forced garbage collection');
            } catch (err) {
                logError(`Failed to force GC: ${err}`);
            }
        }
        
        logWarning('🧹 Audio resources cleaned up - ready for new audio');
    }

    /**
     * Check if audio is currently playing
     */
    isPlaying(): boolean {
        return this.currentSpeaker !== null || this.currentFallback !== null || this.isStopping;
    }

    async playSequence(filePaths: string[], opts?: { rate?: number }): Promise<void> {
        const existingFiles = filePaths.filter(fp => {
            if (!fs.existsSync(fp)) {
                log(`🔕 playSequence skipping missing file: ${fp}`);
                return false;
            }
            return true;
        });
        
        if (existingFiles.length === 0) return;
        
        if (opts?.rate && opts.rate !== 1) {
            return this.playSequenceWithSox(existingFiles, opts.rate);
        }
        
        return this.playSequenceRaw(existingFiles);
    }

    private async playSequenceWithSox(filePaths: string[], rate: number): Promise<void> {
        const cmd = 'sox';
        const args = [...filePaths, '-d', 'tempo', String(rate)];
        const cp = spawn(cmd, args, { stdio: 'ignore' });
        
        return new Promise<void>((resolve, reject) => {
            this.currentFallback = cp;
            cp.on('close', code => {
                this.currentFallback = null;
                if (code === 0 || code === null) {
                    resolve();
                } else {
                    reject(new Error(`sox tempo player exited ${code}`));
                }
            });
        });
    }

    private async playSequenceRaw(filePaths: string[]): Promise<void> {
        const entries = filePaths.map(filePath => {
            const isPcmFile = filePath.toLowerCase().endsWith('.pcm');
            
            if (isPcmFile) {
                const pcm = fs.readFileSync(filePath);
                return { format: STANDARD_PCM_FORMAT, pcm };
            } else {
                const buf = fs.readFileSync(filePath);
                return AudioUtils.parseWavFormat(buf);
            }
        });

        const allPCM = Buffer.concat(entries.map(e => e.pcm));
        const fmt = entries[0].format;

        return new Promise<void>((resolve, reject) => {
            const speaker = new Speaker(fmt);
            speaker.on('close', resolve);
            speaker.on('error', reject);
            speaker.write(allPCM);
            speaker.end();
        });
    }
}

// ===============================
// GLOBAL AUDIO PLAYER INSTANCE
// ===============================

export const audioPlayer = new AudioPlayer();

// ===============================
// PUBLIC API (maintaining backward compatibility)
// ===============================

// Preload alphabet PCM files into the cache for low-latency letter playback
export function preloadAlphabetPCM(): void {
    try {
        const baseDir = config.alphabetPath();
        for (let i = 0; i < 26; i++) {
            const letter = String.fromCharCode(97 + i);
            const filePath = path.join(baseDir, `${letter}.pcm`);
            audioPlayer.preloadPcm(filePath);
        }
        logInfo('[Preload] Alphabet PCM preloaded');
    } catch (err) {
        logWarning(`[Preload] Failed to preload alphabet PCM: ${err}`);
    }
}

export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string; signal?: AbortSignal; panning?: number }
): Promise<void> {
    try {
        log(`[speakToken] token="${token}" category="${category}"`);
        
        // New simplified logic: category determines behavior, not token type
        if (category && category !== 'default' && category !== 'other') {
            // If we have a meaningful category, always use TTS with category-specific voice
            log(`[speakToken] Using category-based TTS for: "${token}" (category: ${category})`);
            const categoryVoice = getSpeakerForCategory(category);
            const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker ?? categoryVoice });
            await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
        } else {
            // No meaningful category - determine by token characteristics
            if (isEarcon(token)) {
                // Earcons (brackets, quotes, etc.) use PCM files
                log(`[speakToken] Playing EARCON for: "${token}" (no category)`);
                await playEarcon(token, opts?.panning);
            } else if (isAlphabet(token)) {
                // Single letters use alphabet PCM files
                log(`[speakToken] Playing ALPHABET PCM for: "${token}" (no category)`);
                const lower = token.toLowerCase();
                const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
                if (fs.existsSync(alphaPath)) {
                    await audioPlayer.playPcmCached(alphaPath, opts?.panning);
                } else {
                    // Fallback to TTS if PCM file missing
                    const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker });
                    await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
                }
            } else if (isNumber(token)) {
                // Single digits use number PCM files
                log(`[speakToken] Playing NUMBER PCM for: "${token}" (no category)`);
                const numPath = path.join(config.numberPath(), `${token}.pcm`);
                if (fs.existsSync(numPath)) {
                    await audioPlayer.playPcmCached(numPath, opts?.panning);
                } else {
                    // Fallback to TTS if PCM file missing
                    const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker });
                    await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
                }
            } else if (getSpecialCharSpoken(token)) {
                // Special characters (like underbar, dot) that should be spoken
                log(`[speakToken] Using TTS for special character: "${token}" -> "${getSpecialCharSpoken(token)}" (no category)`);
                const spokenForm = getSpecialCharSpoken(token)!;
                const filePath = await genTokenAudio(spokenForm, 'special', { speaker: opts?.speaker });
                await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
            } else if (isTTSRequired(token)) {
                // Everything else that needs TTS
                log(`[speakToken] Using TTS for: "${token}" (no category)`);
                const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker });
                await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
            } else {
                log(`[speakToken] Skipping empty or whitespace token: "${token}"`);
                return Promise.resolve();
            }
        }
    } catch (err: any) {
        log(`[speakToken] Error handling token "${token}": ${err.stack || err}`);
        throw err;
    }
}

export type TokenChunk = {
    tokens: string[];
    category?: string;
    panning?: number;
};

/**
 * Speak text using GPT TTS specifically - for notifications and important messages
 * Includes timeout and fallback mechanisms to prevent delayed responses
 */
export async function speakGPT(text: string, signal?: AbortSignal): Promise<void> {
    const startTime = Date.now();
    const TIMEOUT_MS = 3000; // 3 second timeout for GPT TTS
    const currentTime = Date.now();
    
    // Cancel any previous GPT TTS request to prevent delayed responses
    if (activeGPTTTSController) {
        log(`[speakGPT] Cancelling previous GPT TTS request to prevent delayed response`);
        activeGPTTTSController.abort();
        activeGPTTTSController = null;
    }
    
    // Check if we're making requests too frequently (debounce)
    if (currentTime - lastGPTTTSTime < 500) { // 500ms debounce
        log(`[speakGPT] Debouncing GPT TTS request, using fast fallback: "${text}"`);
        await speakFastFallback(text, signal);
        return;
    }
    
    lastGPTTTSTime = currentTime;
    
    try {
        log(`[speakGPT] Speaking with GPT TTS: "${text}"`);
        
        // Create a new controller for this request
        activeGPTTTSController = new AbortController();
        const combinedSignal = signal || activeGPTTTSController.signal;
        
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error('GPT TTS timeout'));
            }, TIMEOUT_MS);
        });
        
        // Create the TTS promise
        const ttsPromise = async () => {
            // Force GPT TTS by using 'vibe_text' category
            const chunks: TokenChunk[] = [{
                tokens: [text],
                category: 'vibe_text', // This forces OpenAI/GPT TTS
                panning: undefined
            }];
            
            await speakTokenList(chunks, combinedSignal);
        };
        
        // Race between TTS and timeout
        try {
            await Promise.race([ttsPromise(), timeoutPromise]);
            const duration = Date.now() - startTime;
            log(`[speakGPT] Successfully spoke with GPT TTS in ${duration}ms: "${text}"`);
        } catch (timeoutError) {
            const duration = Date.now() - startTime;
            log(`[speakGPT] GPT TTS timeout after ${duration}ms, falling back to fast TTS: "${text}"`);
            
            // Cancel the ongoing request
            if (activeGPTTTSController) {
                activeGPTTTSController.abort();
            }
            
            // Fallback to faster espeak TTS for immediate feedback
            await speakFastFallback(text, signal);
        }
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            log(`[speakGPT] GPT TTS request was cancelled: "${text}"`);
            return; // Don't fallback if cancelled intentionally
        }
        
        log(`[speakGPT] Error speaking with GPT TTS: ${error}`);
        // Fallback to fast TTS on any error
        try {
            await speakFastFallback(text, signal);
        } catch (fallbackError) {
            log(`[speakGPT] Fallback TTS also failed: ${fallbackError}`);
            throw error; // Throw original error
        }
    } finally {
        // Clean up the controller
        if (activeGPTTTSController) {
            activeGPTTTSController = null;
        }
    }
}

/**
 * Fast fallback TTS using espeak for immediate feedback
 */
async function speakFastFallback(text: string, signal?: AbortSignal): Promise<void> {
    try {
        log(`[speakGPT] Using fast fallback TTS for: "${text}"`);
        
        // Use espeak directly for immediate response
        const chunks: TokenChunk[] = [{
            tokens: [text],
            category: 'comment', // Use comment voice which is typically espeak
            panning: undefined
        }];
        
        await speakTokenList(chunks, signal);
        log(`[speakGPT] Fast fallback TTS completed: "${text}"`);
    } catch (error) {
        log(`[speakGPT] Fast fallback TTS failed: ${error}`);
        throw error;
    }
}

/**
 * Read tokens using Espeak TTS - combines all tokens (except indentation earcons) into one TTS call
 * Similar to speakGPT but forces Espeak backend for faster reading
 */
export async function readInEspeak(chunks: TokenChunk[], signal?: AbortSignal): Promise<void> {
    try {
        // Filter out indentation earcons and combine all tokens into a single string
        const textTokens: string[] = [];
        
        for (const chunk of chunks) {
            for (const token of chunk.tokens) {
                // Skip indentation earcons (they are typically single characters or specific patterns)
                // We'll let earcons play separately and only combine actual text tokens
                if (token && token.trim().length > 0) {
                    textTokens.push(token);
                }
            }
        }
        
        if (textTokens.length === 0) {
            log(`[readInEspeak] No text tokens to speak`);
            return;
        }
        
        const combinedText = textTokens.join(' ');
        log(`[readInEspeak] Reading combined text with Espeak: "${combinedText}"`);
        
        // Force Espeak TTS by creating a single chunk with no specific category
        // This will use the current TTS backend's Espeak component
        const espeakChunk: TokenChunk = {
            tokens: [combinedText],
            category: undefined, // Let it use default category to route to Espeak
            panning: undefined
        };
        
        await speakTokenList([espeakChunk], signal);
        log(`[readInEspeak] Successfully read with Espeak: "${combinedText}"`);
    } catch (error) {
        log(`[readInEspeak] Error reading with Espeak: ${error}`);
        throw error;
    }
}

export async function speakTokenList(chunks: TokenChunk[], signal?: AbortSignal): Promise<void> {
    let aborted = false;
    let abortListener: (() => void) | null = null;
    let ttsPregenPromises = new Map<string, Promise<string>>();
    
    // Clear stopping state at the start of legitimate audio sequence
    audioPlayer.clearStoppingState();
    
    // Log TTS start for metrics
    const fullText = chunks.map(chunk => chunk.tokens.join(' ')).join(' ');
    logTTSStart(fullText);
    
    // KOREAN TTS PROTECTION: Check if this is Korean text and enable enhanced protection
    const isKoreanTTS = chunks.some(chunk => 
        chunk.tokens.some(token => containsKorean(token))
    );
    
    if (isKoreanTTS) {
        log(`[speakTokenList] Korean TTS detected - enabling enhanced protection against interruptions`);
        // Set a flag to indicate Korean TTS is active for other systems to respect
        (global as any).koreanTTSActive = true;
    }
    
    log(`[speakTokenList] Starting with ${chunks.length} chunks, signal aborted: ${signal?.aborted}, Korean TTS: ${isKoreanTTS}`);
    
    if (signal) {
        if (signal.aborted) {
            log(`[speakTokenList] Signal already aborted before starting`);
            return;
        }
        
        abortListener = () => { 
            log(`[speakTokenList] ABORT SIGNAL RECEIVED - immediately stopping all audio`);
            aborted = true;
            // Immediately stop current audio playback to prevent Korean TTS from finishing current chunk
            audioPlayer.stopCurrentPlayback(true); // Force immediate stopping
            log(`[speakTokenList] Current audio playback stopped immediately with aggressive mode`);
        };
        signal.addEventListener('abort', abortListener, { once: true });
    }
    
    try {
        // Clear any existing queue to ensure clean sequential playback
        audioPlayer.stopCurrentPlayback();
        log(`[speakTokenList] Cleared audio queue, starting token processing`);
        
        // UNIVERSAL WORD LOGIC APPLICATION: Apply word chunking to all appropriate tokens
        log(`[speakTokenList] Applying universal word logic to all chunks...`);
        const processedChunks: TokenChunk[] = [];
        
        for (const chunk of chunks) {
            const { tokens, category, panning } = chunk;
            const expandedTokens: string[] = [];
            
            for (const token of tokens) {
                // Import language detection to check if token is Korean
                const { containsKorean } = require('./language_detection');
                
                if (category === 'variable') {
                    // Skip client-side word chunking for Korean text since server already tokenized it properly
                    if (containsKorean(token)) {
                        // Korean text is already properly tokenized by the server, don't re-process
                        expandedTokens.push(token);
                        log(`[speakTokenList] Korean ${category} "${token}" → keeping as-is (already tokenized by server)`);
                    } else {
                        // Apply word chunking to English variables (handles CamelCase, underscores, 2/3-letter rules)
                        const wordChunks = splitWordChunks(token);
                        expandedTokens.push(...wordChunks);
                        const categoryVoice = getSpeakerForCategory(category);
                        log(`[speakTokenList] ${category} "${token}" → [${wordChunks.join(', ')}] (voice: ${categoryVoice})`);
                    }
                } else if (category === 'literal') {
                    // Literals (string content) - split to allow earcons while preserving literal voice for text
                    // This allows earcons like underscores to be read while keeping text parts as literals
                    const literalParts = splitWordChunks(token);
                    for (const part of literalParts) {
                        expandedTokens.push(part);
                    }
                    log(`[speakTokenList] ${category} "${token}" → split into parts: [${literalParts.join(', ')}] for earcon support`);
                } else if (category === 'regex_pattern') {
                    // Regex patterns should be kept as whole units and spoken with literal voice
                    expandedTokens.push(token);
                    log(`[speakTokenList] Regex pattern "${token}" → keeping as single unit for TTS`);
                } else if (category === 'comment_text') {
                    // For comment text, keep as single token for direct TTS processing
                    // This allows the entire comment to be processed as one unit with language detection
                    // OPTIMIZATION: For Korean comment text, keep even longer phrases together
                    if (containsKorean(token)) {
                        expandedTokens.push(token);
                        log(`[speakTokenList] Korean comment text "${token}" → keeping as single unit for optimized TTS`);
                    } else {
                        expandedTokens.push(token);
                        log(`[speakTokenList] Comment text "${token}" → keeping as single unit for direct TTS`);
                    }
                } else if (category === 'comment_symbol' || category === 'comment_number') {
                    // Comment symbols and numbers should be processed individually (earcons/TTS)
                    expandedTokens.push(token);
                    log(`[speakTokenList] Comment ${category} "${token}" → keeping as individual token`);
                } else if (!category) {
                    // Apply word logic to uncategorized tokens (like explorer items)
                    // This handles 2/3-letter rules for folder names like "src"
                    const wordChunks = splitWordChunks(token);
                    expandedTokens.push(...wordChunks);
                    log(`[speakTokenList] uncategorized "${token}" → [${wordChunks.join(', ')}] (word logic applied)`);
                } else {
                    // Check if this is a numeric token that might be a date format
                    if (/^\d+$/.test(token) && (category === 'literal' || category === 'number' || !category)) {
                        const { isDateLikeFormat } = require('./features/word_logic');
                        if (isDateLikeFormat(token)) {
                            // Split date-like numeric tokens into individual digits
                            const digits = token.split('');
                            expandedTokens.push(...digits);
                            log(`[speakTokenList] Date-like ${category || 'numeric'} "${token}" → split into digits: [${digits.join(', ')}]`);
                        } else {
                            // Keep regular numbers as-is
                            expandedTokens.push(token);
                            log(`[speakTokenList] ${category || 'no-category'} "${token}" → kept as regular number`);
                        }
                    } else {
                        // Keep other tokens as-is
                        expandedTokens.push(token);
                        log(`[speakTokenList] ${category || 'no-category'} "${token}" → kept as-is`);
                    }
                }
            }
            
            // Create new chunk with expanded tokens
            processedChunks.push({
                tokens: expandedTokens,
                category,
                panning
            });
            log(`[speakTokenList] Created chunk with category "${category}" and tokens: [${expandedTokens.join(', ')}]`);
        }
        
        const originalTokenCount = chunks.reduce((total, chunk) => total + chunk.tokens.length, 0);
        const processedTokenCount = processedChunks.reduce((total, chunk) => total + chunk.tokens.length, 0);
        log(`[speakTokenList] Word logic applied: ${chunks.length} chunks (${originalTokenCount} tokens) → ${processedChunks.length} chunks (${processedTokenCount} tokens)`);
        
        // KOREAN OPTIMIZATION: Consolidate consecutive Korean comment_text chunks to reduce TTS overhead
        const optimizedChunks: TokenChunk[] = [];
        let i = 0;
        while (i < processedChunks.length) {
            const currentChunk = processedChunks[i];
            
            // Check if this is a Korean comment_text chunk that can be consolidated
            if (currentChunk.category === 'comment_text' && 
                currentChunk.tokens.length === 1 && 
                containsKorean(currentChunk.tokens[0])) {
                
                // Look ahead for consecutive Korean comment_text chunks
                const koreanTokens: string[] = [currentChunk.tokens[0]];
                let j = i + 1;
                
                while (j < processedChunks.length && 
                       processedChunks[j].category === 'comment_text' &&
                       processedChunks[j].tokens.length === 1 &&
                       containsKorean(processedChunks[j].tokens[0])) {
                    koreanTokens.push(processedChunks[j].tokens[0]);
                    j++;
                }
                
                // If we found multiple consecutive Korean chunks, consolidate them
                if (koreanTokens.length > 1) {
                    const consolidatedText = koreanTokens.join(' ');
                    optimizedChunks.push({
                        tokens: [consolidatedText],
                        category: 'comment_text',
                        panning: currentChunk.panning
                    });
                    log(`[speakTokenList] Korean optimization: consolidated ${koreanTokens.length} chunks into "${consolidatedText}"`);
                    i = j; // Skip the consolidated chunks
                } else {
                    // Single Korean chunk, keep as-is
                    optimizedChunks.push(currentChunk);
                    i++;
                }
            } else {
                // Non-Korean or non-comment chunk, keep as-is
                optimizedChunks.push(currentChunk);
                i++;
            }
        }
        
        const optimizedTokenCount = optimizedChunks.reduce((total, chunk) => total + chunk.tokens.length, 0);
        if (optimizedChunks.length < processedChunks.length) {
            log(`[speakTokenList] Korean consolidation: ${processedChunks.length} chunks → ${optimizedChunks.length} chunks (${optimizedTokenCount} tokens)`);
        }
        
        // Use optimized chunks for the rest of the function
        chunks = optimizedChunks;

        // TEXT AGGREGATION: For code reading, merge contiguous text tokens within a chunk
        // to eliminate inter-token gaps (applies to literal/comment text)
        const aggregatedChunks: TokenChunk[] = chunks.map((chunk) => {
            const cat = chunk.category || 'default';
            if (cat === 'literal' || cat === 'comment_text') {
                const combined = chunk.tokens.join(' ').replace(/\s+/g, ' ').trim();
                return { ...chunk, tokens: combined ? [combined] : [] };
            }
            return chunk;
        });
        chunks = aggregatedChunks;
        
        // PARALLEL TTS PRE-GENERATION: Use both workers simultaneously
        log(`[speakTokenList] Pre-generating TTS for all tokens in parallel...`);
        ttsPregenPromises.clear(); // Clear any previous promises
        
        for (const { tokens, category } of chunks) {
            for (const token of tokens) {
                // Skip tokens that don't need pre-generation
                if (isEarcon(token) || isAlphabet(token) || isNumber(token)) {
                    continue; // These use PCM files, not TTS
                }
                
                // Pre-generate TTS for tokens that will use it
                if (category && category !== 'default' && category !== 'other') {
                    // Tokens with meaningful categories - use token+category as key to distinguish same token with different categories
                    const pregenKey = `${token}:${category}`;
                    if (!ttsPregenPromises.has(pregenKey)) {
                        log(`[speakTokenList] Queuing TTS pre-generation for ${category}: "${token}" with key: "${pregenKey}"`);
                        // Don't pass speaker override - let genTokenAudio use category-based voice selection
                        ttsPregenPromises.set(pregenKey, genTokenAudio(token, category, { abortSignal: signal }));
                    } else {
                        log(`[speakTokenList] Pre-generation already queued for key: "${pregenKey}"`);
                    }
                } else if (getSpecialCharSpoken(token)) {
                    // Special characters need their spoken form pre-generated
                    const spokenForm = getSpecialCharSpoken(token)!;
                    const specialKey = `special_${token}`;
                    if (!ttsPregenPromises.has(specialKey)) {
                        log(`[speakTokenList] Queuing TTS pre-generation for special character: "${token}" -> "${spokenForm}"`);
                        ttsPregenPromises.set(specialKey, genTokenAudio(spokenForm, 'special', { abortSignal: signal }));
                    }
                } else if (isTTSRequired(token)) {
                    // Other tokens that need TTS - use token+category as key
                    const pregenKey = category ? `${token}:${category}` : token;
                    if (!ttsPregenPromises.has(pregenKey)) {
                        log(`[speakTokenList] Queuing TTS pre-generation for: "${token}"`);
                        ttsPregenPromises.set(pregenKey, genTokenAudio(token, category, { abortSignal: signal }));
                    }
                }
            }
        }
        
        log(`[speakTokenList] Started ${ttsPregenPromises.size} parallel TTS requests across 2 workers`);
        
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            // Check for abort before each chunk
            if (signal?.aborted || aborted) {
                log(`[speakTokenList] ABORTED before chunk ${chunkIndex + 1}/${chunks.length}`);
                return;
            }
            
            const { tokens, category, panning } = chunks[chunkIndex];
            log(`[speakTokenList] Processing chunk ${chunkIndex + 1}/${chunks.length}: ${tokens.length} tokens [${tokens.join(', ')}] with category "${category}"`);

            // FAST-PATH: Vibe Coding text → generate one GPT TTS clip to remove inter-token gaps
            if (category === 'vibe_text') {
                try {
                    // Triple-check abort before heavy TTS call
                    if (signal?.aborted || aborted) return;
                    const combined = tokens.join(' ').replace(/\s+/g, ' ').trim();
                    log(`[speakTokenList] *** VIBE_TEXT FAST-PATH *** → single GPT TTS for: "${combined.slice(0, 120)}${combined.length > 120 ? '…' : ''}"`);
                    const ttsFilePath = await genTokenAudio(combined, 'vibe_text', { abortSignal: signal });
                    if (signal?.aborted || aborted) return;
                    await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                    log(`[speakTokenList] *** VIBE_TEXT FAST-PATH COMPLETED *** for: "${combined.slice(0, 50)}${combined.length > 50 ? '...' : ''}"`);
                    // Proceed to next chunk
                    continue;
                } catch (e) {
                    log(`[speakTokenList] VIBE_TEXT fast-path failed, falling back to tokenized playback: ${e}`);
                    // Fall through to regular per-token flow
                }
            }
            
            for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
                const token = tokens[tokenIndex];
                
                // Check for abort before each token
                if (signal?.aborted || aborted) {
                    log(`[speakTokenList] ABORTED at chunk ${chunkIndex + 1}, token ${tokenIndex + 1}. signal.aborted=${signal?.aborted}, aborted=${aborted}`);
                    return;
                }
                
                log(`[speakTokenList] About to process token ${tokenIndex + 1}/${tokens.length}: "${token}"`);
                
                try {
                    // TRIPLE-check abort signal right before audio playback (especially important for Korean TTS)
                    if (signal?.aborted || aborted) {
                        log(`[speakTokenList] ABORTED right before playing token: "${token}"`);
                        return;
                    }
                    
                    // Note: Removed overly aggressive line token reading check here
                    // The abort signal mechanism should be sufficient for stopping
                    
                    // Clear stopping state immediately before each token to prevent false aborts
                    audioPlayer.clearStoppingState();
                    
                    // New simplified token processing logic - check earcons first, regardless of category
                    if (isEarcon(token)) {
                        // Earcons (brackets, quotes, etc.) use PCM files - highest priority
                        log(`[speakTokenList] Playing EARCON for: "${token}" (category: ${category})`);
                        await playEarcon(token, panning);
                    } else if (getSpecialCharSpoken(token)) {
                        // Special characters that should be spoken (even with categories)
                        log(`[speakTokenList] Using TTS for special character: "${token}" -> "${getSpecialCharSpoken(token)}" (category: ${category})`);
                        const specialKey = `special_${token}`;
                        if (ttsPregenPromises.has(specialKey)) {
                            log(`[speakTokenList] Using PRE-GENERATED TTS for special character: "${token}"`);
                            const ttsFilePath = await ttsPregenPromises.get(specialKey)!;
                            await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                        } else {
                            // Fallback to immediate generation
                            const spokenForm = getSpecialCharSpoken(token)!;
                            const ttsFilePath = await genTokenAudio(spokenForm, 'special', { abortSignal: signal });
                            await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                        }
                    } else if (category && category !== 'default' && category !== 'other') {
                        // If we have a meaningful category, use TTS with category-specific voice
                        log(`[speakTokenList] Using category-based TTS for: "${token}" (category: ${category})`);
                        const categoryVoice = getSpeakerForCategory(category);
                        
                        // Check if we have a pre-generated TTS file - use same key format as pre-generation
                        const pregenKey = `${token}:${category}`;
                        if (ttsPregenPromises.has(pregenKey)) {
                            log(`[speakTokenList] Using PRE-GENERATED TTS for: "${token}" (${category}) with key: "${pregenKey}"`);
                            
                            // Check abort signal before waiting for pre-generated TTS
                            if (signal?.aborted || aborted) {
                                log(`[speakTokenList] ABORTED before waiting for pre-generated TTS: "${token}"`);
                                return;
                            }
                            
                            try {
                                const ttsFilePath = await ttsPregenPromises.get(pregenKey)!;
                                log(`[speakTokenList] Retrieved TTS file path: "${ttsFilePath}" for key: "${pregenKey}"`);
                                
                                // Check abort signal after TTS generation completes
                                if (signal?.aborted || aborted) {
                                    log(`[speakTokenList] ABORTED after pre-generated TTS completed: "${token}"`);
                                    return;
                                }
                                
                                await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                                
                                // Check abort signal immediately after audio playback (critical for Korean TTS)
                                if (signal?.aborted || aborted) {
                                    log(`[speakTokenList] ABORTED immediately after pre-generated audio playback: "${token}"`);
                                    audioPlayer.stopCurrentPlayback(true); // Force immediate stop of any remaining audio
                                    return;
                                }
                            } catch (error) {
                                // Handle abort errors gracefully
                                if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                    log(`[speakTokenList] Pre-generated TTS aborted for token: "${token}"`);
                                    return;
                                }
                                // Re-throw non-abort errors
                                throw error;
                            }
                        } else {
                            // Generate new TTS with category voice
                            log(`[speakTokenList] Generating NEW TTS for: "${token}" (${category}) - checking abort frequently`);
                            
                            // Check abort signal before TTS generation
                            if (signal?.aborted || aborted) {
                                log(`[speakTokenList] ABORTED before TTS generation: "${token}"`);
                                return;
                            }
                            
                            try {
                                const ttsFilePath = await genTokenAudio(token, category, { abortSignal: signal });
                                
                                // Check abort signal after TTS generation (especially important for Korean TTS)
                                if (signal?.aborted || aborted) {
                                    log(`[speakTokenList] ABORTED after TTS generation completed: "${token}"`);
                                    return;
                                }
                                
                                await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                                
                                // Check abort signal immediately after audio playback (critical for Korean TTS)
                                if (signal?.aborted || aborted) {
                                    log(`[speakTokenList] ABORTED immediately after new TTS audio playback: "${token}"`);
                                    audioPlayer.stopCurrentPlayback(true); // Force immediate stop of any remaining audio
                                    return;
                                }
                            } catch (error) {
                                // Handle abort errors gracefully
                                if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                    log(`[speakTokenList] New TTS generation aborted for token: "${token}"`);
                                    return;
                                }
                                // Re-throw non-abort errors
                                throw error;
                            }
                        }
                    } else {
                        // No meaningful category - determine by token characteristics
                        if (isAlphabet(token)) {
                            // Single letters use alphabet PCM files
                            log(`[speakTokenList] Playing ALPHABET PCM for: "${token}" (no category)`);
                            const lower = token.toLowerCase();
                            const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
                            if (fs.existsSync(alphaPath)) {
                                await audioPlayer.playPcmCached(alphaPath, panning);
                            } else {
                                // Fallback to TTS if PCM file missing
                                await speakTokenImmediate(token, category, { panning });
                            }
                        } else if (isNumber(token)) {
                            // Single digits use number PCM files
                            log(`[speakTokenList] Playing NUMBER PCM for: "${token}" (no category)`);
                            const numPath = path.join(config.numberPath(), `${token}.pcm`);
                            if (fs.existsSync(numPath)) {
                                await audioPlayer.playPcmCached(numPath, panning);
                            } else {
                                // Fallback to TTS if PCM file missing
                                await speakTokenImmediate(token, category, { panning });
                            }
                        } else if (getSpecialCharSpoken(token)) {
                            // Special characters (like underbar, dot) that should be spoken
                            log(`[speakTokenList] Using TTS for special character: "${token}" -> "${getSpecialCharSpoken(token)}" (no category)`);
                            const specialKey = `special_${token}`;
                            if (ttsPregenPromises.has(specialKey)) {
                                log(`[speakTokenList] Using PRE-GENERATED TTS for special character: "${token}"`);
                                try {
                                    const ttsFilePath = await ttsPregenPromises.get(specialKey)!;
                                    await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                                } catch (error) {
                                    if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                        log(`[speakTokenList] Pre-generated special character TTS aborted for token: "${token}"`);
                                        return;
                                    }
                                    throw error;
                                }
                            } else {
                                // Fallback to immediate generation
                                try {
                                    const spokenForm = getSpecialCharSpoken(token)!;
                                    const ttsFilePath = await genTokenAudio(spokenForm, 'special', { abortSignal: signal });
                                    await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                                } catch (error) {
                                    if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                        log(`[speakTokenList] Special character TTS generation aborted for token: "${token}"`);
                                        return;
                                    }
                                    throw error;
                                }
                            }
                        } else if (isTTSRequired(token)) {
                            // Everything else that needs TTS - use same key format as pre-generation
                            const pregenKey = category ? `${token}:${category}` : token;
                            if (ttsPregenPromises.has(pregenKey)) {
                                log(`[speakTokenList] Using PRE-GENERATED TTS for: "${token}" (no category)`);
                                try {
                                    const ttsFilePath = await ttsPregenPromises.get(pregenKey)!;
                                    await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                                } catch (error) {
                                    if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                        log(`[speakTokenList] Pre-generated TTS aborted for token: "${token}" (no category)`);
                                        return;
                                    }
                                    throw error;
                                }
                            } else {
                                log(`[speakTokenList] Generating NEW TTS for: "${token}" (no category)`);
                                try {
                                    await speakTokenImmediate(token, category, { panning });
                                } catch (error) {
                                    if (signal?.aborted || aborted || (error instanceof Error && error.message.includes('aborted'))) {
                                        log(`[speakTokenList] Immediate TTS generation aborted for token: "${token}"`);
                                        return;
                                    }
                                    throw error;
                                }
                            }
                        } else {
                            log(`[speakTokenList] Skipping empty or whitespace token: "${token}"`);
                        }
                    }
                    log(`[speakTokenList] Successfully completed token: "${token}"`);
                } catch (err) {
                    log(`[speakTokenList] Error speaking token "${token}": ${err}`);
                    // Continue with next token instead of stopping completely
                }
            }
            log(`[speakTokenList] Completed chunk ${chunkIndex + 1}/${chunks.length}`);
        }
        log(`[speakTokenList] Successfully completed all ${chunks.length} chunks`);
    } catch (err) {
        log(`[speakTokenList] Unexpected error in main loop: ${err}`);
        throw err;
    } finally {
        if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
        }
        
        // Clean up any remaining unresolved TTS promises to prevent unhandled rejections
        if (ttsPregenPromises.size > 0) {
            log(`[speakTokenList] Cleaning up ${ttsPregenPromises.size} remaining TTS promises`);
            for (const [key, promise] of ttsPregenPromises) {
                promise.catch((error: any) => {
                    // Silently handle aborted promises to prevent unhandled rejections
                    if (error instanceof Error && error.message.includes('aborted')) {
                        log(`[speakTokenList] Cleaned up aborted TTS promise for: ${key}`);
                    } else {
                        log(`[speakTokenList] Cleaned up TTS promise error for ${key}: ${error}`);
                    }
                });
            }
        }
        
        // KOREAN TTS PROTECTION: Clear the protection flag
        if (isKoreanTTS) {
            (global as any).koreanTTSActive = false;
            log(`[speakTokenList] Korean TTS protection disabled`);
        }
        
        log(`[speakTokenList] Finished (cleanup completed)`);
    }
}

// Internal function for immediate token playback without queueing
async function speakTokenImmediate(
    token: string,
    category?: string,
    opts?: { panning?: number }
): Promise<void> {
    try {
        log(`[speakTokenImmediate] token="${token}" category="${category}"`);
        
        // Use the same simplified logic as speakToken and speakTokenList
        if (category && category !== 'default' && category !== 'other') {
            // Category-based TTS
            log(`[speakTokenImmediate] Using category-based TTS for: "${token}" (category: ${category})`);
            const categoryVoice = getSpeakerForCategory(category);
            const filePath = await genTokenAudio(token, category, { speaker: categoryVoice });
            await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
        } else if (isEarcon(token)) {
            // Earcons
            log(`[speakTokenImmediate] Playing EARCON for: "${token}"`);
            await playEarcon(token, opts?.panning);
        } else if (isAlphabet(token)) {
            // Alphabet PCM files
            log(`[speakTokenImmediate] Processing alphabet token: ${token}`);
            const lower = token.toLowerCase();
            const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
            if (fs.existsSync(alphaPath)) {
                log(`[speakTokenImmediate] Playing cached alphabet PCM: ${alphaPath}`);
                await audioPlayer.playPcmCached(alphaPath, opts?.panning);
            } else {
                log(`[speakTokenImmediate] Generating TTS for alphabet: ${token}`);
                const filePath = await genTokenAudio(token, category);
                await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
            }
        } else if (isNumber(token)) {
            // Number PCM files
            log(`[speakTokenImmediate] Processing number token: ${token}`);
            const numPath = path.join(config.numberPath(), `${token}.pcm`);
            if (fs.existsSync(numPath)) {
                log(`[speakTokenImmediate] Playing cached number PCM: ${numPath}`);
                await audioPlayer.playPcmCached(numPath, opts?.panning);
            } else {
                log(`[speakTokenImmediate] Generating TTS for number: ${token}`);
                const filePath = await genTokenAudio(token, category);
                await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
            }
        } else if (getSpecialCharSpoken(token)) {
            // Special characters
            log(`[speakTokenImmediate] Using TTS for special character: "${token}" -> "${getSpecialCharSpoken(token)}"`);
            const spokenForm = getSpecialCharSpoken(token)!;
            const filePath = await genTokenAudio(spokenForm, 'special');
            await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
        } else if (isTTSRequired(token)) {
            // General TTS
            log(`[speakTokenImmediate] Processing TTS token: ${token}`);
            try {
                const filePath = await genTokenAudio(token, category);
                await audioPlayer.playTtsAsPcm(filePath, opts?.panning);
            } catch (ttsError) {
                log(`[speakTokenImmediate] TTS failed for "${token}", trying fallback playback: ${ttsError}`);
                // Fallback: Try to use external player to speak the token directly
                try {
                    // Use system TTS as fallback
                    if (process.platform === 'darwin') {
                        const cp = spawn('say', [token], { stdio: 'ignore' });
                        await new Promise<void>((resolve) => {
                            cp.on('close', () => resolve());
                            cp.on('error', () => resolve()); // Don't fail on error
                        });
                        log(`[speakTokenImmediate] Fallback 'say' completed for: ${token}`);
                    } else {
                        // For non-macOS, just log the token
                        log(`[speakTokenImmediate] No TTS fallback available, skipping: ${token}`);
                    }
                } catch (fallbackError) {
                    log(`[speakTokenImmediate] Fallback also failed for "${token}": ${fallbackError}`);
                }
            }
        } else {
            log(`[speakTokenImmediate] Skipping token (no handler): ${token}`);
            return Promise.resolve();
        }
        log(`[speakTokenImmediate] COMPLETED token: ${token}`);
    } catch (err: any) {
        log(`[speakTokenImmediate] Error handling token "${token}": ${err.stack || err}`);
        throw err;
    }
}

export function playWave(
    filePath: string,
    opts?: { isEarcon?: boolean; rate?: number; immediate?: boolean; panning?: number }
): Promise<void> {
    // Clear stopping state if it might be lingering inappropriately
    // This is a safety net for legitimate audio that should play
    if (opts?.immediate) {
        audioPlayer.clearStoppingState();
    }
    
    // Apply global playspeed if no specific rate is provided
    const effectiveRate = opts?.rate ?? config.playSpeed;
    
    // Check if this is an alphabet character - for faster processing
    const isAlphabetChar = filePath.includes('/alphabet/') || filePath.includes('\\alphabet\\');
    
    // Check if this is a Korean TTS file (contains 'openai_ko' in filename)
    const isKoreanTTS = path.basename(filePath).includes('openai_ko');
    const volumeBoost = isKoreanTTS ? openaiTTSConfig.volumeBoost : undefined;
    
    // For earcons, use pitch-preserving processing if speed != 1.0 to maintain correct pitch
    if (opts?.isEarcon) {
        if (Math.abs(effectiveRate - 1.0) > 0.01 && config.preservePitch) {
            log(`[playWave] EARCON - Using pitch-preserving processing for earcon: ${path.basename(filePath)}`);
            // Use pitch-preserving processing for earcons when speed != 1.0
            return applyAudioProcessing(filePath, effectiveRate, volumeBoost)
                .then(processedFilePath => {
                    return audioPlayer.playWavFile(processedFilePath, {
                        ...opts,
                        rate: 1.0 // Don't apply rate again - it's already in the processed file
                    });
                });
        } else {
            log(`[playWave] EARCON - Direct playback at normal speed: ${path.basename(filePath)}`);
            return audioPlayer.playWavFile(filePath, { ...opts, rate: effectiveRate });
        }
    }
    
    // Use audio processing if pitch preservation is enabled, rate != 1.0, or volume boost is needed
    // BUT skip pitch-preserving for alphabet characters to avoid delay
    const needsProcessing = ((config.preservePitch && Math.abs(effectiveRate - 1.0) > 0.01 && !isAlphabetChar) || 
                           (volumeBoost && Math.abs(volumeBoost - 1.0) > 0.01));
    
    if (isAlphabetChar && config.preservePitch && Math.abs(effectiveRate - 1.0) > 0.01) {
        log(`[playWave] Using FAST sample-rate method for alphabet char (bypassing pitch-preserving): ${path.basename(filePath)}`);
    }
    
    if (needsProcessing) {
        return applyAudioProcessing(filePath, effectiveRate, volumeBoost)
            .then(processedFilePath => {
                // Play the processed file at normal rate (1.0) since tempo and volume are already adjusted
                return audioPlayer.playWavFile(processedFilePath, {
                    ...opts,
                    rate: 1.0 // Don't apply rate again - it's already in the processed file
                });
            })
            .catch(error => {
                log(`[playWave] Audio processing failed: ${error}, falling back to sample rate adjustment`);
                // Fallback to original method if FFmpeg fails
                return audioPlayer.playWavFile(filePath, { ...opts, rate: effectiveRate });
            });
    }
    
    // Use original sample rate adjustment method
    const effectiveOpts = {
        ...opts,
        rate: effectiveRate
    };
    return audioPlayer.playWavFile(filePath, effectiveOpts);
}

export function generateTone(duration = 200, freq = 440): Promise<void> {
    const sampleRate = 44100;
    const total = Math.floor((sampleRate * duration) / 1000);
    
    return new Promise((resolve, reject) => {
        const speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
        let i = 0;
        const stream = new Readable({
            read() {
                if (i < total) {
                    const t = i++ / sampleRate;
                    const amp = Math.sin(2 * Math.PI * freq * t) * 32767;
                    const buf = Buffer.alloc(2);
                    buf.writeInt16LE(amp, 0);
                    this.push(buf);
                } else {
                    this.push(null);
                }
            },
        });
        stream.pipe(speaker);
        speaker.on('close', resolve);
        speaker.on('error', reject);
    });
}

export function stopPlayback(): void {
    logAudioEvent('cancel', { reason: 'manual_stop' });
    audioPlayer.stopAll();
}

export function clearAudioStoppingState(): void {
    audioPlayer.clearStoppingState();
}

export function cleanupAudioResources(): void {
    audioPlayer.cleanup();
}

// ===============================
// THINKING AUDIO SYSTEM
// ===============================

class ThinkingAudioPlayer {
    private speaker: any = null;
    private isPlaying = false;
    private thinkingInterval: NodeJS.Timeout | null = null;
    
    constructor() {
        log('[ThinkingAudio] Thinking audio player initialized'); 
    }
    
    private get thinkingPcmPath(): string {
        return path.join(config.audioPath(), 'alert', 'thinking.pcm');
    }
    
    private get thinkingFinishedPcmPath(): string {
        return path.join(config.audioPath(), 'alert', 'thinking_finished.pcm');
    }
    
    async startThinking(): Promise<void> {
        if (this.isPlaying) {
            log('[ThinkingAudio] Thinking audio already playing');
            return;
        }
        
        try {
            // Log paths for debugging
            log(`[ThinkingAudio] Thinking PCM path: ${this.thinkingPcmPath}`);
            log(`[ThinkingAudio] Thinking finished PCM path: ${this.thinkingFinishedPcmPath}`);
            log(`[ThinkingAudio] Thinking PCM exists: ${fs.existsSync(this.thinkingPcmPath)}`);
            log(`[ThinkingAudio] Thinking finished PCM exists: ${fs.existsSync(this.thinkingFinishedPcmPath)}`);
            
            // Stop any current audio to avoid conflicts
            audioPlayer.stopCurrentPlayback();
            
            this.isPlaying = true;
            log('[ThinkingAudio] Starting continuous thinking audio loop');
            
            // Play thinking.pcm in a loop
            await this.playThinkingLoop();
            
        } catch (error) {
            logError(`[ThinkingAudio] Error starting thinking audio: ${error}`);
            this.isPlaying = false;
        }
    }
    
    async stopThinking(): Promise<void> {
        if (!this.isPlaying) {
            return;
        }
        
        log('[ThinkingAudio] Stopping thinking audio');
        this.isPlaying = false;
        
        // Clear the interval
        if (this.thinkingInterval) {
            clearTimeout(this.thinkingInterval);
            this.thinkingInterval = null;
        }
        
        // Stop current speaker
        if (this.speaker) {
            try {
                this.speaker.end();
            } catch (error) {
                log(`[ThinkingAudio] Error stopping speaker: ${error}`);
            }
            this.speaker = null;
        }
    }
    
    async playThinkingFinished(): Promise<void> {
        try {
            log('[ThinkingAudio] Playing thinking finished sound');
            
            // Stop thinking loop first
            await this.stopThinking();
            
            // Play thinking_finished.pcm once
            if (fs.existsSync(this.thinkingFinishedPcmPath)) {
                await audioPlayer.playPcmCached(this.thinkingFinishedPcmPath);
            } else {
                log('[ThinkingAudio] thinking_finished.pcm not found');
            }
            
        } catch (error) {
            logError(`[ThinkingAudio] Error playing thinking finished: ${error}`);
        }
    }
    
    private async playThinkingLoop(): Promise<void> {
        if (!this.isPlaying) {
            log('[ThinkingAudio] Stopping loop - not playing');
            return;
        }
        
        if (!fs.existsSync(this.thinkingPcmPath)) {
            logError(`[ThinkingAudio] Thinking PCM file not found: ${this.thinkingPcmPath}`);
            return;
        }
        
        try {
            log('[ThinkingAudio] Playing thinking.pcm');
            // Play thinking.pcm
            await audioPlayer.playPcmCached(this.thinkingPcmPath);
            log('[ThinkingAudio] Finished playing thinking.pcm');
            
            // Schedule next iteration if still thinking
            if (this.isPlaying) {
                log('[ThinkingAudio] Scheduling next thinking loop iteration');
                this.thinkingInterval = setTimeout(() => {
                    this.playThinkingLoop();
                }, 100); // Small gap between loops
            }
            
        } catch (error) {
            if (this.isPlaying) {
                logError(`[ThinkingAudio] Error in thinking loop: ${error}`);
                // Try to continue the loop despite error
                this.thinkingInterval = setTimeout(() => {
                    this.playThinkingLoop();
                }, 500);
            }
        }
    }
    
    isThinking(): boolean {
        return this.isPlaying;
    }
}

const thinkingAudioPlayer = new ThinkingAudioPlayer();

export async function startThinkingAudio(): Promise<void> {
    await thinkingAudioPlayer.startThinking();
}

export async function stopThinkingAudio(): Promise<void> {
    await thinkingAudioPlayer.stopThinking();
}

export async function playThinkingFinished(): Promise<void> {
    await thinkingAudioPlayer.playThinkingFinished();
}

export function isThinkingAudioPlaying(): boolean {
    return thinkingAudioPlayer.isThinking();
}

export async function testThinkingAudio(): Promise<void> {
    log('[ThinkingAudio] Testing thinking audio system...');
    try {
        await startThinkingAudio();
        await new Promise(resolve => setTimeout(resolve, 3000)); // Play for 3 seconds
        await playThinkingFinished();
        log('[ThinkingAudio] Test completed successfully');
    } catch (error) {
        logError(`[ThinkingAudio] Test failed: ${error}`);
    }
}

export async function playSequence(filePaths: string[], opts?: { rate?: number }): Promise<void> {
    return audioPlayer.playSequence(filePaths, opts);
}

/**
 * Check if audio is currently playing (TTS, PCM, WAV, etc.)
 */
export function isAudioPlaying(): boolean {
    return audioPlayer.isPlaying() || thinkingAudioPlayer.isThinking();
}