// Global controller for line-read cancellation
export let lineAbortController = new AbortController();

import { stopPlayback, clearAudioStoppingState, stopGPTTTS, stopThinkingAudio } from '../audio';
import { stopEarconPlayback } from '../earcon';
import { cleanupAudioMinimap } from './audio_minimap';
import * as vscode from 'vscode';

// Track if line token reading is currently active
let lineTokenReadingActive = false;

// Track if ASR is currently recording (to prevent token reading from starting)
let asrRecordingActive = false;

// Navigation generation to invalidate stale reads when cursor moves again
let navigationGeneration = 0;

export function bumpNavigationGeneration(): number {
    navigationGeneration += 1;
    return navigationGeneration;
}

export function getNavigationGeneration(): number {
    return navigationGeneration;
}

export function setLineTokenReadingActive(active: boolean): void {
	lineTokenReadingActive = active;
	
	// AGGRESSIVE: Disable ALL inline suggestions during line reading
	if (active) {
		// Hide any existing inline suggestions
		vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
		
		// Cancel any pending inline suggestions
		Promise.resolve(vscode.commands.executeCommand('editor.action.inlineSuggest.cancel')).catch(() => {
			// Ignore if command doesn't exist
		});
		
		// CRITICAL: Disable VSCode's built-in inline suggestions completely
		Promise.resolve(vscode.commands.executeCommand('setContext', 'inlineSuggestionsEnabled', false)).catch(() => {
			// Ignore if command doesn't exist
		});
		
		// Also disable GitHub Copilot if present
		Promise.resolve(vscode.commands.executeCommand('github.copilot.toggleInlineSuggestion', false)).catch(() => {
			// Ignore if Copilot not installed
		});
		
	} else {
		// Re-enable inline suggestions when line reading stops
		Promise.resolve(vscode.commands.executeCommand('setContext', 'inlineSuggestionsEnabled', true)).catch(() => {
			// Ignore if command doesn't exist
		});
		
		// Re-enable GitHub Copilot if present
		Promise.resolve(vscode.commands.executeCommand('github.copilot.toggleInlineSuggestion', true)).catch(() => {
			// Ignore if Copilot not installed
		});
		
		// Re-enable editor inline suggestions setting
		const config = vscode.workspace.getConfiguration('editor');
		if (config.get('inlineSuggest.enabled') !== true) {
			config.update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
		}
	}
}

export function getLineTokenReadingActive(): boolean {
	return lineTokenReadingActive;
}

export function setASRRecordingActive(active: boolean): void {
	asrRecordingActive = active;
}

export function getASRRecordingActive(): boolean {
	return asrRecordingActive;
}

export function stopAllAudio(): void {
	// COMPREHENSIVE AUDIO STOPPING - Stop all types of audio immediately
	
	// 1. Stop main audio player (TTS, PCM, WAV files) - MULTIPLE CALLS FOR SAFETY
	stopPlayback(); // First call
	stopPlayback(); // Second call for safety
	stopPlayback(); // Third call for extra safety
	
	// 2. Stop earcon playback (punctuation sounds, etc.)
	stopEarconPlayback();
	
	// 3. Stop audio minimap (continuous tones during fast navigation) 
	cleanupAudioMinimap();
	
	// 4. Abort the line reading controller (this will also stop image descriptions)
	lineAbortController.abort();
	
	// 5. Create a new controller for the next reading session
	// @ts-ignore
	lineAbortController = new AbortController();
	
	// 6. Clear the active flags
	setLineTokenReadingActive(false);
	
	// 7. Clear image description active flag if it's running
	try {
		const { setImageDescriptionActive } = require('./image_description');
		setImageDescriptionActive(false);
	} catch (error) {
		// Image description module not available
	}
	
	// 8. Stop vibe coding TTS if active (fix for Command+. not stopping vibe coding TTS)
	try {
		// Use synchronous require to avoid timing issues
		const vibeCoding = require('./vibe_coding');
		if (vibeCoding && vibeCoding.stopVibeCodingTTS) {
			vibeCoding.stopVibeCodingTTS();
		}
		
		// Also directly set vibe coding TTS active state to false
		if (vibeCoding && vibeCoding.setVibeCodingTTSActive) {
			vibeCoding.setVibeCodingTTSActive(false);
		}
	} catch (error) {
		// Vibe coding module not available
	}
	
	// 8.5. Stop code analysis TTS if active (fix for Command+. not stopping code analysis TTS)
	try {
		const codeAnalysis = require('./code_analysis');
		if (codeAnalysis && codeAnalysis.stopCodeAnalysisTTS) {
			codeAnalysis.stopCodeAnalysisTTS();
		}
	} catch (error) {
		// Code analysis module not available
	}
	
	// 9. Stop GPT TTS and notification TTS (NEW - for notification말하기 중단)
	try {
		// Stop GPT TTS controller if active
		stopGPTTTS();
		
		// Stop thinking audio if active
		stopThinkingAudio();
		
	} catch (error) {
		// GPT TTS module not available
	}
	
	// 10. Force additional stop calls to ensure everything is terminated
	stopPlayback(); // Third call
	
	// 11. Try to stop any remaining audio processes
	try {
		const { cleanupAudioResources } = require('../audio');
		cleanupAudioResources();
		
		// Also try direct audio player stop
		const audioModule = require('../audio');
		if (audioModule.audioPlayer && audioModule.audioPlayer.stopAll) {
			audioModule.audioPlayer.stopAll();
		}
	} catch (error) {
		// Audio cleanup error - ignore
	}
	
	// 12. Stop conversational ASR processing if active
	try {
		const conversationalModule = require('../conversational_asr');
		// This will stop any ongoing LLM processing and TTS
		if (conversationalModule.stopAllProcessing) {
			conversationalModule.stopAllProcessing();
		}
	} catch (error) {
		// Conversational ASR module not available
	}
	
	// 13. Stop terminal audio processing if active (avoid infinite loop)
	try {
		// Just abort terminal controller directly to avoid circular calls
		const terminalModule = require('./terminal');
		if (terminalModule.terminalAbortController) {
			terminalModule.terminalAbortController.abort();
		}
	} catch (error) {
		// Terminal module not available
	}
	
	// 14. Clear audio stopping state to allow new audio
	clearAudioStoppingState();
}

