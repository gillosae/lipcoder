import * as vscode from 'vscode';
import { log } from './utils';
import { config } from './config';
import { getASRRecordingStatus } from './features/enhanced_push_to_talk_asr';

/**
 * Native macOS TTS implementation that mimics VoiceOver behavior
 * This module provides text-to-speech functionality using only macOS native 'say' command
 */

// Direct macOS say command - no server needed

// VoiceOver-like settings with panning support
interface TTSSettings {
    voice: string;
    rate: number;        // words per minute (VoiceOver default: ~200)
    volume: number;      // 0.0 to 1.0
    punctuation: 'none' | 'some' | 'all';  // VoiceOver punctuation levels
    panningEnabled: boolean;  // Enable spatial audio panning
    panningStrength: number;  // Panning strength (0.0 to 1.0)
}

// Panning configuration
interface PanningInfo {
    pan: number;  // -1.0 (left) to 1.0 (right)
    column: number;
    totalColumns: number;
}

// Default settings matching VoiceOver behavior
const DEFAULT_SETTINGS: TTSSettings = {
    voice: 'Yuna',       // Default to Yuna as per user preference
    rate: 200,           // VoiceOver default speaking rate
    volume: 0.8,         // Comfortable volume level
    punctuation: 'some', // Read some punctuation like VoiceOver
    panningEnabled: true, // Enable panning by default
    panningStrength: 0.7  // Moderate panning strength
};

// Current TTS settings
let currentSettings: TTSSettings = { ...DEFAULT_SETTINGS };

// Audio control
let currentAudio: any = null;
let isPlaying = false;
let audioQueue: Array<{ text: string; priority: 'high' | 'normal' }> = [];
let lastSpeakTime = 0;
let isStopping = false;

// Duplicate prevention
let lastSpokenText = '';
let lastSpokenTime = 0;
const DUPLICATE_PREVENTION_WINDOW_MS = 1000; // 1 second window to prevent duplicates

/**
 * Initialize TTS system
 */
export function initializeTTS(): void {
    log('[TTS] Initializing native macOS TTS system');
    
    // Load user preferences
    loadTTSSettings();
    
    // Initialize earcon cache in background
    setImmediate(() => {
        initializeEarconCache();
    });
    
    log(`[TTS] Initialized with voice: ${currentSettings.voice}, rate: ${currentSettings.rate}`);
}

/**
 * Load TTS settings from VS Code configuration
 */
function loadTTSSettings(): void {
    const config = vscode.workspace.getConfiguration('lipcoder');
    
    currentSettings.voice = config.get('tts.voice', DEFAULT_SETTINGS.voice);
    currentSettings.rate = config.get('tts.rate', DEFAULT_SETTINGS.rate);
    currentSettings.volume = config.get('tts.volume', DEFAULT_SETTINGS.volume);
    currentSettings.punctuation = config.get('tts.punctuation', DEFAULT_SETTINGS.punctuation);
    currentSettings.panningEnabled = config.get('tts.panningEnabled', DEFAULT_SETTINGS.panningEnabled);
    currentSettings.panningStrength = config.get('tts.panningStrength', DEFAULT_SETTINGS.panningStrength);
    
    log(`[TTS] Settings loaded: ${JSON.stringify(currentSettings)}`);
    log(`[TTS] Panning settings: enabled=${currentSettings.panningEnabled}, strength=${currentSettings.panningStrength}`);
}

// TTS server URL (no longer needed, but kept for compatibility)
// const TTS_SERVER_URL = 'http://localhost:5008';

/**
 * Calculate panning based on cursor position in the editor
 */
function calculatePanning(textLength?: number): PanningInfo {
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !currentSettings.panningEnabled) {
            return { pan: 0, column: 0, totalColumns: 80 }; // Center panning if no editor or disabled
        }
        
        const position = editor.selection.active;
        const line = editor.document.lineAt(position.line);
        const column = position.character;
        
        // Calculate total visible columns (use editor viewport width or reasonable default)
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const tabSize = editorConfig.get<number>('tabSize', 4);
        const lineLength = line.text.length;
        
        // Use a reasonable maximum width for panning calculation
        const maxColumns = Math.max(lineLength, 120); // At least 120 chars for good panning range
        
        // Calculate pan value: -1.0 (left) to 1.0 (right)
        let pan = 0;
        if (maxColumns > 0) {
            // Map column position to pan range
            pan = (column / maxColumns) * 2 - 1; // Convert 0-maxColumns to -1 to 1
            pan = Math.max(-1, Math.min(1, pan)); // Clamp to valid range
            pan *= currentSettings.panningStrength; // Apply strength setting
        }
        
        log(`[TTS] Panning calculated: column=${column}, maxColumns=${maxColumns}, pan=${pan.toFixed(2)}`);
        
        return {
            pan,
            column,
            totalColumns: maxColumns
        };
        
    } catch (error) {
        log(`[TTS] Error calculating panning: ${error}`);
        return { pan: 0, column: 0, totalColumns: 80 };
    }
}

/**
 * Calculate progressive panning for text that spans multiple characters
 */
function calculateProgressivePanning(text: string, startColumn: number, maxColumns: number): { startPan: number, endPan: number } {
    if (!currentSettings.panningEnabled) {
        return { startPan: 0, endPan: 0 };
    }
    
    // Estimate text width (rough approximation)
    const textWidth = text.length;
    const endColumn = startColumn + textWidth;
    
    // Calculate start and end pan positions
    const startPan = Math.max(-1, Math.min(1, ((startColumn / maxColumns) * 2 - 1) * currentSettings.panningStrength));
    const endPan = Math.max(-1, Math.min(1, ((endColumn / maxColumns) * 2 - 1) * currentSettings.panningStrength));
    
    log(`[TTS] Progressive panning: "${text}" from column ${startColumn} to ${endColumn}, pan ${startPan.toFixed(2)} → ${endPan.toFixed(2)}`);
    
    return { startPan, endPan };
}

/**
 * Apply progressive panning to audio file using sox
 */
