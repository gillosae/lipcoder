import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as wav from 'wav';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import { log, logWarning, logInfo, logError, logSuccess } from './utils';
import { config } from './config';
import { isAlphabet, isNumber } from './mapping';

// Import from the new modules
import { playEarcon, stopEarconPlayback, isEarconToken, findTokenSound, earconRaw } from './earcon';
import { genTokenAudio, playSpecial, isTTSRequired, getSpeakerForCategory } from './tts';

// Re-export functions that other modules expect from audio.ts
export { genTokenAudio, playSpecial } from './tts';
export { playEarcon, earconRaw } from './earcon';

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
            const format = STANDARD_PCM_FORMAT;
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

    private cache = new AudioCache();
    private fallbackManager = new FallbackPlayerManager();

    async playPcmCached(filePath: string, panning?: number): Promise<void> {
        const entry = this.cache.loadAndCache(filePath);
        
        return new Promise<void>((resolve, reject) => {
            this.stopCurrentPlayback();
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...entry.format, samplesPerFrame: 128 } as any);
            this.currentSpeaker = speaker;
            
            speaker.on('close', resolve);
            speaker.on('error', reject);
            
            let finalPcm = entry.pcm;
            if (panning !== undefined && panning !== 0) {
                finalPcm = AudioUtils.applyPanning(entry.pcm, entry.format, panning);
                log(`[playPcmCached] Applied panning ${panning.toFixed(2)} to cached PCM: ${path.basename(filePath)}`);
            }
            
            speaker.write(finalPcm);
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
    }

    stopAll(): void {
        stopEarconPlayback();
        this.stopCurrentPlayback();
        this.fallbackManager.killAll();
    }

    cleanup(): void {
        logWarning('🧹 Cleaning up audio resources...');
        this.stopAll();
        this.cache.clear();
        
        if (global.gc) {
            try {
                global.gc();
                logInfo('🗑️ Forced garbage collection');
            } catch (err) {
                logError(`Failed to force GC: ${err}`);
            }
        }
        
        logWarning('🧹 Audio resources cleaned up');
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
            playPromise = playWave(filePath, { panning: opts?.panning });
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
        
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
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
                    // Force immediate playback for sequential token reading
                    await speakTokenImmediate(token, category, { panning });
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
                await audioPlayer.playWavFile(filePath, { immediate: true, panning: opts?.panning });
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
    return audioPlayer.playWavFile(filePath, opts);
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

export function cleanupAudioResources(): void {
    audioPlayer.cleanup();
}

export async function playSequence(filePaths: string[], opts?: { rate?: number }): Promise<void> {
    return audioPlayer.playSequence(filePaths, opts);
}