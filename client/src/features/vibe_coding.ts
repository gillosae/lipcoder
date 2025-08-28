import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { speakTokenList, speakGPT, TokenChunk, startThinkingAudio, stopThinkingAudio, playThinkingFinished, stopPlayback } from '../audio';
// Automatic text reading imports removed - continuous actions eliminated
import { stopAllAudio } from './stop_reading';
import { log } from '../utils';
import { logVibeCoding, logFeatureUsage } from '../activity_logger';
import { comprehensiveEventTracker } from '../comprehensive_event_tracker';
import { isEditorActive } from '../ide/active';
import { vibeCodingConfig } from '../config';
import * as Diff from 'diff';
// Intelligent suggestions import removed - continuous actions eliminated
import { showSuggestionHistory, showCurrentSuggestions } from './suggestion_storage';

interface CodeChange {
    line: number;
    original: string;
    modified: string;
    type: 'added' | 'removed' | 'modified';
}

interface VibeCodingResult {
    changes: CodeChange[];
    summary: string;
    totalAdded: number;
    totalRemoved: number;
    modifiedText: string;
    originalText: string;
    changeDescription: string;
    affectedFunctions: string[];
    changeType: 'full_rewrite' | 'partial_modification' | 'addition' | 'test_addition';
}

interface ContextInfo {
    selectedCode: string;
    focusedFunction: string | null;
    cursorPosition: vscode.Position;
    contextLines: string[];
    isLargeFile: boolean;
}

interface PendingChange {
    id: string;
    result: VibeCodingResult;
    timestamp: number;
    instruction: string;
}

// Global state for managing pending changes
let pendingChanges: Map<string, PendingChange> = new Map();
let currentChangeId: string | null = null;

let currentDiffChangeId: string | null = null;
let vbAcceptItem: vscode.StatusBarItem | null = null;
let vbRejectItem: vscode.StatusBarItem | null = null;

// Track if vibe coding TTS is currently active
let vibeCodingTTSActive = false;

function isInlineDiffPreferred(): boolean {
    try {
        // Read from the scoped "lipcoder" section
        const scoped = vscode.workspace.getConfiguration('lipcoder').get<string>('vibeCoding.diffMode');
        // Read from the root config in case the setting is written as "lipcoder.vibeCoding.diffMode"
        const root = vscode.workspace.getConfiguration().get<string>('lipcoder.vibeCoding.diffMode');
        // Legacy key support
        const legacy = vscode.workspace.getConfiguration('lipcoder').get<string>('diffPreviewMode');

        const pick = scoped ?? root ?? 'native';
        const inline = pick === 'inline' || pick === 'singleEditor' || legacy === 'inline';

        log(`[vibe_coding] diff mode read — scoped:${scoped} root:${root} legacy:${legacy} => pick:${pick} -> inline=${inline}`);
        return inline;
    } catch (e) {
        log(`[vibe_coding] diff mode read failed: ${e}`);
        return false;
    }
}

/**
 * Set vibe coding TTS active state
 */
export function setVibeCodingTTSActive(active: boolean): void {
    vibeCodingTTSActive = active;
    log(`[vibe_coding] TTS active state set to: ${active}`);
}

/**
 * Get vibe coding TTS active state
 */
export function getVibeCodingTTSActive(): boolean {
    return vibeCodingTTSActive;
}

/**
 * Stop vibe coding TTS if active
 */
export function stopVibeCodingTTS(): void {
    if (vibeCodingTTSActive) {
        log('[vibe_coding] Stopping vibe coding TTS due to cursor movement');
        vibeCodingTTSActive = false;
        // Use comprehensive audio stopping
        try {
            stopAllAudio(); // Stop all audio including TTS
            stopPlayback(); // Additional direct stop call
            log('[vibe_coding] Successfully stopped vibe coding TTS');
        } catch (error) {
            log(`[vibe_coding] Error stopping TTS: ${error}`);
        }
    }
}

/**
 * Wrapper for speakTokenList that tracks vibe coding TTS state
 */
async function speakTokenListWithTracking(chunks: TokenChunk[]): Promise<void> {
    try {
        setVibeCodingTTSActive(true);
        // Force all chunks to use 'vibe_text' category to ensure GPT TTS
        // This applies to all vibe coding related messages including success/error messages
        const routed = chunks.map(ch => ({
            tokens: ch.tokens,
            category: 'vibe_text' as const, // Force GPT TTS for all vibe coding messages
            panning: ch.panning
        }));
        
        // Enhanced logging for debugging TTS routing
        const tokenText = routed.map(ch => ch.tokens.join(' ')).join(' ');
        log(`[vibe_coding] *** SPEAKING WITH FORCED GPT TTS *** - Text: "${tokenText.slice(0, 100)}${tokenText.length > 100 ? '...' : ''}", vibeCodingTTSActive: ${vibeCodingTTSActive}`);
        
        // Clean up LLM response text - remove dots/ellipsis that should not be spoken
        const cleanedRouted = routed.map(chunk => ({
            ...chunk,
            tokens: chunk.tokens.map(token => 
                // Remove standalone dots, ellipsis, and processing indicators
                token.replace(/^\.{3,}$|^…$|^processing\.{3,}$|^thinking\.{3,}$/gi, '')
                     .replace(/\.{3,}/g, '') // Remove ellipsis within text
                     .trim()
            ).filter(token => token.length > 0) // Remove empty tokens
        })).filter(chunk => chunk.tokens.length > 0); // Remove empty chunks
        
        if (cleanedRouted.length > 0) {
            log(`[vibe_coding] About to call speakTokenList with ${cleanedRouted.length} chunks, first chunk: ${JSON.stringify(cleanedRouted[0])}`);
            await speakTokenList(cleanedRouted);
            log(`[vibe_coding] speakTokenList completed successfully`);
        } else {
            log(`[vibe_coding] All tokens were filtered out (dots/ellipsis), skipping speech`);
        }
    } catch (error) {
        log(`[vibe_coding] Error in speakTokenListWithTracking: ${error}`);
        // Try to speak a fallback message using regular TTS
        try {
            const { speakTokenList } = await import('../audio.js');
            await speakGPT('Vibe coding completed');
        } catch (fallbackError) {
            log(`[vibe_coding] Fallback TTS also failed: ${fallbackError}`);
        }
    } finally {
        setVibeCodingTTSActive(false);
        log(`[vibe_coding] TTS tracking completed, vibeCodingTTSActive reset to: ${vibeCodingTTSActive}`);
    }
}

/**
 * Get active editor with retry logic to handle timing issues
 * Now uses last active editor tracking for terminal ASR support
 */
async function getActiveEditorWithRetry(maxRetries: number = 3, delayMs: number = 100): Promise<vscode.TextEditor | undefined> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log(`[vibe_coding] Attempting to get active editor (attempt ${attempt}/${maxRetries})`);
        
        const editor = isEditorActive();
        if (editor) {
            log(`[vibe_coding] Found valid file editor: ${editor.document.fileName}`);
            return editor;
        }
        
        log(`[vibe_coding] No editor found on attempt ${attempt}`);
        
        // Wait before next attempt (except on last attempt)
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    // Last resort: try to get any visible text editor
    const visibleEditors = vscode.window.visibleTextEditors;
    log(`[vibe_coding] Found ${visibleEditors.length} visible editors`);
    
    for (const editor of visibleEditors) {
        if (editor.document.uri.scheme === 'file') {
            log(`[vibe_coding] Using visible file editor: ${editor.document.fileName}`);
            return editor;
        }
    }
    
    log(`[vibe_coding] No valid editor found after all attempts`);
    return undefined;
}

/**
 * Extract filename from instruction and attempt to open the file
 */
async function extractAndOpenFileFromInstruction(instruction: string): Promise<vscode.TextEditor | null> {
    log(`[vibe_coding] Extracting filename from instruction: "${instruction}"`);
    
    // Common file patterns to look for
    const filePatterns = [
        // Direct file mentions with extensions
        /([a-zA-Z0-9_\-\.]+\.(py|js|ts|tsx|jsx|java|cpp|c|h|cs|php|rb|go|rs|swift|kt|scala|sh|bat|ps1|sql|html|css|scss|sass|less|json|xml|yaml|yml|md|txt|csv|log))\b/gi,
        // Python files specifically
        /([a-zA-Z0-9_\-]+\.py)\b/gi,
        // Common filenames without extension but with context
        /(?:파일|file|in|에서|from)\s+([a-zA-Z0-9_\-]+)(?:\s|$|에서|에|를|을)/gi,
        // Korean patterns
        /([a-zA-Z0-9_\-]+(?:\.py|\.js|\.ts|\.tsx|\.jsx|\.java|\.cpp|\.c|\.h|\.cs|\.php|\.rb|\.go|\.rs|\.swift|\.kt|\.scala|\.sh|\.bat|\.ps1|\.sql|\.html|\.css|\.scss|\.sass|\.less|\.json|\.xml|\.yaml|\.yml|\.md|\.txt|\.csv|\.log)?)(?:에서|에|를|을|파일)/gi
    ];
    
    const extractedFiles: string[] = [];
    
    // Extract potential filenames
    for (const pattern of filePatterns) {
        const matches = instruction.matchAll(pattern);
        for (const match of matches) {
            if (match[1]) {
                extractedFiles.push(match[1]);
            }
        }
    }
    
    // Remove duplicates and filter
    const uniqueFiles = [...new Set(extractedFiles)];
    log(`[vibe_coding] Extracted potential filenames: ${uniqueFiles.join(', ')}`);
    
    if (uniqueFiles.length === 0) {
        log('[vibe_coding] No filenames found in instruction');
        return null;
    }
    
    // Try to find and open the files
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        log('[vibe_coding] No workspace folder available');
        return null;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    
    for (const fileName of uniqueFiles) {
        try {
            const foundFile = await findFileInWorkspace(rootPath, fileName);
            if (foundFile) {
                log(`[vibe_coding] Found file: ${foundFile}`);
                const document = await vscode.workspace.openTextDocument(foundFile);
                const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
                await speakGPT(`Opened ${path.basename(foundFile)} for editing`);
                return editor;
            }
        } catch (error) {
            log(`[vibe_coding] Error opening file ${fileName}: ${error}`);
        }
    }
    
    log('[vibe_coding] No matching files found in workspace');
    return null;
}

