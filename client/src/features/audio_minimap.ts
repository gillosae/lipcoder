import * as vscode from 'vscode';
import { log } from '../utils';
import { config } from '../config';
import { playWave, stopPlayback } from '../audio';
import * as path from 'path';
const Speaker = require('speaker');

// Continuous tone generation using longer buffers and seamless streaming
class ContinuousToneGenerator {
    private speaker: any = null;
    private isPlaying = false;
    private currentFrequency = 440;
    private sampleRate = 24000;
    private channels = 2;
    private bitDepth = 16;
    private volume = 0.2; // Reduced volume to avoid distortion
    private phaseAccumulator = 0; // Track phase for seamless frequency transitions
    private isGenerating = false;
    
    constructor() {
        // Will be initialized when needed
    }
    
    private generateContinuousBuffer(frequency: number, durationSeconds: number): Buffer {
        const samplesCount = Math.floor(this.sampleRate * durationSeconds);
        const bufferSize = samplesCount * this.channels * (this.bitDepth / 8);
        const buffer = Buffer.alloc(bufferSize);
        
        // Calculate phase increment for this frequency
        const phaseIncrement = (2 * Math.PI * frequency) / this.sampleRate;
        
        let bufferIndex = 0;
        for (let i = 0; i < samplesCount; i++) {
            // Generate sine wave sample with continuous phase
            const amplitude = Math.sin(this.phaseAccumulator) * this.volume * 32767;
            const sample = Math.round(amplitude);
            
            // Write stereo samples
            buffer.writeInt16LE(sample, bufferIndex);     // Left channel
            buffer.writeInt16LE(sample, bufferIndex + 2); // Right channel
            bufferIndex += 4;
            
            // Update phase accumulator
            this.phaseAccumulator += phaseIncrement;
            
            // Keep phase in reasonable range to avoid overflow
            if (this.phaseAccumulator > 2 * Math.PI) {
                this.phaseAccumulator -= 2 * Math.PI;
            }
        }
        
        return buffer;
    }
    
    startTone(frequency: number): void {
        if (this.isPlaying) {
            this.updateFrequency(frequency);
            return;
        }
        
        try {
            // Stop any existing playback first
            stopPlayback();
            
            this.currentFrequency = frequency;
            this.isPlaying = true;
            this.phaseAccumulator = 0; // Reset phase for new tone
            this.isGenerating = false;
            
            // Create speaker instance with larger buffer
            this.speaker = new Speaker({
                channels: this.channels,
                bitDepth: this.bitDepth,
                sampleRate: this.sampleRate,
                samplesPerFrame: 2048 // Larger frame size for smoother playback
            });
            
            this.speaker.on('close', () => {
                log('[ContinuousTone] Speaker closed');
                this.cleanup();
            });
            
            this.speaker.on('error', (err: any) => {
                log(`[ContinuousTone] Speaker error: ${err}`);
                this.stopTone();
            });
            
            // Start continuous generation with longer buffers
            this.startContinuousGeneration();
            
            log(`[ContinuousTone] Started continuous tone at ${frequency}Hz`);
        } catch (error) {
            log(`[ContinuousTone] Failed to start tone: ${error}`);
            this.isPlaying = false;
        }
    }
    
    private startContinuousGeneration(): void {
        if (this.isGenerating) return;
        this.isGenerating = true;
        
        const generateAndQueue = () => {
            if (!this.isPlaying || !this.speaker || this.speaker.destroyed) {
                this.isGenerating = false;
                return;
            }
            
            try {
                // Generate 200ms of continuous audio
                const buffer = this.generateContinuousBuffer(this.currentFrequency, 0.2);
                
                // Write to speaker
                const success = this.speaker.write(buffer);
                
                if (!success) {
                    // Handle backpressure - wait for drain
                    this.speaker.once('drain', () => {
                        if (this.isPlaying) {
                            setImmediate(generateAndQueue); // Continue immediately after drain
                        } else {
                            this.isGenerating = false;
                        }
                    });
                } else {
                    // Schedule next buffer generation with minimal delay
                    setImmediate(generateAndQueue);
                }
            } catch (error) {
                log(`[ContinuousTone] Error generating audio: ${error}`);
                this.stopTone();
            }
        };
        
        // Start the generation loop
        generateAndQueue();
    }
    
    updateFrequency(frequency: number): void {
        if (!this.isPlaying) return;
        
        // Smoothly update frequency - phase accumulator continues seamlessly
        this.currentFrequency = frequency;
        log(`[ContinuousTone] Updated frequency to ${frequency}Hz`);
    }
    
