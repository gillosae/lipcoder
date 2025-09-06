import * as vscode from 'vscode';
import { log } from './utils';
import { speak, stopSpeaking, isSpeaking, readCode, readText, beginNavigation } from './tts';

/**
 * Audio system for LipCoder using native macOS TTS
 * This module provides VoiceOver-like audio feedback for code navigation and reading
 */

// Audio context and control
let audioContext: AudioContext | null = null;
let isInitialized = false;

// VoiceOver-like reading modes
export type ReadingMode = 'character' | 'word' | 'line' | 'sentence' | 'paragraph';

// Token types for different code elements (VoiceOver-style categorization)
export type TokenCategory = 
    | 'keyword'      // if, for, function, etc.
    | 'identifier'   // variable names, function names
    | 'literal'      // strings, numbers
    | 'operator'     // +, -, =, etc.
    | 'punctuation'  // {, }, (, ), etc.
    | 'comment'      // // and /* */ comments
    | 'whitespace'   // spaces, tabs, newlines
    | 'unknown'
    // Legacy categories for compatibility
    | 'variable'
    | 'comment_text'
    | 'comment_symbol'
    | 'vibe_text'
    | 'earcon'
    | string;        // Allow any string for backward compatibility

// Token chunk for speech synthesis
export interface TokenChunk {
    tokens: string[];
    category?: TokenCategory;
    priority?: 'high' | 'normal';
    panning?: number; // Legacy compatibility
}

// Audio interruption control
let currentAbortController: AbortController | null = null;

/**
 * Initialize audio system
 */
export function initializeAudio(): void {
    if (isInitialized) {
        return;
    }
    
    log('[Audio] Initializing audio system');
    
    try {
        const navToken = beginNavigation();
        // Initialize Web Audio API context for potential future use
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        isInitialized = true;
        log('[Audio] Audio system initialized successfully');
        
    } catch (error) {
        log(`[Audio] Failed to initialize audio context: ${error}`);
        // Continue without Web Audio API - TTS will still work
        isInitialized = true;
    }
}

/**
 * Stop all audio playback (VoiceOver-style interruption)
 */
export function stopAllAudio(): void {
    // Add stack trace to see where this is called from
    const stack = new Error().stack;
    log(`[Audio] Stopping all audio - Called from: ${stack?.split('\n')[2]?.trim()}`);
    
    // Abort current operations
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    
    // Stop TTS
    stopSpeaking();
}

/**
 * Check if audio is currently playing
 */
export function isAudioPlaying(): boolean {
    return isSpeaking();
}

/**
 * Speak a list of token chunks (main interface for code reading)
 */