/**
 * Recursively search for a file in the workspace
 */
async function findFileInWorkspace(rootPath: string, fileName: string): Promise<string | null> {
    const searchPaths: string[] = [];
    
    // First try exact match in root
    const exactPath = path.join(rootPath, fileName);
    if (fs.existsSync(exactPath)) {
        return exactPath;
    }
    
    // If no extension provided, try common extensions
    if (!path.extname(fileName)) {
        const commonExtensions = ['.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.cpp', '.c', '.h'];
        for (const ext of commonExtensions) {
            const pathWithExt = path.join(rootPath, fileName + ext);
            if (fs.existsSync(pathWithExt)) {
                return pathWithExt;
            }
        }
    }
    
    // Recursive search
    async function searchDirectory(dirPath: string, depth: number = 0): Promise<string | null> {
        if (depth > 5) return null; // Limit search depth
        
        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            // First check files in current directory
            for (const item of items) {
                if (item.isFile()) {
                    if (item.name === fileName || 
                        (item.name.toLowerCase() === fileName.toLowerCase()) ||
                        (path.basename(item.name, path.extname(item.name)) === path.basename(fileName, path.extname(fileName)))) {
                        return path.join(dirPath, item.name);
                    }
                }
            }
            
            // Then search subdirectories
            for (const item of items) {
                if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                    const found = await searchDirectory(path.join(dirPath, item.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch (error) {
            // Ignore permission errors
        }
        
        return null;
    }
    
    return await searchDirectory(rootPath);
}

export async function activateVibeCoding(prefilledInstruction?: string, options?: { suppressConversationalASR?: boolean }) {
    log('[vibe_coding] ===== VIBE CODING ACTIVATED =====');
    logVibeCoding('vibe_coding_activated', prefilledInstruction);
    
    // Track vibe coding feature start
    comprehensiveEventTracker.trackFeatureStart('vibe_coding', {
        prefilledInstruction,
        suppressConversationalASR: options?.suppressConversationalASR
    });
    
    // Enhanced editor detection with retry logic
    let editor = await getActiveEditorWithRetry();
    
    // If no editor is active and we have a prefilled instruction, try to extract filename and open it
    if (!editor && prefilledInstruction) {
        log('[vibe_coding] No active editor, attempting to find and open file from instruction');
        const extractedFile = await extractAndOpenFileFromInstruction(prefilledInstruction);
        if (extractedFile) {
            editor = extractedFile;
            log(`[vibe_coding] Successfully opened file: ${editor.document.fileName}`);
        }
    }
    
    if (!editor) {
        log('[vibe_coding] No active editor found after retries');
        logVibeCoding('vibe_coding_error', 'No active editor found');
        await speakGPT('No active editor found. Please open a file and try again.');
        vscode.window.setStatusBarMessage('No active editor - please open a file and try again', 4000);
        return;
    }
    
    log(`[vibe_coding] Active editor found: ${editor.document.fileName}`);
    log(`[vibe_coding] Editor scheme: ${editor.document.uri.scheme}, language: ${editor.document.languageId}`);
    
    if (prefilledInstruction) {
        log(`[vibe_coding] Using prefilled instruction: "${prefilledInstruction}"`);
    }

    // Get intelligent context
    const context = await getIntelligentContext(editor);
    
    let instruction: string | undefined;
    
    if (prefilledInstruction) {
        // Use the prefilled instruction from ASR
        instruction = prefilledInstruction;
        log(`[vibe_coding] Using ASR instruction directly: "${instruction}"`);
        
        // Silent - no audio feedback for ASR instructions
        log(`[vibe_coding] Received ASR instruction silently: "${instruction}"`);
    } else {
        // Show input box for manual instruction
        instruction = await vscode.window.showInputBox({
        placeHolder: 'Describe what you want to change in the code...',
        prompt: `Vibe Coding: Describe your desired code changes in natural language\n\nContext: ${context.focusedFunction ? 'Function under cursor' : context.selectedCode ? 'Selected code' : 'Entire file'}${context.isLargeFile ? ' (large file)' : ''}`,
        value: '',
        ignoreFocusOut: true
    });
    }

    if (!instruction) {
        await speakGPT('No instruction provided');
        return;
    }

    // Silent processing - no audio feedback
    log('[vibe_coding] Processing vibe coding request silently');
    // Play tick-tick while waiting for the LLM result
    await startThinkingAudio();
    
    // Get original text for diff comparison
    const originalText = editor.document.getText();
    
    try {
        log(`[vibe_coding] Starting vibe coding request: ${instruction}`);
        logVibeCoding('vibe_coding_request_started', instruction, editor.document.fileName);
        
        const result = await processVibeCodingRequest(editor, instruction, context);
        log(`[vibe_coding] Request processed, showing diff preview`);
        
        // Generate unique change ID
        const changeId = generateChangeId();
        currentChangeId = changeId;
        
        // Store pending change
        pendingChanges.set(changeId, {
            id: changeId,
            result,
            timestamp: Date.now(),
            instruction
        });
        
        logVibeCoding('vibe_coding_changes_generated', instruction, editor.document.fileName, {
            changeId,
            changesCount: result.changes.length,
            totalAdded: result.totalAdded,
            totalRemoved: result.totalRemoved,
            changeType: result.changeType
        });
        
        // Auto-apply the change without showing any diff
        await showChangesAndAutoAccept(changeId, result, options);
        
        log(`[vibe_coding] Diff preview completed`);
        
        // Track vibe coding feature completion (success)
        comprehensiveEventTracker.trackFeatureStop('vibe_coding', true, {
            instruction,
            file: editor.document.fileName
        });
    } catch (error) {
        log(`[vibe_coding] Error: ${error}`);
        log(`[vibe_coding] Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
        logVibeCoding('vibe_coding_error', instruction, editor.document.fileName, { error: String(error) });
        
        // Track vibe coding feature completion (failure)
        comprehensiveEventTracker.trackFeatureStop('vibe_coding', false, {
            instruction,
            file: editor.document.fileName,
            error: String(error)
        });
        
        await speakGPT('Error processing vibe coding request');
        vscode.window.showErrorMessage(`Vibe Coding Error: ${error}`);
    } finally {
        try { await stopThinkingAudio(); } catch {}
    }
}

// Test function for debugging
export async function testVibeCoding() {
    log('[vibe_coding] ===== TEST VIBE CODING =====');
    await speakGPT('Testing vibe coding TTS with GPT voice');
    vscode.window.showInformationMessage('Vibe Coding Test - Check console for logs and listen for GPT voice');
    
    // Test with a sample instruction
    await activateVibeCoding('create a simple test function');
}

// Test function specifically for TTS debugging
export async function testVibeCodingTTS() {
    log('[vibe_coding] ===== TEST VIBE CODING TTS =====');
    
    // Test different TTS scenarios
    const testMessages = [
        'This is a test of vibe coding TTS using GPT voice',
        'Changes applied successfully',
        'Code modified with improvements'
    ];
    
    for (const message of testMessages) {
        log(`[vibe_coding] Testing TTS for: "${message}"`);
        try {
            await speakGPT(message);
            log(`[vibe_coding] TTS test completed for: "${message}"`);
        } catch (error) {
            log(`[vibe_coding] TTS test failed for: "${message}", error: ${error}`);
        }
        // Wait between tests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    vscode.window.showInformationMessage('Vibe Coding TTS Test Complete - Check console for detailed logs');
}

/**
 * Handle voice commands for vibe coding (accept, apply, revert, reject)
 */
export async function handleVibeCodingVoiceCommand(voiceText: string): Promise<boolean> {
    if (!voiceText) {
        return false;
    }
    
    const text = voiceText.toLowerCase().trim();
    log(`[vibe_coding] Processing voice command: "${text}"`);
    logVibeCoding('vibe_coding_voice_command', text);
    
    // Check if there are pending changes
    const hasPendingChanges = currentChangeId || currentDiffChangeId;
    
    if (!hasPendingChanges) {
        log(`[vibe_coding] No pending changes for voice command: "${text}"`);
        logVibeCoding('vibe_coding_voice_command_no_changes', text);
        return false;
    }
    
    // Voice patterns for applying changes (English and Korean)
    const applyPatterns = [
        'accept',
        'apply',
        'apply changes',
        'accept changes',
        'yes',
        'confirm',
        'ok',
        'okay',
        // Korean patterns
        '적용',
        '적용해',
        '적용해줘',
        '승인',
        '승인해',
        '승인해줘',
        '확인',
        '네',
        '예',
        '좋아',
        '맞아',
        '변경 적용',
        '변경사항 적용',
        '반영'
    ];
    
    // Voice patterns for rejecting changes (English and Korean)
    const rejectPatterns = [
        'reject',
        'revert',
        'cancel',
        'no',
        'reject changes',
        'revert changes',
        'cancel changes',
        'undo',
        // Korean patterns
        '거부',
        '거부해',
        '거부해줘',
        '취소',
        '취소해',
        '취소해줘',
        '되돌려',
        '되돌려줘',
        '아니야',
        '아니',
        '싫어',
        '안돼',
        '변경 취소',
        '변경사항 취소',
        '원래대로',
        '이전으로',
        '거절'
    ];
    
    // Check for apply patterns
    for (const pattern of applyPatterns) {
        if (text === pattern || text.includes(pattern)) {
            log(`[vibe_coding] Voice command matched apply pattern: "${pattern}"`);
            await speakGPT('Applying changes via voice command');
            
            if (currentChangeId) {
                await applyPendingChange(currentChangeId);
            } else if (currentDiffChangeId) {
                await applyPendingChange(currentDiffChangeId);
            }
            
            clearInlineDiffDecorations();
            return true;
        }
    }
    
    // Check for reject patterns
    for (const pattern of rejectPatterns) {
        if (text === pattern || text.includes(pattern)) {
            log(`[vibe_coding] Voice command matched reject pattern: "${pattern}"`);
            await speakGPT('Rejecting changes via voice command');
            
            if (currentChangeId) {
                await rejectPendingChange(currentChangeId);
            } else if (currentDiffChangeId) {
                await rejectPendingChange(currentDiffChangeId);
            }
            
            clearInlineDiffDecorations();
            return true;
        }
    }
    
    log(`[vibe_coding] Voice command "${text}" did not match any vibe coding patterns`);
    return false;
}

// Register the main command and change management commands
export function registerVibeCodingCommands(context: vscode.ExtensionContext) {
    // Set up context key for keyboard shortcuts
    vscode.commands.executeCommand('setContext', 'vibeCodingDiffVisible', false);
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.vibeCoding', activateVibeCoding)
    );
    
    // Add test commands for debugging
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testVibeCoding', testVibeCoding)
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testVibeCodingTTS', testVibeCodingTTS)
    );
    
    // Add voice command handler for vibe coding
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.handleVibeCodingVoiceCommand', handleVibeCodingVoiceCommand)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.acceptVibeCodingChange', async () => {
            const id = currentChangeId || currentDiffChangeId;
            if (id) {
                await applyPendingChange(id);
                disposeVibeControls();
                const pending = pendingChanges.get(id);
                const changesSummary = pending ? `+${pending.result.totalAdded || 0} -${pending.result.totalRemoved || 0}` : '';
                // Use status bar message instead of popup for non-intrusive feedback
                vscode.window.setStatusBarMessage(`✅ Changes applied ${changesSummary}`, 5000);
                await speakGPT(`Changes applied. ${pending?.result.summary || ''}`);
            } else {
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending vibe coding change to apply', 3000);
            }
        }),
    
        vscode.commands.registerCommand('lipcoder.rejectVibeCodingChange', async () => {
            const id = currentChangeId || currentDiffChangeId;
            if (id) {
                await rejectPendingChange(id);
                disposeVibeControls();
                // Use status bar message instead of popup for non-intrusive feedback
                vscode.window.setStatusBarMessage('❌ Changes discarded', 5000);
                await speakGPT('Changes discarded');
            } else {
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending vibe coding change to discard', 3000);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showVibeCodingDiff', async () => {
          const id = currentChangeId || currentDiffChangeId;
          if (!id) {
            // Use status bar message instead of popup
            vscode.window.setStatusBarMessage('No pending vibe coding change to show', 3000);
            return;
          }
          const pending = pendingChanges.get(id);
          if (!pending) {
            // Use status bar message instead of popup
            vscode.window.setStatusBarMessage('No diff data available for the current change', 3000);
            return;
          }
          await showSmartDiffPreview(id, pending.result);
        }),
      
        vscode.commands.registerCommand('lipcoder.showSuggestionHistory', async () => {
          await showSuggestionHistory();
        }),
      
        vscode.commands.registerCommand('lipcoder.continueWithSuggestions', async () => {
          await showCurrentSuggestions();
        }),
      );
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.startVibeCoding', async () => {
            const instruction = await vscode.window.showInputBox({
            placeHolder: 'Describe what you want to change (e.g., “Convert var to const in this file”, “Add error handling around fetch”)',
            prompt: 'Vibe Coding: Natural language instruction',
            value: '',
            ignoreFocusOut: true
            });
            if (!instruction?.trim()) {
            // Use status bar message instead of popup
            vscode.window.setStatusBarMessage('No instruction provided', 3000);
            return;
            }
            // Pass as prefilled so it follows the silent/ASR-like path
            await activateVibeCoding(instruction.trim(), { suppressConversationalASR: true });
        })
    );
    
    registerChangeManagementCommands(context);
}

// Placeholder functions - will be implemented in the next steps
async function getIntelligentContext(editor: vscode.TextEditor): Promise<ContextInfo> {
    const document = editor.document;
    const selection = editor.selection;
    const cursorPosition = editor.selection.active;
    const fullText = document.getText();
    
    // 1. Check for user selection first - only use selected code if explicitly selected
    const selectedCode = document.getText(selection);
    if (selectedCode.trim()) {
        log(`[vibe_coding] Using selected code (${selectedCode.length} chars)`);
        return {
            selectedCode,
            focusedFunction: null,
            cursorPosition,
            contextLines: selectedCode.split('\n'),
            isLargeFile: false
        };
    }
    
    // 2. Always use full file context for better LLM understanding
    // Find function under cursor for reference but don't limit context to it
    const focusedFunction = findFunctionUnderCursor(fullText, cursorPosition.line);
    
    // 3. Determine if this is a large file
    const isLargeFile = fullText.split('\n').length > 500;
    
    log(`[vibe_coding] Using full file context (${fullText.length} chars, ${fullText.split('\n').length} lines)`);
    if (focusedFunction) {
        log(`[vibe_coding] Cursor is in function: ${focusedFunction.substring(0, 100)}...`);
    }
    
    return {
        selectedCode: '',
        focusedFunction,
        cursorPosition,
        contextLines: fullText.split('\n'), // Always use full file
        isLargeFile
    };
}

async function processVibeCodingRequest(editor: vscode.TextEditor, instruction: string, context: ContextInfo): Promise<VibeCodingResult> {
    const document = editor.document;
    const originalText = document.getText();
    
    // Use smart code generation that handles both full and partial code outputs
    const modifiedCode = await generateSmartCodeModification(originalText, instruction, context);
    
    // Calculate differences using smart analysis
    const result = calculateSmartCodeChanges(originalText, modifiedCode, instruction, context);
    
    return result;
}

/**
 * Estimate token count for text (rough approximation: 1 token ≈ 4 characters)
 */
function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Create smart context for large files that respects token limits
 */
function createSmartContext(originalText: string, context: ContextInfo, instruction: string): { contextText: string; isPartialContext: boolean } {
    const maxTokens = 180000; // Leave buffer for system prompt and response
    const systemPromptTokens = 1000; // Estimated system prompt size
    const responseTokens = 4000; // Max response tokens
    const availableTokens = maxTokens - systemPromptTokens - responseTokens;
    
    const fullTextTokens = estimateTokenCount(originalText);
    const instructionTokens = estimateTokenCount(instruction);
    
    log(`[vibe_coding] Token estimation - Full text: ${fullTextTokens}, Available: ${availableTokens}`);
    
    // If the full text fits within token limits, use it
    if (fullTextTokens + instructionTokens < availableTokens) {
        return { contextText: originalText, isPartialContext: false };
    }
    
    // For large files, create smart context around cursor position
    const lines = originalText.split('\n');
    const cursorLine = context.cursorPosition.line;
    const totalLines = lines.length;
    
    log(`[vibe_coding] File too large (${fullTextTokens} tokens), creating smart context around line ${cursorLine + 1}`);
    
    // If user has selected code, prioritize that
    if (context.selectedCode && context.selectedCode.trim()) {
        const selectedTokens = estimateTokenCount(context.selectedCode);
        if (selectedTokens + instructionTokens < availableTokens) {
            log(`[vibe_coding] Using selected code context (${selectedTokens} tokens)`);
            return { contextText: context.selectedCode, isPartialContext: true };
        }
    }
    
    // Calculate context window around cursor
    const maxLinesForTokens = Math.floor(availableTokens / 20); // Rough estimate: 20 tokens per line
    const contextRadius = Math.floor(maxLinesForTokens / 2);
    
    const startLine = Math.max(0, cursorLine - contextRadius);
    const endLine = Math.min(totalLines - 1, cursorLine + contextRadius);
    
    const contextLines = lines.slice(startLine, endLine + 1);
    const contextText = contextLines.join('\n');
    
    // Add file structure info for better context
    const fileInfo = `// File: ${totalLines} total lines, showing lines ${startLine + 1}-${endLine + 1} around cursor (line ${cursorLine + 1})
// This is a partial view of the file. Make changes that fit naturally within this context.

${contextText}`;
    
    log(`[vibe_coding] Created smart context: lines ${startLine + 1}-${endLine + 1} (${estimateTokenCount(fileInfo)} tokens)`);
    return { contextText: fileInfo, isPartialContext: true };
}

/**
 * Enhanced smart code modification that handles both full and partial code outputs
 */
async function generateSmartCodeModification(originalText: string, instruction: string, context: ContextInfo): Promise<string> {
    try {
        const { callLLMForCompletion } = await import('../llm.js');
        
        // Create smart context that respects token limits
        const { contextText, isPartialContext } = createSmartContext(originalText, context, instruction);
        
        // Analyze the instruction to determine the best approach (English and Korean)
        const isTestRequest = /test|unit test|create test|add test|write test|테스트|단위 테스트|테스트 함수|테스트를 만들어|테스트 코드/i.test(instruction);
        const isFunctionRequest = /function|method|def |create function|add function|함수|메서드|함수를 만들어|함수 생성|새 함수/i.test(instruction);
        const isClassRequest = /class|create class|add class|클래스|클래스를 만들어|클래스 생성|새 클래스/i.test(instruction);
        const isFullRewrite = /rewrite|refactor|restructure|reorganize|리팩토링|리팩터링|재구성|다시 작성|코드 개선/i.test(instruction);
        
        // Enhanced system prompt for better code generation with Korean language support
        const systemPrompt = `You are an expert coding assistant that generates high-quality code modifications. You understand instructions in both English and Korean.

${isPartialContext ? 
'IMPORTANT: You are working with a PARTIAL view of a large file. Return only the modified section that needs to change, maintaining proper context and structure.' :
'IMPORTANT: Always return the COMPLETE modified file, not just snippets or diffs.'}

CONTEXT ANALYSIS:
- Current cursor: Line ${context.cursorPosition.line + 1}
- In function: ${context.focusedFunction ? 'Yes' : 'No'}
- Selected code: ${context.selectedCode ? 'Yes' : 'No'}
- File size: ${context.isLargeFile ? 'Large' : 'Normal'}
- Context type: ${isPartialContext ? 'Partial (large file)' : 'Complete'}

LANGUAGE SUPPORT:
- You understand Korean instructions like "코드의 신택스 에러를 고쳐줘" (fix syntax errors in the code)
- Korean coding terms: 함수 (function), 변수 (variable), 클래스 (class), 에러 (error), 테스트 (test)
- Respond to Korean instructions with the same quality as English instructions

RULES:
${isPartialContext ? 
'1. Return only the modified section with proper context\n2. Maintain existing indentation and structure exactly as provided\n3. Include necessary imports if adding new functionality\n4. Focus changes around the cursor position\n5. DO NOT reformat or change existing code formatting' :
'1. Return the complete file with all modifications applied\n2. Preserve existing code structure and formatting exactly as provided\n3. Include all necessary imports\n4. Preserve existing functionality while adding requested changes\n5. DO NOT reformat or change existing code formatting'}
6. Do not use markdown code fences in your response
7. Handle both English and Korean instructions with equal proficiency
8. IMPORTANT: Do not apply any code formatting, linting, or style changes unless explicitly requested`;

        // Create appropriate prompt based on context type
        const prompt = isPartialContext ? 
            `Code Context:
${contextText}

Instruction: ${instruction}

Analyze the code context and instruction, then return the modified section with the requested changes.
Focus on the area around the cursor and make targeted improvements.` :
            `Original Code:
${contextText}

Instruction: ${instruction}

Analyze the code and instruction, then return the complete modified file with all improvements.
Make sure to include all existing code plus the requested changes.`;
        
        log(`[vibe_coding] Smart modification request: ${instruction} (${isPartialContext ? 'partial' : 'full'} context)`);
        
        // Start thinking audio during LLM processing
        await startThinkingAudio();
        
        try {
            const modifiedCode = await callLLMForCompletion(systemPrompt, prompt, 4000, 0.1);
            
            // Play thinking finished sound and stop thinking audio
            await playThinkingFinished();
            
            // Clean up the response
            const cleanedCode = stripCodeFences(modifiedCode);
            
            // For partial context, we need to merge the changes back into the original file
            if (isPartialContext) {
                log(`[vibe_coding] Merging partial changes back into full file`);
                return mergePartialChanges(originalText, cleanedCode, context);
            }
            
            log(`[vibe_coding] Smart modification completed`);
            return cleanedCode;
        } catch (error) {
            // Make sure to stop thinking audio even if LLM fails
            await stopThinkingAudio();
            throw error;
        }
        
    } catch (error) {
        log(`[vibe_coding] Smart modification error: ${error}`);
        throw error;
    }
}

/**
 * Get programming language from file extension
 */
function getLanguageFromExtension(ext: string): string {
    const langMap: { [key: string]: string } = {
        '.ts': 'TypeScript',
        '.js': 'JavaScript',
        '.py': 'Python',
        '.java': 'Java',
        '.cpp': 'C++',
        '.c': 'C',
        '.cs': 'C#',
        '.go': 'Go',
        '.rs': 'Rust',
        '.php': 'PHP',
        '.rb': 'Ruby'
    };
    return langMap[ext] || 'Unknown';
}

/**
 * Merge partial changes back into the original file
 */
function mergePartialChanges(originalText: string, partialChanges: string, context: ContextInfo): string {
    // For now, return the partial changes as-is
    // In a more sophisticated implementation, we would intelligently merge
    // the changes back into the specific location in the original file
    
    // If user had selected code, replace the selection
    if (context.selectedCode && context.selectedCode.trim()) {
        return originalText.replace(context.selectedCode, partialChanges);
    }
    
    // Otherwise, for partial context, we'll return the changes as-is
    // This is a simplified approach - a full implementation would need
    // more sophisticated merging logic
    return partialChanges;
}

function disposeVibeControls() {
    if (vbAcceptItem) { vbAcceptItem.dispose(); vbAcceptItem = null; }
    if (vbRejectItem) { vbRejectItem.dispose(); vbRejectItem = null; }
}

function showPersistentVibeControls(changeId: string, result: VibeCodingResult) {
    disposeVibeControls();

    const changesSummary = `+${result.totalAdded || 0} -${result.totalRemoved || 0}`;

    vbAcceptItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    vbAcceptItem.text = '$(check) Vibe: Accept';
    vbAcceptItem.tooltip = `Apply vibe changes (${changesSummary})`;
    vbAcceptItem.command = 'lipcoder.acceptVibeCodingChange';
    vbAcceptItem.show();

    vbRejectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    vbRejectItem.text = '$(close) Vibe: Reject';
    vbRejectItem.tooltip = 'Discard vibe changes';
    vbRejectItem.command = 'lipcoder.rejectVibeCodingChange';
    vbRejectItem.show();
}

async function showSmartDiffPreview(changeId: string, result: VibeCodingResult, options?: { suppressConversationalASR?: boolean }): Promise<void> {
    const { summary } = result;
    try {
        log('[vibe_coding] showSmartDiffPreview: applying change immediately');
        await applyPendingChange(changeId);
        log(`[vibe_coding] Change applied: ${summary}`);
    } catch (error) {
        log(`[vibe_coding] Error applying change: ${error}`);
        vscode.window.showErrorMessage(`Vibe Coding: failed to apply change: ${error}`);
    }
}

/**
 * Show inline diff for vibe coding changes (legacy path disabled)
 */
async function showVibeCodingDiff(
    filePath: string, 
    originalText: string, 
    modifiedText: string, 
    summary: string, 
    changeId: string, 
    result: VibeCodingResult,
    options?: { suppressConversationalASR?: boolean }
): Promise<void> {
    // Legacy path disabled: primary flow uses vscode.diff
    return;
}

/**
 * Show simple inline diff for vibe coding changes (legacy path disabled)
 */
async function showSimpleVibeCodingDiff(
    editor: vscode.TextEditor,
    originalText: string, 
    modifiedText: string, 
    summary: string, 
    changeId: string, 
    result: VibeCodingResult,
    options?: { suppressConversationalASR?: boolean }
): Promise<void> {
    // Legacy path disabled: primary flow uses vscode.diff
    return;
}

/**
 * Show simple diff for vibe coding with red/green highlighting (legacy path disabled)
 */
async function showSimpleVibeCodingStyleDiff(
    editor: vscode.TextEditor, 
    originalText: string, 
    modifiedText: string, 
    summary: string, 
    result: VibeCodingResult
): Promise<boolean> {
    // Legacy path disabled: primary flow uses vscode.diff
    return false;
}

// Global decoration types for vibe coding
let vbAddedDecorationType: vscode.TextEditorDecorationType | null = null;
let vbRemovedDecorationType: vscode.TextEditorDecorationType | null = null;
let vbActiveEditor: vscode.TextEditor | null = null;

/**
 * Apply proper diff highlighting using diff library
 */
function applyProperVibeCodingHighlighting(editor: vscode.TextEditor, originalText: string, modifiedText: string): void {
    // Clear any existing decorations
    clearVibeCodingDecorations();
    
    // Create decoration types
    vbAddedDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(46, 160, 67, 0.2)', // Green background
        isWholeLine: true
    });
    
    vbRemovedDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(248, 81, 73, 0.2)', // Red background
        isWholeLine: true,
        textDecoration: 'line-through'
    });
    
    // Calculate proper diff
    const diffResult = Diff.diffLines(originalText, modifiedText);
    const displayContent = createVibeCodingDiffContent(diffResult);
    
    // Replace editor content with diff display
    editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(editor.document.lineCount, 0)
        );
        editBuilder.replace(fullRange, displayContent.content);
    }).then(() => {
        // Apply decorations
        const addedDecorations: vscode.DecorationOptions[] = [];
        const removedDecorations: vscode.DecorationOptions[] = [];
        
        displayContent.lineTypes.forEach((lineType, index) => {
            const range = new vscode.Range(
                new vscode.Position(index, 0),
                new vscode.Position(index, Number.MAX_SAFE_INTEGER)
            );
            
            if (lineType === 'added') {
                addedDecorations.push({ range });
            } else if (lineType === 'removed') {
                removedDecorations.push({ range });
            }
        });
        
        if (vbAddedDecorationType) {
            editor.setDecorations(vbAddedDecorationType, addedDecorations);
        }
        if (vbRemovedDecorationType) {
            editor.setDecorations(vbRemovedDecorationType, removedDecorations);
        }
        
        vbActiveEditor = editor;
    });
}

/**
 * Create diff content for vibe coding
 */
function createVibeCodingDiffContent(diffResult: Diff.Change[]): { content: string; lineTypes: ('added' | 'removed' | 'unchanged')[] } {
    const lines: string[] = [];
    const lineTypes: ('added' | 'removed' | 'unchanged')[] = [];
    
    diffResult.forEach(change => {
        if (change.removed) {
            const removedLines = change.value.split('\n').filter(line => line.length > 0);
            removedLines.forEach(line => {
                lines.push(`// REMOVED: ${line}`);
                lineTypes.push('removed');
            });
        } else if (change.added) {
            const addedLines = change.value.split('\n').filter(line => line.length > 0);
            addedLines.forEach(line => {
                lines.push(line);
                lineTypes.push('added');
            });
        } else {
            const unchangedLines = change.value.split('\n').filter(line => line.length > 0);
            unchangedLines.forEach(line => {
                lines.push(line);
                lineTypes.push('unchanged');
            });
        }
    });
    
    return {
        content: lines.join('\n'),
        lineTypes
    };
}