async function applyProgressivePanning(originalFile: string, pannedFile: string, text: string, panningInfo: PanningInfo, tempDir: string): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');
    
    // Calculate progressive panning for the text
    const { startPan, endPan } = calculateProgressivePanning(text, panningInfo.column, panningInfo.totalColumns);
    
    // If start and end panning are very similar or text is short, use simple panning
    const shouldUseProgressivePanning = Math.abs(endPan - startPan) >= 0.1 && text.length >= 8;
    
    if (!shouldUseProgressivePanning) {
        // Simple static panning
        const leftGain = (1 - startPan) / 2;
        const rightGain = (1 + startPan) / 2;
        
        const soxArgs = [
            originalFile,
            '-c', '2', // Force stereo output
            pannedFile,
            'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
        ];
        
        log(`[TTS] Static panning: left=${leftGain.toFixed(3)}, right=${rightGain.toFixed(3)}`);
        
        return new Promise<void>((resolve, reject) => {
            const soxProcess = spawn('sox', soxArgs);
            
            soxProcess.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Sox static panning failed with code ${code}`));
                }
            });
            
            soxProcess.on('error', (error: any) => {
                if (error.code === 'ENOENT') {
                    reject(new Error('Sox not found. Install Sox for panning support or disable panning in settings.'));
                } else {
                    reject(error);
                }
            });
        });
    } else {
        // Progressive panning using sox with multiple segments
        log(`[TTS] Progressive panning: ${startPan.toFixed(2)} → ${endPan.toFixed(2)}`);
        
        // Create progressive panning by mixing multiple segments with different pan positions
        const tempSegmentDir = path.join(tempDir, `segments_${Date.now()}`);
        if (!fs.existsSync(tempSegmentDir)) {
            fs.mkdirSync(tempSegmentDir, { recursive: true });
        }
        
        try {
            // First, get audio duration to calculate segments
            const duration = await getAudioDuration(originalFile);
            
            // Create 5 segments with progressive panning
            const numSegments = 5;
            const segmentDuration = duration / numSegments;
            const segmentFiles: string[] = [];
            
            // Create all segment processing promises
            const segmentPromises: Promise<void>[] = [];
            
            for (let i = 0; i < numSegments; i++) {
                const segmentStart = i * segmentDuration;
                const progress = i / (numSegments - 1); // 0 to 1
                const currentPan = startPan + (endPan - startPan) * progress;
                
                const leftGain = (1 - currentPan) / 2;
                const rightGain = (1 + currentPan) / 2;
                
                const segmentFile = path.join(tempSegmentDir, `segment_${i}.wav`);
                segmentFiles.push(segmentFile);
                
                // Extract segment and apply panning
                const segmentArgs = [
                    originalFile,
                    '-c', '2',
                    segmentFile,
                    'trim', segmentStart.toFixed(3), segmentDuration.toFixed(3),
                    'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
                ];
                
                const segmentPromise = new Promise<void>((segmentResolve, segmentReject) => {
                    const segmentProcess = spawn('sox', segmentArgs);
                    
                    segmentProcess.on('close', (code: number) => {
                        if (code === 0) {
                            log(`[TTS] Created segment ${i}: pan=${currentPan.toFixed(2)}, left=${leftGain.toFixed(3)}, right=${rightGain.toFixed(3)}`);
                            segmentResolve();
                        } else {
                            segmentReject(new Error(`Segment ${i} processing failed`));
                        }
                    });
                    
                    segmentProcess.on('error', segmentReject);
                });
                
                segmentPromises.push(segmentPromise);
            }
            
            // Wait for all segments to complete
            await Promise.all(segmentPromises);
            
            // Concatenate all segments
            return new Promise<void>((resolve, reject) => {
                const concatArgs = segmentFiles.concat([pannedFile]);
                const concatProcess = spawn('sox', concatArgs);
                
                concatProcess.on('close', (code: number) => {
                    // Clean up segment files
                    segmentFiles.forEach(file => {
                        try {
                            if (fs.existsSync(file)) fs.unlinkSync(file);
                        } catch (e) {}
                    });
                    try {
                        if (fs.existsSync(tempSegmentDir)) fs.rmSync(tempSegmentDir, { recursive: true });
                    } catch (e) {}
                    
                    if (code === 0) {
                        log(`[TTS] Successfully created progressive panning with ${numSegments} segments`);
                        resolve();
                    } else {
                        // Fallback to static panning
                        log(`[TTS] Progressive panning failed, trying static panning`);
                        const avgPan = (startPan + endPan) / 2;
                        const leftGain = (1 - avgPan) / 2;
                        const rightGain = (1 + avgPan) / 2;
                        
                        const fallbackArgs = [
                            originalFile,
                            '-c', '2',
                            pannedFile,
                            'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
                        ];
                        
                        const fallbackProcess = spawn('sox', fallbackArgs);
                        
                        fallbackProcess.on('close', (fallbackCode: number) => {
                            if (fallbackCode === 0) {
                                resolve();
                            } else {
                                reject(new Error(`Sox fallback panning failed with code ${fallbackCode}`));
                            }
                        });
                        
                        fallbackProcess.on('error', reject);
                    }
                });
                
                concatProcess.on('error', (error: any) => {
                    // Clean up on error
                    segmentFiles.forEach(file => {
                        try {
                            if (fs.existsSync(file)) fs.unlinkSync(file);
                        } catch (e) {}
                    });
                    try {
                        if (fs.existsSync(tempSegmentDir)) fs.rmSync(tempSegmentDir, { recursive: true });
                    } catch (e) {}
                    
                    if (error.code === 'ENOENT') {
                        reject(new Error('Sox not found. Install Sox for panning support or disable panning in settings.'));
                    } else {
                        reject(error);
                    }
                });
            });
            
        } catch (segmentError) {
            // Clean up on any error
            try {
                if (fs.existsSync(tempSegmentDir)) fs.rmSync(tempSegmentDir, { recursive: true });
            } catch (e) {}
            
            log(`[TTS] Progressive panning segment creation failed: ${segmentError}`);
            // Fallback to static panning
            const avgPan = (startPan + endPan) / 2;
            const leftGain = (1 - avgPan) / 2;
            const rightGain = (1 + avgPan) / 2;
            
            const fallbackArgs = [
                originalFile,
                '-c', '2',
                pannedFile,
                'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
            ];
            
            return new Promise<void>((resolve, reject) => {
                const fallbackProcess = spawn('sox', fallbackArgs);
                
                fallbackProcess.on('close', (fallbackCode: number) => {
                    if (fallbackCode === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Sox fallback panning failed with code ${fallbackCode}`));
                    }
                });
                
                fallbackProcess.on('error', reject);
            });
        }
    }
}

/**
 * Get audio duration using soxi
 */
async function getAudioDuration(audioFile: string): Promise<number> {
    const { spawn } = require('child_process');
    
    return new Promise<number>((resolve) => {
        const durationProcess = spawn('soxi', ['-D', audioFile]);
        let duration = 1.0; // Default fallback
        
        durationProcess.stdout.on('data', (data: Buffer) => {
            const durationStr = data.toString().trim();
            const parsedDuration = parseFloat(durationStr);
            if (!isNaN(parsedDuration)) {
                duration = parsedDuration;
            }
        });
        
        durationProcess.on('close', () => resolve(duration));
        durationProcess.on('error', () => resolve(duration)); // Continue even if soxi fails
    });
}

/**
 * Speak text using native macOS TTS
 */
export async function speak(text: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!text.trim()) {
        return;
    }
    
    // Check if ASR is currently recording - if so, don't start TTS
    if (getASRRecordingStatus()) {
        log(`[TTS] ASR is recording, skipping TTS: "${text}"`);
        return;
    }
    
    const now = Date.now();
    
    // Prevent duplicate content within time window for longer phrases only.
    // Allow repeated single characters and common atomic tokens like 'space'/'tab'.
    const isAtomicToken = text.length === 1 || text === 'space' || text === 'tab';
    if (!isAtomicToken && priority !== 'high') {
        if (text === lastSpokenText && (now - lastSpokenTime) < DUPLICATE_PREVENTION_WINDOW_MS) {
            log(`[TTS] Prevented duplicate speech: "${text}" (within ${DUPLICATE_PREVENTION_WINDOW_MS}ms window)`);
            return;
        }
    }
    
    // Prevent rapid duplicate calls (debouncing) - reduced for faster transitions
    // Skip debouncing for high priority speech (cursor movement)
    if (now - lastSpeakTime < 10 && priority !== 'high') { // 10ms debounce for faster response
        log(`[TTS] Debounced duplicate speak call: "${text}"`);
        return;
    }
    
    // Update tracking variables
    lastSpeakTime = now;
    // For high priority speech (cursor movement), don't update lastSpokenText to allow re-reading same line
    if (priority !== 'high') {
        lastSpokenText = text;
        lastSpokenTime = now;
    } else {
        log(`[TTS] High priority speech - not updating duplicate prevention for: "${text}"`);
    }
    
    log(`[TTS] Speaking: "${text}" (priority: ${priority})`);
    
    // High priority speech interrupts current speech immediately
    if (priority === 'high' && !isStopping) {
        isStopping = true;
        await stopSpeaking();
        isStopping = false;
        // Clear queue for high priority
        audioQueue.length = 0;
    }
    
    // If currently speaking and this is normal priority, queue it
    if (isPlaying && priority === 'normal') {
        audioQueue.push({ text, priority });
        log(`[TTS] Queued speech: "${text}"`);
        return;
    }
    
    try {
        // Use system say command directly for simplicity and reliability
        await playTextDirectly(text, priority);
        
    } catch (error) {
        log(`[TTS] Error speaking text: ${error}`);
    }
}

