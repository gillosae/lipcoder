import * as vscode from 'vscode';
import * as path from 'path';
import { playEarcon } from '../earcon';
import { log } from '../utils';

let clipboardContent = '';
let isMonitoring = false;
let lastPasteTime = 0;
let documentChangeListener: vscode.Disposable | null = null;

/**
 * Play copy/cut audio feedback
 */
async function playCopySound(): Promise<void> {
    try {
        log('[ClipboardAudio] Playing copy sound');
        await playEarcon('copy', 0); // This will now find copy.pcm in the alert folder
    } catch (error) {
        log(`[ClipboardAudio] Error playing copy sound: ${error}`);
    }
}

/**
 * Play paste audio feedback
 */
async function playPasteSound(): Promise<void> {
    try {
        log('[ClipboardAudio] Playing paste sound');
        await playEarcon('paste', 0); // This will now find paste.pcm in the alert folder
    } catch (error) {
        log(`[ClipboardAudio] Error playing paste sound: ${error}`);
    }
}

/**
 * Monitor clipboard changes to detect copy/cut operations
 */
async function monitorClipboard(): Promise<void> {
    if (!isMonitoring) {
        return;
    }
    
    try {
        const currentContent = await vscode.env.clipboard.readText();
        
        // If clipboard content changed, it means copy/cut occurred
        if (currentContent !== clipboardContent && currentContent.length > 0) {
            log(`[ClipboardAudio] Clipboard changed from "${clipboardContent}" to "${currentContent}"`);
            clipboardContent = currentContent;
            log(`[ClipboardAudio] Playing copy sound`);
            await playCopySound();
        } else if (currentContent !== clipboardContent) {
            // Update clipboard content even if it's empty (for accurate paste detection)
            clipboardContent = currentContent;
            log(`[ClipboardAudio] Clipboard content updated to: "${currentContent}"`);
        }
    } catch (error) {
        log(`[ClipboardAudio] Error monitoring clipboard: ${error}`);
    }
    
    // Continue monitoring
    setTimeout(monitorClipboard, 200); // Check every 200ms
}

/**
 * Handle Korean cut command (잘라내기)
 */
async function handleKoreanCutCommand(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.clipboardCutAction');
    await playCopySound(); // Use same sound for cut as copy
}

/**
 * Detect paste operations by monitoring document changes
 */
function detectPasteOperation(event: vscode.TextDocumentChangeEvent): void {
    // Only check if we have clipboard content to compare against
    if (!clipboardContent || clipboardContent.length === 0) {
        log('[ClipboardAudio] No clipboard content to compare against');
        return;
    }
    
    // Check if any of the changes match clipboard content (indicating a paste)
    for (const change of event.contentChanges) {
        log(`[ClipboardAudio] Document change detected: "${change.text}" (length: ${change.text.length})`);
        log(`[ClipboardAudio] Current clipboard: "${clipboardContent}" (length: ${clipboardContent.length})`);
        
        if (change.text === clipboardContent) {
            const now = Date.now();
            // Debounce to avoid multiple paste sounds for the same operation
            if (now - lastPasteTime > 500) {
                lastPasteTime = now;
                log('[ClipboardAudio] Paste operation detected, playing paste sound');
                playPasteSound();
            } else {
                log('[ClipboardAudio] Paste detected but debounced (too recent)');
            }
            break;
        }
    }
}

/**
 * Start clipboard monitoring
 */
async function startClipboardMonitoring(): Promise<void> {
    if (isMonitoring) {
        return;
    }
    
    isMonitoring = true;
    log('[ClipboardAudio] Starting clipboard monitoring');
    
    // Initialize clipboard content
    try {
        clipboardContent = await vscode.env.clipboard.readText();
    } catch (error) {
        log(`[ClipboardAudio] Error initializing clipboard content: ${error}`);
        clipboardContent = '';
    }
    
    // Start monitoring clipboard changes (for copy/cut detection)
    monitorClipboard();
    
    // Monitor document changes (for paste detection)
    documentChangeListener = vscode.workspace.onDidChangeTextDocument(detectPasteOperation);
    log('[ClipboardAudio] Document change listener registered for paste detection');
}

/**
 * Stop clipboard monitoring
 */
function stopClipboardMonitoring(): void {
    isMonitoring = false;
    
    // Clean up document change listener
    if (documentChangeListener) {
        documentChangeListener.dispose();
        documentChangeListener = null;
        log('[ClipboardAudio] Document change listener disposed');
    }
    
    log('[ClipboardAudio] Stopped clipboard monitoring');
}

/**
 * Handle copy command with audio feedback
 */
async function handleCopyCommand(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    await playCopySound();
}

/**
 * Handle cut command with audio feedback
 */
async function handleCutCommand(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.clipboardCutAction');
    await playCopySound(); // Use same sound for cut as copy
}

/**
 * Handle paste command with audio feedback
 */
async function handlePasteCommand(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await playPasteSound();
}

/**
 * Test copy sound
 */
async function testCopySound(): Promise<void> {
    log('[ClipboardAudio] Testing copy sound');
    await playCopySound();
}

/**
 * Test paste sound
 */
async function testPasteSound(): Promise<void> {
    log('[ClipboardAudio] Testing paste sound');
    await playPasteSound();
}

/**
 * Register clipboard audio feedback commands
 */
export function registerClipboardAudio(context: vscode.ExtensionContext): void {
    log('[ClipboardAudio] Registering clipboard audio feedback');
    
    // Start clipboard monitoring
    startClipboardMonitoring();
    
    // Register custom clipboard commands with audio feedback
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.copy', handleCopyCommand),
        vscode.commands.registerCommand('lipcoder.cut', handleCutCommand),
        vscode.commands.registerCommand('lipcoder.잘라내기', handleKoreanCutCommand), // Korean cut command
        vscode.commands.registerCommand('lipcoder.paste', handlePasteCommand),
        // Test commands
        vscode.commands.registerCommand('lipcoder.testCopySound', testCopySound),
        vscode.commands.registerCommand('lipcoder.testPasteSound', testPasteSound)
    );
    
    // Clean up on extension deactivation
    context.subscriptions.push({
        dispose: stopClipboardMonitoring
    });
    
    log('[ClipboardAudio] Clipboard audio feedback registered successfully');
}
