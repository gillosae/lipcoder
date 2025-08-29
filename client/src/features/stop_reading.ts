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
	console.log('[stopAllAudio] 🛑 STOP ALL AUDIO CALLED - starting comprehensive cleanup');
	
	// 1. Stop main audio player (TTS, PCM, WAV files) - MULTIPLE CALLS FOR SAFETY
	console.log('[stopAllAudio] 1. Stopping main audio playback');
	stopPlayback(); // First call
	stopPlayback(); // Second call for safety
	
	// 2. Stop earcon playback (punctuation sounds, etc.)
	console.log('[stopAllAudio] 2. Stopping earcon playback');
	stopEarconPlayback();
	
	// 3. Stop audio minimap (continuous tones during fast navigation) 
	console.log('[stopAllAudio] 3. Cleaning up audio minimap');
	cleanupAudioMinimap();
	
	// 4. Abort the line reading controller (this will also stop image descriptions)
	console.log('[stopAllAudio] 4. Aborting line reading controller');
	lineAbortController.abort();
	
	// 5. Create a new controller for the next reading session
	console.log('[stopAllAudio] 5. Creating new abort controller');
	// @ts-ignore
	lineAbortController = new AbortController();
	
	// 6. Clear the active flags
	console.log('[stopAllAudio] 6. Clearing active flags');
	setLineTokenReadingActive(false);
	
	// 7. Clear image description active flag if it's running
	console.log('[stopAllAudio] 7. Clearing image description active flag');
	try {
		const { setImageDescriptionActive } = require('./image_description');
		setImageDescriptionActive(false);
		console.log('[stopAllAudio] 7a. Image description active flag cleared');
	} catch (error) {
		console.log('[stopAllAudio] 7b. Image description module not available (normal)');
	}
	
	// 8. Stop vibe coding TTS if active (fix for Command+. not stopping vibe coding TTS)
	console.log('[stopAllAudio] 8. Stopping vibe coding TTS if active');
	try {
		// Use synchronous require to avoid timing issues
		const vibeCoding = require('./vibe_coding');
		if (vibeCoding && vibeCoding.stopVibeCodingTTS) {
			vibeCoding.stopVibeCodingTTS();
			console.log('[stopAllAudio] 8a. Vibe coding TTS stopped');
		} else {
			console.log('[stopAllAudio] 8b. stopVibeCodingTTS function not available');
		}
		
		// Also directly set vibe coding TTS active state to false
		if (vibeCoding && vibeCoding.setVibeCodingTTSActive) {
			vibeCoding.setVibeCodingTTSActive(false);
			console.log('[stopAllAudio] 8c. Vibe coding TTS active state set to false');
		}
	} catch (error) {
		console.log('[stopAllAudio] 8d. Error stopping vibe coding TTS (normal):', error);
	}
	
	// 9. Stop GPT TTS and notification TTS (NEW - for notification말하기 중단)
	console.log('[stopAllAudio] 9. Stopping GPT TTS and notification TTS');
	try {
		// Stop GPT TTS controller if active
		stopGPTTTS();
		console.log('[stopAllAudio] 9a. GPT TTS stopped');
		
		// Stop thinking audio if active
		stopThinkingAudio();
		console.log('[stopAllAudio] 9b. Thinking audio stopped');
		
	} catch (error) {
		console.log('[stopAllAudio] 9c. Error stopping GPT TTS (normal):', error);
	}
	
	// 10. Force additional stop calls to ensure everything is terminated
	console.log('[stopAllAudio] 10. Final safety stop calls');
	stopPlayback(); // Third call
	
	// 11. Try to stop any remaining audio processes
	console.log('[stopAllAudio] 11. Emergency audio cleanup');
	try {
		const { cleanupAudioResources } = require('../audio');
		cleanupAudioResources();
		console.log('[stopAllAudio] 11a. Audio resources cleaned up');
		
		// Also try direct audio player stop
		const audioModule = require('../audio');
		if (audioModule.audioPlayer && audioModule.audioPlayer.stopAll) {
			audioModule.audioPlayer.stopAll();
			console.log('[stopAllAudio] 11b. Direct audio player stopped');
		}
	} catch (error) {
		console.log('[stopAllAudio] 11c. Audio cleanup error (normal):', error);
	}
	
	// 12. Stop conversational ASR processing if active
	console.log('[stopAllAudio] 12. Stopping conversational ASR processing');
	try {
		const conversationalModule = require('../conversational_asr');
		// This will stop any ongoing LLM processing and TTS
		if (conversationalModule.stopAllProcessing) {
			conversationalModule.stopAllProcessing();
			console.log('[stopAllAudio] 12a. Conversational ASR processing stopped');
		}
	} catch (error) {
		console.log('[stopAllAudio] 12b. Error stopping conversational ASR (normal):', error);
	}
	
	// Note: stopping state will be cleared explicitly by callers when they want to start new audio
	console.log('[stopAllAudio] 🛑 ALL AUDIO STOPPED - comprehensive cleanup completed');
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
			console.log('[stopReadLineTokens] Command called - delegating to stopAllAudio');
			stopAllAudio();
		}),
		
		vscode.commands.registerCommand('lipcoder.stopAllAudio', () => {
			console.log('[stopAllAudio] Command called directly');
			stopAllAudio();
		})
	);
}