/**
 * Play text directly using macOS say command
 */
async function playTextDirectly(text: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    try {
        // For high priority (cursor movement, navigation), use fast simple rate adjustment
        // For normal priority, use pitch preservation if enabled
        if (priority === 'high' || config.playSpeed === 1.0) {
            // Fast path - direct say command with rate adjustment
            const effectiveRate = Math.round(currentSettings.rate * config.playSpeed);
            await playWithSayCommand(text, effectiveRate);
        } else if (config.preservePitch) {
            // Pitch preservation enabled - use FFmpeg time stretching
            await playWithPitchPreservation(text);
        } else {
            // Simple speed change - just adjust rate
            const effectiveRate = Math.round(currentSettings.rate * config.playSpeed);
            await playWithSayCommand(text, effectiveRate);
        }
        
    } catch (error) {
        isPlaying = false;
        currentAudio = null;
        throw error;
    }
}

/**
 * Play text using direct say command with optional panning
 */
async function playWithSayCommand(text: string, rate: number): Promise<void> {
    const { spawn } = require('child_process');
    
    // Calculate panning for current cursor position
    const panningInfo = calculatePanning();
    
    // If panning is disabled OR this is high priority, use direct say for speed
    if (!currentSettings.panningEnabled || rate >= currentSettings.rate) {
        const args = ['-v', currentSettings.voice, '-r', rate.toString()];
        
        log(`[TTS] Fast say (no panning): voice=${currentSettings.voice}, rate=${rate}`);
        
        return new Promise<void>((resolve, reject) => {
            isPlaying = true;
            
            const process = spawn('say', args, {
                stdio: ['pipe', 'ignore', 'ignore'] // Ignore stdout/stderr for faster startup
            });
            
            // Write text and close stdin immediately
            process.stdin.write(text);
            process.stdin.end();
            
            process.on('close', (code: number | null) => {
                isPlaying = false;
                currentAudio = null;
                
                log(`[TTS] Say process closed with code: ${code}`);
                
                if (code === 0 || code === null) {
                    // null code can happen when process is terminated by signal (normal for stopping)
                    resolve();
                    // Process queue asynchronously to not block current speech
                    setImmediate(() => processAudioQueue());
                } else {
                    reject(new Error(`Say command exited with code ${code}`));
                }
            });
            
            process.on('error', (error: any) => {
                isPlaying = false;
                currentAudio = null;
                reject(error);
            });
            
            // Store process reference for stopping
            currentAudio = process;
        });
    } else {
        // Use panning with temporary file processing
        return await playWithPanning(text, rate, panningInfo);
    }
}

/**
 * Play text with spatial panning using say + sox pipeline
 */
async function playWithPanning(text: string, rate: number, panningInfo: PanningInfo): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawn } = require('child_process');
    
    // Create temporary files
    const tempDir = path.join(os.tmpdir(), 'lipcoder_panning');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const originalFile = path.join(tempDir, `tts_${Date.now()}.aiff`);
    const pannedFile = path.join(tempDir, `panned_${Date.now()}.wav`);
    
    try {
        log(`[TTS] Playing with progressive panning: text="${text}", column=${panningInfo.column}`);
        
        // Step 1: Generate audio with say command
        await new Promise<void>((resolve, reject) => {
            const sayProcess = spawn('say', [
                '-v', currentSettings.voice,
                '-r', rate.toString(),
                '-o', originalFile
            ]);
            
            sayProcess.stdin.write(text);
            sayProcess.stdin.end();
            
            sayProcess.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Say command failed with code ${code}`));
                }
            });
            
            sayProcess.on('error', reject);
        });
        
        // Step 2: Apply progressive panning with sox
        await applyProgressivePanning(originalFile, pannedFile, text, panningInfo, tempDir);
        
        // Step 3: Play the panned audio
        await new Promise<void>((resolve, reject) => {
            isPlaying = true;
            
            const playProcess = spawn('afplay', [pannedFile]);
            
            playProcess.on('close', (code: number) => {
                isPlaying = false;
                currentAudio = null;
                
                if (code === 0) {
                    log(`[TTS] Successfully played progressively panned audio`);
                    resolve();
                    processAudioQueue();
                } else {
                    reject(new Error(`Panned audio playback failed with code ${code}`));
                }
            });
            
            playProcess.on('error', reject);
            
            currentAudio = playProcess;
        });
        
    } catch (error) {
        log(`[TTS] Progressive panning failed, falling back to direct say: ${error}`);
        // Fallback to direct say without panning
        const args = ['-v', currentSettings.voice, '-r', rate.toString()];
        
        return new Promise<void>((resolve, reject) => {
            isPlaying = true;
            
            const process = spawn('say', args, {
                stdio: ['pipe', 'ignore', 'ignore']
            });
            
            process.stdin.write(text);
            process.stdin.end();
            
            process.on('close', (code: number | null) => {
                isPlaying = false;
                currentAudio = null;
                
                if (code === 0 || code === null) {
                    resolve();
                    processAudioQueue();
                } else {
                    reject(new Error(`Fallback say command exited with code ${code}`));
                }
            });
            
            process.on('error', reject);
            currentAudio = process;
        });
    } finally {
        // Clean up temporary files
        try {
            if (fs.existsSync(originalFile)) fs.unlinkSync(originalFile);
            if (fs.existsSync(pannedFile)) fs.unlinkSync(pannedFile);
        } catch (cleanupError) {
            log(`[TTS] Failed to cleanup panning temp files: ${cleanupError}`);
        }
    }
}

/**
 * Play text with pitch preservation using FFmpeg
 */
async function playWithPitchPreservation(text: string): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawn } = require('child_process');
    
    // Create temporary files
    const tempDir = path.join(os.tmpdir(), 'lipcoder_tts');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const originalFile = path.join(tempDir, `original_${Date.now()}.aiff`);
    const stretchedFile = path.join(tempDir, `stretched_${Date.now()}.wav`);
    
    try {
        // Step 1: Generate audio with say command at normal rate
        log(`[TTS] Generating audio with pitch preservation at ${config.playSpeed}x speed`);
        
        await new Promise<void>((resolve, reject) => {
            const sayProcess = spawn('say', [
                '-v', currentSettings.voice,
                '-r', currentSettings.rate.toString(),
                '-o', originalFile
            ]);
            
            sayProcess.stdin.write(text);
            sayProcess.stdin.end();
            
            sayProcess.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Say command failed with code ${code}`));
                }
            });
            
            sayProcess.on('error', reject);
        });
        
        // Step 2: Use FFmpeg to time-stretch with pitch preservation
        await new Promise<void>((resolve, reject) => {
            // FFmpeg atempo filter for pitch-preserving time stretching
            const ffmpegArgs = [
                '-i', originalFile,
                '-filter:a', `atempo=${config.playSpeed}`,
                '-y', // Overwrite output file
                stretchedFile
            ];
            
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            
            ffmpegProcess.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            });
            
            ffmpegProcess.on('error', (error: any) => {
                if (error.code === 'ENOENT') {
                    reject(new Error('FFmpeg not found. Install FFmpeg for pitch preservation or disable it in settings.'));
                } else {
                    reject(error);
                }
            });
        });
        
        // Step 3: Play the time-stretched audio
        await new Promise<void>((resolve, reject) => {
            isPlaying = true;
            
            const playProcess = spawn('afplay', [stretchedFile]);
            
            playProcess.on('close', (code: number) => {
                isPlaying = false;
                currentAudio = null;
                
                if (code === 0) {
                    log(`[TTS] Successfully played pitch-preserved audio at ${config.playSpeed}x speed`);
                    resolve();
                    processAudioQueue();
                } else {
                    reject(new Error(`Audio playback failed with code ${code}`));
                }
            });
            
            playProcess.on('error', reject);
            
            currentAudio = playProcess;
        });
        
    } catch (error) {
        log(`[TTS] Pitch preservation failed, falling back to simple speed change: ${error}`);
        // Fallback to simple rate adjustment
        const effectiveRate = Math.round(currentSettings.rate * config.playSpeed);
        await playWithSayCommand(text, effectiveRate);
    } finally {
        // Clean up temporary files
        try {
            if (fs.existsSync(originalFile)) fs.unlinkSync(originalFile);
            if (fs.existsSync(stretchedFile)) fs.unlinkSync(stretchedFile);
        } catch (cleanupError) {
            log(`[TTS] Failed to cleanup temp files: ${cleanupError}`);
        }
    }
}

