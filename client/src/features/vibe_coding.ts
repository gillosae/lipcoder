import * as vscode from 'vscode';
import { speakTokenList, TokenChunk, startThinkingAudio, stopThinkingAudio, playThinkingFinished, stopPlayback } from '../audio';
import { suppressAutomaticTextReading, resumeAutomaticTextReading } from './nav_editor';
import { stopAllAudio } from './stop_reading';
import { log } from '../utils';
import { logVibeCoding, logFeatureUsage } from '../activity_logger';
import * as Diff from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

// Track if vibe coding TTS is currently active
let vibeCodingTTSActive = false;

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
        await speakTokenList(chunks);
    } finally {
        setVibeCodingTTSActive(false);
    }
}

/**
 * Get active editor with retry logic to handle timing issues
 */
async function getActiveEditorWithRetry(maxRetries: number = 3, delayMs: number = 100): Promise<vscode.TextEditor | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log(`[vibe_coding] Attempting to get active editor (attempt ${attempt}/${maxRetries})`);
        
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            // Validate that this is a proper file editor
            if (editor.document.uri.scheme === 'file') {
                log(`[vibe_coding] Found valid file editor: ${editor.document.fileName}`);
                return editor;
            } else {
                log(`[vibe_coding] Found editor but not a file (scheme: ${editor.document.uri.scheme})`);
            }
        } else {
            log(`[vibe_coding] No active editor found on attempt ${attempt}`);
        }
        
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
    return null;
}

