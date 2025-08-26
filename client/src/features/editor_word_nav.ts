import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk, playWave } from '../audio';
import { stopAllAudio } from './stop_reading';
import { logWarning, logError, logSuccess } from '../utils';
import { logFeatureUsage } from '../activity_logger';
import { config } from '../config';
import { isEarcon, getSpecialCharSpoken, twoLenExceptions, threeLenExceptions } from '../mapping';
import * as path from 'path';

// Word navigation state
let currentWordIndex = -1; // Current word position within the line
let currentLineWords: string[] = []; // Words in the current line

// Keyword lists for proper categorization
const PYTHON_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 
    'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 
    'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 
    'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const TYPESCRIPT_KEYWORDS = new Set([
    'abstract', 'any', 'as', 'bigint', 'boolean', 'break', 'case', 'catch', 'class', 
    'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 
    'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 
    'instanceof', 'let', 'new', 'null', 'number', 'object', 'return', 'static', 'super', 
    'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 
    'var', 'void', 'while', 'with', 'yield', 'interface', 'implements', 'readonly', 
    'private', 'protected', 'public', 'module', 'namespace', 'declare', 'constructor', 
    'get', 'set', 'is', 'key', 'keyof', 'unique', 'unknown', 'never'
]);

/**
 * Determine the proper category for a word token based on language and content
 */
function categorizeWord(word: string, languageId: string): string {
    const lowerWord = word.toLowerCase();
    
    // Check for keywords based on language
    if (languageId === 'python' && PYTHON_KEYWORDS.has(word)) {
        return `keyword_python`;
    } else if ((languageId === 'typescript' || languageId === 'javascript') && TYPESCRIPT_KEYWORDS.has(word)) {
        return `keyword_typescript`;
    }
    
    // Apply two/three length exceptions logic like readLineTokens
    if (word.length === 2 && twoLenExceptions.has(lowerWord)) {
        return 'variable';
    } else if (word.length === 3 && threeLenExceptions.has(lowerWord)) {
        return 'variable';
    }
    
    // Default to variable for other words
    return 'variable';
}

/**
 * Tokenizes text into chunks similar to readLineTokens logic
 * This handles both words and punctuation properly with proper categorization
 */
function tokenizeText(text: string, languageId: string = 'typescript'): TokenChunk[] {
    if (!text || text.length === 0) {
        return [];
    }

    const chunks: TokenChunk[] = [];
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        
        // Skip whitespace
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        
        // Check if this is the start of a word (alphanumeric + underscore)
        if (/\w/.test(char)) {
            // Collect the entire word
            let word = '';
            while (i < text.length && /\w/.test(text[i])) {
                word += text[i];
                i++;
            }
            
            // Apply proper categorization like readLineTokens
            const category = categorizeWord(word, languageId);
            chunks.push({ tokens: [word], category });
        } else {
            // It's punctuation - handle as single character with proper categorization
            let category: string;
            if (getSpecialCharSpoken(char)) {
                category = 'special'; // Will use TTS with specialCharMap
            } else {
                category = 'type'; // Will use earcon logic
            }
            chunks.push({ tokens: [char], category });
            i++;
        }
    }
    
    return chunks;
}
let lastNavigatedLine = -1; // Track which line we last navigated on
let lastNavigatedColumn = -1; // Track column position

/**
 * Parse a line of text into words for word-level navigation
 */
function parseLineToWords(line: string): string[] {
    if (!line || line.trim().length === 0) {
        return [];
    }
    
    // Split by word boundaries, preserving punctuation as separate words
    // This regex splits on whitespace but keeps punctuation as separate tokens
    const words: string[] = [];
    const tokens = line.split(/(\s+)/); // Split but keep separators
    
    for (const token of tokens) {
        if (token.trim().length === 0) continue; // Skip whitespace
        
        // Further split tokens that contain punctuation
        const subTokens = token.split(/([^\w\s])/); // Split on non-word, non-space characters
        for (const subToken of subTokens) {
            if (subToken.trim().length > 0) {
                words.push(subToken);
            }
        }
    }
    
    return words.filter(word => word.trim().length > 0);
}

/**
 * Update word navigation state for the current cursor position
 */