/**
 * Process queued audio
 */
function processAudioQueue(): void {
    if (audioQueue.length > 0 && !isPlaying) {
        const next = audioQueue.shift();
        if (next) {
            speak(next.text, next.priority);
        }
    }
}

/**
 * Stop current speech (comprehensive stop for all TTS processes)
 */
export async function stopSpeaking(): Promise<void> {
    if (isStopping) {
        log('[TTS] Already stopping, skipping duplicate call');
        return;
    }
    
    isStopping = true;
    log('[TTS] EMERGENCY STOP - Terminating all TTS processes immediately');
    
    // Stop thinking earcon if active
    if (isThinkingActive) {
        isThinkingActive = false;
        if (thinkingInterval) {
            clearInterval(thinkingInterval);
            thinkingInterval = null;
        }
        log('[TTS] Stopped thinking earcon during emergency stop');
    }
    
    // Kill current audio process if running
    if (currentAudio && currentAudio.kill) {
        try {
            currentAudio.kill('SIGKILL'); // Use SIGKILL for immediate termination
            log('[TTS] Terminated current audio process');
        } catch (error) {
            // Process might already be dead, ignore error
            log(`[TTS] Error killing current audio process: ${error}`);
        }
    }
    
    // AGGRESSIVE: Kill ALL audio processes immediately - no mercy
    try {
        const { spawn, execSync } = require('child_process');
        
        // Use execSync for immediate execution without waiting
        try {
            execSync('pkill -9 -f "say"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all say processes');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "afplay"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all afplay processes');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "sox"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all sox processes');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "ffmpeg"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all ffmpeg processes');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "soxi"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all soxi processes');
        } catch (e) {}
        
        // Also kill any temp file related processes
        try {
            execSync('pkill -9 -f "lipcoder_panning"', { stdio: 'ignore', timeout: 100 });
            execSync('pkill -9 -f "lipcoder_tts"', { stdio: 'ignore', timeout: 100 });
            log('[TTS] SIGKILL all lipcoder temp processes');
        } catch (e) {}
        
        log('[TTS] EMERGENCY STOP COMPLETE - All audio processes terminated');
    } catch (error) {
        log(`[TTS] Error in emergency stop: ${error}`);
    }
    
    // Reset all state immediately
    currentAudio = null;
    isPlaying = false;
    isEarconPlaying = false;
    
    // Stop thinking earcon
    isThinkingActive = false;
    if (thinkingInterval) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
    
    // Clear all queues
    audioQueue.length = 0;
    earconQueue.length = 0;
    
    // Reset duplicate prevention
    lastSpokenText = '';
    lastSpokenTime = 0;
    
    // Clean up any temp files that might be left behind
    try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        
        const tempDir = path.join(os.tmpdir(), 'lipcoder_panning');
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            log('[TTS] Cleaned up panning temp directory');
        }
        
        const ttsDir = path.join(os.tmpdir(), 'lipcoder_tts');
        if (fs.existsSync(ttsDir)) {
            fs.rmSync(ttsDir, { recursive: true, force: true });
            log('[TTS] Cleaned up TTS temp directory');
        }
    } catch (cleanupError) {
        log(`[TTS] Temp cleanup error (non-critical): ${cleanupError}`);
    }
    
    isStopping = false;
    
    // Small delay to ensure all processes are truly dead before allowing new speech
    await new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * Check if currently speaking
 */
export function isSpeaking(): boolean {
    return isPlaying;
}

/**
 * Set speech rate (words per minute)
 */
export function setSpeechRate(rate: number): void {
    currentSettings.rate = Math.max(50, Math.min(500, rate)); // Clamp to reasonable range
    log(`[TTS] Speech rate set to: ${currentSettings.rate} WPM`);
}

/**
 * Set voice
 */
export function setVoice(voice: string): void {
    currentSettings.voice = voice;
    log(`[TTS] Voice set to: ${currentSettings.voice}`);
}

/**
 * Set volume
 */
export function setVolume(volume: number): void {
    currentSettings.volume = Math.max(0, Math.min(1, volume)); // Clamp to 0-1 range
    log(`[TTS] Volume set to: ${currentSettings.volume}`);
}

/**
 * Set punctuation level
 */
export function setPunctuationLevel(level: 'none' | 'some' | 'all'): void {
    currentSettings.punctuation = level;
    log(`[TTS] Punctuation level set to: ${currentSettings.punctuation}`);
}

/**
 * Enable or disable panning
 */
export function setPanningEnabled(enabled: boolean): void {
    currentSettings.panningEnabled = enabled;
    log(`[TTS] Panning enabled: ${currentSettings.panningEnabled}`);
}

/**
 * Set panning strength (0.0 to 1.0)
 */
export function setPanningStrength(strength: number): void {
    currentSettings.panningStrength = Math.max(0, Math.min(1, strength)); // Clamp to 0-1 range
    log(`[TTS] Panning strength set to: ${currentSettings.panningStrength}`);
}

/**
 * Get current settings
 */
export function getTTSSettings(): TTSSettings {
    return { ...currentSettings };
}

// Memory-based earcon cache for ultra-fast playback
const earconMemoryCache = new Map<string, Buffer>();
let earconCacheInitialized = false;

// Python keywords list
const PYTHON_KEYWORDS = new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 
    'def', 'del', 'elif', 'else', 'except', 'false', 'finally', 'for', 
    'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 
    'none', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'true', 
    'try', 'while', 'with', 'yield'
]);

// Male voice for Python keywords
const PYTHON_KEYWORD_VOICE = 'Fred'; // Clear US English male voice

// Earcon playback queue and state management
let isEarconPlaying = false;
let earconQueue: Array<{ type: 'open' | 'close', resolve: () => void }> = [];

// Navigation token to cancel stale line reads
let activeNavigationToken = 0;

export function beginNavigation(): number {
    activeNavigationToken++;
    return activeNavigationToken;
}

function getActiveNavigationToken(): number {
    return activeNavigationToken;
}

/**
 * Initialize earcon cache with pre-processed audio data
 */