export async function activateVibeCoding(prefilledInstruction?: string) {
    log('[vibe_coding] ===== VIBE CODING ACTIVATED =====');
    logVibeCoding('vibe_coding_activated', prefilledInstruction);
    
    // Enhanced editor detection with retry logic
    let editor = await getActiveEditorWithRetry();
    if (!editor) {
        log('[vibe_coding] No active editor found after retries');
        logVibeCoding('vibe_coding_error', 'No active editor found');
        await speakTokenListWithTracking([{ tokens: ['No active editor found. Please open a file and try again.'], category: undefined }]);
        vscode.window.showErrorMessage('No active editor found. Please open a file and try again.');
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
        await speakTokenListWithTracking([{ tokens: ['No instruction provided'], category: undefined }]);
        return;
    }

    // Silent processing - no audio feedback
    log('[vibe_coding] Processing vibe coding request silently');
    
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
        
        // Show diff and handle user decision
        await showSmartDiffPreview(changeId, result);
        
        log(`[vibe_coding] Diff preview completed`);
    } catch (error) {
        log(`[vibe_coding] Error: ${error}`);
        log(`[vibe_coding] Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
        logVibeCoding('vibe_coding_error', instruction, editor.document.fileName, { error: String(error) });
        await speakTokenListWithTracking([{ tokens: ['Error processing vibe coding request'], category: undefined }]);
        vscode.window.showErrorMessage(`Vibe Coding Error: ${error}`);
    }
}

// Test function for debugging
export async function testVibeCoding() {
    log('[vibe_coding] ===== TEST VIBE CODING =====');
    await speakTokenListWithTracking([{ tokens: ['Testing vibe coding'], category: undefined }]);
    vscode.window.showInformationMessage('Vibe Coding Test - Check console for logs');
    
    // Test with a sample instruction
    await activateVibeCoding('create a simple test function');
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
        '변경사항 적용'
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
        '이전으로'
    ];
    
    // Check for apply patterns
    for (const pattern of applyPatterns) {
        if (text === pattern || text.includes(pattern)) {
            log(`[vibe_coding] Voice command matched apply pattern: "${pattern}"`);
            await speakTokenListWithTracking([{ tokens: ['Applying changes via voice command'], category: undefined }]);
            
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
            await speakTokenListWithTracking([{ tokens: ['Rejecting changes via voice command'], category: undefined }]);
            
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
    
    // Add test command for debugging
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testVibeCoding', testVibeCoding)
    );
    
    // Add voice command handler for vibe coding
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.handleVibeCodingVoiceCommand', handleVibeCodingVoiceCommand)
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
 * Enhanced smart code modification that handles both full and partial code outputs
 */
async function generateSmartCodeModification(originalText: string, instruction: string, context: ContextInfo): Promise<string> {
    try {
        const { callLLMForCompletion } = await import('../llm.js');
        
        // Analyze the instruction to determine the best approach (English and Korean)
        const isTestRequest = /test|unit test|create test|add test|write test|테스트|단위 테스트|테스트 함수|테스트를 만들어|테스트 코드/i.test(instruction);
        const isFunctionRequest = /function|method|def |create function|add function|함수|메서드|함수를 만들어|함수 생성|새 함수/i.test(instruction);
        const isClassRequest = /class|create class|add class|클래스|클래스를 만들어|클래스 생성|새 클래스/i.test(instruction);
        const isFullRewrite = /rewrite|refactor|restructure|reorganize|리팩토링|리팩터링|재구성|다시 작성|코드 개선/i.test(instruction);
        
        // Enhanced system prompt for better code generation with Korean language support
        const systemPrompt = `You are an expert coding assistant that generates high-quality code modifications. You understand instructions in both English and Korean.

IMPORTANT: Always return the COMPLETE modified file, not just snippets or diffs.

CONTEXT ANALYSIS:
- Current cursor: Line ${context.cursorPosition.line + 1}
- In function: ${context.focusedFunction ? 'Yes' : 'No'}
- Selected code: ${context.selectedCode ? 'Yes' : 'No'}
- File size: ${context.isLargeFile ? 'Large' : 'Normal'}

LANGUAGE SUPPORT:
- You understand Korean instructions like "코드의 신택스 에러를 고쳐줘" (fix syntax errors in the code)
- Korean coding terms: 함수 (function), 변수 (variable), 클래스 (class), 에러 (error), 테스트 (test)
- Respond to Korean instructions with the same quality as English instructions

RULES:
1. Return the complete file with all modifications applied
2. Maintain proper code structure and formatting
3. Include all necessary imports
4. Preserve existing functionality while adding requested changes
5. Do not use markdown code fences in your response
6. Handle both English and Korean instructions with equal proficiency`;

        // Always request complete file to avoid merging issues
        const prompt = `Original Code:
${originalText}

Instruction: ${instruction}

Analyze the code and instruction, then return the complete modified file with all improvements.
Make sure to include all existing code plus the requested changes.`;
        
        log(`[vibe_coding] Smart modification request: ${instruction}`);
        
        // Start thinking audio during LLM processing
        await startThinkingAudio();
        
        try {
            const modifiedCode = await callLLMForCompletion(systemPrompt, prompt, 4000, 0.1);
            
            // Play thinking finished sound and stop thinking audio
            await playThinkingFinished();
            
            // Clean up the response
            const cleanedCode = stripCodeFences(modifiedCode);
            
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

async function showSmartDiffPreview(changeId: string, result: VibeCodingResult): Promise<void> {
    const { changes, summary, totalAdded, totalRemoved, modifiedText, originalText, changeDescription } = result;
    
    if (changes.length === 0) {
        // Silent - log instead of speaking
        log('[vibe_coding] No changes were made');
        vscode.window.showInformationMessage('No changes were made to the code.');
        return;
    }
    
    try {
        log(`[vibe_coding] Creating diff preview for change ${changeId}`);
        
        // Validate that we have different content
        if (originalText === modifiedText) {
            log(`[vibe_coding] No changes detected - original and modified text are identical`);
            // Silent - log instead of speaking
            log('[vibe_coding] No changes were made');
            vscode.window.showInformationMessage('No changes were made to the code.');
            return;
        }
        
        // Show changes briefly and auto-accept
        await showChangesAndAutoAccept(changeId, result);
        
    } catch (error) {
        log(`[vibe_coding] Error showing diff preview: ${error}`);
        log(`[vibe_coding] Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
        // Fallback to auto-apply
        await applyPendingChange(changeId);
    }
}

/**
 * Show changes briefly and automatically accept them
 */
