import * as vscode from 'vscode';
import { log } from '../utils';
import { speakTokenList, TokenChunk } from '../audio';

/**
 * Read function tokens functionality - simplified for native macOS TTS
 */

/**
 * Register read function tokens command
 */
export function registerReadFunctionTokens(context: vscode.ExtensionContext, client?: any): void {
    log('[ReadFunctionTokens] Registering read function tokens command');
    
    const command = vscode.commands.registerCommand('lipcoder.readFunctionTokens', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            await vscode.window.showWarningMessage('No active editor');
            return;
        }
        
        // Get current function context
        const position = editor.selection.active;
        const document = editor.document;
        
        // Simple function detection - look for function keyword
        const line = document.lineAt(position.line);
        const text = line.text;
        
        if (text.includes('function') || text.includes('=>') || text.includes('def ')) {
            const chunks: TokenChunk[] = [{
                tokens: [text.trim()],
                category: 'keyword'
            }];
            
            await speakTokenList(chunks);
        } else {
            await speakTokenList([{
                tokens: ['No function found at cursor'],
                category: 'comment'
            }]);
        }
    });
    
    context.subscriptions.push(command);
}