async function initializeEarconCache(): Promise<void> {
    if (earconCacheInitialized) {
        return;
    }
    
    try {
        const { spawn } = require('child_process');
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        
        // Find project root
        let projectRoot = __dirname;
        while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
            projectRoot = path.dirname(projectRoot);
        }
        
        const audioDir = path.join(projectRoot, 'client', 'audio', 'earcon');
        const originalFiles = {
            'open': path.join(audioDir, 'parenthesis.wav'),
            'close': path.join(audioDir, 'parenthesis2.wav')
        };
        
        // Common playspeed values to pre-cache
        const commonSpeeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
        const preservePitchOptions = [true, false];
        
        log('[TTS] Initializing earcon memory cache...');
        
        const tempDir = path.join(os.tmpdir(), 'lipcoder_earcon_init');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        for (const [type, originalFile] of Object.entries(originalFiles)) {
            if (!fs.existsSync(originalFile)) {
                log(`[TTS] Earcon file not found: ${originalFile}`);
                continue;
            }
            
            for (const speed of commonSpeeds) {
                for (const preservePitch of preservePitchOptions) {
                    const cacheKey = `${type}_${speed}_${preservePitch}`;
                    
                    try {
                        let processedFile: string;
                        
                        if (speed === 1.0) {
                            // Use original file for normal speed
                            processedFile = originalFile;
                        } else {
                            // Process with speed adjustment
                            processedFile = path.join(tempDir, `${cacheKey}.wav`);
                            
                            if (preservePitch) {
                                // FFmpeg with atempo
                                await new Promise<void>((resolve, reject) => {
                                    const ffmpegArgs = [
                                        '-i', originalFile,
                                        '-filter:a', `atempo=${speed}`,
                                        '-y',
                                        processedFile
                                    ];
                                    
                                    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });
                                    
                                    ffmpegProcess.on('close', (code: number) => {
                                        if (code === 0) {
                                            resolve();
                                        } else {
                                            reject(new Error(`FFmpeg failed with code ${code}`));
                                        }
                                    });
                                    
                                    ffmpegProcess.on('error', reject);
                                });
                            } else {
                                // Sox with tempo
                                await new Promise<void>((resolve, reject) => {
                                    const soxArgs = [
                                        originalFile,
                                        processedFile,
                                        'tempo', speed.toString()
                                    ];
                                    
                                    const soxProcess = spawn('sox', soxArgs, { stdio: 'ignore' });
                                    
                                    soxProcess.on('close', (code: number) => {
                                        if (code === 0) {
                                            resolve();
        } else {
                                            reject(new Error(`Sox failed with code ${code}`));
                                        }
                                    });
                                    
                                    soxProcess.on('error', reject);
                                });
                            }
                        }
                        
                        // Load processed file into memory
                        const audioData = fs.readFileSync(processedFile);
                        earconMemoryCache.set(cacheKey, audioData);
                        
                        // Clean up temp file if it was created
                        if (processedFile !== originalFile && fs.existsSync(processedFile)) {
                            fs.unlinkSync(processedFile);
                        }
                        
                        log(`[TTS] Cached earcon: ${cacheKey} (${audioData.length} bytes)`);
                        
                    } catch (error) {
                        log(`[TTS] Failed to cache earcon ${cacheKey}: ${error}`);
                    }
                }
            }
        }
        
        // Clean up temp directory
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true });
            }
        } catch (cleanupError) {
            log(`[TTS] Failed to cleanup temp dir: ${cleanupError}`);
        }
        
        earconCacheInitialized = true;
        log(`[TTS] Earcon cache initialized with ${earconMemoryCache.size} entries`);
        
    } catch (error) {
        log(`[TTS] Failed to initialize earcon cache: ${error}`);
    }
}


/**
 * Play Python keyword using macOS male voice (wait for completion to avoid overlap)
 */
async function playPythonKeyword(keyword: string, priority: 'high' | 'normal' = 'normal'): Promise<boolean> {
    try {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        
        const lowerKeyword = keyword.toLowerCase().trim();
        
        if (!PYTHON_KEYWORDS.has(lowerKeyword)) {
            return false; // Not a Python keyword
        }
        
        log(`[TTS] Playing Python keyword earcon: ${lowerKeyword}`);
        
        // Find the project root by looking for package.json
        let currentDir = __dirname;
        let projectRoot = '';
        
        while (currentDir !== path.dirname(currentDir)) {
            if (fs.existsSync(path.join(currentDir, 'package.json'))) {
                projectRoot = currentDir;
                break;
            }
            currentDir = path.dirname(currentDir);
        }
        
        if (!projectRoot) {
            log(`[TTS] Could not find project root for keyword: ${lowerKeyword}`);
            return false;
        }
        
        // Path to the keyword PCM file
        const keywordPath = path.join(projectRoot, 'client', 'audio', 'python_macos', `${lowerKeyword}.pcm`);
        
        if (!fs.existsSync(keywordPath)) {
            log(`[TTS] Keyword audio file not found: ${keywordPath}`);
            return false;
        }
        
        // Calculate panning for current cursor position
        const panningInfo = calculatePanning();
        
        log(`[TTS] Python keyword panning check: enabled=${currentSettings.panningEnabled}, pan=${panningInfo.pan.toFixed(3)}, abs=${Math.abs(panningInfo.pan).toFixed(3)}`);
        
        return new Promise<boolean>((resolve) => {
            try {
                // Apply panning if enabled (removed threshold for testing)
                if (currentSettings.panningEnabled) {
                    // Create temporary file for panned keyword
                    const tempFile = path.join(os.tmpdir(), `keyword_panned_${lowerKeyword}_${Date.now()}.wav`);
                    
                    // Convert PCM to WAV with panning
                    const leftGain = (1 - panningInfo.pan) / 2;
                    const rightGain = (1 + panningInfo.pan) / 2;
                    
                    const process = spawn('sox', [
                        '-t', 'raw',           // Input type: raw PCM
                        '-r', '44100',         // Sample rate: 44.1kHz
                        '-b', '16',            // Bit depth: 16-bit
                        '-c', '1',             // Channels: mono
                        '-e', 'signed-integer', // Encoding: signed PCM
                        keywordPath,           // Input file
                        '-c', '2',             // Force stereo output
                        tempFile,              // Output to temp file
                        'tempo', '2.0',        // 2x speed for faster playback
                        'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
                    ]);
                    
                    log(`[TTS] Python keyword with panning: ${lowerKeyword}, pan=${panningInfo.pan.toFixed(2)}, left=${leftGain.toFixed(3)}, right=${rightGain.toFixed(3)}`);
                    
                    let resolved = false;
                    
                    process.on('close', (code: number | null) => {
                        if (!resolved) {
                            resolved = true;
                            
                            if (code === 0) {
                                // Play the panned file
                                const playProcess = spawn('afplay', [tempFile]);
                                
                                playProcess.on('close', (playCode: number | null) => {
                                    // Clean up temp file
                                    try {
                                        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                                    } catch (cleanupError) {}
                                    
                                    log(`[TTS] Python keyword earcon ${lowerKeyword} completed with code: ${playCode}`);
                                    resolve(playCode === 0 || playCode === null);
                                });
                                
                                playProcess.on('error', (error: any) => {
                                    try {
                                        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                                    } catch (cleanupError) {}
                                    log(`[TTS] Python keyword earcon ${lowerKeyword} playback error: ${error}`);
                                    resolve(false);
                                });
                                
                                // Timeout for playback
                                setTimeout(() => {
                                    try { playProcess.kill('SIGKILL'); } catch (e) {}
                                    try {
                                        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                                    } catch (cleanupError) {}
                                    resolve(true);
                                }, 400);
                            } else {
                                log(`[TTS] Python keyword panning failed for ${lowerKeyword}, code: ${code}`);
                                resolve(false);
                            }
                        }
                    });
                    
                    process.on('error', (error: any) => {
                        if (!resolved) {
                            resolved = true;
                            log(`[TTS] Python keyword panning error for ${lowerKeyword}: ${error}`);
                            resolve(false);
                        }
                    });
                    
                    // Timeout for processing
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            try { process.kill('SIGKILL'); } catch (e) {}
                            log(`[TTS] Python keyword panning timeout for ${lowerKeyword}`);
                            resolve(false);
                        }
                    }, 800);
                    
                } else {
                    // Play without panning (original behavior)
                    log(`[TTS] Python keyword playing without panning: enabled=${currentSettings.panningEnabled}, pan=${panningInfo.pan.toFixed(3)}`);
                    const process = spawn('sox', [
                        '-t', 'raw',           // Input type: raw PCM
                        '-r', '44100',         // Sample rate: 44.1kHz (standard audio rate)
                        '-b', '16',            // Bit depth: 16-bit
                        '-c', '1',             // Channels: mono
                        '-e', 'signed-integer', // Encoding: signed PCM
                        keywordPath,           // Input file
                        '-d',                  // Output to default audio device
                        'tempo', '2.0'         // 2x speed for faster playback
                    ]);
                    
                    let resolved = false;
                    
                    process.on('close', (code: number | null) => {
                        if (!resolved) {
                            resolved = true;
                            log(`[TTS] Python keyword earcon ${lowerKeyword} completed with code: ${code}`);
                            // Immediate resolve for fastest transition
                            resolve(code === 0 || code === null);
                        }
                    });
                    
                    process.on('error', (error: any) => {
                        if (!resolved) {
                            resolved = true;
                            log(`[TTS] Python keyword earcon ${lowerKeyword} error: ${error}`);
                            resolve(false);
                        }
                    });
                    
                    // Balanced timeout - enough for completion but not too long
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            try { process.kill('SIGKILL'); } catch (e) {}
                            log(`[TTS] Python keyword earcon ${lowerKeyword} timeout`);
                            resolve(true);
                        }
                    }, 400); // Increased to prevent cutting off keywords
                }
                
            } catch (error) {
                log(`[TTS] Error processing keyword earcon ${lowerKeyword}: ${error}`);
                resolve(false);
            }
        });
        
    } catch (error) {
        log(`[TTS] Error playing Python keyword ${keyword}: ${error}`);
        return false;
    }
}