export async function speakTokenList(
    chunks: TokenChunk[], 
    abortSignal?: AbortSignal
): Promise<void> {
    if (!chunks || chunks.length === 0) {
        return;
    }
    
    log(`[Audio] Speaking ${chunks.length} token chunks`);
    
    // Create abort controller if not provided
    if (!abortSignal) {
        currentAbortController = new AbortController();
        abortSignal = currentAbortController.signal;
    }
    
    try {
        for (const chunk of chunks) {
            // Check for abort signal
            if (abortSignal.aborted) {
                log('[Audio] Speech aborted');
                return;
            }
            
            // Join tokens in chunk
            const text = chunk.tokens.join(' ');
            if (!text.trim()) {
                continue;
            }
            
            // Determine priority based on category
            const priority = chunk.priority || (chunk.category === 'keyword' ? 'high' : 'normal');
            
            // Speak the chunk
            await speak(text, priority);
            
            // Small pause between chunks for better comprehension
            if (!abortSignal.aborted) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        
    } catch (error) {
        if (!abortSignal.aborted) {
            log(`[Audio] Error speaking token list: ${error}`);
        }
    } finally {
        if (currentAbortController && abortSignal === currentAbortController.signal) {
            currentAbortController = null;
        }
    }
}

/**
 * Read current line (VoiceOver-style line reading)
 */
export async function readCurrentLine(editorArg?: vscode.TextEditor, specificLineNumber?: number): Promise<void> {
    // Use provided editor or active editor
    const editor = editorArg || vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    // Use specific line number if provided, otherwise use current cursor position
    const position = specificLineNumber !== undefined 
        ? new vscode.Position(specificLineNumber, editor.selection.active.character)
        : editor.selection.active;
    const lineNumber = position.line + 1;
    
    log(`[Audio] Reading line ${lineNumber} (0-based: ${position.line}) at column ${position.character}`);
    log(`[Audio] Editor document: ${editor.document.fileName}`);
    log(`[Audio] Using ${editorArg ? 'provided' : 'active'} editor`);
    
    try {
        const line = editor.document.lineAt(position.line);
        
        log(`[Audio] Line ${lineNumber} content: "${line.text}"`);
        
        // Read the line content directly without additional code earcons/processing
        if (line.text.trim()) {
            log(`[Audio] Reading line content with code processing (high priority): "${line.text}"`);
            await readCode(line.text, 'high'); // Keep keyword/paren earcons per user requirement
        } else {
            log(`[Audio] Reading blank line with high priority`);
            await speak('blank', 'high');
        }
        
        log(`[Audio] Successfully read line ${lineNumber}: "${line.text}"`);
    } catch (error) {
        log(`[Audio] Error reading line ${lineNumber}: ${error}`);
        await speak('Error reading line', 'high');
    }
}

/**
 * Read current word (VoiceOver-style word reading)
 */
export async function readCurrentWord(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    const position = editor.selection.active;
    const wordRange = editor.document.getWordRangeAtPosition(position);
    
    if (wordRange) {
        const word = editor.document.getText(wordRange);
        await readCode(word, 'high');
    } else {
        // No word at cursor, speak the character
        const line = editor.document.lineAt(position.line);
        if (position.character < line.text.length) {
            const char = line.text.charAt(position.character);
            await readCode(char, 'high');
        } else {
            await speak('end of line', 'high');
        }
    }
}

/**
 * Read word near the cursor with directional bias (VoiceOver-style)
 * - direction 'right': read the next word to the right of the cursor
 * - direction 'left': read the previous word to the left of the cursor
 */
export async function readWordNearCursor(direction: 'left' | 'right'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }

    const position = editor.selection.active;
    const document = editor.document;
    const line = document.lineAt(position.line).text;

    function isWordChar(ch: string): boolean {
        return /[A-Za-z0-9_$]/.test(ch);
    }

    // If we're already on a word char, just read that word
    if (position.character < line.length && isWordChar(line.charAt(position.character))) {
        const range = document.getWordRangeAtPosition(position);
        if (range) {
            const word = document.getText(range);
            await readCode(word, 'high');
            return;
        }
    }

    if (direction === 'right') {
        let i = Math.min(position.character, line.length);
        // Skip non-word characters to the right
        while (i < line.length && !isWordChar(line.charAt(i))) i++;
        if (i >= line.length) {
            await speak('end of line', 'high');
            return;
        }
        const pos = new vscode.Position(position.line, i);
        const range = document.getWordRangeAtPosition(pos);
        if (range) {
            const word = document.getText(range);
            await readCode(word, 'high');
            return;
        }
    } else { // left
        let i = Math.min(position.character - 1, line.length - 1);
        // Skip non-word characters to the left
        while (i >= 0 && !isWordChar(line.charAt(i))) i--;
        if (i < 0) {
            await speak('start of line', 'high');
            return;
        }
        // Move to somewhere within the word
        const pos = new vscode.Position(position.line, i);
        const range = document.getWordRangeAtPosition(pos);
        if (range) {
            const word = document.getText(range);
            await readCode(word, 'high');
            return;
        }
    }

    // Fallback to current character if no word found
    if (position.character < line.length) {
        const ch = line.charAt(position.character);
        await readCode(ch, 'high');
    } else {
        await speak('end of line', 'high');
    }
}

/**
 * Read current character (VoiceOver-style character reading)
 */
export async function readCurrentCharacter(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    const position = editor.selection.active;
    const line = editor.document.lineAt(position.line);
    
    if (position.character < line.text.length) {
        const char = line.text.charAt(position.character);
        await readCode(char, 'high');
    } else {
        await speak('end of line', 'high');
    }
}

/**
 * Tokenize a line of code for VoiceOver-style reading
 */
function tokenizeLine(text: string): TokenChunk[] {
    const chunks: TokenChunk[] = [];
    const tokens = text.split(/(\s+|[{}()\[\];,.])/);
    
    for (const token of tokens) {
        if (!token) continue;
        
        const category = categorizeToken(token);
        
        // Group similar tokens together for better flow
        const lastChunk = chunks[chunks.length - 1];
        if (lastChunk && lastChunk.category === category && category !== 'operator') {
            lastChunk.tokens.push(token);
        } else {
            chunks.push({
                tokens: [token],
                category: category
            });
        }
    }
    
    return chunks;
}

/**
 * Categorize a token for appropriate speech handling
 */