async function showChangesAndAutoAccept(changeId: string, result: VibeCodingResult): Promise<void> {
    const { changes, summary, totalAdded, totalRemoved, modifiedText, originalText, changeDescription } = result;
    
    try {
        log(`[vibe_coding] Showing changes and auto-accepting for change ${changeId}`);
        
        // Show a brief notification about the changes
        vscode.window.showInformationMessage(
            `${summary} - Changes: +${totalAdded} -${totalRemoved} lines (Auto-applying...)`,
            { modal: false }
        );
        
        // Brief delay to show the notification
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Auto-apply the changes
        await applyPendingChange(changeId);
        
        // Show success notification
        vscode.window.showInformationMessage(
            `✅ Changes applied successfully: ${summary}`,
            { modal: false }
        );
        
        log(`[vibe_coding] Auto-accepted change ${changeId}: ${summary}`);
        
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
let currentDiffChangeId: string | null = null;
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
        
        // Create decoration types for different change types
        const addedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
        
        const removedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            textDecoration: 'line-through'
        });
        
        const modifiedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.modifiedTextBackground'),
            border: '0 0 0 3px solid',
            borderColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
        
        currentDiffDecorations = [addedDecoration, removedDecoration, modifiedDecoration];
        
        // Apply decorations based on changes
        const addedRanges: vscode.Range[] = [];
        const removedRanges: vscode.Range[] = [];
        const modifiedRanges: vscode.Range[] = [];
        
        // Calculate line-based changes for decoration
        const originalLines = originalText.split('\n');
        const modifiedLines = modifiedText.split('\n');
        const diff = Diff.diffLines(originalText, modifiedText);
        
        let currentLine = 0;
        
        for (const part of diff) {
            const lines = part.value.split('\n');
            if (lines[lines.length - 1] === '') {
                lines.pop(); // Remove empty last line
            }
            
            if (part.added) {
                for (let i = 0; i < lines.length; i++) {
                    const lineNumber = currentLine + i;
                    if (lineNumber < editor.document.lineCount) {
                        const range = new vscode.Range(lineNumber, 0, lineNumber, editor.document.lineAt(lineNumber).text.length);
                        addedRanges.push(range);
                    }
                }
            } else if (part.removed) {
                for (let i = 0; i < lines.length; i++) {
                    const lineNumber = currentLine + i;
                    if (lineNumber < editor.document.lineCount) {
                        const range = new vscode.Range(lineNumber, 0, lineNumber, editor.document.lineAt(lineNumber).text.length);
                        removedRanges.push(range);
                    }
                }
            } else {
                // Unchanged lines
                currentLine += lines.length;
            }
        }
        
        // Apply decorations
        editor.setDecorations(addedDecoration, addedRanges);
        editor.setDecorations(removedDecoration, removedRanges);
        editor.setDecorations(modifiedDecoration, modifiedRanges);
        
        log(`[vibe_coding] Applied ${addedRanges.length} added, ${removedRanges.length} removed, ${modifiedRanges.length} modified decorations`);
        
        // Silent - no audio announcement of changes
        log(`[vibe_coding] Changes ready: ${result.summary}`);
        
        // Show action buttons with enhanced options
        const action = await vscode.window.showInformationMessage(
            `${summary}\n\n📊 Changes: +${totalAdded} -${totalRemoved} lines\n\n💡 Review the highlighted changes and choose an action:`,
            { modal: false }, // Non-modal so user can see the editor
            'Apply Changes',
            'Reject Changes',
            'Show Details'
        );
        
        if (action === 'Apply Changes') {
            await applyPendingChange(changeId);
            clearInlineDiffDecorations();
        } else if (action === 'Reject Changes') {
            await rejectPendingChange(changeId);
            clearInlineDiffDecorations();
        } else if (action === 'Show Details') {
            await showChangeDetails(changeId);
            // Keep decorations and show the action dialog again
            await showInlineDiffActionDialog(changeId, result);
        } else {
            // User closed dialog, keep change pending with decorations
            await speakTokenListWithTracking([{ tokens: ['Change pending review. Use command palette to apply or reject.'], category: undefined }]);
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
    
    const action = await vscode.window.showInformationMessage(
        `${summary}\n\n📊 Changes: +${totalAdded} -${totalRemoved} lines\n\n💡 Choose an action:`,
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
                await speakTokenListWithTracking([{ tokens: ['Applying changes'], category: undefined }]);
                await applyPendingChange(currentChangeId);
                clearInlineDiffDecorations();
            } else if (currentDiffChangeId) {
                await speakTokenListWithTracking([{ tokens: ['Applying changes'], category: undefined }]);
                await applyPendingChange(currentDiffChangeId);
                clearInlineDiffDecorations();
    } else {
                await speakTokenListWithTracking([{ tokens: ['No pending changes to apply'], category: undefined }]);
                vscode.window.showInformationMessage('No pending changes to apply');
            }
        })
    );
    
    // Reject current pending change
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.rejectCurrentChange', async () => {
            if (currentChangeId) {
                await speakTokenListWithTracking([{ tokens: ['Rejecting changes'], category: undefined }]);
                await rejectPendingChange(currentChangeId);
                clearInlineDiffDecorations();
            } else if (currentDiffChangeId) {
                await speakTokenListWithTracking([{ tokens: ['Rejecting changes'], category: undefined }]);
                await rejectPendingChange(currentDiffChangeId);
                clearInlineDiffDecorations();
            } else {
                await speakTokenListWithTracking([{ tokens: ['No pending changes to reject'], category: undefined }]);
                vscode.window.showInformationMessage('No pending changes to reject');
            }
        })
    );
    
    // Show details of current pending change
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showCurrentChangeDetails', async () => {
            if (currentChangeId) {
                await showChangeDetails(currentChangeId);
            } else {
                vscode.window.showInformationMessage('No pending changes');
            }
        })
    );
    
    // List all pending changes
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.listPendingChanges', async () => {
            if (pendingChanges.size === 0) {
                vscode.window.showInformationMessage('No pending changes');
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
                }
            }
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
        summary = `Major code refactoring with ${totalAdded} additions and ${totalRemoved} removals`;
    } else if (totalAdded > 0 && totalRemoved > 0) {
        summary = `Modified code with ${totalAdded} additions and ${totalRemoved} removals`;
    } else if (totalAdded > 0) {
        summary = `Added ${totalAdded} lines of code`;
    } else if (totalRemoved > 0) {
        summary = `Removed ${totalRemoved} lines of code`;
    } else {
        summary = `Modified ${changes.length} locations in the code`;
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
            description += `Complete code rewrite with ${totalAdded} additions and ${totalRemoved} removals. `;
            break;
        case 'partial_modification':
            description += `Modified existing code with ${totalAdded} additions and ${totalRemoved} removals. `;
            break;
        case 'addition':
            description += `Added ${totalAdded} new lines of code. `;
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
            tokens: [`Code modified with ${totalAdded} additions and ${totalRemoved} removals`], 
            category: undefined 
        }]);
    }
}