/**
 * Play earcon sound for parentheses with minimal latency and sequential playback
 */
async function playParenthesesEarcon(type: 'open' | 'close'): Promise<void> {
    return new Promise<void>((resolve) => {
        // Add to queue
        earconQueue.push({ type, resolve });
        
        // Process queue if not already playing
        if (!isEarconPlaying) {
            processEarconQueue();
        }
    });
}

/**
 * Process earcon queue sequentially
 */
async function processEarconQueue(): Promise<void> {
    if (isEarconPlaying || earconQueue.length === 0) {
        return;
    }
    
    isEarconPlaying = true;
    
    while (earconQueue.length > 0) {
        const { type, resolve } = earconQueue.shift()!;
        
        try {
            await playEarconImmediate(type);
        } catch (error) {
            log(`[TTS] Error playing earcon ${type}: ${error}`);
        }
        
        resolve();
        
        // Minimal gap between earcons for speed
        await new Promise(r => setTimeout(r, 5));
    }
    
    isEarconPlaying = false;
}

/**
 * Immediately play a single earcon using memory cache with panning (internal function)
 */
async function playEarconImmediate(type: 'open' | 'close'): Promise<void> {
    return new Promise<void>((resolve) => {
        try {
            // Ensure cache is initialized
            if (!earconCacheInitialized) {
                log(`[TTS] Earcon cache not initialized, initializing now...`);
                initializeEarconCache().then(() => {
                    playEarconImmediate(type).then(resolve);
                }).catch(() => {
                    resolve(); // Continue even if cache init fails
                });
                return;
            }
            
            const { spawn } = require('child_process');
            const path = require('path');
            const fs = require('fs');
            const os = require('os');
            
            // Calculate panning for current cursor position
            const panningInfo = calculatePanning();
            
            // Try to find exact match in memory cache first
            const exactCacheKey = `${type}_${config.playSpeed}_${config.preservePitch}`;
            let audioData = earconMemoryCache.get(exactCacheKey);
            
            if (!audioData) {
                // Try to find closest speed match
                const availableKeys = Array.from(earconMemoryCache.keys()).filter(key => key.startsWith(`${type}_`));
                const speeds = availableKeys.map(key => {
                    const parts = key.split('_');
                    return { key, speed: parseFloat(parts[1]), preservePitch: parts[2] === 'true' };
                });
                
                // Find closest speed with matching pitch preservation preference
                const matchingPitch = speeds.filter(s => s.preservePitch === config.preservePitch);
                const candidates = matchingPitch.length > 0 ? matchingPitch : speeds;
                
                if (candidates.length > 0) {
                    const closest = candidates.reduce((prev, curr) => 
                        Math.abs(curr.speed - config.playSpeed) < Math.abs(prev.speed - config.playSpeed) ? curr : prev
                    );
                    audioData = earconMemoryCache.get(closest.key);
                    log(`[TTS] Using closest cached earcon: ${closest.key} (requested: ${exactCacheKey})`);
                }
            } else {
                log(`[TTS] Using exact cached earcon: ${exactCacheKey}`);
            }
            
            if (audioData) {
                // Play from memory cache with optional panning
                const tempFile = path.join(os.tmpdir(), `earcon_${type}_${Date.now()}.wav`);
                
                try {
                    fs.writeFileSync(tempFile, audioData);
                    
                    // Apply panning if enabled (removed threshold for testing)
                    if (currentSettings.panningEnabled) {
                        const pannedFile = path.join(os.tmpdir(), `earcon_panned_${type}_${Date.now()}.wav`);
                        
                        // Apply panning with sox
                        const leftGain = (1 - panningInfo.pan) / 2;
                        const rightGain = (1 + panningInfo.pan) / 2;
                        
                        const soxArgs = [
                            tempFile,
                            '-c', '2', // Force stereo output
                            pannedFile,
                            'remix', `1v${leftGain.toFixed(3)}`, `1v${rightGain.toFixed(3)}`
                        ];
                        
                        log(`[TTS] Earcon panning: ${type}, pan=${panningInfo.pan.toFixed(2)}, left=${leftGain.toFixed(3)}, right=${rightGain.toFixed(3)}`);
                        
                        const soxProcess = spawn('sox', soxArgs, { stdio: 'ignore' });
                        
                        soxProcess.on('close', (soxCode: number) => {
                            // Clean up original temp file
                            try {
                                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                            } catch (cleanupError) {}
                            
                            if (soxCode === 0) {
                                // Play panned earcon
                                playEarconFile(pannedFile, type, resolve);
                            } else {
                                log(`[TTS] Sox panning failed for earcon ${type}, playing without panning`);
                                // Fallback to original file
                                playEarconFile(tempFile, type, resolve);
                            }
                        });
                        
                        soxProcess.on('error', (error: any) => {
                            log(`[TTS] Sox error for earcon ${type}: ${error}`);
                            // Fallback to original file
                            try {
                                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                            } catch (cleanupError) {}
                            playEarconFile(tempFile, type, resolve);
                        });
                    } else {
                        // Play without panning
                        playEarconFile(tempFile, type, resolve);
                    }
                    
                    return;
                    
                } catch (fileError) {
                    log(`[TTS] Failed to write temp earcon file: ${fileError}`);
                    try {
                        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    } catch (cleanupError) {}
                }
            }
            
            // Fallback: cache miss or error - play original file
            log(`[TTS] Cache miss for ${exactCacheKey}, falling back to original file`);
            
            // Find original file
            let projectRoot = __dirname;
            while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
                projectRoot = path.dirname(projectRoot);
            }
            
            const audioDir = path.join(projectRoot, 'client', 'audio', 'earcon');
            const originalFile = type === 'open' 
                ? path.join(audioDir, 'parenthesis.wav')
                : path.join(audioDir, 'parenthesis2.wav');
            
            if (fs.existsSync(originalFile)) {
                playEarconFile(originalFile, type, resolve);
            } else {
                log(`[TTS] Original earcon file not found: ${originalFile}`);
                resolve();
            }
            
        } catch (error) {
            log(`[TTS] Earcon ${type} error: ${error}`);
            resolve();
        }
    });
}

/**
 * Helper function to play an earcon file
 */