/**
 * NUCLEAR OPTION: Force kill ALL audio processes immediately
 * Use this when regular stopAllAudio() doesn't work
 */
export function forceKillAllAudio(): void {
	try {
		// 1. Multiple aggressive stop calls with immediate flag
		for (let i = 0; i < 10; i++) {
			stopPlayback();
			stopEarconPlayback();
			
			// Also try direct audioPlayer access for immediate stopping
			try {
				const { audioPlayer } = require('../audio');
				if (audioPlayer && audioPlayer.stopCurrentPlayback) {
					audioPlayer.stopCurrentPlayback(true); // Force immediate
				}
			} catch (e) {}
		}
		
		// 2. Force abort ALL controllers multiple times
		for (let i = 0; i < 3; i++) {
			lineAbortController.abort();
			// @ts-ignore
			lineAbortController = new AbortController();
		}
		
		// 3. Force stop GPT TTS multiple times
		for (let i = 0; i < 3; i++) {
			stopGPTTTS();
			stopThinkingAudio();
		}
		
		// 4. Clear all audio state flags aggressively
		setLineTokenReadingActive(false);
		setASRRecordingActive(false);
		
		// 5. Try to kill any remaining audio processes via enhanced cleanup
		try {
			const { enhancedCleanupAudioResources } = require('../audio');
			enhancedCleanupAudioResources();
		} catch (e) {
			// Enhanced cleanup not available
		}
		
		// 6. Force clear audio minimap multiple times
		for (let i = 0; i < 3; i++) {
			cleanupAudioMinimap();
		}
		
		// 7. Force stop all feature-specific TTS
		try {
			const vibeCoding = require('./vibe_coding');
			if (vibeCoding?.stopVibeCodingTTS) {
				for (let i = 0; i < 3; i++) {
					vibeCoding.stopVibeCodingTTS();
				}
			}
		} catch (e) {}
		
		try {
			const codeAnalysis = require('./code_analysis');
			if (codeAnalysis?.stopCodeAnalysisTTS) {
				for (let i = 0; i < 3; i++) {
					codeAnalysis.stopCodeAnalysisTTS();
				}
			}
		} catch (e) {}
		
		try {
			const imageDesc = require('./image_description');
			if (imageDesc?.setImageDescriptionActive) {
				imageDesc.setImageDescriptionActive(false);
			}
		} catch (e) {}
		
		// 8. Final safety cleanup
		try {
			const { cleanupAudioResources, clearAudioStoppingState } = require('../audio');
			cleanupAudioResources();
			clearAudioStoppingState();
		} catch (e) {}
		
	} catch (error) {
		console.error('[forceKillAllAudio] Error during nuclear stop:', error);
	}
}

// Legacy function name for backward compatibility  
export function stopReading(): void {
	stopAllAudio();
}

// Specialized function for cursor movement - stops everything and prepares for new audio
export function stopForCursorMovement(): void {
	// Stop all current audio
	stopAllAudio();
	
	// Stop vibe coding TTS if active
	try {
		const vibeCoding = require('./vibe_coding');
		if (vibeCoding && vibeCoding.stopVibeCodingTTS) {
			vibeCoding.stopVibeCodingTTS();
		}
	} catch (error) {
		// Ignore import errors - vibe coding might not be available
	}
	
	// Clear stopping state immediately since cursor movement should start new audio right away
	clearAudioStoppingState();
}

// Specialized function for new line reading - comprehensive stop with preparation
export function stopForNewLineReading(): void {
	// Stop all current audio
	stopAllAudio();
	
	// Clear stopping state immediately for new audio to start
	clearAudioStoppingState();
}

export function registerStopReading(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.stopReadLineTokens', () => {
			stopAllAudio();
		}),
		
		vscode.commands.registerCommand('lipcoder.stopAllAudio', () => {
			stopAllAudio();
		}),
		
		// NUCLEAR OPTION: Force kill all audio when regular stop doesn't work
		vscode.commands.registerCommand('lipcoder.forceKillAllAudio', () => {
			forceKillAllAudio();
		})
	);
}