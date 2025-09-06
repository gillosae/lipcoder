import * as vscode from 'vscode';
import { log } from '../utils';
// Remove conflicting import - we'll define our own stopAllAudio

/**
 * Stop reading functionality - simplified for native macOS TTS
 */

/**
 * Register stop-related commands
 */
export function registerStopReading(context: any): void {
    try {
        // Stop token/line reading (LLM/tts abort)
        context.subscriptions.push(
            vscode.commands.registerCommand('lipcoder.stopReadLineTokens', async () => {
                try {
                    stopReading();
                } catch (error) {
                    log(`[StopReading] Error in stopReadLineTokens: ${error}`);
                }
            })
        );

        // Global stop: ASR recording, thinking earcon, TTS/audio, and abort LLM
        context.subscriptions.push(
            vscode.commands.registerCommand('lipcoder.stopAllAudio', async () => {
                try {
                    // Abort current TTS/LLM and stop audio
                    stopReading();

                    // Stop ASR recording if active
                    try {
                        const asrModule = require('./enhanced_push_to_talk_asr');
                        if (asrModule && typeof asrModule.getASRRecordingStatus === 'function' && asrModule.getASRRecordingStatus()) {
                            if (typeof asrModule.stopASRCommandMode === 'function') {
                                await asrModule.stopASRCommandMode();
                            } else if (typeof asrModule.stopASRWriteMode === 'function') {
                                await asrModule.stopASRWriteMode();
                            } else if (typeof asrModule.cleanupASRResources === 'function') {
                                asrModule.cleanupASRResources();
                            }
                        }
                    } catch (e) {
                        // Non-fatal
                    }

                    // Stop "thinking" earcon if playing
                    try {
                        const audio = require('../audio');
                        if (typeof audio.stopThinkingAudio === 'function') {
                            await audio.stopThinkingAudio();
                        }
                    } catch (e) {
                        // Non-fatal
                    }
                } catch (error) {
                    log(`[StopReading] Error in stopAllAudio command: ${error}`);
                }
            })
        );

        // Nuclear stop: aggressively kill audio processes and stop ASR/thinking
        context.subscriptions.push(
            vscode.commands.registerCommand('lipcoder.forceKillAllAudio', async () => {
                try {
                    // Immediate TTS kill and process-level termination
                    stopForCursorMovement();

                    // Stop ASR completely
                    try {
                        const asrModule = require('./enhanced_push_to_talk_asr');
                        if (asrModule && typeof asrModule.cleanupASRResources === 'function') {
                            asrModule.cleanupASRResources();
                        }
                    } catch (e) {
                        // Non-fatal
                    }

                    // Ensure thinking earcon is stopped
                    try {
                        const audio = require('../audio');
                        if (typeof audio.stopThinkingAudio === 'function') {
                            await audio.stopThinkingAudio();
                        }
                    } catch (e) {
                        // Non-fatal
                    }

                    // Finally, abort any pending LLM/line operations
                    try {
                        lineAbortController.abort();
                        lineAbortController = new AbortController();
                    } catch (e) {
                        // Non-fatal
                    }
                } catch (error) {
                    log(`[StopReading] Error in forceKillAllAudio command: ${error}`);
                }
            })
        );
    } catch (error) {
        log(`[StopReading] Failed to register stop commands: ${error}`);
    }
}

// Global abort controller for line reading
export let lineAbortController = new AbortController();

// Reading state tracking
let lineTokenReadingActive = false;
let asrRecordingActive = false;
let navigationGeneration = 0;

/**
 * Stop all reading and audio
 */
export function stopReading(): void {
    log('[StopReading] Stopping all reading');
    stopAllAudio();
    
    // Abort current operations
    lineAbortController.abort();
    lineAbortController = new AbortController();
    
    // Reset state
    lineTokenReadingActive = false;
}

/**
 * Stop all audio including TTS (comprehensive stop for all audio sources)
 */