/**
 * Clear vibe coding decorations
 */
function clearVibeCodingDecorations(): void {
    if (vbActiveEditor) {
        if (vbAddedDecorationType) {
            vbActiveEditor.setDecorations(vbAddedDecorationType, []);
        }
        if (vbRemovedDecorationType) {
            vbActiveEditor.setDecorations(vbRemovedDecorationType, []);
        }
        vbActiveEditor = null;
    }
    
    if (vbAddedDecorationType) {
        vbAddedDecorationType.dispose();
        vbAddedDecorationType = null;
    }
    if (vbRemovedDecorationType) {
        vbRemovedDecorationType.dispose();
        vbRemovedDecorationType = null;
    }
}

/**
 * Show proper accept/reject buttons for vibe coding with cleanup
 */
function showProperVibeCodingAcceptReject(
    editor: vscode.TextEditor, 
    originalText: string,
    modifiedText: string,
    summary: string, 
    result: VibeCodingResult, 
    resolve: (accepted: boolean) => void
): void {
    const changesSummary = `+${result.totalAdded || 0} -${result.totalRemoved || 0}`;
    
    vscode.window.showInformationMessage(
        `${summary} (${changesSummary})`,
        '✅ Accept',
        '❌ Reject'
    ).then(choice => {
        if (choice === '✅ Accept') {
            // Apply final modified content (without diff markers)
            editor.edit(editBuilder => {
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(editor.document.lineCount, 0)
                );
                editBuilder.replace(fullRange, modifiedText);
            });
            clearVibeCodingDecorations();
            resolve(true);
        } else {
            // Restore original content
            editor.edit(editBuilder => {
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(editor.document.lineCount, 0)
                );
                editBuilder.replace(fullRange, originalText);
            });
            clearVibeCodingDecorations();
            resolve(false);
        }
    });
}