function updateWordNavigationState(editor: vscode.TextEditor): void {
    const position = editor.selection.active;
    const line = position.line;
    const column = position.character;
    
    // Get the current line text
    const lineText = editor.document.lineAt(line).text;
    currentLineWords = parseLineToWords(lineText);
    
    // Find the word index based on cursor position
    if (currentLineWords.length === 0) {
        currentWordIndex = -1;
        lastNavigatedLine = line;
        lastNavigatedColumn = column;
        return;
    }
    
    // Calculate word positions in the original line
    let currentPos = 0;
    let foundWordIndex = -1;
    
    for (let i = 0; i < currentLineWords.length; i++) {
        const word = currentLineWords[i];
        const wordStart = lineText.indexOf(word, currentPos);
        const wordEnd = wordStart + word.length;
        
        if (column >= wordStart && column <= wordEnd) {
            foundWordIndex = i;
            break;
        } else if (column < wordStart) {
            // Cursor is before this word, use previous word or this word
            foundWordIndex = Math.max(0, i - 1);
            break;
        }
        
        currentPos = wordEnd;
    }
    
    // If we didn't find a word, use the last word
    if (foundWordIndex === -1) {
        foundWordIndex = currentLineWords.length - 1;
    }
    
    currentWordIndex = foundWordIndex;
    lastNavigatedLine = line;
    lastNavigatedColumn = column;
}

/**
 * Move cursor to a specific word in the current line
 */
function moveCursorToWord(editor: vscode.TextEditor, wordIndex: number, direction: 'left' | 'right' = 'right'): void {
    if (wordIndex < 0 || wordIndex >= currentLineWords.length) {
        return;
    }
    
    const position = editor.selection.active;
    const lineText = editor.document.lineAt(position.line).text;
    const targetWord = currentLineWords[wordIndex];
    
    // Find the position of the target word
    let currentPos = 0;
    for (let i = 0; i <= wordIndex; i++) {
        const word = currentLineWords[i];
        const wordStart = lineText.indexOf(word, currentPos);
        
        if (i === wordIndex) {
            let cursorPosition: number;
            if (direction === 'left') {
                // Move cursor to the beginning of the target word (|word)
                cursorPosition = wordStart;
            } else {
                // Move cursor to the end of the target word (word|)
                cursorPosition = wordStart + word.length;
            }
            
            const newPosition = new vscode.Position(position.line, cursorPosition);
            const newSelection = new vscode.Selection(newPosition, newPosition);
            editor.selection = newSelection;
            editor.revealRange(new vscode.Range(newPosition, newPosition));
            break;
        }
        
        currentPos = wordStart + word.length;
    }
}

/**
 * Convert a word into proper token chunks with categories and earcons
 */
function parseWordToTokens(word: string): TokenChunk[] {
    const chunks: TokenChunk[] = [];
    let currentToken = '';
    
    for (let i = 0; i < word.length; i++) {
        const char = word[i];
        
        // If we encounter a special character that should be an earcon
        if (isEarcon(char)) {
            // First, add any accumulated text as a regular token
            if (currentToken.trim().length > 0) {
                chunks.push({
                    tokens: [currentToken.trim()],
                    category: undefined
                });
                currentToken = '';
            }
            
            // Add the special character as its own earcon token
            chunks.push({
                tokens: [char],
                category: 'earcon'
            });
        } else {
            // Regular character - accumulate
            currentToken += char;
        }
    }
    
    // Add any remaining token
    if (currentToken.trim().length > 0) {
        chunks.push({
            tokens: [currentToken.trim()],
            category: undefined
        });
    }
    
    return chunks;
}

/**
 * Clean up word navigation resources
 */
function cleanupEditorWordNav(): void {
    currentWordIndex = -1;
    currentLineWords = [];
    lastNavigatedLine = -1;
    lastNavigatedColumn = -1;
    logSuccess('[EditorWordNav] Cleaned up word navigation resources');
}

/**
 * Register editor word navigation commands
 */
