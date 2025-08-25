import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { playWave, speakTokenList, TokenChunk } from '../audio';
import { stopAllAudio } from './stop_reading';
import { config } from '../config';
import { log } from '../utils';

// Current syntax error navigation state
let currentErrorIndex = 0;
let currentErrors: vscode.Diagnostic[] = [];
let currentUri: vscode.Uri | null = null;
let lastActiveEditor: vscode.TextEditor | null = null;

interface SyntaxError {
    message: string;
    line: number;
    character: number;
    severity: vscode.DiagnosticSeverity;
    source?: string;
    uri: vscode.Uri;
}

/**
 * Get all syntax errors from the current document
 */
function getSyntaxErrors(uri: vscode.Uri): SyntaxError[] {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    
    log(`[SyntaxErrors] Raw diagnostics count: ${diagnostics.length}`);
    diagnostics.forEach((d, i) => {
        log(`[SyntaxErrors] Diagnostic ${i}: severity=${d.severity}, source=${d.source}, message="${d.message}"`);
    });
    
    // Filter for syntax errors (errors and warnings, excluding hints and info)
    const syntaxErrors = diagnostics.filter(diagnostic => 
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning
    );
    
    // Convert to our format and sort by line number
    return syntaxErrors
        .map(diagnostic => ({
            message: diagnostic.message,
            line: diagnostic.range.start.line,
            character: diagnostic.range.start.character,
            severity: diagnostic.severity,
            source: diagnostic.source,
            uri
        }))
        .sort((a, b) => {
            if (a.line !== b.line) {
                return a.line - b.line;
            }
            return a.character - b.character;
        });
}

/**
 * Navigate to a specific syntax error location (without TTS)
 */
