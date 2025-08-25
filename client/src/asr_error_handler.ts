import * as vscode from 'vscode';
import { log, logError } from './utils';
import { genTokenAudio } from './tts';
import { audioPlayer } from './audio';

/**
 * Enhanced ASR error handler that provides both TTS and popup notifications
 */
export async function handleASRError(error: Error, context?: string): Promise<void> {
    const contextPrefix = context ? `[${context}] ` : '[ASR] ';
    const errorMessage = error.message;
    
    // Log the error
    logError(`${contextPrefix}ASR Error: ${errorMessage}`);
    
    // Determine error type and create user-friendly message
    let userMessage = 'ASR Error';
    let ttsMessage = 'ASR error occurred';
    
    if (errorMessage.includes('api.openai.com') || errorMessage.includes('transcriptions')) {
        // OpenAI API specific errors
        if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
            userMessage = 'ASR Error: Invalid API key';
            ttsMessage = 'ASR error: Invalid API key';
        } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
            userMessage = 'ASR Error: Rate limit exceeded';
            ttsMessage = 'ASR error: Rate limit exceeded';
        } else if (errorMessage.includes('network') || errorMessage.includes('fetch') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
            userMessage = 'ASR Error: Network connection failed';
            ttsMessage = 'ASR error: Network connection failed';
        } else if (errorMessage.includes('400') || errorMessage.includes('Bad Request')) {
            userMessage = 'ASR Error: Invalid audio data';
            ttsMessage = 'ASR error: Invalid audio data';
        } else {
            userMessage = 'ASR Error: OpenAI API request failed';
            ttsMessage = 'ASR error: OpenAI API request failed';
        }
    } else if (errorMessage.includes('localhost') || errorMessage.includes('5004') || errorMessage.includes('5005')) {
        // Local server errors
        userMessage = 'ASR Error: Local ASR server not available';
        ttsMessage = 'ASR error: Local ASR server not available';
    } else if (errorMessage.includes('microphone') || errorMessage.includes('audio')) {
        // Audio/microphone errors
        userMessage = 'ASR Error: Microphone access failed';
        ttsMessage = 'ASR error: Microphone access failed';
    } else {
        // Generic error
        userMessage = `ASR Error: ${errorMessage}`;
        ttsMessage = `ASR error: ${errorMessage}`;
    }
    
    // Show non-blocking popup notification (bottom-right style as per user preference)
    try {
        // Use showInformationMessage with modal: false for non-blocking notification
        vscode.window.showErrorMessage(userMessage, { modal: false });
        log(`${contextPrefix}Showed error popup: ${userMessage}`);
    } catch (popupError) {
        logError(`${contextPrefix}Failed to show error popup: ${popupError}`);
    }
    
    // Speak the error using TTS (simple TTS as per user preference)
    try {
        log(`${contextPrefix}Speaking error via TTS: "${ttsMessage}"`);
        
        // Generate TTS for the error message
        const ttsFilePath = await genTokenAudio(ttsMessage, 'error', { 
            speaker: 'default' // Use default voice for error messages
        });
        
        // Play the TTS audio
        await audioPlayer.playTtsAsPcm(ttsFilePath, 0); // No panning for error messages
        
        log(`${contextPrefix}Successfully spoke error via TTS`);
    } catch (ttsError) {
        logError(`${contextPrefix}Failed to speak error via TTS: ${ttsError}`);
        // Don't throw - TTS failure shouldn't break error handling
    }
}

/**
 * Simplified error handler for cases where we just want to log and show basic notification
 */
export async function handleASRErrorSimple(error: Error, context?: string): Promise<void> {
    const contextPrefix = context ? `[${context}] ` : '[ASR] ';
    logError(`${contextPrefix}ASR Error: ${error.message}`);
    
    // Just show a simple error message without TTS
    vscode.window.showErrorMessage(`ASR Error: ${error.message}`, { modal: false });
}