function categorizeToken(token: string): TokenCategory {
    if (!token.trim()) {
        return 'whitespace';
    }
    
    // Keywords (common programming keywords)
    const keywords = [
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
        'function', 'return', 'var', 'let', 'const', 'class', 'interface',
        'import', 'export', 'from', 'as', 'async', 'await', 'try', 'catch',
        'finally', 'throw', 'new', 'this', 'super', 'extends', 'implements',
        'public', 'private', 'protected', 'static', 'readonly', 'abstract'
    ];
    
    if (keywords.includes(token.toLowerCase())) {
        return 'keyword';
    }
    
    // Literals
    if (/^["'`].*["'`]$/.test(token) || /^\d+(\.\d+)?$/.test(token) || /^(true|false|null|undefined)$/.test(token)) {
        return 'literal';
    }
    
    // Operators
    if (/^[+\-*/%=<>!&|^~?:]+$/.test(token)) {
        return 'operator';
    }
    
    // Punctuation
    if (/^[{}()\[\];,.]$/.test(token)) {
        return 'punctuation';
    }
    
    // Comments
    if (token.startsWith('//') || token.startsWith('/*') || token.startsWith('*')) {
        return 'comment';
    }
    
    // Identifiers (variable names, function names, etc.)
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(token)) {
        return 'identifier';
    }
    
    return 'unknown';
}

/**
 * Read selection (VoiceOver-style selection reading)
 */
export async function readSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    const selection = editor.selection;
    if (selection.isEmpty) {
        await speak('No selection', 'high');
        return;
    }
    
    const selectedText = editor.document.getText(selection);
    const lines = selectedText.split('\n');
    
    if (lines.length === 1) {
        // Single line selection - read as code
        await speak('Selected:', 'high');
        await readCode(selectedText, 'normal');
    } else {
        // Multi-line selection
        await speak(`Selected ${lines.length} lines`, 'high');
        
        // Read first few lines as code
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            if (lines[i].trim()) {
                await readCode(lines[i], 'normal');
            } else {
                await speak('blank line', 'normal');
            }
        }
        
        if (lines.length > 3) {
            await speak(`and ${lines.length - 3} more lines`, 'normal');
        }
    }
}

/**
 * Announce cursor position (VoiceOver-style position announcement)
 */
export async function announceCursorPosition(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    const position = editor.selection.active;
    const columnNumber = position.character + 1;
    
    await speak(`Column ${columnNumber}`, 'high');
}

/**
 * Read document title (VoiceOver-style document announcement)
 */
export async function readDocumentTitle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await speak('No active editor', 'high');
        return;
    }
    
    const fileName = editor.document.fileName.split('/').pop() || 'Untitled';
    const isDirty = editor.document.isDirty ? 'modified' : '';
    
    await speak(`${fileName} ${isDirty}`.trim(), 'high');
}

/**
 * Play earcon (short audio cue) - placeholder for future implementation
 */
export async function playEarcon(type: string): Promise<void> {
    // For now, use speech feedback instead of audio files
    switch (type) {
        case 'indent':
            await speak('indent', 'high');
            break;
        case 'error':
            await speak('error', 'high');
            break;
        case 'warning':
            await speak('warning', 'high');
            break;
        default:
            log(`[Audio] Unknown earcon type: ${type}`);
    }
}

/**
 * Legacy compatibility functions
 */
export async function speakGPT(text: string, abortSignalOrCategory?: AbortSignal | string): Promise<void> {
    // Handle both old (category) and new (AbortSignal) usage patterns
    await speak(text, 'normal');
}

export async function startThinkingAudio(): Promise<void> {
    const { startThinkingEarcon } = await import('./tts.js');
    await startThinkingEarcon();
}

export async function stopThinkingAudio(): Promise<void> {
    const { stopThinkingEarcon } = await import('./tts.js');
    await stopThinkingEarcon();
}

export async function playThinkingFinished(): Promise<void> {
    const { stopThinkingEarcon } = await import('./tts.js');
    await stopThinkingEarcon();
}

export async function playWave(filePath: string, options?: any): Promise<void> {
    // Legacy wave file playback - now using TTS
    const fileName = filePath.split('/').pop()?.replace('.pcm', '').replace('.wav', '') || 'sound';
    await speak(fileName, options?.immediate ? 'high' : 'normal');
}

export async function speakToken(token: string): Promise<void> {
    await speak(token, 'high');
}

export function stopPlayback(): void {
    stopAllAudio();
}

export function clearAudioStoppingState(): void {
    // Legacy function - no-op in new implementation
}

export async function readInEspeak(chunks: TokenChunk[], abortSignal?: AbortSignal): Promise<void> {
    await speakTokenList(chunks, abortSignal);
}

export function cleanupAudioResources(): void {
    cleanupAudio();
}

export async function testThinkingAudio(): Promise<void> {
    await speak('test thinking audio', 'normal');
}

// Audio player compatibility
export const audioPlayer = {
    play: async (text: string) => await speak(text),
    stop: () => stopAllAudio(),
    playTtsAsPcm: async (filePath: string, panning?: number) => {
        // Legacy TTS file playback - convert to speech
        const fileName = filePath.split('/').pop()?.replace('.wav', '').replace('.pcm', '') || 'audio';
        await speak(fileName, 'normal');
    }
};

/**
 * Cleanup audio resources
 */
export function cleanupAudio(): void {
    log('[Audio] Cleaning up audio resources');
    
    stopAllAudio();
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    isInitialized = false;
}
