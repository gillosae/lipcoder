import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as wav from 'wav';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import { log, logWarning, logInfo, logError, logSuccess } from './utils';
import { config, sileroConfig } from './config';
import { isAlphabet, isNumber, specialCharMap } from './mapping';

// Import from the new modules
import { playEarcon, stopEarconPlayback, isEarconToken, findTokenSound, earconRaw } from './earcon';
import { genTokenAudio, playSpecial, isTTSRequired, getSpeakerForCategory } from './tts';

// Import word logic for universal application
import { splitWordChunks, splitCommentChunks } from './features/word_logic';

// Re-export functions that other modules expect from audio.ts
export { genTokenAudio, playSpecial } from './tts';
export { playEarcon, earconRaw } from './earcon';

// ===============================
// PITCH-PRESERVING TIME STRETCHING
// ===============================

/**
 * Apply pitch-preserving time stretching to an audio file using FFmpeg
 * Returns path to the processed file (cached for efficiency)
 */
async function applyPitchPreservingTimeStretch(inputFilePath: string, playSpeed: number): Promise<string> {
    // Skip processing if playspeed is 1.0 (no change needed)
    if (Math.abs(playSpeed - 1.0) < 0.01) {
        return inputFilePath;
    }
    
    // Generate cache key based on file and playspeed
    const inputBasename = path.basename(inputFilePath, path.extname(inputFilePath));
    const speedKey = playSpeed.toFixed(3).replace('.', '_');
    const outputFileName = `${inputBasename}_speed${speedKey}.wav`;
    const outputFilePath = path.join(os.tmpdir(), 'lipcoder_timestretch', outputFileName);
    
    // Create cache directory if it doesn't exist
    const cacheDir = path.dirname(outputFilePath);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // Return cached file if it exists and is newer than input
    if (fs.existsSync(outputFilePath)) {
        const inputStat = fs.statSync(inputFilePath);
        const outputStat = fs.statSync(outputFilePath);
        if (outputStat.mtime > inputStat.mtime) {
            log(`[timeStretch] Using cached time-stretched file: ${outputFileName}`);
            return outputFilePath;
        }
    }
    
    log(`[timeStretch] Applying ${playSpeed}x time stretch with pitch preservation to: ${path.basename(inputFilePath)}`);
    
    // Check if input file exists
    if (!fs.existsSync(inputFilePath)) {
        const error = new Error(`Input file does not exist: ${inputFilePath}`);
        logError(`[timeStretch] ${error.message}`);
        return Promise.reject(error);
    }
    
    return new Promise((resolve, reject) => {
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
        
        const filterChain = atempoFilters.join(',');
        
        // Check if input is a PCM file and add format specifications
        const isPcmFile = inputFilePath.toLowerCase().endsWith('.pcm');
        let ffmpegArgs: string[];
        
        if (isPcmFile) {
            // For PCM files, specify the format explicitly using standard PCM format
            log(`[timeStretch] PCM file detected, using format: ${STANDARD_PCM_FORMAT.channels}ch, ${STANDARD_PCM_FORMAT.sampleRate}Hz, 16-bit`);
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
        
        log(`[timeStretch] Running: ffmpeg ${ffmpegArgs.join(' ')}`);
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, { 
            stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
        });
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log(`[timeStretch] Successfully created time-stretched file: ${outputFileName}`);
                resolve(outputFilePath);
            } else {
                logError(`[timeStretch] FFmpeg failed with code ${code}. stderr: ${stderr}`);
                reject(new Error(`FFmpeg time stretch failed: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            logError(`[timeStretch] FFmpeg spawn error: ${err}`);
            reject(err);
        });
    });
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
    private currentSpeaker: Speaker | null = null;
    private currentReader: wav.Reader | null = null;
    private currentFileStream: fs.ReadStream | null = null;
    private currentFallback: ChildProcess | null = null;
    private playQueue = Promise.resolve();
    private isStopping = false; // Flag to prevent new audio during stop
    private stoppingTimeout: NodeJS.Timeout | null = null;

    private cache = new AudioCache();
    private fallbackManager = new FallbackPlayerManager();

    async playPcmCached(filePath: string, panning?: number): Promise<void> {
        // Check if we're in the middle of stopping - abort immediately  
        if (this.isStopping) {
            log(`[playPcmCached] Aborted - stopping in progress for: ${path.basename(filePath)}`);
            return;
        }
        
        // For pitch-preserving PCM playback, convert to WAV and use time stretching
        if (config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01) {
            log(`[playPcmCached] Using pitch-preserving time stretching for: ${path.basename(filePath)}`);
            try {
                // Load PCM data and convert to temporary WAV
                const originalEntry = this.cache.loadAndCache(filePath);
                const pcmData = originalEntry.pcm;
                const format = originalEntry.format;
                
                // Create temporary WAV file for FFmpeg processing
                const tempWavPath = path.join(os.tmpdir(), `pcm_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
                
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
                
                // Use pitch-preserving time stretching
                const processedFilePath = await applyPitchPreservingTimeStretch(tempWavPath, config.playSpeed);
                
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
                    const speaker = new Speaker({ ...finalFormat, samplesPerFrame: 128 } as any);
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
            const speaker = new Speaker({ ...adjustedFormat, samplesPerFrame: 128 } as any);
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
            const speaker = new Speaker({ ...format, samplesPerFrame: 128 } as any);
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
                    const speaker = new Speaker({ ...adjusted, samplesPerFrame: 128 } as any);
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
                const speaker = new Speaker({ ...finalFormat, samplesPerFrame: 128 } as any);
                this.currentSpeaker = speaker;
                
                speaker.on('close', () => {
                    log(`[playWavFileDirectBuffer] FAST playback completed for: ${path.basename(filePath)}`);
                    resolve();
                });
                speaker.on('error', (err) => {
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

    private handlePannedPlayback(reader: wav.Reader, speaker: Speaker, format: any, panning: number): void {
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
            log(`[playWavFile] Aborted - stopping in progress for: ${path.basename(filePath)}`);
            return;
        }
        
        log(`[playWavFile] Starting playback for: ${path.basename(filePath)}, opts: ${JSON.stringify(opts)}`);
        
        if (!fs.existsSync(filePath)) {
            log(`🔕 playWavFile skipping missing file: ${filePath}`);
            return Promise.resolve();
        }

        const isPcmFile = filePath.toLowerCase().endsWith('.pcm');
        log(`[playWavFile] File type: ${isPcmFile ? 'PCM' : 'WAV'}`);
        
        if (isPcmFile) {
            log(`[playWavFile] Delegating to playPcmFile`);
            return this.playPcmFile(filePath, opts);
        }
        
        // Use immediate fallback player only if no panning is needed
        if (opts?.immediate && (opts?.panning === undefined || opts?.panning === 0)) {
            log(`[playWavFile] Using immediate fallback player (no panning)`);
            const p = this.fallbackManager.createPlayer(filePath);
            this.playQueue = p.catch(() => {});
            return p;
        }
        
        // FAST PATH: For immediate playback with panning, use direct buffer approach
        if (opts?.immediate && opts?.panning !== undefined && opts?.panning !== 0) {
            log(`[playWavFile] Using FAST direct buffer playback with panning: ${opts.panning}`);
            return this.playWavFileDirectBuffer(filePath, opts);
        }
        
        // Use immediate WAV reader for other cases
        if (opts?.immediate) {
            log(`[playWavFile] Using immediate WAV reader (no panning)`);
            return this.playWavFileInternal(filePath, opts);
        }
        
        if (opts?.isEarcon) {
            log(`[playWavFile] Playing earcon via raw PCM cache: ${filePath}`);
            const fname = path.basename(filePath, '.pcm');
            if (findTokenSound(fname)) {
                return playEarcon(fname, 0);
            }
        }

        log(`[playWavFile] Using WAV reader with queueing, panning: ${opts?.panning}`);
        this.playQueue = this.playQueue.then(() => {
            log(`[playWavFile] Queue executing for: ${path.basename(filePath)}`);
            return this.playWavFileInternal(filePath, opts);
        });
        return this.playQueue;
    }

    private async playWavFileInternal(filePath: string, opts?: { rate?: number; panning?: number }): Promise<void> {
        log(`[playWavFileInternal] Starting internal playback for: ${path.basename(filePath)}`);
        
        return new Promise<void>((resolve, reject) => {
            log(`[playWavFileInternal] Creating file stream and WAV reader`);
            const fileStream = fs.createReadStream(filePath);
            this.currentFileStream = fileStream;
            const reader = new wav.Reader();
            this.currentReader = reader;
            let fallback = false;

            const doFallback = (err: any) => {
                log(`🛑 wav-stream error: ${err.stack || err}`);
                if (fallback) return;
                fallback = true;
                reader.removeAllListeners();
                fileStream.unpipe(reader);
                fileStream.destroy();
                
                log(`[playWavFileInternal] Falling back to external player`);
                this.fallbackManager.createPlayer(filePath)
                    .then(() => {
                        log(`[playWavFileInternal] Fallback player completed for: ${path.basename(filePath)}`);
                        resolve();
                    })
                    .catch(reject);
            };

            reader.on('format', (format: any) => {
                log(`🔊 got format: ${JSON.stringify(format)}`);
                log(`[playWavFileInternal] Processing format for: ${path.basename(filePath)}`);
                try {
                    const adjusted = { ...format };
                    if (opts?.rate !== undefined) {
                        adjusted.sampleRate = Math.floor(format.sampleRate * opts.rate);
                        log(`[playWavFileInternal] Adjusted sample rate to: ${adjusted.sampleRate}`);
                    }
                    
                    log(`[playWavFileInternal] Stopping current playback before starting new`);
                    this.stopCurrentPlayback();
                    
                    log(`[playWavFileInternal] Creating Speaker with format: ${JSON.stringify(adjusted)}`);
                    // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
                    const speaker = new Speaker({ ...adjusted, samplesPerFrame: 128 } as any);
                    this.currentSpeaker = speaker;
                    
                    speaker.on('close', () => {
                        log(`[playWavFileInternal] Speaker closed for: ${path.basename(filePath)}`);
                        resolve();
                    });
                    speaker.on('error', (err) => {
                        log(`[playWavFileInternal] Speaker error for ${path.basename(filePath)}: ${err}`);
                        reject(err);
                    });
                    
                    if (opts?.panning !== undefined && opts.panning !== 0 && format.channels === 2) {
                        log(`[playWavFileInternal] Using panned playback with panning: ${opts.panning}`);
                        this.handlePannedPlayback(reader, speaker, format, opts.panning);
                    } else if (opts?.panning !== undefined && opts.panning !== 0 && format.channels === 1) {
                        log(`[playWavFileInternal] Mono file with panning requested - converting to stereo on-the-fly`);
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
                            const stereoSpeaker = new Speaker({ ...stereoFormat, samplesPerFrame: 128 } as any);
                            this.currentSpeaker = stereoSpeaker;
                            
                            stereoSpeaker.on('close', () => {
                                log(`[playWavFileInternal] Stereo speaker closed for: ${path.basename(filePath)}`);
                                resolve();
                            });
                            stereoSpeaker.on('error', (err) => {
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

    stopCurrentPlayback(): void {
        this.isStopping = true; // Prevent new audio from starting
        
        if (this.currentSpeaker) {
            try {
                this.currentSpeaker.destroy();
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
        this.stopCurrentPlayback();
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

    async playTtsAsPcm(wavFilePath: string, panning?: number): Promise<void> {
        // Check if we're in the middle of stopping - abort immediately  
        if (this.isStopping) {
            log(`[playTtsAsPcm] Aborted - stopping in progress for: ${path.basename(wavFilePath)}`);
            return;
        }
        
        log(`[playTtsAsPcm] SIMPLE FAST TTS playback: ${path.basename(wavFilePath)}, panning: ${panning}`);
        
        // Use pitch-preserving time stretching if enabled and playspeed != 1.0
        if (config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01) {
            try {
                log(`[playTtsAsPcm] Using pitch-preserving time stretching for playspeed ${config.playSpeed}x`);
                const processedFilePath = await applyPitchPreservingTimeStretch(wavFilePath, config.playSpeed);
                
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
                    
                    // @ts-ignore: samplesPerFrame used for low-latency
                    const speaker = new Speaker({ ...finalFormat, samplesPerFrame: 128 } as any);
                    this.currentSpeaker = speaker;
                    
                    speaker.on('close', () => {
                        log(`[playTtsAsPcm] Pitch-preserving playback completed: ${path.basename(wavFilePath)}`);
                        resolve();
                    });
                    speaker.on('error', reject);
                    
                    log(`[playTtsAsPcm] Writing ${finalPcm.length} bytes to speaker (pitch-preserving)`);
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
            const wavData = fs.readFileSync(wavFilePath);
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
                
                // @ts-ignore: samplesPerFrame used for low-latency
                const speaker = new Speaker({ ...adjustedFormat, samplesPerFrame: 128 } as any);
                this.currentSpeaker = speaker;
                
                speaker.on('close', () => {
                    log(`[playTtsAsPcm] Sample rate adjustment playback completed: ${path.basename(wavFilePath)}`);
                    resolve();
                });
                speaker.on('error', reject);
                
                log(`[playTtsAsPcm] Writing ${finalPcm.length} bytes to speaker (sample rate adjustment)`);
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

const audioPlayer = new AudioPlayer();

// ===============================
// PUBLIC API (maintaining backward compatibility)
// ===============================

export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string; signal?: AbortSignal; panning?: number }
): Promise<void> {
    try {
        log(`[speakToken] token="${token}" category="${category}"`);
        let playPromise: Promise<void>;
        
        if (isAlphabet(token)) {
            const lower = token.toLowerCase();
            const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
            if (fs.existsSync(alphaPath)) {
                playPromise = audioPlayer.playPcmCached(alphaPath, opts?.panning);
            } else {
                const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker ?? getSpeakerForCategory(category) });
                playPromise = playWave(filePath, { panning: opts?.panning });
            }
        } else if (isNumber(token)) {
            const numPath = path.join(config.numberPath(), `${token}.pcm`);
            if (fs.existsSync(numPath)) {
                playPromise = audioPlayer.playPcmCached(numPath, opts?.panning);
            } else {
                const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker ?? getSpeakerForCategory(category) });
                playPromise = playWave(filePath, { panning: opts?.panning });
            }
        } else if (isEarconToken(token)) {
            playPromise = playEarcon(token, opts?.panning);
        } else if (isTTSRequired(token)) {
            const speakerName = opts?.speaker ?? getSpeakerForCategory(category);
            const filePath = await genTokenAudio(token, category, { speaker: speakerName });
            // Use ultra-fast PCM caching for regular speakToken too
            playPromise = audioPlayer.playTtsAsPcm(filePath, opts?.panning);
        } else {
            return Promise.resolve();
        }
        
        await playPromise;
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

export async function speakTokenList(chunks: TokenChunk[], signal?: AbortSignal): Promise<void> {
    let aborted = false;
    let abortListener: (() => void) | null = null;
    
    // Clear stopping state at the start of legitimate audio sequence
    audioPlayer.clearStoppingState();
    
    log(`[speakTokenList] Starting with ${chunks.length} chunks, signal aborted: ${signal?.aborted}`);
    
    if (signal) {
        if (signal.aborted) {
            log(`[speakTokenList] Signal already aborted before starting`);
            return;
        }
        
        abortListener = () => { 
            log(`[speakTokenList] ABORT SIGNAL RECEIVED - reading will stop`);
            aborted = true; 
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
                if (category === 'variable') {
                    // Apply word chunking to variables (handles CamelCase, underscores, 2/3-letter rules)
                    const wordChunks = splitWordChunks(token);
                    expandedTokens.push(...wordChunks);
                    log(`[speakTokenList] Variable "${token}" → [${wordChunks.join(', ')}]`);
                } else if (category === 'comment_text' || category === 'comment_symbol') {
                    // Apply comment chunking for comment-related tokens
                    const commentChunks = splitCommentChunks(token, category);
                    expandedTokens.push(...commentChunks);
                    log(`[speakTokenList] Comment "${token}" → [${commentChunks.join(', ')}]`);
                } else {
                    // Keep other tokens as-is
                    expandedTokens.push(token);
                }
            }
            
            // Create new chunk with expanded tokens
            processedChunks.push({
                tokens: expandedTokens,
                category,
                panning
            });
        }
        
        const originalTokenCount = chunks.reduce((total, chunk) => total + chunk.tokens.length, 0);
        const processedTokenCount = processedChunks.reduce((total, chunk) => total + chunk.tokens.length, 0);
        log(`[speakTokenList] Word logic applied: ${chunks.length} chunks (${originalTokenCount} tokens) → ${processedChunks.length} chunks (${processedTokenCount} tokens)`);
        
        // Use processed chunks for the rest of the function
        chunks = processedChunks;
        
        // PARALLEL TTS PRE-GENERATION: Use both workers simultaneously
        log(`[speakTokenList] Pre-generating TTS for all tokens in parallel...`);
        const ttsPregenPromises = new Map<string, Promise<string>>();
        
        for (const { tokens, category } of chunks) {
            for (const token of tokens) {
                // Priority 1: Check if this is a special character token (regardless of category)
                const isSpecialChar = specialCharMap[token] !== undefined;
                if (isSpecialChar) {
                    continue; // Special characters use direct TTS generation
                } else if (isEarconToken(token)) {
                    continue; // Earcons don't need TTS pre-generation
                } else if (isAlphabet(token) || isNumber(token)) {
                    continue; // Alphabet and numbers use PCM files, not TTS
                } else if (category && category !== 'other' && isTTSRequired(token)) {
                    // Pre-generate TTS for all tokens with meaningful categories
                    if (!ttsPregenPromises.has(token)) {
                        log(`[speakTokenList] Queuing TTS pre-generation for ${category}: "${token}"`);
                        ttsPregenPromises.set(token, genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) }));
                    }
                } else if (isTTSRequired(token) && !ttsPregenPromises.has(token)) {
                    log(`[speakTokenList] Queuing TTS pre-generation for: "${token}"`);
                    ttsPregenPromises.set(token, genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) }));
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
            log(`[speakTokenList] Processing chunk ${chunkIndex + 1}/${chunks.length}: ${tokens.length} tokens [${tokens.join(', ')}]`);
            
            for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
                const token = tokens[tokenIndex];
                
                // Check for abort before each token
                if (signal?.aborted || aborted) {
                    log(`[speakTokenList] ABORTED at chunk ${chunkIndex + 1}, token ${tokenIndex + 1}. signal.aborted=${signal?.aborted}, aborted=${aborted}`);
                    return;
                }
                
                log(`[speakTokenList] About to process token ${tokenIndex + 1}/${tokens.length}: "${token}"`);
                
                try {
                    // Double-check abort signal right before audio playback
                    if (signal?.aborted || aborted) {
                        log(`[speakTokenList] ABORTED right before playing token: "${token}"`);
                        return;
                    }
                    
                    // Clear stopping state immediately before each token to prevent false aborts
                    audioPlayer.clearStoppingState();
                    
                    // Route tokens to appropriate playback method
                    // Priority 1: Check if this is a special character token
                    const isSpecialChar = specialCharMap[token] !== undefined;
                    if (isSpecialChar && category === 'special') {
                        // Only use the old playSpecial for 'special' category
                        log(`[speakTokenList] Using SPECIAL TTS for: "${token}"`);
                        await playSpecial(token);
                    } else if (isEarconToken(token)) {
                        log(`[speakTokenList] Playing EARCON for: "${token}" (category: ${category})`);
                        await playEarcon(token, panning);
                    } else if (isAlphabet(token)) {
                        log(`[speakTokenList] Playing ALPHABET PCM for: "${token}"`);
                        const lower = token.toLowerCase();
                        const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
                        if (fs.existsSync(alphaPath)) {
                            await audioPlayer.playPcmCached(alphaPath, panning);
                        } else {
                            // Fallback to TTS for missing alphabet
                            await speakTokenImmediate(token, category, { panning });
                        }
                    } else if (isNumber(token)) {
                        log(`[speakTokenList] Playing NUMBER PCM for: "${token}"`);
                        const numPath = path.join(config.numberPath(), `${token}.pcm`);
                        if (fs.existsSync(numPath)) {
                            await audioPlayer.playPcmCached(numPath, panning);
                        } else {
                            // Fallback to TTS for missing number
                            await speakTokenImmediate(token, category, { panning });
                        }
                    } else if (category && category !== 'other' && isTTSRequired(token)) {
                        // Handle all tokens with meaningful categories using TTS
                        if (getSpeakerForCategory(category) !== sileroConfig.defaultSpeaker) {
                            log(`[speakTokenList] Using TTS with ${category} voice for: "${token}"`);
                            const ttsFilePath = await genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) });
                            await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                        } else if (ttsPregenPromises.has(token)) {
                            log(`[speakTokenList] Using PRE-GENERATED TTS for: "${token}" (${category})`);
                            const ttsFilePath = await ttsPregenPromises.get(token)!;
                            await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                        } else {
                            log(`[speakTokenList] Generating NEW TTS for: "${token}" (${category})`);
                            await speakTokenImmediate(token, category, { panning });
                        }
                    } else if (isTTSRequired(token) && ttsPregenPromises.has(token)) {
                        log(`[speakTokenList] Using PRE-GENERATED TTS for: "${token}"`);
                        const ttsFilePath = await ttsPregenPromises.get(token)!;
                        await audioPlayer.playTtsAsPcm(ttsFilePath, panning);
                    } else if (isTTSRequired(token)) {
                        log(`[speakTokenList] Generating NEW TTS for: "${token}" (not pre-generated)`);
                        // This shouldn't happen often since we pre-generate, but fallback
                        await speakTokenImmediate(token, category, { panning });
                    } else {
                        log(`[speakTokenList] Skipping token (no handler): "${token}"`);
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
        
        if (isAlphabet(token)) {
            log(`[speakTokenImmediate] Processing alphabet token: ${token}`);
            const lower = token.toLowerCase();
            const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
            if (fs.existsSync(alphaPath)) {
                log(`[speakTokenImmediate] Playing cached alphabet PCM: ${alphaPath}`);
                await audioPlayer.playPcmCached(alphaPath, opts?.panning);
            } else {
                log(`[speakTokenImmediate] Generating TTS for alphabet: ${token}`);
                const filePath = await genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) });
                await audioPlayer.playWavFile(filePath, { immediate: true, panning: opts?.panning });
            }
        } else if (isNumber(token)) {
            log(`[speakTokenImmediate] Processing number token: ${token}`);
            const numPath = path.join(config.numberPath(), `${token}.pcm`);
            if (fs.existsSync(numPath)) {
                log(`[speakTokenImmediate] Playing cached number PCM: ${numPath}`);
                await audioPlayer.playPcmCached(numPath, opts?.panning);
            } else {
                log(`[speakTokenImmediate] Generating TTS for number: ${token}`);
                const filePath = await genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) });
                await audioPlayer.playWavFile(filePath, { immediate: true, panning: opts?.panning });
            }
        } else if (isEarconToken(token)) {
            log(`[speakTokenImmediate] Processing earcon token: ${token}`);
            log(`[speakTokenImmediate] About to call playEarcon for: ${token}`);
            await playEarcon(token, opts?.panning);
            log(`[speakTokenImmediate] Completed playEarcon for: ${token}`);
        } else if (isTTSRequired(token)) {
            log(`[speakTokenImmediate] Processing TTS token: ${token}`);
            try {
                const filePath = await genTokenAudio(token, category, { speaker: getSpeakerForCategory(category) });
                // ULTRA FAST PATH: Convert TTS WAV to cached PCM for instant playback
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
    
    // Use pitch-preserving time stretching if enabled and rate != 1.0
    if (config.preservePitch && Math.abs(effectiveRate - 1.0) > 0.01) {
        return applyPitchPreservingTimeStretch(filePath, effectiveRate)
            .then(processedFilePath => {
                // Play the time-stretched file at normal rate (1.0) since tempo is already adjusted
                return audioPlayer.playWavFile(processedFilePath, {
                    ...opts,
                    rate: 1.0 // Don't apply rate again - it's already in the processed file
                });
            })
            .catch(error => {
                log(`[playWave] Pitch-preserving time stretch failed: ${error}, falling back to sample rate adjustment`);
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
    audioPlayer.stopAll();
}

export function clearAudioStoppingState(): void {
    audioPlayer.clearStoppingState();
}

export function cleanupAudioResources(): void {
    audioPlayer.cleanup();
}

export async function playSequence(filePaths: string[], opts?: { rate?: number }): Promise<void> {
    return audioPlayer.playSequence(filePaths, opts);
}