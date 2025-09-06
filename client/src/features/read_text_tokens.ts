import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../utils';
import { readSelection } from '../audio';
import { readCode } from '../tts';
import { playEarcon } from '../earcon';
import { config } from '../config';

/**
 * Read text tokens functionality with indentation earcon support
 */

let readTextTokensActive = false;

/**
 * Get read text tokens active state
 */
export function getReadTextTokensActive(): boolean {
    return readTextTokensActive;
}

/**
 * Set read text tokens active state
 */
export function setReadTextTokensActive(active: boolean): void {
    readTextTokensActive = active;
}

/**
 * Clear typing audio state for URI
 */
export function clearTypingAudioStateForUri(uri: vscode.Uri | string): void {
    // No-op in simplified implementation
    log(`[ReadTextTokens] Clearing typing audio state for ${uri.toString()}`);
}

/**
 * Calculate indentation level of a line
 */
function getIndentationLevel(line: string, tabSize: number): number {
    let indentLevel = 0;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === ' ') {
            indentLevel++;
        } else if (line[i] === '\t') {
            indentLevel += tabSize;
        } else {
            break;
        }
    }
    return Math.floor(indentLevel / tabSize);
}

/**
 * Play indentation earcon based on level change
 */
async function playIndentationEarcon(oldLevel: number, newLevel: number): Promise<void> {
    if (oldLevel === newLevel) {
        return; // No change in indentation
    }

    let earconIndex: number;
    
    if (newLevel > oldLevel) {
        // Indenting (들여쓰기): map RESULTING indent level to 0..4
        // newLevel 1 -> 0, 2 -> 1, 3 -> 2, 4 -> 3, >=5 -> 4
        earconIndex = Math.min(4, Math.max(0, newLevel - 1));
        log(`[IndentEarcon] Indenting: ${oldLevel} -> ${newLevel} (abs level), playing indent_${earconIndex}`);
    } else {
        // Outdenting (내어쓰기): map RESULTING indent level to 5..9
        // newLevel 0 -> 9, 1 -> 8, 2 -> 7, 3 -> 6, >=4 -> 5
        earconIndex = 9 - Math.min(newLevel, 4);
        log(`[IndentEarcon] Outdenting: ${oldLevel} -> ${newLevel} (abs level), playing indent_${earconIndex}`);
    }

    try {
        const earconPath = path.join(config.audioPath(), 'earcon', `indent_${earconIndex}.pcm`);
        await playEarcon(earconPath);
    } catch (error) {
        log(`[IndentEarcon] Error playing earcon: ${error}`);
    }
}

/**
 * Read text tokens with indentation earcon support
 */
export async function readTextTokens(
    editor?: vscode.TextEditor, 
    diagCache?: any, 
    changes?: readonly vscode.TextDocumentContentChangeEvent[], 
    indentLevels?: Map<string, number>, 
    tabSize?: number, 
    skipNextIndentObj?: { value: boolean }, 
    MAX_INDENT_UNITS?: number, 
    audioMap?: any
): Promise<void> {
    readTextTokensActive = true;
    
    try {
        if (!editor || !changes || !indentLevels || !tabSize) {
            log('[ReadTextTokens] Missing required parameters, falling back to simple read');
            await readSelection();
            return;
        }

        const document = editor.document;
        const documentUri = document.uri.toString();
        
        // Process each change to detect indentation changes
        for (const change of changes) {
            // Skip if we should skip next indent (e.g., after Enter key)
            if (skipNextIndentObj?.value) {
                skipNextIndentObj.value = false;
                continue;
            }

            // Check if this is a line change that might affect indentation
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            
            // Handle Enter key press (creates new line)
            if (change.text.includes('\n')) {
                log('[ReadTextTokens] Enter key detected, skipping next indent earcon');
                if (skipNextIndentObj) {
                    skipNextIndentObj.value = true;
                }
                continue;
            }
            
            // Check indentation changes on affected lines (supports multi-line indent/dedent)
            try {
                const firstLine = startLine;
                const lastLine = endLine;
                for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
                    try {
                        const currentLine = document.lineAt(lineNum);
                        const lineText = currentLine.text;

                        // Calculate current indentation level
                        const currentIndentLevel = getIndentationLevel(lineText, tabSize);

                        // Track per-line indentation using a document+line key
                        const lineKey = `${documentUri}:${lineNum}`;

                        // Prefer previously stored per-line indent; fall back to legacy document-level if present
                        let previousIndentLevel: number | null = null;
                        if (indentLevels.has(lineKey)) {
                            previousIndentLevel = indentLevels.get(lineKey)!;
                        } else if (indentLevels.has(documentUri)) {
                            previousIndentLevel = indentLevels.get(documentUri)!;
                        }

                        // Update stored indentation level for this specific line
                        indentLevels.set(lineKey, currentIndentLevel);

                        // Play earcon once if any line's indentation changed
                        if (previousIndentLevel !== null && currentIndentLevel !== previousIndentLevel) {
                            await playIndentationEarcon(previousIndentLevel, currentIndentLevel);
                            log(`[ReadTextTokens] Line ${lineNum}: indent ${previousIndentLevel} -> ${currentIndentLevel}`);
                            break; // Only play one earcon per change batch
                        }
                    } catch (innerErr) {
                        log(`[ReadTextTokens] Error processing line ${lineNum}: ${innerErr}`);
                    }
                }
            } catch (error) {
                log(`[ReadTextTokens] Error processing change block: ${error}`);
            }

            // Speak single-character insertions (low-latency using precomputed PCM when available)
            try {
                if (change.text && change.text.length === 1 && !change.text.includes('\n') && change.rangeLength === 0) {
                    const ch = change.text;
                    const fs = require('fs');

                    // Alphabet (use macOS/espeak/silero precomputed PCM based on backend)
                    if (/^[A-Za-z]$/.test(ch)) {
                        const filePath = path.join(config.alphabetPath(), `${ch.toLowerCase()}.pcm`);
                        if (filePath && fs.existsSync(filePath)) {
                            await playEarcon(filePath);
                            continue;
                        }
                    }

                    // Digits
                    if (/^\d$/.test(ch)) {
                        const filePath = path.join(config.numberPath(), `${ch}.pcm`);
                        if (filePath && fs.existsSync(filePath)) {
                            await playEarcon(filePath);
                            continue;
                        }
                    }

                    // Space
                    if (ch === ' ') {
                        const filePath = path.join(config.earconPath(), 'space.pcm');
                        if (filePath && fs.existsSync(filePath)) {
                            await playEarcon(filePath);
                            continue;
                        }
                    }

                    // Fallback to TTS
                    await readCode(ch, 'normal');
                }
            } catch (speakErr) {
                log(`[ReadTextTokens] Error speaking typed character: ${speakErr}`);
            }
        }
        
        // Continue with normal text reading only if there is an active selection
        try {
            const hasSelection = editor.selection && !editor.selection.isEmpty;
            if (hasSelection) {
                await readSelection();
            }
        } catch {}
        
    } finally {
        readTextTokensActive = false;
    }
}
