import { log } from './utils';
import { initializeTTS } from './tts';
import { initializeAudio } from './audio';

/**
 * Preload system - simplified for native macOS TTS
 */

/**
 * Preload everything needed for the extension
 */
export async function preloadEverything(context?: any): Promise<void> {
    log('[Preload] Starting preload process');
    
    try {
        // Initialize TTS system
        initializeTTS();
        
        // Initialize audio system
        initializeAudio();
        
        log('[Preload] Preload completed successfully');
    } catch (error) {
        log(`[Preload] Error during preload: ${error}`);
    }
}