async function navigateToErrorLocation(error: SyntaxError): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== error.uri.toString()) {
        // Open the document if it's not the active one
        const document = await vscode.workspace.openTextDocument(error.uri);
        const newEditor = await vscode.window.showTextDocument(document);
        if (newEditor) {
            const position = new vscode.Position(error.line, error.character);
            newEditor.selection = new vscode.Selection(position, position);
            newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    } else {
        // Navigate within the current document
        const position = new vscode.Position(error.line, error.character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
    
    // Play error sound based on severity
    const severitySound = error.severity === vscode.DiagnosticSeverity.Error ? 'excitation.pcm' : 'question.pcm';
    const soundPath = path.join(config.specialPath(), severitySound);
    await playWave(soundPath, { isEarcon: true, immediate: true });
}

/**
 * Navigate to a specific syntax error (with TTS)
 */
async function navigateToError(error: SyntaxError, index: number, total: number): Promise<void> {
    await navigateToErrorLocation(error);
    
    // Speak the error information - simple format: "line N, error message"
    const simpleText = `line ${error.line + 1}, ${error.message}`;
    
    log(`[SyntaxErrors] Speaking: "${simpleText}"`);
    speakTokenList([{ tokens: [simpleText], category: undefined }]);
}

/**
 * Get syntax errors and initialize navigation
 */
async function initializeSyntaxErrorNavigation(editorArg?: vscode.TextEditor): Promise<boolean> {
    // Try multiple fallbacks to find an editor
    let editor = editorArg || vscode.window.activeTextEditor || lastActiveEditor;
    
    // If still no editor, try to get any visible text editor
    if (!editor && vscode.window.visibleTextEditors.length > 0) {
        editor = vscode.window.visibleTextEditors[0];
    }
    
    log(`[SyntaxErrors] Editor detection: editorArg=${!!editorArg}, activeTextEditor=${!!vscode.window.activeTextEditor}, lastActiveEditor=${!!lastActiveEditor}, visibleEditors=${vscode.window.visibleTextEditors.length}, finalEditor=${!!editor}`);
    
    if (!editor) {
        log('[SyntaxErrors] No editor found after all fallbacks');
        vscode.window.setStatusBarMessage('No active editor - please open a code file first', 3000);
        return false;
    }
    
    // Remember this editor for future use
    lastActiveEditor = editor;
    
    const uri = editor.document.uri;
    const errors = getSyntaxErrors(uri);
    
    log(`[SyntaxErrors] Found ${errors.length} syntax errors in ${uri.fsPath}`);
    
    if (errors.length === 0) {
        speakTokenList([{ tokens: ['No syntax errors found in this file'], category: undefined }]);
        return false;
    }
    
    currentErrors = errors.map(error => ({
        message: error.message,
        range: new vscode.Range(error.line, error.character, error.line, error.character),
        severity: error.severity,
        source: error.source
    }));
    currentUri = uri;
    currentErrorIndex = 0;
    
    return true;
}

/**
 * Show syntax error list and allow navigation
 */
async function showSyntaxErrorList(editorArg?: vscode.TextEditor): Promise<void> {
    // Try multiple fallbacks to find an editor
    let editor = editorArg || vscode.window.activeTextEditor || lastActiveEditor;
    
    // If still no editor, try to get any visible text editor
    if (!editor && vscode.window.visibleTextEditors.length > 0) {
        editor = vscode.window.visibleTextEditors[0];
    }
    
    if (!editor) {
        vscode.window.setStatusBarMessage('No active editor - please open a code file first', 3000);
        return;
    }
    
    // Remember this editor for future use
    lastActiveEditor = editor;
    
    const uri = editor.document.uri;
    const errors = getSyntaxErrors(uri);
    
    if (errors.length === 0) {
        speakTokenList([{ tokens: ['No syntax errors found in this file'], category: undefined }]);
        return;
    }
    
    // Create QuickPick for error navigation
    const quickPick = vscode.window.createQuickPick<{
        label: string;
        description: string;
        detail: string;
        error: SyntaxError;
        index: number;
    }>();
    
    quickPick.items = errors.map((error, index) => {
        // Use clean labels without emojis - put visual indicators in description
        const severityText = error.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
        const severityIcon = error.severity === vscode.DiagnosticSeverity.Error ? '❌' : '⚠️';
        const sourceText = error.source ? ` (${error.source})` : '';
        
        return {
            label: `Line ${error.line + 1}:${error.character + 1}`,
            description: `${severityIcon} ${severityText}${sourceText}`,
            detail: error.message,
            error,
            index
        };
    });
    
    quickPick.placeholder = `Select a syntax error (${errors.length} found)`;
    quickPick.title = 'Syntax Errors';
    
    // Store original selection to restore if cancelled
    const originalSelection = editor.selection;
    
    // Navigate to error on selection change
    quickPick.onDidChangeActive(async (activeItems) => {
        if (activeItems.length > 0) {
            // Stop all audio (same pattern as other QuickPick features)
            stopAllAudio();
            
            const item = activeItems[0];
            log(`[SyntaxErrors] Navigating to error ${item.index + 1} of ${errors.length}`);
            
            // Navigate to the error location
            await navigateToErrorLocation(item.error);
            
            // Speak clean TTS (same pattern as breadcrumb/function_list)
            const cleanText = `line ${item.error.line + 1}, ${item.error.message}`;
            log(`[SyntaxErrors] Speaking: "${cleanText}"`);
            speakTokenList([{ tokens: [cleanText], category: undefined }]);
        }
    });
    
    // Handle selection
    quickPick.onDidAccept(() => {
        const selectedItem = quickPick.activeItems[0];
        if (selectedItem) {
            currentErrors = errors.map(error => ({
                message: error.message,
                range: new vscode.Range(error.line, error.character, error.line, error.character),
                severity: error.severity,
                source: error.source
            }));
            currentUri = uri;
            currentErrorIndex = selectedItem.index;
        }
        quickPick.hide();
    });
    
    // Restore original position if cancelled
    quickPick.onDidHide(() => {
        if (!quickPick.selectedItems.length) {
            editor.selection = originalSelection;
            editor.revealRange(new vscode.Range(originalSelection.active, originalSelection.active));
        }
    });
    
    quickPick.show();
}

/**
 * Navigate to next syntax error
 */
async function nextSyntaxError(editorArg?: vscode.TextEditor): Promise<void> {
    if (!await initializeSyntaxErrorNavigation(editorArg)) {
        return;
    }
    
    if (currentErrors.length === 0) {
        return;
    }
    
    currentErrorIndex = (currentErrorIndex + 1) % currentErrors.length;
    const error = currentErrors[currentErrorIndex];
    const syntaxError: SyntaxError = {
        message: error.message,
        line: error.range.start.line,
        character: error.range.start.character,
        severity: error.severity,
        source: error.source,
        uri: currentUri!
    };
    
    await navigateToError(syntaxError, currentErrorIndex, currentErrors.length);
}

/**
 * Navigate to previous syntax error
 */
async function previousSyntaxError(editorArg?: vscode.TextEditor): Promise<void> {
    if (!await initializeSyntaxErrorNavigation(editorArg)) {
        return;
    }
    
    if (currentErrors.length === 0) {
        return;
    }
    
    currentErrorIndex = currentErrorIndex === 0 ? currentErrors.length - 1 : currentErrorIndex - 1;
    const error = currentErrors[currentErrorIndex];
    const syntaxError: SyntaxError = {
        message: error.message,
        line: error.range.start.line,
        character: error.range.start.character,
        severity: error.severity,
        source: error.source,
        uri: currentUri!
    };
    
    await navigateToError(syntaxError, currentErrorIndex, currentErrors.length);
}

/**
 * Navigate to first syntax error
 */
async function firstSyntaxError(editorArg?: vscode.TextEditor): Promise<void> {
    if (!await initializeSyntaxErrorNavigation(editorArg)) {
        return;
    }
    
    if (currentErrors.length === 0) {
        return;
    }
    
    currentErrorIndex = 0;
    const error = currentErrors[currentErrorIndex];
    const syntaxError: SyntaxError = {
        message: error.message,
        line: error.range.start.line,
        character: error.range.start.character,
        severity: error.severity,
        source: error.source,
        uri: currentUri!
    };
    
    await navigateToError(syntaxError, currentErrorIndex, currentErrors.length);
}

/**
 * Register all syntax error navigation commands
 */
export function registerSyntaxErrors(context: ExtensionContext) {
    // Track active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                lastActiveEditor = editor;
            }
        })
    );
    
    // Initialize with current active editor if available
    if (vscode.window.activeTextEditor) {
        lastActiveEditor = vscode.window.activeTextEditor;
    }
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.syntaxErrorList', async (editorArg?: vscode.TextEditor) => {
            log('[SyntaxErrors] syntaxErrorList command called');
            stopAllAudio();
            await showSyntaxErrorList(editorArg);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.nextSyntaxError', async (editorArg?: vscode.TextEditor) => {
            stopAllAudio();
            await nextSyntaxError(editorArg);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.previousSyntaxError', async (editorArg?: vscode.TextEditor) => {
            stopAllAudio();
            await previousSyntaxError(editorArg);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.firstSyntaxError', async (editorArg?: vscode.TextEditor) => {
            stopAllAudio();
            await firstSyntaxError(editorArg);
        })
    );
    
    // Listen for diagnostic changes to update current errors
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
            if (currentUri && e.uris.some(uri => uri.toString() === currentUri!.toString())) {
                // Reset navigation state when diagnostics change
                currentErrors = [];
                currentErrorIndex = 0;
                log('[SyntaxErrors] Diagnostics changed, resetting navigation state');
            }
        })
    );
    
    log('[SyntaxErrors] Syntax error navigation commands registered');
}
