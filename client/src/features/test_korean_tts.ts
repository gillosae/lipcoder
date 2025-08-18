import * as vscode from 'vscode';
import { log } from '../utils';
import { genTokenAudio } from '../tts';
import { detectLanguage, shouldUseKoreanTTS } from '../language_detection';
import { openaiTTSConfig } from '../config';

export function registerTestKoreanTTS(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('lipcoder.testKoreanTTS', async () => {
        try {
            log('[testKoreanTTS] Starting Korean TTS test...');
            
            // Test cases
            const testCases = [
                '안녕하세요',  // Hello
                '변수',        // Variable
                '함수',        // Function
                'hello',       // English for comparison
            ];
            
            // Check configuration
            log(`[testKoreanTTS] OpenAI API key configured: ${openaiTTSConfig.apiKey ? 'Yes' : 'No'}`);
            log(`[testKoreanTTS] OpenAI TTS model: ${openaiTTSConfig.model}`);
            log(`[testKoreanTTS] OpenAI TTS voice: ${openaiTTSConfig.voice}`);
            log(`[testKoreanTTS] OpenAI TTS language: ${openaiTTSConfig.language}`);
            
            for (const testText of testCases) {
                try {
                    log(`[testKoreanTTS] Testing: "${testText}"`);
                    
                    // Test language detection
                    const detectedLang = detectLanguage(testText);
                    const useKorean = shouldUseKoreanTTS(testText);
                    log(`[testKoreanTTS] Language: ${detectedLang}, Use Korean TTS: ${useKorean}`);
                    
                    // Test TTS generation
                    const audioFile = await genTokenAudio(testText, 'test');
                    log(`[testKoreanTTS] Generated audio file: ${audioFile}`);
                    
                    // Play the audio
                    const { playWave } = require('../audio');
                    await playWave(audioFile);
                    
                    log(`[testKoreanTTS] Successfully played: "${testText}"`);
                    
                    // Wait a bit between tests
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (error) {
                    log(`[testKoreanTTS] Error testing "${testText}": ${error}`);
                    vscode.window.showErrorMessage(`Korean TTS test failed for "${testText}": ${error}`);
                }
            }
            
            vscode.window.showInformationMessage('Korean TTS test completed. Check the console for details.');
            
        } catch (error) {
            log(`[testKoreanTTS] Test failed: ${error}`);
            vscode.window.showErrorMessage(`Korean TTS test failed: ${error}`);
        }
    });
    
    context.subscriptions.push(disposable);
    log('[testKoreanTTS] Test command registered');
}