export function stopAllAudio(): void {
    log('[StopReading] Stopping all audio sources');
    
    // Stop TTS immediately (both male and female voices)
    import('../tts.js').then(tts => {
        tts.stopSpeaking();
        tts.cleanupTTS();
    }).catch(error => {
        log(`[StopReading] Error stopping TTS: ${error}`);
    });
    
    // Stop audio module functions
    import('../audio.js').then(audio => {
        if (audio.stopAllAudio) {
            audio.stopAllAudio();
        }
    }).catch(error => {
        log(`[StopReading] Error stopping audio module: ${error}`);
    });
    
    // Kill any remaining macOS say processes
    try {
        const { spawn } = require('child_process');
        spawn('pkill', ['-f', 'say'], { stdio: 'ignore' });
        spawn('pkill', ['-f', 'afplay'], { stdio: 'ignore' });
        spawn('pkill', ['-f', 'sox'], { stdio: 'ignore' });
    } catch (error) {
        log(`[StopReading] Error killing audio processes: ${error}`);
    }
}

/**
 * Stop for cursor movement (IMMEDIATE comprehensive TTS stop for all voices)
 */
export function stopForCursorMovement(): void {
    log('[StopReading] IMMEDIATE STOP - Terminating all TTS for cursor movement');
    
    // Stop all TTS immediately (both male and female voices)
    import('../tts.js').then(tts => {
        tts.stopSpeaking();
    }).catch(error => {
        log(`[StopReading] Error stopping TTS for cursor movement: ${error}`);
    });
    
    // IMMEDIATE KILL: Use execSync for instant termination without waiting
    try {
        const { execSync } = require('child_process');
        
        // Kill all audio processes with SIGKILL (-9) for immediate termination
        try {
            execSync('pkill -9 -f "say"', { stdio: 'ignore', timeout: 50 });
            log('[StopReading] SIGKILL all say processes for cursor movement');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "afplay"', { stdio: 'ignore', timeout: 50 });
            log('[StopReading] SIGKILL all afplay processes for cursor movement');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "sox"', { stdio: 'ignore', timeout: 50 });
            log('[StopReading] SIGKILL all sox processes for cursor movement');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "ffmpeg"', { stdio: 'ignore', timeout: 50 });
            log('[StopReading] SIGKILL all ffmpeg processes for cursor movement');
        } catch (e) {}
        
        try {
            execSync('pkill -9 -f "soxi"', { stdio: 'ignore', timeout: 50 });
            log('[StopReading] SIGKILL all soxi processes for cursor movement');
        } catch (e) {}
        
        log('[StopReading] IMMEDIATE STOP COMPLETE for cursor movement');
    } catch (error) {
        log(`[StopReading] Error in immediate stop for cursor movement: ${error}`);
    }
    
    // Reset state but don't abort controller
    lineTokenReadingActive = false;
}

/**
 * Stop for new line reading (only stop TTS, don't interfere with new line reading)
 */
export function stopForNewLineReading(): void {
    log('[StopReading] Stopping for new line reading (TTS only)');
    
    // Only stop TTS, don't call stopAllAudio to avoid interfering with new line reading
    import('../tts.js').then(tts => tts.stopSpeaking());
    
    // Reset state but don't abort controller
    lineTokenReadingActive = false;
}

/**
 * Get line token reading active state
 */
export function getLineTokenReadingActive(): boolean {
    return lineTokenReadingActive;
}

/**
 * Set line token reading active state
 */
export function setLineTokenReadingActive(active: boolean): void {
    lineTokenReadingActive = active;
}

/**
 * Get ASR recording active state
 */
export function getASRRecordingActive(): boolean {
    return asrRecordingActive;
}

/**
 * Set ASR recording active state
 */
export function setASRRecordingActive(active: boolean): void {
    asrRecordingActive = active;
}

/**
 * Bump navigation generation
 */
export function bumpNavigationGeneration(): void {
    navigationGeneration++;
}

/**
 * Get navigation generation
 */
export function getNavigationGeneration(): number {
    return navigationGeneration;
}
