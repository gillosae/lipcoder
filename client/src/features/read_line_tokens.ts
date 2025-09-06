import * as vscode from 'vscode';
import { log } from '../utils';
import { readCurrentLine } from '../audio';

/**
 * Read line tokens functionality - simplified for native macOS TTS
 */

/**
 * Register read line tokens command
 */
export function registerReadLineTokens(context: vscode.ExtensionContext, client?: any): void {
    log('[ReadLineTokens] Registering read line tokens command');
    
    const command = vscode.commands.registerCommand('lipcoder.readLineTokens', async (editorArg?: vscode.TextEditor) => {
        log('[ReadLineTokens] Command executed!');
        try {
            await readCurrentLine(editorArg);
            log('[ReadLineTokens] readCurrentLine completed');
        } catch (error) {
            log(`[ReadLineTokens] Error: ${error}`);
        }
    });
    
    // Add a simple test command for debugging
    const testCommand = vscode.commands.registerCommand('lipcoder.testTTS', async () => {
        log('[ReadLineTokens] Test TTS command executed!');
        try {
            const { speak } = await import('../tts.js');
            await speak('Test TTS is working', 'high');
            log('[ReadLineTokens] Test TTS completed');
        } catch (error) {
            log(`[ReadLineTokens] Test TTS error: ${error}`);
        }
    });
    
    context.subscriptions.push(command);
    context.subscriptions.push(testCommand);
}
