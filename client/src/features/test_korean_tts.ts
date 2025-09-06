import * as vscode from 'vscode';
import { log } from '../utils';
import { speak } from '../tts';

/**
 * Test Korean TTS functionality - simplified for native macOS TTS
 */

/**
 * Register test Korean TTS command
 */
export function registerTestKoreanTTS(context: vscode.ExtensionContext): void {
    log('[TestKoreanTTS] Registering test Korean TTS command');
    
    const command = vscode.commands.registerCommand('lipcoder.testKoreanTTS', async () => {
        // Test Korean text with macOS TTS
        const koreanText = '안녕하세요. 한국어 음성 합성 테스트입니다.';
        
        try {
            await speak(koreanText, 'high');
            vscode.window.showInformationMessage('Korean TTS test completed');
        } catch (error) {
            vscode.window.showErrorMessage(`Korean TTS test failed: ${error}`);
        }
    });
    
    context.subscriptions.push(command);
}