/**
 * Create inline diff preview content for vibe coding
 */
function createVibeCodingDiffPreview(original: string, modified: string, summary: string): string {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const previewLines: string[] = [];
    
    previewLines.push(`// Vibe Coding Changes Preview`);
    previewLines.push(`// Summary: ${summary}`);
    previewLines.push(`// Legend: Green (+) = Added, Red (-) = Removed`);
    previewLines.push('');
    
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    
    for (let i = 0; i < maxLines; i++) {
        const originalLine = originalLines[i];
        const modifiedLine = modifiedLines[i];
        
        if (originalLine === undefined) {
            // Line added
            previewLines.push(`+ ${modifiedLine}`);
        } else if (modifiedLine === undefined) {
            // Line removed
            previewLines.push(`- ${originalLine}`);
        } else if (originalLine !== modifiedLine) {
            // Line modified
            previewLines.push(`- ${originalLine}`);
            previewLines.push(`+ ${modifiedLine}`);
        } else {
            // Line unchanged (show some context)
            previewLines.push(`  ${originalLine}`);
        }
    }
    
    return previewLines.join('\n');
}

/**
 * Show changes briefly and automatically accept them
 */
async function showChangesAndAutoAccept(changeId: string, result: VibeCodingResult, options?: { suppressConversationalASR?: boolean }): Promise<void> {
    const { changes, summary, totalAdded, totalRemoved, modifiedText, originalText, changeDescription } = result;
    
    try {
        log(`[vibe_coding] Showing changes and auto-accepting for change ${changeId}`);
        
        // Show a brief notification about the changes and speak it
        const autoApplyMessage = `${summary} (Auto-applying...)`;
        // Show non-blocking notification as per user preferences [[memory:6411078]]
        vscode.window.showInformationMessage(autoApplyMessage, { modal: false });
        
        // Speak the summary
        await speakTokenListWithTracking([{ 
            tokens: [summary], 
            category: undefined 
        }]);
        
        // Brief delay to show the notification
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Auto-apply the changes
        await applyPendingChange(changeId);
        
        // Show success notification and speak it
        const successMessage = `✅ Changes applied successfully: ${summary}`;
        // Show non-blocking notification as per user preferences [[memory:6411078]]
        vscode.window.showInformationMessage(successMessage, { modal: false });
        
        // Speak the success message
        await speakTokenListWithTracking([{ 
            tokens: [`Changes applied successfully. ${summary}`], 
            category: undefined 
        }]);
        
        log(`[vibe_coding] Auto-accepted change ${changeId}: ${summary}`);
        
        // Continuous actions after vibe coding have been eliminated per user request
        log(`[vibe_coding] Vibe coding completed - no continuous actions will be triggered`);
        
    } catch (error) {
        log(`[vibe_coding] Error in auto-accept: ${error}`);
        // Fallback to direct apply
        await applyPendingChange(changeId);
    }
}