/**
 * Show simple diff preview as fallback
 */
async function showSimpleDiffPreview(changeId: string, result: VibeCodingResult) {
    const { summary, totalAdded, totalRemoved } = result;
    
    const action = await vscode.window.showInformationMessage(
        `${summary}\n\nChanges: +${totalAdded} -${totalRemoved} lines`,
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
        vscode.window.showErrorMessage('No active editor found. Please open a file and try again.');
        log('[vibe_coding] No active editor found when applying changes');
        return;
    }
    
    try {
        // Suppress automatic text reading during vibe coding changes
        suppressAutomaticTextReading();
        
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
        
        // Resume automatic text reading after a short delay
        setTimeout(() => {
            resumeAutomaticTextReading();
        }, 500); // 500ms delay to ensure all text changes are processed
        
        // Remove from pending changes
        pendingChanges.delete(changeId);
        currentChangeId = null;
        
        // Silent success - no audio announcement
        log(`[vibe_coding] Changes applied successfully: ${result.summary}`);
            
        log(`[vibe_coding] Successfully applied change ${changeId}`);
        
    } catch (error) {
        // Make sure to resume automatic reading even if there's an error
        resumeAutomaticTextReading();
        log(`[vibe_coding] Error applying change: ${error}`);
        vscode.window.showErrorMessage(`Failed to apply changes: ${error}`);
    }
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
    
    await speakTokenListWithTracking([{ tokens: ['Changes rejected'], category: undefined }]);
    vscode.window.showInformationMessage('Changes rejected');
    
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
        
        message += `${totalAdded} lines added, ${totalRemoved} lines removed. `;
        
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