    stopTone(): void {
        if (!this.isPlaying) return;
        
        log('[ContinuousTone] Stopping continuous tone...');
        this.isPlaying = false;
        this.isGenerating = false;
        
        try {
            if (this.speaker && !this.speaker.destroyed) {
                this.speaker.end();
            }
        } catch (error) {
            log(`[ContinuousTone] Error stopping tone: ${error}`);
        }
    }
    
    // Getter to check if tone is currently playing
    get isCurrentlyPlaying(): boolean {
        return this.isPlaying;
    }
    
    // Public cleanup method
    cleanup(): void {
        this.stopTone();
        // Force cleanup after a short delay
        setTimeout(() => {
            if (this.speaker && !this.speaker.destroyed) {
                try {
                    this.speaker.destroy();
                } catch (e) {
                    // Ignore errors during forced cleanup
                }
            }
            this.speaker = null;
            this.isPlaying = false;
            this.isGenerating = false;
            log('[ContinuousTone] Forced cleanup completed');
        }, 100);
    }
}

// Global tone generator instance
const toneGenerator = new ContinuousToneGenerator();

// Speed tracking variables
let lastLineChange: number | null = null;
let lastLineNumber: number | null = null;
let isInFastMovement = false;
let fastMovementTimeout: NodeJS.Timeout | null = null;
let recentMovements: Array<{line: number, time: number}> = [];

/**
 * Calculate cursor movement speed using a sliding window approach
 */
function calculateMovementSpeed(currentLine: number): number | null {
    const now = Date.now();
    
    // Add current movement to the window
    recentMovements.push({line: currentLine, time: now});
    
    // Keep only movements from the last 300ms (shorter window for more responsive detection)
    const windowMs = 300;
    recentMovements = recentMovements.filter(m => now - m.time <= windowMs);
    
    // Need at least 3 movements to calculate speed (more strict)
    if (recentMovements.length < 3) {
        return null;
    }
    
    // Calculate speed over the window
    const oldest = recentMovements[0];
    const newest = recentMovements[recentMovements.length - 1];
    const timeDiff = newest.time - oldest.time;
    const lineDiff = Math.abs(newest.line - oldest.line);
    
    if (timeDiff <= 0 || lineDiff === 0) {
        return null;
    }
    
    const speed = (lineDiff / timeDiff) * 1000; // lines per second
    log(`[AudioMinimap] Movement speed: ${speed.toFixed(2)} lines/sec (${lineDiff} lines in ${timeDiff}ms, ${recentMovements.length} movements)`);
    
    return speed;
}

/**
 * Map file position to frequency (continuous pitch)
 */
function getFrequencyForPosition(currentLine: number, totalLines: number): number {
    if (totalLines <= 1) {
        return 440; // A4 for single line files
    }
    
    // Calculate position ratio (0.0 to 1.0)
    const ratio = currentLine / (totalLines - 1);
    
    // Map to frequency range: 220Hz (A3) to 880Hz (A5) - 2 octaves
    const minFreq = 220; // A3
    const maxFreq = 880; // A5
    const frequency = minFreq + (ratio * (maxFreq - minFreq));
    
    return Math.round(frequency * 10) / 10; // Round to 1 decimal place
}

/**
 * Update continuous tone for current position
 */
export function updateContinuousTone(editor: vscode.TextEditor): void {
    if (!config.audioMinimapEnabled || !isInFastMovement) {
        return;
    }
    
    const currentLine = editor.selection.active.line;
    const totalLines = editor.document.lineCount;
    
    const frequency = getFrequencyForPosition(currentLine, totalLines);
    const percentage = ((currentLine / (totalLines - 1)) * 100).toFixed(1);
    
    log(`[AudioMinimap] Updating tone to ${frequency}Hz for line ${currentLine + 1}/${totalLines} (${percentage}%)`);
    
    toneGenerator.updateFrequency(frequency);
}

/**
 * Check if cursor movement should trigger audio minimap
 */