function generateChangeId(): string {
    return `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Global variables for inline diff management
let currentDiffDecorations: vscode.TextEditorDecorationType[] = [];
let vibeCodingDiffContext: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();

/**
 * Show inline diff with decorations in the current editor (like Cursor/ChatGPT)
 */
async function showInlineDiffWithDecorations(changeId: string, result: VibeCodingResult): Promise<void> {
    const { changes, summary, totalAdded, totalRemoved, modifiedText, originalText, changeDescription } = result;
    const editor = await getActiveEditorWithRetry();
    
    if (!editor) {
        log(`[vibe_coding] No active editor for inline diff`);
        await showSimpleDiffPreview(changeId, result);
        return;
    }
    
    try {
        log(`[vibe_coding] Creating inline diff decorations`);
        
        // Clear any existing decorations
        clearInlineDiffDecorations();
        currentDiffChangeId = changeId;
        
        // Set context for keyboard shortcuts
        await vscode.commands.executeCommand('setContext', 'vibeCodingDiffVisible', true);
        
        // Create decoration types for different change types (without isWholeLine)
        const addedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });

        const removedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            textDecoration: 'line-through'
        });

        const modifiedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.modifiedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });

        currentDiffDecorations = [addedDecoration, removedDecoration, modifiedDecoration];

        // Calculate line-based changes for decoration against the ORIGINAL document
        const diff = Diff.diffLines(originalText, modifiedText);

        const removedRanges: vscode.Range[] = [];         // lines removed from original
        const modifiedRanges: vscode.Range[] = [];        // lines changed in-place
        const addedGhosts: vscode.DecorationOptions[] = [];// virtual preview of added lines

        // We'll walk the ORIGINAL document line pointer
        let origLine = 0;

        for (const part of diff) {
            const lines = part.value.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();

            if (part.added) {
                // These lines don't exist in the original. Render them as a ghost preview
                // anchored at the insertion point (the current origLine).
                const anchorLine = Math.min(Math.max(origLine - 1, 0), Math.max(0, editor.document.lineCount - 1));
                if (editor.document.lineCount > 0) {
                    for (let i = 0; i < lines.length; i++) {
                        const lineText = lines[i];
                        const anchorRange = new vscode.Range(anchorLine, 0, anchorLine, 0);
                        addedGhosts.push({
                            range: anchorRange,
                            renderOptions: {
                                after: {
                                    contentText: ` + ${lineText}`,
                                    color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                                    margin: '0 0 0 16px'
                                }
                            }
                        });
                    }
                }
                // Note: we do NOT advance origLine here because these lines are not in the original
            } else if (part.removed) {
                // These lines existed in the original—mark them as removed
                for (let i = 0; i < lines.length; i++) {
                    const lineNumber = origLine + i;
                    if (lineNumber < editor.document.lineCount) {
                        const range = new vscode.Range(lineNumber, 0, lineNumber, editor.document.lineAt(lineNumber).text.length);
                        removedRanges.push(range);
                    }
                }
                origLine += lines.length; // advance past the removed lines in the original
            } else {
                // Unchanged: advance past these lines in the original
                origLine += lines.length;
            }
        }

        // Heuristic for modified-in-place lines: mark overlaps of removed+added around unchanged boundaries as modified
        // (optional, simple approach: any removed followed by added near the same anchor gets a modified badge on the preceding line)
        if (removedRanges.length > 0 && addedGhosts.length > 0) {
            const modifiedAnchor = removedRanges[removedRanges.length - 1];
            modifiedRanges.push(modifiedAnchor);
        }

        // Color the insertion anchor line for additions (visual cue similar to Copilot)
        const insertionAnchors: vscode.Range[] = [];
        {
            let origLine2 = 0;
            for (const part of diff) {
                const lines = part.value.split('\n');
                if (lines[lines.length - 1] === '') lines.pop();
                if (part.added) {
                    const anchor = Math.min(Math.max(origLine2 - 1, 0), Math.max(0, editor.document.lineCount - 1));
                    const range = new vscode.Range(anchor, 0, anchor, editor.document.lineAt(anchor).text.length);
                    insertionAnchors.push(range);
                } else if (part.removed) {
                    origLine2 += lines.length;
                } else {
                    origLine2 += lines.length;
                }
            }
        }

        // Apply decorations
        editor.setDecorations(addedDecoration, insertionAnchors);
        editor.setDecorations(removedDecoration, removedRanges);
        editor.setDecorations(modifiedDecoration, modifiedRanges);
        // Use a dedicated decoration type for ghosts to avoid style conflicts
        const ghostType = vscode.window.createTextEditorDecorationType({});
        editor.setDecorations(ghostType, addedGhosts);

        // Persistent status bar controls (Accept / Reject) for inline mode
        showPersistentVibeControls(changeId, result);
        await vscode.commands.executeCommand('setContext', 'lipcoder.vibeCodingShowingDiff', true);

        // Speak the summary of changes
        log(`[vibe_coding] Changes ready: ${result.summary}`);
        await speakTokenListWithTracking([{
            tokens: [summary],
            category: undefined
        }]);

        // Show action buttons with enhanced options
        const action = await vscode.window.showInformationMessage(
            `${summary}\n\n💡 Review the highlighted changes and choose an action:`,
            { modal: false },
            'Apply Changes',
            'Reject Changes',
            'Show Details'
        );

        if (action === 'Apply Changes') {
            try {
                await applyPendingChange(changeId);
                clearInlineDiffDecorations();
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to apply change: ${e}`);
            }
        } else if (action === 'Reject Changes') {
            try {
                await rejectPendingChange(changeId);
                clearInlineDiffDecorations();
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to discard change: ${e}`);
            }
        } else if (action === 'Show Details') {
            await showChangeDetails(changeId);
            // Keep decorations; user can still use status bar Accept/Reject
        } else {
            // User dismissed; keep controls visible
        }
    } catch (error) {
        log(`[vibe_coding] Error showing inline diff: ${error}`);
        clearInlineDiffDecorations();
        await showSimpleDiffPreview(changeId, result);
    }
}

/**
 * Show action dialog again for inline diff
 */
async function showInlineDiffActionDialog(changeId: string, result: VibeCodingResult): Promise<void> {
    const { summary, totalAdded, totalRemoved } = result;
    
    // Speak the summary
    await speakTokenListWithTracking([{ 
        tokens: [summary], 
        category: undefined 
    }]);
    
    const action = await vscode.window.showInformationMessage(
        `${summary}\n\n💡 Choose an action:`,
        { modal: false },
        'Apply Changes',
        'Reject Changes'
    );
    
    if (action === 'Apply Changes') {
        await applyPendingChange(changeId);
        clearInlineDiffDecorations();
    } else if (action === 'Reject Changes') {
        await rejectPendingChange(changeId);
        clearInlineDiffDecorations();
    }
}

/**
 * Clear inline diff decorations
 */
function clearInlineDiffDecorations(): void {
    if (currentDiffDecorations.length > 0) {
        for (const decoration of currentDiffDecorations) {
            decoration.dispose();
        }
        currentDiffDecorations = [];
        currentDiffChangeId = null;
        
        // Clear context for keyboard shortcuts
        vscode.commands.executeCommand('setContext', 'vibeCodingDiffVisible', false);
        
        log(`[vibe_coding] Cleared inline diff decorations`);
    }
}

function findFunctionUnderCursor(fullText: string, cursorLine: number): string | null {
    const lines = fullText.split('\n');
    
    // Look for function definitions near the cursor
    const functionPatterns = [
        /^def\s+\w+\s*\(/,           // Python functions
        /^async\s+def\s+\w+\s*\(/,    // Python async functions
        /^class\s+\w+/,               // Python classes
        /^function\s+\w+\s*\(/,       // JavaScript functions
        /^const\s+\w+\s*=\s*\(/,      // JavaScript arrow functions
        /^let\s+\w+\s*=\s*\(/,        // JavaScript arrow functions
        /^var\s+\w+\s*=\s*\(/,        // JavaScript arrow functions
        /^public\s+.*\s+\w+\s*\(/,    // Java/C# methods
        /^private\s+.*\s+\w+\s*\(/,   // Java/C# methods
        /^protected\s+.*\s+\w+\s*\(/, // Java/C# methods
    ];
    
    // Search backwards from cursor to find the most recent function
    for (let i = cursorLine; i >= 0; i--) {
        const line = lines[i];
        for (const pattern of functionPatterns) {
            if (pattern.test(line)) {
                // Found a function definition, extract the function
                return extractFunction(lines, i);
            }
        }
    }
    
    return null;
}

function extractFunction(lines: string[], startLine: number): string {
    const functionLines: string[] = [];
    let braceCount = 0;
    let parenCount = 0;
    
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        functionLines.push(line);
        
        // Count braces and parentheses to find function end
        for (const char of line) {
            if (char === '{') {
                braceCount++;
            }
            if (char === '}') {
                braceCount--;
            }
            if (char === '(') {
                parenCount++;
            }
            if (char === ')') {
                parenCount--;
            }
        }
        
        // For Python, look for indentation level
        if (lines[startLine].startsWith('def ') || lines[startLine].startsWith('class ')) {
            const baseIndent = lines[startLine].match(/^\s*/)?.[0].length || 0;
            const currentIndent = line.match(/^\s*/)?.[0].length || 0;
            
            // If we're back to the base indentation level and not at the start
            if (i > startLine && currentIndent <= baseIndent && line.trim() !== '') {
                functionLines.pop(); // Remove the last line as it's outside the function
                break;
            }
        } else {
            // For other languages, use brace counting
            if (braceCount === 0 && parenCount === 0 && i > startLine) {
                break;
            }
        }
    }
    
    return functionLines.join('\n');
}

async function getASTContext(document: vscode.TextDocument, cursorPosition: vscode.Position): Promise<string | null> {
    try {
        // Get the symbol at the cursor position
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (!symbols || symbols.length === 0) {
            return null;
        }
        
        // Find the symbol that contains the cursor position
        const cursorOffset = document.offsetAt(cursorPosition);
        let targetSymbol: vscode.SymbolInformation | null = null;
        
        for (const symbol of symbols) {
            const symbolRange = symbol.location.range;
            const symbolStart = document.offsetAt(symbolRange.start);
            const symbolEnd = document.offsetAt(symbolRange.end);
            
            if (cursorOffset >= symbolStart && cursorOffset <= symbolEnd) {
                targetSymbol = symbol;
                break;
            }
        }
        
        if (targetSymbol) {
            // Extract the code for this symbol
            const symbolRange = targetSymbol.location.range;
            const symbolCode = document.getText(symbolRange);
            log(`[vibe_coding] Found AST symbol: ${targetSymbol.name} (${symbolCode.length} chars)`);
            return symbolCode;
        }
        
        return null;
    } catch (error) {
        log(`[vibe_coding] AST analysis failed: ${error}`);
        return null;
    }
}

function registerChangeManagementCommands(context: vscode.ExtensionContext): void {
            // Apply current pending change
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.applyCurrentChange', async () => {
            if (currentChangeId) {
                await speakGPT('Applying changes');
                await applyPendingChange(currentChangeId);
                clearInlineDiffDecorations();
            } else if (currentDiffChangeId) {
                await speakGPT('Applying changes');
                await applyPendingChange(currentDiffChangeId);
                clearInlineDiffDecorations();
    } else {
                await speakGPT('No pending changes to apply');
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending changes to apply', 3000);
            }
        })
    );
    
    // Reject current pending change
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.rejectCurrentChange', async () => {
            if (currentChangeId) {
                await speakGPT('Rejecting changes');
                await rejectPendingChange(currentChangeId);
                clearInlineDiffDecorations();
            } else if (currentDiffChangeId) {
                await speakGPT('Rejecting changes');
                await rejectPendingChange(currentDiffChangeId);
                clearInlineDiffDecorations();
            } else {
                await speakGPT('No pending changes to reject');
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending changes to reject', 3000);
            }
        })
    );
    
    // Show details of current pending change
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showCurrentChangeDetails', async () => {
            if (currentChangeId) {
                await showChangeDetails(currentChangeId);
            } else {
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending changes', 3000);
            }
        })
    );
    
    // List all pending changes
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.listPendingChanges', async () => {
            if (pendingChanges.size === 0) {
                // Use status bar message instead of popup
                vscode.window.setStatusBarMessage('No pending changes', 3000);
                return;
            }
            
            const items = Array.from(pendingChanges.values()).map(change => ({
                label: change.result.summary,
                description: `${change.result.totalAdded}+ ${change.result.totalRemoved}-`,
                detail: change.instruction,
                changeId: change.id
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a pending change to review'
            });
            
            if (selected) {
                currentChangeId = (selected as any).changeId;
                const change = pendingChanges.get((selected as any).changeId);
                if (change) {
                    await showSmartDiffPreview((selected as any).changeId, change.result);

                    // Primary path is vscode.diff. Disable legacy inline/preview flows & post-diff prompts.
                    await vscode.commands.executeCommand('setContext', 'lipcoder.disableInlineVibeFlows', true);
                }
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(() => {
          vscode.commands.executeCommand('setContext', 'lipcoder.vibeCodingShowingDiff', false);
        })
      );
}

/**
 * Smart merge partial code with original code
 */
async function smartMergePartialCode(originalText: string, partialCode: string, instruction: string, context: ContextInfo): Promise<string> {
    const isTestRequest = /test|unit test|create test|add test|write test/i.test(instruction);
    const isFunctionRequest = /function|method|def |create function|add function/i.test(instruction);
    const isClassRequest = /class|create class|add class/i.test(instruction);
        
        if (isTestRequest) {
        return await smartMergeTestCode(originalText, partialCode);
    } else if (isFunctionRequest || isClassRequest) {
        return await smartMergeFunctionCode(originalText, partialCode, context);
        } else {
        // Default: append at the end
        return originalText + '\n\n' + partialCode;
    }
}

/**
 * Smart merge test code with original code
 */
async function smartMergeTestCode(originalText: string, testCode: string): Promise<string> {
    try {
        log(`[vibe_coding] Starting smart test code merge`);
        
        const testLines = testCode.split('\n');
        const testImports: string[] = [];
        const testContent: string[] = [];
        
        let foundFirstClass = false;
        
        for (const line of testLines) {
            const trimmed = line.trim();
            
            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                if (!foundFirstClass) {
                    testImports.push(line);
                } else {
                    testContent.push(line);
                }
            } else if (trimmed.startsWith('class ')) {
                foundFirstClass = true;
                testContent.push(line);
            } else if (foundFirstClass || trimmed !== '') {
                testContent.push(line);
            }
        }
        
        // Process original code
        const originalLines = originalText.split('\n');
        const result: string[] = [];
        let lastImportIndex = -1;
        let mainBlockStart = -1;
        
        for (let i = 0; i < originalLines.length; i++) {
            const line = originalLines[i];
            const trimmed = line.trim();
            
            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                lastImportIndex = i;
            }
            
            if (trimmed.startsWith('if __name__')) {
                mainBlockStart = i;
                break;
            }
            
            result.push(line);
        }
        
        // Add new imports after existing imports
        if (testImports.length > 0) {
            const insertIndex = lastImportIndex >= 0 ? lastImportIndex + 1 : 0;
            
            const existingImports = result.join('\n');
            const newImports = testImports.filter(imp => {
                const importName = imp.trim();
                return !existingImports.includes(importName);
            });
            
            if (newImports.length > 0) {
                result.splice(insertIndex, 0, ...newImports);
                if (insertIndex === 0 && result[newImports.length].trim() !== '') {
                    result.splice(newImports.length, 0, '');
                }
            }
        }
        
        // Add test content before the main block
        if (testContent.length > 0) {
            if (result[result.length - 1].trim() !== '') {
                result.push('');
            }
            result.push(...testContent);
        }
        
        // Add the original main block if it exists
        if (mainBlockStart >= 0) {
            if (result[result.length - 1].trim() !== '') {
                result.push('');
            }
            
            for (let i = mainBlockStart; i < originalLines.length; i++) {
                result.push(originalLines[i]);
            }
        }
        
        const finalResult = result.join('\n');
        log(`[vibe_coding] Smart test merge completed successfully`);
        return finalResult;
        
    } catch (error) {
        log(`[vibe_coding] Smart test merge failed: ${error}`);
        return originalText + '\n\n' + testCode;
    }
}

/**
 * Smart merge function code with original code
 */
async function smartMergeFunctionCode(originalText: string, functionCode: string, context: ContextInfo): Promise<string> {
    try {
        log(`[vibe_coding] Starting smart function code merge`);
        
    const originalLines = originalText.split('\n');
        
        // If we have a focused function, replace it
    if (context.focusedFunction) {
            return originalText.replace(context.focusedFunction, functionCode);
        }
        
        // Otherwise, find the best place to insert the new function
        let insertIndex = originalLines.length;
        
        // Look for a good insertion point (after imports, before main block)
        for (let i = originalLines.length - 1; i >= 0; i--) {
            const line = originalLines[i].trim();
            if (line.startsWith('if __name__')) {
                insertIndex = i;
            break;
    }
}

        // Insert the function
        const result = [...originalLines];
        if (insertIndex < result.length && result[insertIndex - 1].trim() !== '') {
            result.splice(insertIndex, 0, '');
        }
        result.splice(insertIndex, 0, ...functionCode.split('\n'));
        if (insertIndex < originalLines.length && result[insertIndex + functionCode.split('\n').length].trim() !== '') {
            result.splice(insertIndex + functionCode.split('\n').length, 0, '');
        }
        
        log(`[vibe_coding] Smart function merge completed successfully`);
        return result.join('\n');
        
    } catch (error) {
        log(`[vibe_coding] Smart function merge failed: ${error}`);
        return originalText + '\n\n' + functionCode;
    }
}

/**
 * Extract function names from code
 */
function extractFunctionNames(code: string): string[] {
    const lines = code.split('\n');
    const functionNames: string[] = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('def ') && !trimmed.startsWith('def test_')) {
            const match = trimmed.match(/def\s+(\w+)\s*\(/);
            if (match && match[1] !== 'main') {
                functionNames.push(match[1]);
            }
        }
    }
    
    return functionNames;
}

function stripCodeFences(code: string): string {
    // Remove code fences and language specifiers
    let cleaned = code.replace(/^```[\w]*\s*/i, '').replace(/```\s*$/i, '').trim();
    
    // Also handle cases where there might be multiple code blocks
    cleaned = cleaned.replace(/```[\w]*\s*/gi, '').replace(/```/g, '');
    
    return cleaned;
}

/**
 * Enhanced diff calculation with detailed change analysis
 */
function calculateSmartCodeChanges(originalText: string, modifiedText: string, instruction: string, context: ContextInfo): VibeCodingResult {
    const originalLines = originalText.split('\n');
    const modifiedLines = modifiedText.split('\n');
    
    // Use the existing Diff library for detailed analysis
    const changes: CodeChange[] = [];
    const diff = Diff.diffLines(originalText, modifiedText);
    
    let lineNumber = 1;
    let totalAdded = 0;
    let totalRemoved = 0;
    
    // Analyze each diff chunk
    for (const part of diff) {
        const lines = part.value.split('\n');
        // Remove empty last line if it exists
        if (lines[lines.length - 1] === '') {
            lines.pop();
        }
        
        if (part.added) {
            totalAdded += lines.length;
            for (let i = 0; i < lines.length; i++) {
                changes.push({
                    line: lineNumber + i,
                    original: '',
                    modified: lines[i],
                    type: 'added'
                });
            }
        } else if (part.removed) {
            totalRemoved += lines.length;
            for (let i = 0; i < lines.length; i++) {
                changes.push({
                    line: lineNumber + i,
                    original: lines[i],
                    modified: '',
                    type: 'removed'
                });
            }
        } else {
            // Unchanged lines
            lineNumber += lines.length;
        }
    }
    
    // Analyze the type of change
    const changeType = analyzeChangeType(changes, totalAdded, totalRemoved, instruction);
    
    // Generate intelligent summary and description
    const summary = generateIntelligentSummary(changes, totalAdded, totalRemoved, instruction);
    const changeDescription = generateDetailedChangeDescription(changes, totalAdded, totalRemoved, instruction, changeType);
    const affectedFunctions = extractAffectedFunctions(changes, modifiedText);
    
    return {
        changes,
        summary,
        totalAdded,
        totalRemoved,
        modifiedText,
        originalText,
        changeDescription,
        affectedFunctions,
        changeType
    };
}

/**
 * Analyze the type of change made
 */
function analyzeChangeType(changes: CodeChange[], totalAdded: number, totalRemoved: number, instruction: string): 'full_rewrite' | 'partial_modification' | 'addition' | 'test_addition' {
    const addedCode = changes.filter(c => c.type === 'added').map(c => c.modified).join('\n');
    
    const hasTestClass = /class.*Test.*unittest\.TestCase/i.test(addedCode);
    const hasTestMethods = /def test_/i.test(addedCode);
    const isTestInstruction = /test|unit test|create test|add test|write test|테스트|단위 테스트|테스트 함수|테스트를 만들어|테스트 코드/i.test(instruction);
    
    if (hasTestClass && hasTestMethods && isTestInstruction) {
        return 'test_addition';
    } else if (totalRemoved > 10 && totalAdded > 10) {
        return 'full_rewrite';
    } else if (totalRemoved > 0 && totalAdded > 0) {
        return 'partial_modification';
    } else {
        return 'addition';
    }
}

/**
 * Generate an intelligent summary of what was changed
 */
function generateIntelligentSummary(changes: CodeChange[], totalAdded: number, totalRemoved: number, instruction: string): string {
    if (changes.length === 0) {
        return 'No changes were made to the code.';
    }
    
    const addedLines = changes.filter(c => c.type === 'added');
    const addedCode = addedLines.map(c => c.modified).join('\n');
    
    // Detect what was added
    const hasTestClass = /class.*Test.*unittest\.TestCase/i.test(addedCode);
    const hasTestMethods = /def test_/i.test(addedCode);
    const hasTypeHints = /:\s*(str|int|float|bool|List|Dict|Optional)/i.test(addedCode);
    const hasImports = /^(import|from).*$/m.test(addedCode);
    const hasDocstrings = /""".*"""/s.test(addedCode);
    const hasFunctions = /def\s+\w+\s*\(/i.test(addedCode);
    const hasClasses = /class\s+\w+/i.test(addedCode);
    
    let summary = '';
    
    if (hasTestClass && hasTestMethods) {
        const testCount = (addedCode.match(/def test_/g) || []).length;
        summary = `Added comprehensive test suite with ${testCount} test method${testCount > 1 ? 's' : ''}`;
    } else if (hasFunctions && !hasTestMethods) {
        const functionCount = (addedCode.match(/def\s+\w+\s*\(/g) || []).length;
        summary = `Added ${functionCount} new function${functionCount > 1 ? 's' : ''}`;
    } else if (hasClasses) {
        const classCount = (addedCode.match(/class\s+\w+/g) || []).length;
        summary = `Added ${classCount} new class${classCount > 1 ? 'es' : ''}`;
    } else if (totalAdded > 10 && totalRemoved > 10) {
        summary = `Major code refactoring completed`;
    } else if (totalAdded > 0 && totalRemoved > 0) {
        summary = `Code modified with improvements`;
    } else if (totalAdded > 0) {
        summary = `New code added`;
    } else if (totalRemoved > 0) {
        summary = `Code cleaned up`;
    } else {
        summary = `Code modified`;
    }
    
    // Add quality improvements
    const improvements = [];
    if (hasTypeHints) {
        improvements.push('type hints');
    }
    if (hasImports) {
        improvements.push('organized imports');
    }
    if (hasDocstrings) {
        improvements.push('documentation');
    }
    
    if (improvements.length > 0) {
        summary += ` (${improvements.join(', ')})`;
    }
    
    return summary;
}

/**
 * Generate detailed change description for audio announcement
 */
function generateDetailedChangeDescription(
    changes: CodeChange[], 
    totalAdded: number, 
    totalRemoved: number, 
    instruction: string, 
    changeType: 'full_rewrite' | 'partial_modification' | 'addition' | 'test_addition'
): string {
    const addedCode = changes.filter(c => c.type === 'added').map(c => c.modified).join('\n');
    
    let description = 'Code modified. ';
    
    switch (changeType) {
        case 'test_addition':
            const testCount = (addedCode.match(/def test_/g) || []).length;
            description += `Added comprehensive test suite with ${testCount} test methods. `;
            break;
        case 'full_rewrite':
            description += `Complete code rewrite with improvements. `;
            break;
        case 'partial_modification':
            description += `Modified existing code with enhancements. `;
            break;
        case 'addition':
            description += `Added new code. `;
            break;
    }
    
    // Add specific features detected
    const features = [];
    if (/def\s+\w+\s*\(/i.test(addedCode)) {
        const functionCount = (addedCode.match(/def\s+\w+\s*\(/g) || []).length;
        features.push(`${functionCount} function${functionCount > 1 ? 's' : ''}`);
    }
    if (/class\s+\w+/i.test(addedCode)) {
        const classCount = (addedCode.match(/class\s+\w+/g) || []).length;
        features.push(`${classCount} class${classCount > 1 ? 'es' : ''}`);
    }
    if (/:\s*(str|int|float|bool|List|Dict|Optional)/i.test(addedCode)) {
        features.push('type hints');
    }
    if (/""".*"""/s.test(addedCode)) {
        features.push('documentation');
    }
    
    if (features.length > 0) {
        description += `Added ${features.join(', ')}. `;
    }
    
    return description;
}

/**
 * Extract names of affected functions
 */
function extractAffectedFunctions(changes: CodeChange[], modifiedText: string): string[] {
    const functions: string[] = [];
    const addedCode = changes.filter(c => c.type === 'added').map(c => c.modified).join('\n');
    
    // Extract function names from added code
    const functionMatches = addedCode.match(/def\s+(\w+)\s*\(/g);
    if (functionMatches) {
        for (const match of functionMatches) {
            const nameMatch = match.match(/def\s+(\w+)\s*\(/);
            if (nameMatch && nameMatch[1]) {
                functions.push(nameMatch[1]);
            }
        }
    }
    
    // Extract class names from added code
    const classMatches = addedCode.match(/class\s+(\w+)/g);
    if (classMatches) {
        for (const match of classMatches) {
            const nameMatch = match.match(/class\s+(\w+)/);
            if (nameMatch && nameMatch[1]) {
                functions.push(nameMatch[1]);
            }
        }
    }
    
    return functions;
}

/**
 * Announce code changes with detailed audio description
 */
async function announceCodeChanges(result: VibeCodingResult) {
    const { changeDescription, totalAdded, totalRemoved, affectedFunctions, changeType } = result;
    
    try {
        let message = changeDescription;
        
        // Add function-specific information
        if (affectedFunctions.length > 0) {
            if (changeType === 'test_addition') {
                message += `Testing functions: ${affectedFunctions.join(', ')}. `;
        } else {
                message += `Modified functions: ${affectedFunctions.join(', ')}. `;
            }
        }
        
        // Add navigation hint
        message += 'Review the diff to apply or reject changes.';
        
        log(`[vibe_coding] Announcing changes: "${message}"`);
        
        // Use pure TTS without token processing for natural speech
        const chunks: TokenChunk[] = [{
            tokens: [message],
            category: undefined  // No category = pure TTS without earcons
        }];
        
        await speakTokenListWithTracking(chunks);
        
    } catch (error) {
        log(`[vibe_coding] Error announcing changes: ${error}`);
        // Fallback to basic announcement
        await speakTokenListWithTracking([{ 
            tokens: [`Code modified successfully`], 
            category: undefined 
        }]);
    }
}

/**
 * Show simple diff preview as fallback
 */
async function showSimpleDiffPreview(changeId: string, result: VibeCodingResult) {
    const { summary, totalAdded, totalRemoved } = result;
    
    // Speak the summary
    await speakTokenListWithTracking([{ 
        tokens: [summary], 
        category: undefined 
    }]);
    
    const action = await vscode.window.showInformationMessage(
        `${summary}`,
        'Apply Changes',
        'Reject Changes',
        'Show Details'
    );
    
    if (action === 'Apply Changes') {
        await applyPendingChange(changeId);
    } else if (action === 'Reject Changes') {
        await rejectPendingChange(changeId);
    } else if (action === 'Show Details') {
        await showChangeDetails(changeId);
    }
}

/**
 * Show detailed information about the change
 */
async function showChangeDetails(changeId: string) {
    const pendingChange = pendingChanges.get(changeId);
    if (!pendingChange) {
        vscode.window.showErrorMessage('Change not found');
        return;
    }
    
    const { result, instruction } = pendingChange;
    const { summary, totalAdded, totalRemoved, affectedFunctions, changeType } = result;
    
    let details = `**Instruction:** ${instruction}\n\n`;
    details += `**Change Type:** ${changeType.replace('_', ' ')}\n\n`;
    details += `**Summary:** ${summary}\n\n`;
    details += `**Statistics:**\n`;
    details += `- Added: ${totalAdded} lines\n`;
    details += `- Removed: ${totalRemoved} lines\n`;
    details += `- Net change: ${totalAdded - totalRemoved} lines\n\n`;
    
    if (affectedFunctions.length > 0) {
        details += `**Affected Functions/Classes:**\n`;
        details += affectedFunctions.map(f => `- ${f}`).join('\n');
        details += '\n\n';
    }
    
    details += `**Timestamp:** ${new Date(pendingChange.timestamp).toLocaleString()}`;
    
    // Show in a new document
    const doc = await vscode.workspace.openTextDocument({
        content: details,
        language: 'markdown'
    });
    
    await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside
    });
}

/**
 * Apply a pending change
 */
async function applyPendingChange(changeId: string) {
    const pendingChange = pendingChanges.get(changeId);
    if (!pendingChange) {
        vscode.window.showErrorMessage('Change not found');
        return;
    }
    
    const editor = await getActiveEditorWithRetry();
    if (!editor) {
        vscode.window.setStatusBarMessage('No active editor - please open a file and try again', 4000);
        log('[vibe_coding] No active editor found when applying changes');
        return;
    }
    
    try {
        // Continuous actions eliminated - no automatic text reading suppression needed
        log(`[vibe_coding] Applying changes without automatic text reading management`);
        
        // Apply the change by replacing the entire document content
        const { result } = pendingChange;
        const document = editor.document;
        const originalText = document.getText();
        
        await editor.edit(editBuilder => {
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(originalText.length)
            );
            editBuilder.replace(fullRange, result.modifiedText);
        });
        
        // Move cursor to the start of the first added code
        const firstAddedLinePosition = findFirstAddedLine(originalText, result.modifiedText);
        if (firstAddedLinePosition !== null) {
            const position = new vscode.Position(firstAddedLinePosition, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            log(`[vibe_coding] Cursor moved to first added line: ${firstAddedLinePosition + 1}`);
        }
        
        // Continuous actions eliminated - automatic text reading will NOT be resumed
        log(`[vibe_coding] Changes applied - automatic text reading remains suppressed per user request`);
        
        // Remove from pending changes
        pendingChanges.delete(changeId);
        currentChangeId = null;
        
        // Silent success - no audio announcement
        log(`[vibe_coding] Changes applied successfully: ${result.summary}`);
            
        log(`[vibe_coding] Successfully applied change ${changeId}`);
        
    } catch (error) {
        // Continuous actions eliminated - automatic reading will NOT be resumed even on error
        log(`[vibe_coding] Error applying change: ${error}`);
        vscode.window.showErrorMessage(`Failed to apply changes: ${error}`);
    }
}

/**
 * Find the first line where code was added by comparing original and modified text
 */
function findFirstAddedLine(originalText: string, modifiedText: string): number | null {
    const diff = Diff.diffLines(originalText, modifiedText);
    let currentLine = 0;
    
    for (const part of diff) {
        const lines = part.value.split('\n');
        if (lines[lines.length - 1] === '') lines.pop(); // Remove empty last line
        
        if (part.added) {
            // Found the first added section, return the line number
            return currentLine;
        } else if (!part.removed) {
            // Unchanged lines, advance the line counter
            currentLine += lines.length;
        }
        // For removed lines, we don't advance the line counter in the new text
    }
    
    return null; // No additions found
}

/**
 * Reject a pending change
 */
async function rejectPendingChange(changeId: string) {
    const pendingChange = pendingChanges.get(changeId);
    if (!pendingChange) {
        vscode.window.showErrorMessage('Change not found');
        return;
    }
    
    // Remove from pending changes
    pendingChanges.delete(changeId);
    currentChangeId = null;
    
    await speakGPT('Changes rejected');
    // Use status bar message instead of popup
    vscode.window.setStatusBarMessage('Changes rejected', 5000);
    
    log(`[vibe_coding] Rejected change ${changeId}`);
}

/**
 * Speak a comprehensive success message after applying changes
 */
async function speakVibeCodingSuccess(result: VibeCodingResult) {
    const { summary, totalAdded, totalRemoved, changeType, affectedFunctions } = result;
    
    try {
        let message = "Changes applied successfully. ";
        
        switch (changeType) {
            case 'test_addition':
                message += "Test suite added. ";
                break;
            case 'full_rewrite':
                message += "Code rewritten with improvements. ";
                break;
            case 'partial_modification':
                message += "Code modified successfully. ";
                break;
            case 'addition':
                message += "New code added. ";
                break;
        }
        
        // Focus on feature-based summary instead of line counts
        if (affectedFunctions.length > 0) {
            message += `Modified: ${affectedFunctions.slice(0, 3).join(', ')}`;
            if (affectedFunctions.length > 3) {
                message += ` and ${affectedFunctions.length - 3} more`;
            }
            message += '. ';
        }
        
        log(`[vibe_coding] Speaking success message: "${message}"`);
        
        // Use pure TTS without token processing for natural speech
        const chunks: TokenChunk[] = [{
            tokens: [message],
            category: undefined  // No category = pure TTS without earcons
        }];
        
        await speakTokenListWithTracking(chunks);
        
    } catch (error) {
        log(`[vibe_coding] Error speaking success message: ${error}`);
        await speakTokenListWithTracking([{ 
            tokens: [`Changes applied with ${totalAdded} additions and ${totalRemoved} removals`], 
            category: undefined 
        }]);
    }
}

/**
 * Create a temporary file for diff comparison
 */
async function createTempFile(content: string, suffix: string): Promise<vscode.Uri> {
    const editor = vscode.window.activeTextEditor;
    const fileExtension = editor ? path.extname(editor.document.fileName) : '.txt';
    
    const tempDir = os.tmpdir();
    const fileName = `lipcoder-${suffix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}${fileExtension}`;
    const tempFilePath = path.join(tempDir, fileName);
    
    // Ensure the temp directory exists
    if (!fs.existsSync(tempDir)) {
        await fs.promises.mkdir(tempDir, { recursive: true });
    }
    
    await fs.promises.writeFile(tempFilePath, content, 'utf8');
    
    log(`[vibe_coding] Created temp file: ${tempFilePath}`);
    return vscode.Uri.file(tempFilePath);
}

/**
 * Clean up temporary files
 */
async function cleanupTempFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
        try {
            await fs.promises.unlink(uri.fsPath);
            log(`[vibe_coding] Cleaned up temp file: ${uri.fsPath}`);
        } catch (error) {
            log(`[vibe_coding] Failed to cleanup temp file ${uri.fsPath}: ${error}`);
        }
    }
}
