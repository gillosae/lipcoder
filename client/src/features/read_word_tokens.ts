import * as vscode from 'vscode';
import { log } from '../utils';
import { readCurrentWord } from '../audio';

/**
 * Read word tokens functionality - simplified for native macOS TTS
 */

/**
 * Read word tokens
 */
export async function readWordTokens(editor?: any, changes?: any): Promise<void> {
    log('[ReadWordTokens] Reading word tokens');
    await readCurrentWord();
}
