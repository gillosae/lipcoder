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
	
	// 1. Stop main audio player (TTS, PCM, WAV files)
	stopPlayback(); // Single call is sufficient - reduces audio crackling
	
	// 2. Stop earcon playback (punctuation sounds, etc.)
	stopEarconPlayback();
	
	// 3. Stop audio minimap (continuous tones during fast navigation) 
	cleanupAudioMinimap();
	
	// 4. Abort the line reading controller
	lineAbortController.abort();
	
	// 5. Create a new controller for the next reading session
	// @ts-ignore
	lineAbortController = new AbortController();
	
	// 6. Clear the active flag
	setLineTokenReadingActive(false);
	
	// 7. Force additional stop calls to ensure everything is terminated
	stopPlayback();
	
	// Note: stopping state will be cleared explicitly by callers when they want to start new audio
}

// Legacy function name for backward compatibility  
export function stopReading(): void {
	stopAllAudio();
}

// Specialized function for cursor movement - stops everything and prepares for new audio
export function stopForCursorMovement(): void {
	// Stop all current audio
	stopAllAudio();
	
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
		})
	);
}