export function shouldUseAudioMinimap(currentLine: number, editor?: vscode.TextEditor): boolean {
    if (!config.audioMinimapEnabled) {
        return false;
    }
    
    const speed = calculateMovementSpeed(currentLine);
    
    // Clear any existing timeout first
    if (fastMovementTimeout) {
        clearTimeout(fastMovementTimeout);
        fastMovementTimeout = null;
    }
    
    // If we have a valid speed measurement
    if (speed !== null) {
        const shouldUse = speed >= config.audioMinimapSpeedThreshold;
        
        if (shouldUse && !isInFastMovement) {
            // Start continuous tone when fast movement begins
            log(`[AudioMinimap] Starting fast movement at line ${currentLine + 1} (speed: ${speed.toFixed(2)} lines/sec)`);
            isInFastMovement = true;
            if (editor) {
                const frequency = getFrequencyForPosition(currentLine, editor.document.lineCount);
                toneGenerator.startTone(frequency);
                log(`[AudioMinimap] Started continuous tone at ${frequency}Hz`);
            }
        }
        
        if (isInFastMovement) {
            // Set timeout to detect when movement stops
            fastMovementTimeout = setTimeout(() => {
                log(`[AudioMinimap] Movement timeout triggered for line ${currentLine + 1}`);
                onFastMovementEnd(currentLine, editor);
            }, 150); // Reasonable timeout for detecting end of movement
        }
        
        log(`[AudioMinimap] Speed: ${speed.toFixed(2)} lines/sec, threshold: ${config.audioMinimapSpeedThreshold}, use minimap: ${shouldUse}, inFastMovement: ${isInFastMovement}`);
        
        return shouldUse;
    } else {
        // No valid speed measurement
        if (isInFastMovement) {
            // If we were in fast movement but now have no speed data, set a short timeout
            fastMovementTimeout = setTimeout(() => {
                log(`[AudioMinimap] No speed data timeout triggered for line ${currentLine + 1}`);
                onFastMovementEnd(currentLine, editor);
            }, 100); // Shorter timeout when speed data is unavailable
        }
        
        log(`[AudioMinimap] No speed data available, inFastMovement: ${isInFastMovement}`);
        return isInFastMovement; // Continue if already in fast movement
    }
}

/**
 * Called when fast movement ends
 */
function onFastMovementEnd(lastLine: number, editor?: vscode.TextEditor): void {
    if (!isInFastMovement) return;
    
    log(`[AudioMinimap] Fast movement ending at line ${lastLine + 1}...`);
    isInFastMovement = false;
    
    // Stop the continuous tone immediately
    toneGenerator.stopTone();
    
    // Clear recent movements to prevent false speed calculations
    recentMovements = [];
    
    // Wait a short moment for the tone to fully stop, then announce line number
    setTimeout(() => {
        log(`[AudioMinimap] Announcing line ${lastLine + 1} after tone stopped`);
        
        if (editor) {
            vscode.commands.executeCommand('lipcoder.readLineTokens', editor)
                .then(() => {
                    log(`[AudioMinimap] Line announcement completed for line ${lastLine + 1}`);
                }, (err: any) => {
                    log(`[AudioMinimap] Line announcement failed: ${err}`);
                });
        } else {
            vscode.commands.executeCommand('lipcoder.readLineTokens')
                .then(() => {
                    log(`[AudioMinimap] Line announcement completed for line ${lastLine + 1}`);
                }, (err: any) => {
                    log(`[AudioMinimap] Line announcement failed: ${err}`);
                });
        }
    }, 150); // Give tone time to stop
}

/**
 * Reset speed tracking (call when editor changes or long pause)
 */
export function resetSpeedTracking(currentLine?: number, editor?: vscode.TextEditor): void {
    lastLineChange = null;
    lastLineNumber = null;
    
    // If we were in fast movement, end it properly with line announcement
    if (isInFastMovement) {
        log('[AudioMinimap] Speed tracking reset - ending fast movement with line announcement');
        
        // Clear timeout first to prevent double calls
        if (fastMovementTimeout) {
            clearTimeout(fastMovementTimeout);
            fastMovementTimeout = null;
        }
        
        // Get current line from editor if not provided
        let lineToAnnounce = currentLine;
        if (lineToAnnounce === undefined && editor) {
            lineToAnnounce = editor.selection.active.line;
        }
        
        // Call onFastMovementEnd to properly stop tone and announce line
        if (lineToAnnounce !== undefined) {
            onFastMovementEnd(lineToAnnounce, editor);
        } else {
            // Fallback: just stop the tone if we can't get line number
            isInFastMovement = false;
            toneGenerator.stopTone();
            log('[AudioMinimap] Speed tracking reset - stopped tone without line announcement (no line info)');
        }
    }
    
    recentMovements = [];
    
    if (fastMovementTimeout) {
        clearTimeout(fastMovementTimeout);
        fastMovementTimeout = null;
    }
}

/**
 * Cleanup function to be called when extension deactivates
 */
export function cleanupAudioMinimap(): void {
    resetSpeedTracking();
    toneGenerator.cleanup();
    log('[AudioMinimap] Audio minimap cleanup completed');
}

/**
 * Check if continuous tone is currently playing
 */
export function isContinuousTonePlaying(): boolean {
    return toneGenerator.isCurrentlyPlaying;
} 