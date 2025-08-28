// Global controller for line-read cancellation
export let lineAbortController = new AbortController();

import { stopPlayback, clearAudioStoppingState } from '../audio';
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
	
	// 1. Stop main audio player (TTS, PCM, WAV files)
	console.log('[stopAllAudio] 1. Stopping main audio playback');
	stopPlayback(); // Single call is sufficient - reduces audio crackling
	
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
	
	// 8. Force additional stop calls to ensure everything is terminated
	console.log('[stopAllAudio] 8. Final safety stop call');
	stopPlayback();
	
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
	import('./vibe_coding.js').then(({ stopVibeCodingTTS }) => {
		stopVibeCodingTTS();
	}).catch(() => {
		// Ignore import errors - vibe coding might not be available
	});
	
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