function playEarconFile(filePath: string, type: 'open' | 'close', resolve: () => void): void {
    const { spawn } = require('child_process');
    const fs = require('fs');
    
    const process = spawn('afplay', [filePath], {
        stdio: 'ignore'
    });
    
    let resolved = false;
    
    process.on('close', (code: number | null) => {
        if (!resolved) {
            resolved = true;
            log(`[TTS] Earcon ${type} completed with code: ${code}`);
            // Clean up temp file
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (cleanupError) {}
            resolve();
        }
    });
    
    process.on('error', (error: any) => {
        if (!resolved) {
            resolved = true;
            log(`[TTS] Earcon ${type} error: ${error}`);
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (cleanupError) {}
            resolve();
        }
    });
    
    // Calculate timeout based on expected duration
    const earconDuration = 250; // Original duration
    const adjustedDuration = Math.round(earconDuration / config.playSpeed);
    const timeoutMs = Math.max(adjustedDuration + 50, 300);
    
    setTimeout(() => {
        if (!resolved) {
            resolved = true;
            try { process.kill('SIGTERM'); } catch (e) {}
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (cleanupError) {}
            resolve();
        }
    }, timeoutMs);
}


/**
 * Read code with proper code-specific processing and earcons for parentheses
 */
export async function readCode(text: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!text.trim()) {
        return;
    }
    
    // Capture navigation token to cancel stale reads
    const navTokenAtStart = getActiveNavigationToken();
    const isStale = () => getActiveNavigationToken() !== navTokenAtStart;

    // Check if ASR is currently recording - if so, don't start TTS
    if (getASRRecordingStatus()) {
        log(`[TTS] ASR is recording, skipping code reading: "${text}"`);
        return;
    }
    
    log(`[TTS] Reading code: "${text}"`);
    
    // Check for parentheses BEFORE processing text
    const hasParentheses = text.includes('(') || text.includes(')');
    
    if (hasParentheses) {
        // Split the original text around parentheses
        const parts = text.split(/(\(|\))/);
        log(`[TTS] Split text into parts: ${JSON.stringify(parts)}`);
        
        for (let i = 0; i < parts.length; i++) {
            if (isStale()) {
                log('[TTS] Aborting code read (stale navigation) during parentheses processing');
                return;
            }
            const part = parts[i];
            log(`[TTS] Processing part ${i}: "${part}"`);
            
            if (part === '(') {
                // Play open parenthesis earcon
                log(`[TTS] Found open paren - playing earcon`);
                await playParenthesesEarcon('open');
            } else if (part === ')') {
                // Play close parenthesis earcon
                log(`[TTS] Found close paren - playing earcon`);
                await playParenthesesEarcon('close');
            } else if (part.trim()) {
                // Check for Python keywords first
                await speakCodePart(part, priority);
            }
        }
    } else {
        // No parentheses, check for Python keywords in the whole text
        if (isStale()) {
            log('[TTS] Aborting code read (stale navigation) before speakCodePart');
            return;
        }
        await speakCodePart(text, priority);
    }
}

/**
 * Speak a code part, optimized for minimal delay between words
 */
async function speakCodePart(text: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!text) {
        return;
    }
    
    // Capture navigation token to cancel stale reads
    const navTokenAtStart = getActiveNavigationToken();
    const isStale = () => getActiveNavigationToken() !== navTokenAtStart;

    // Handle whitespace-only text with panning
    if (!text.trim()) {
        // For whitespace, speak a brief silence with panning applied
        const spaceText = 'space';
        if (!isStale()) {
            await speak(spaceText, priority);
        }
        return;
    }
    
    log(`[TTS] speakCodePart called with: "${text}"`);
    
    // Split text into words and process them
    const words = text.trim().split(/\s+/);
    log(`[TTS] Split into words: ${JSON.stringify(words)}`);
    
    // Group consecutive words by voice type for batch processing
    const groups: Array<{type: 'keyword' | 'regular', words: string[], processedText?: string}> = [];
    let currentGroup: {type: 'keyword' | 'regular', words: string[]} | null = null;
    
    for (const word of words) {
        const cleanWord = word.toLowerCase().replace(/[^\w]/g, '');
        const isKeyword = PYTHON_KEYWORDS.has(cleanWord);
        const wordType = isKeyword ? 'keyword' : 'regular';
        
        log(`[TTS] Word: "${word}" -> clean: "${cleanWord}" -> isKeyword: ${isKeyword} -> type: ${wordType}`);
        
        if (!currentGroup || currentGroup.type !== wordType) {
            // Start new group
            currentGroup = { type: wordType, words: [word] };
            groups.push(currentGroup);
        } else {
            // Add to current group
            currentGroup.words.push(word);
        }
    }
    
    log(`[TTS] Created ${groups.length} groups: ${JSON.stringify(groups.map(g => ({type: g.type, words: g.words})))}`);
    
    // Process each group with optimized scheduling for minimal delays
    for (let i = 0; i < groups.length; i++) {
        if (isStale()) {
            log('[TTS] Aborting speakCodePart (stale navigation) before processing group');
            return;
        }
        const group = groups[i];
        log(`[TTS] Processing group type: ${group.type}, words: ${JSON.stringify(group.words)}`);
        
        if (group.type === 'keyword') {
            // Process keywords individually with immediate completion
            for (const word of group.words) {
                if (isStale()) {
                    log('[TTS] Aborting speakCodePart (stale navigation) during keyword group');
                    return;
                }
                const cleanWord = word.toLowerCase().replace(/[^\w]/g, '');
                const success = await playPythonKeyword(cleanWord, priority);
                
                if (!success) {
                    // Fallback to regular TTS if keyword failed
                    const processedWord = processCodeWord(word);
                    if (processedWord) {
                        if (isStale()) {
                            log('[TTS] Aborting speakCodePart (stale navigation) before fallback speak');
                            return;
                        }
                        await speak(processedWord, priority);
                    }
                }
            }
        } else {
            // Process regular words as a batch with immediate start
            const processedText = group.words
                .map(word => processCodeWord(word))
                .filter(word => word)
                .join(' ');
            
            if (processedText) {
                if (isStale()) {
                    log('[TTS] Aborting speakCodePart (stale navigation) before batch speak');
                    return;
                }
                await speak(processedText, priority);
            }
        }
        
        // Absolutely no delay between groups - immediate processing
    }
}

/**
 * Process a single code word for TTS
 */