export function registerEditorWordNav(context: ExtensionContext) {
    logSuccess('[EditorWordNav] Registering editor word navigation commands');
    
    context.subscriptions.push(
        // Navigate to next word in current editor line (Option+Right Arrow)
        vscode.commands.registerCommand('lipcoder.editorWordRight', async () => {
            console.log(`[EditorWordNav] *** EDITOR WORD RIGHT COMMAND CALLED ***`);
            stopAllAudio();
            
            logFeatureUsage('editorWordRight', 'navigate');
            
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                await speakTokenList([{ tokens: ['No active editor'], category: undefined }]);
                return;
            }
            
            // Get position before movement
            const oldPosition = editor.selection.active;
            const document = editor.document;
            const lineText = document.lineAt(oldPosition.line).text;
            
            console.log(`[EditorWordNav] Right nav: old=${oldPosition.character}, line="${lineText}"`);
            
            // Use VSCode's built-in word navigation
            await vscode.commands.executeCommand('cursorWordRight');
            
            // Get position after movement
            const newPosition = editor.selection.active;
            
            console.log(`[EditorWordNav] Right nav: new=${newPosition.character}`);
            
            // Check if we moved to end of line
            if (newPosition.character >= lineText.length) {
                const endEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                await playWave(endEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ tokens: ['End of line'], category: undefined }]);
                return;
            }
            
            // Find what we traversed by looking backwards from new position
            let textToRead = '';
            
            console.log(`[EditorWordNav] Right nav: looking for word between ${oldPosition.character} and ${newPosition.character}`);
            
            // Check if we're now inside a word - if so, read that word
            const currentWordRange = document.getWordRangeAtPosition(newPosition);
            console.log(`[EditorWordNav] Right nav: currentWordRange at pos ${newPosition.character}:`, currentWordRange ? `${currentWordRange.start.character}-${currentWordRange.end.character}` : 'null');
            
            if (currentWordRange && currentWordRange.start.character > oldPosition.character) {
                // We're inside a word that starts after our old position - read it
                textToRead = document.getText(currentWordRange);
                console.log(`[EditorWordNav] Right nav: found current word: "${textToRead}"`);
            } else {
                // Look for any word between old and new positions
                console.log(`[EditorWordNav] Right nav: searching for word between ${oldPosition.character} and ${newPosition.character}`);
                for (let i = oldPosition.character; i <= newPosition.character; i++) {
                    const testRange = document.getWordRangeAtPosition(new vscode.Position(newPosition.line, i));
                    if (testRange && testRange.start.character > oldPosition.character) {
                        textToRead = document.getText(testRange);
                        console.log(`[EditorWordNav] Right nav: found word in search: "${textToRead}"`);
                        break;
                    }
                }
                
                // If no word found, check for text we passed over
                if (!textToRead) {
                    const traversedText = lineText.substring(oldPosition.character, newPosition.character);
                    if (traversedText.trim().length > 0) {
                        // Use tokenization approach like readLineTokens
                        const chunks = tokenizeText(traversedText, editor.document.languageId);
                        if (chunks.length > 0) {
                            console.log(`[EditorWordNav] Right nav: tokenized text into ${chunks.length} chunks:`, chunks);
                            await speakTokenList(chunks);
                            return; // Exit early since we've already spoken the text
                        }
                    }
                }
            }
            
            if (textToRead) {
                await new Promise(resolve => setTimeout(resolve, 50));
                const category = categorizeWord(textToRead, editor.document.languageId);
                await speakTokenList([{ tokens: [textToRead], category }]);
            } else {
                // Fallback: read character at current position with slow speed
                const char = lineText[newPosition.character] || '';
                console.log(`[EditorWordNav] Right nav: fallback - reading char at pos ${newPosition.character}: "${char}"`);
                if (char) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    // For alphabet characters, use alphabet PCM files at slow speed
                    if (/^[a-zA-Z]$/.test(char)) {
                        const alphaPath = path.join(config.alphabetPath(), `${char.toLowerCase()}.pcm`);
                        console.log(`[EditorWordNav] Playing alphabet audio at slow speed: ${alphaPath}`);
                        await playWave(alphaPath, { 
                            immediate: true, 
                            rate: 0.5  // Slow speed for cursor movement
                        });
                    } else {
                        await speakTokenList([{ tokens: [char], category: undefined }]);
                    }
                } else {
                    console.log(`[EditorWordNav] Right nav: no character to read`);
                }
            }
        }),

        // Navigate to previous word in current editor line (Option+Left Arrow)
        vscode.commands.registerCommand('lipcoder.editorWordLeft', async () => {
            console.log(`[EditorWordNav] *** EDITOR WORD LEFT COMMAND CALLED ***`);
            stopAllAudio();
            
            logFeatureUsage('editorWordLeft', 'navigate');
            
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                await speakTokenList([{ tokens: ['No active editor'], category: undefined }]);
                return;
            }
            
            // Get position before movement
            const oldPosition = editor.selection.active;
            const document = editor.document;
            const lineText = document.lineAt(oldPosition.line).text;
            
            // Use VSCode's built-in word navigation
            await vscode.commands.executeCommand('cursorWordLeft');
            
            // Get position after movement
            const newPosition = editor.selection.active;
            
            // Check if we moved to beginning of line
            if (newPosition.character === 0) {
                // At beginning of line - play indentation earcon
                const indentLevel = lineText.length - lineText.trimStart().length;
                const tabSize = editor.options.tabSize as number || 4;
                const indentUnits = Math.floor(indentLevel / tabSize);
                
                console.log(`[EditorWordNav] Indent level: ${indentLevel}, tabSize: ${tabSize}, indentUnits: ${indentUnits}`);
                
                if (indentUnits > 0) {
                    const indentEarconNum = Math.min(indentUnits, 9);
                    const indentEarcon = path.join(config.audioPath(), 'earcon', `indent_${indentEarconNum}.pcm`);
                    console.log(`[EditorWordNav] Playing indent earcon: ${indentEarcon}`);
                    await playWave(indentEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                } else {
                    const startEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    console.log(`[EditorWordNav] Playing start earcon: ${startEarcon}`);
                    await playWave(startEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                }
                return;
            }
            
            // Find what we traversed - look at the text between old and new positions
            let textToRead = '';
            
            console.log(`[EditorWordNav] Left nav: old=${oldPosition.character}, new=${newPosition.character}`);
            
            if (oldPosition.character > newPosition.character) {
                // We moved left, so read what was between the positions
                const traversedText = lineText.substring(newPosition.character, oldPosition.character);
                console.log(`[EditorWordNav] Traversed text: "${traversedText}"`);
                
                // Try to find a word in the traversed text
                const wordMatch = traversedText.match(/\w+/);
                if (wordMatch) {
                    textToRead = wordMatch[0];
                    console.log(`[EditorWordNav] Found word: "${textToRead}"`);
                } else {
                    // No word found, use tokenization approach
                    if (traversedText.trim().length > 0) {
                        const chunks = tokenizeText(traversedText, editor.document.languageId);
                        if (chunks.length > 0) {
                            console.log(`[EditorWordNav] Left nav: tokenized text into ${chunks.length} chunks:`, chunks);
                            await speakTokenList(chunks);
                            return; // Exit early since we've already spoken the text
                        }
                    } else {
                        console.log(`[EditorWordNav] Only whitespace found in traversed text`);
                    }
                }
            }
            
            if (textToRead) {
                console.log(`[EditorWordNav] About to speak: "${textToRead}"`);
                await new Promise(resolve => setTimeout(resolve, 50));
                const category = categorizeWord(textToRead, editor.document.languageId);
                await speakTokenList([{ tokens: [textToRead], category }]);
            } else {
                console.log(`[EditorWordNav] No text to read, using fallback`);
                // Fallback: check if we're on a word now
                const wordRange = document.getWordRangeAtPosition(newPosition);
                if (wordRange) {
                    const word = document.getText(wordRange);
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await speakTokenList([{ tokens: [word], category: undefined }]);
                } else {
                    // Read character at current position with slow speed
                    const char = lineText[newPosition.character] || '';
                    if (char) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                        // For alphabet characters, use alphabet PCM files at slow speed
                        if (/^[a-zA-Z]$/.test(char)) {
                            const alphaPath = path.join(config.alphabetPath(), `${char.toLowerCase()}.pcm`);
                            console.log(`[EditorWordNav] Playing alphabet audio at slow speed: ${alphaPath}`);
                            await playWave(alphaPath, { 
                                immediate: true, 
                                rate: 0.5  // Slow speed for cursor movement
                            });
                        } else {
                            await speakTokenList([{ tokens: [char], category: undefined }]);
                        }
                    }
                }
            }
        })
    );
    
    // Register cleanup
    context.subscriptions.push({
        dispose: cleanupEditorWordNav
    });
}