function processCodeWord(word: string): string {
    return word
                    // Handle camelCase and PascalCase
                    .replace(/([a-z])([A-Z])/g, '$1 $2')
                    // Handle snake_case and kebab-case
                    .replace(/[_-]/g, ' ')
                    // Handle numbers in identifiers
                    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
                    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
                    // Handle common code punctuation
                    .replace(/\./g, ' dot ')
                    .replace(/,/g, ' comma ')
                    .replace(/;/g, ' semicolon ')
                    .replace(/:/g, ' colon ')
                    .replace(/\[/g, ' open bracket ')
                    .replace(/\]/g, ' close bracket ')
                    .replace(/\{/g, ' open brace ')
                    .replace(/\}/g, ' close brace ')
                    .replace(/"/g, ' quote ')
                    .replace(/'/g, ' apostrophe ')
                    .replace(/=/g, ' equals ')
                    .replace(/\+/g, ' plus ')
                    .replace(/-/g, ' dash ')
                    .replace(/\*/g, ' asterisk ')
                    .replace(/\//g, ' slash ')
                    .replace(/\\/g, ' backslash ')
                    .replace(/</g, ' less than ')
                    .replace(/>/g, ' greater than ')
                    .replace(/@/g, ' at ')
                    .replace(/#/g, ' hash ')
                    .replace(/\$/g, ' dollar ')
                    .replace(/%/g, ' percent ')
                    .replace(/\^/g, ' caret ')
                    .replace(/&/g, ' ampersand ')
                    .replace(/\|/g, ' pipe ')
                    // Clean up multiple spaces
                    .replace(/\s+/g, ' ')
                    .trim();
}

/**
 * Read normal text with minimal processing
 */
export async function readText(text: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!text.trim()) {
        return;
    }
    
    // Check if ASR is currently recording - if so, don't start TTS
    if (getASRRecordingStatus()) {
        log(`[TTS] ASR is recording, skipping text reading: "${text}"`);
        return;
    }
    
    log(`[TTS] Reading text: "${text}"`);
    
    // Minimal processing for normal text - just clean up spacing
    const processed = text.replace(/\s+/g, ' ').trim();
    
    await speak(processed, priority);
}

/**
 * Play ASR start earcon
 */
export async function playASRStartEarcon(): Promise<void> {
    try {
        const fs = require('fs');
        const path = require('path');
        const { spawn } = require('child_process');
        const os = require('os');
        
        // Find project root
        let projectRoot = __dirname;
        while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
            projectRoot = path.dirname(projectRoot);
        }
        
        const earconPath = path.join(projectRoot, 'client', 'audio', 'alert', 'asr_start.wav');
        log(`[TTS] ASR start earcon path: ${earconPath}`);
        
        if (fs.existsSync(earconPath)) {
            log('[TTS] Playing ASR start earcon at 2x speed');
            // Small delay to avoid race with aggressive stopSpeaking kill
            await new Promise(r => setTimeout(r, 30));
            // Create temp file with 2x tempo using sox
            const tempFile = path.join(os.tmpdir(), `asr_start_2x_${Date.now()}.wav`);
            const soxArgs = [earconPath, tempFile, 'tempo', '2.0'];
            const soxProc = spawn('sox', soxArgs, { stdio: 'ignore' });
            
            await new Promise<void>((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                soxProc.on('close', finish);
                soxProc.on('error', finish);
                setTimeout(finish, 500); // Fallback timeout
            });
            
            const playTarget = fs.existsSync(tempFile) ? tempFile : earconPath;
            const process = spawn('afplay', [playTarget], { stdio: 'ignore' });
            process.on('close', (code: number) => {
                log(`[TTS] ASR start earcon completed with code: ${code}`);
                try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
            });
            process.on('error', (error: any) => {
                log(`[TTS] ASR start earcon error: ${error}`);
                try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
            });
        } else {
            log(`[TTS] ASR start earcon file not found: ${earconPath}`);
        }
    } catch (error) {
        log(`[TTS] Error playing ASR start earcon: ${error}`);
    }
}

/**
 * Play ASR stop earcon
 */
export async function playASRStopEarcon(): Promise<void> {
    try {
        const fs = require('fs');
        const path = require('path');
        const { spawn } = require('child_process');
        const os = require('os');
        
        // Find project root
        let projectRoot = __dirname;
        while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
            projectRoot = path.dirname(projectRoot);
        }
        
        const earconPath = path.join(projectRoot, 'client', 'audio', 'alert', 'asr_stop.wav');
        log(`[TTS] ASR stop earcon path: ${earconPath}`);
        
        if (fs.existsSync(earconPath)) {
            log('[TTS] Playing ASR stop earcon at 2x speed');
            // Small delay to avoid race with aggressive stopSpeaking kill
            await new Promise(r => setTimeout(r, 30));
            // Create temp file with 2x tempo using sox
            const tempFile = path.join(os.tmpdir(), `asr_stop_2x_${Date.now()}.wav`);
            const soxArgs = [earconPath, tempFile, 'tempo', '2.0'];
            const soxProc = spawn('sox', soxArgs, { stdio: 'ignore' });
            
            await new Promise<void>((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                soxProc.on('close', finish);
                soxProc.on('error', finish);
                setTimeout(finish, 500); // Fallback timeout
            });
            
            const playTarget = fs.existsSync(tempFile) ? tempFile : earconPath;
            const process = spawn('afplay', [playTarget], { stdio: 'ignore' });
            process.on('close', (code: number) => {
                log(`[TTS] ASR stop earcon completed with code: ${code}`);
                try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
            });
            process.on('error', (error: any) => {
                log(`[TTS] ASR stop earcon error: ${error}`);
                try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
            });
        } else {
            log(`[TTS] ASR stop earcon file not found: ${earconPath}`);
        }
    } catch (error) {
        log(`[TTS] Error playing ASR stop earcon: ${error}`);
    }
}

// Thinking earcon state
let thinkingInterval: NodeJS.Timeout | null = null;
let isThinkingActive = false;

/**
 * Start thinking earcon (repeating)
 */
export async function startThinkingEarcon(): Promise<void> {
    if (isThinkingActive) {
        log('[TTS] Thinking earcon already active');
        return;
    }
    
    isThinkingActive = true;
    log('[TTS] Starting thinking earcon');
    
    const playThinkingSound = async () => {
        if (!isThinkingActive) return;
        
        try {
            const fs = require('fs');
            const path = require('path');
            const { spawn } = require('child_process');
            
            // Find project root
            let projectRoot = __dirname;
            while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
                projectRoot = path.dirname(projectRoot);
            }
            
            const earconPath = path.join(projectRoot, 'client', 'audio', 'alert', 'thinking.wav');
            
            if (fs.existsSync(earconPath)) {
                const process = spawn('afplay', [earconPath], { stdio: 'ignore' });
                
                process.on('error', (error: any) => {
                    log(`[TTS] Thinking earcon error: ${error}`);
                });
            }
        } catch (error) {
            log(`[TTS] Error playing thinking earcon: ${error}`);
        }
    };
    
    // Play immediately and then repeat every 400ms (double frequency)
    await playThinkingSound();
    thinkingInterval = setInterval(playThinkingSound, 400);
}

/**
 * Stop thinking earcon and play finished sound
 */
export async function stopThinkingEarcon(): Promise<void> {
    if (!isThinkingActive) {
        return;
    }
    
    isThinkingActive = false;
    log('[TTS] Stopping thinking earcon');
    
    if (thinkingInterval) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
    
    // Play thinking finished earcon
    try {
        const fs = require('fs');
        const path = require('path');
        const { spawn } = require('child_process');
        
        // Find project root
        let projectRoot = __dirname;
        while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
            projectRoot = path.dirname(projectRoot);
        }
        
        const earconPath = path.join(projectRoot, 'client', 'audio', 'alert', 'thinking_finished.wav');
        
        if (fs.existsSync(earconPath)) {
            log('[TTS] Playing thinking finished earcon');
            const process = spawn('afplay', [earconPath], { stdio: 'ignore' });
            
            process.on('close', (code: number) => {
                log(`[TTS] Thinking finished earcon completed with code: ${code}`);
            });
            
            process.on('error', (error: any) => {
                log(`[TTS] Thinking finished earcon error: ${error}`);
            });
        } else {
            log(`[TTS] Thinking finished earcon file not found: ${earconPath}`);
        }
    } catch (error) {
        log(`[TTS] Error playing thinking finished earcon: ${error}`);
    }
}

/**
 * Legacy compatibility functions
 */
export async function genTokenAudio(text: string, category?: string, options?: any): Promise<string> {
    // Legacy function - now just speaks the text and returns a dummy path
    await speak(text, 'normal');
    return '/tmp/dummy_audio.wav'; // Return dummy path for compatibility
}

export function getSpeakerForCategory(category: string): string {
    // Return appropriate voice based on category
    switch (category) {
        case 'keyword':
        case 'operator':
            return currentSettings.voice; // Use male voice for keywords as per preference
        default:
            return currentSettings.voice;
    }
}

/**
 * Cleanup TTS resources
 */
export function cleanupTTS(): void {
    log('[TTS] Cleaning up TTS resources');
    stopSpeaking();
}
