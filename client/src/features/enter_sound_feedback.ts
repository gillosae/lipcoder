import * as vscode from 'vscode';
import { log } from '../utils';
import { getLineSeverity, updateLineSeverity } from './line_severity';
import { spawn } from 'child_process';
import * as path from 'path';

/**
 * Enter Sound Feedback Feature
 * Plays different sounds based on syntax errors when Enter is pressed
 */

let enterSoundEnabled = true;

/**
 * Handle text document change events to detect Enter key presses
 */
function handleTextDocumentChange(event: vscode.TextDocumentChangeEvent) {
    if (!enterSoundEnabled) {
        return;
    }

    // Check if this is an Enter key press (newline insertion)
    for (const change of event.contentChanges) {
        if (change.text === '\n' || change.text === '\r\n') {
            // This is likely an Enter key press
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== event.document) {
                continue;
            }

            // Get the line where Enter was pressed (before the newline)
            const lineNumber = change.range.start.line;
            const uri = event.document.uri.toString();
            
            // Check for syntax errors on the current line
            const severity = getLineSeverity(uri, lineNumber);
            
            // More detailed logging for debugging
            log(`[EnterSoundFeedback] Enter pressed on line ${lineNumber}`);
            log(`[EnterSoundFeedback] URI: ${uri}`);
            log(`[EnterSoundFeedback] Line severity: ${severity}`);
            log(`[EnterSoundFeedback] Severity types - Error: ${vscode.DiagnosticSeverity.Error}, Warning: ${vscode.DiagnosticSeverity.Warning}, Info: ${vscode.DiagnosticSeverity.Information}, Hint: ${vscode.DiagnosticSeverity.Hint}`);
            
            // Check if there's an error (Error = 0, Warning = 1, Information = 2, Hint = 3)
            const hasError = severity !== null && severity === vscode.DiagnosticSeverity.Error;
            
            // Also check for warnings as potential errors
            const hasWarningOrError = severity !== null && (severity === vscode.DiagnosticSeverity.Error || severity === vscode.DiagnosticSeverity.Warning);
            
            log(`[EnterSoundFeedback] Has error: ${hasError}, Has warning or error: ${hasWarningOrError}`);
            
            // Play appropriate sound based on syntax error presence
            // Use warning or error for now to test if it works
            playEnterSound(hasWarningOrError);
            
            log(`[EnterSoundFeedback] Playing sound for ${hasWarningOrError ? 'error/warning' : 'normal'} case`);
            break; // Only handle the first Enter in the change event
        }
    }
}

/**
 * Play PCM file directly using sox
 */
async function playPCMFile(fileName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            // Get the extension context to find the audio directory
            const context = (global as any).lipcoderContext as vscode.ExtensionContext;
            if (!context) {
                throw new Error('Extension context not available');
            }
            
            // Build path to the PCM file in client/audio/earcon/
            const audioPath = path.join(context.extensionPath, 'client', 'audio', 'earcon', fileName);
            
            log(`[EnterSoundFeedback] Playing PCM file: ${audioPath}`);
            
            // Play PCM directly with sox with volume boost, faster tempo, and higher pitch
            const process = spawn('sox', [
                '-t', 'raw',           // Input type: raw PCM
                '-r', '44100',         // Sample rate: 44.1kHz
                '-b', '16',            // Bit depth: 16-bit
                '-c', '1',             // Channels: mono
                '-e', 'signed-integer', // Encoding: signed PCM
                audioPath,             // Input file
                '-d',                  // Output to default audio device
                'gain', '5',           // Reduce volume slightly to 5dB boost
                'tempo', '1.5',        // 1.5x faster playback
                'pitch', '300'         // Increase pitch by 300 cents (3 semitones)
            ]);
            
            let resolved = false;
            
            process.on('close', (code: number | null) => {
                if (!resolved) {
                    resolved = true;
                    if (code === 0 || code === null) {
                        log(`[EnterSoundFeedback] Successfully played ${fileName}`);
                        resolve();
                    } else {
                        log(`[EnterSoundFeedback] PCM playback failed with code: ${code}`);
                        reject(new Error(`PCM playback failed with code: ${code}`));
                    }
                }
            });
            
            process.on('error', (error: any) => {
                if (!resolved) {
                    resolved = true;
                    log(`[EnterSoundFeedback] PCM playback error: ${error}`);
                    reject(error);
                }
            });
            
            // Timeout to prevent hanging
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { process.kill('SIGKILL'); } catch (e) {}
                    log(`[EnterSoundFeedback] PCM playback timeout for ${fileName}`);
                    resolve(); // Resolve even on timeout to not block the UI
                }
            }, 1000); // 1 second timeout
            
        } catch (error) {
            log(`[EnterSoundFeedback] Error setting up PCM playback: ${error}`);
            reject(error);
        }
    });
}

/**
 * Play the appropriate enter sound based on syntax error status
 */
async function playEnterSound(hasError: boolean) {
    try {
        const soundFile = hasError ? 'enter2.pcm' : 'enter.pcm';
        await playPCMFile(soundFile);
        log(`[EnterSoundFeedback] Played ${soundFile} for enter ${hasError ? 'with error' : 'without error'}`);
    } catch (error) {
        log(`[EnterSoundFeedback] Failed to play enter sound: ${error}`);
    }
}

/**
 * Toggle enter sound feedback on/off
 */
function toggleEnterSoundFeedback(): boolean {
    enterSoundEnabled = !enterSoundEnabled;
    log(`[EnterSoundFeedback] Enter sound feedback ${enterSoundEnabled ? 'enabled' : 'disabled'}`);
    return enterSoundEnabled;
}

/**
 * Register the enter sound feedback feature
 */
export function registerEnterSoundFeedback(context: vscode.ExtensionContext) {
    log('[EnterSoundFeedback] Registering enter sound feedback feature');

    // Initialize diagnostic cache (reuse existing line severity system)
    updateLineSeverity();

    // Listen for text document changes
    const changeListener = vscode.workspace.onDidChangeTextDocument(handleTextDocumentChange);
    context.subscriptions.push(changeListener);

    // Register command to toggle enter sound feedback
    const toggleCommand = vscode.commands.registerCommand('lipcoder.toggleEnterSoundFeedback', () => {
        const enabled = toggleEnterSoundFeedback();
        vscode.window.showInformationMessage(
            `Enter sound feedback ${enabled ? 'enabled' : 'disabled'}`
        );
    });
    context.subscriptions.push(toggleCommand);

    // Register command to test enter sounds
    const testCommand = vscode.commands.registerCommand('lipcoder.testEnterSounds', async () => {
        try {
            vscode.window.showInformationMessage('Testing enter sounds...');
            
            // Test normal enter sound
            log('[EnterSoundFeedback] Testing normal enter sound (enter.pcm)');
            await playEnterSound(false);
            
            // Wait a bit then test error sound
            setTimeout(async () => {
                log('[EnterSoundFeedback] Testing error enter sound (enter2.pcm)');
                await playEnterSound(true);
                vscode.window.showInformationMessage('Enter sound test completed!');
            }, 1500); // Increased delay to ensure first sound finishes
            
        } catch (error) {
            vscode.window.showErrorMessage(`Enter sound test failed: ${error}`);
        }
    });
    context.subscriptions.push(testCommand);

    // Register command to debug current line diagnostics
    const debugCommand = vscode.commands.registerCommand('lipcoder.debugLineDiagnostics', async () => {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const position = editor.selection.active;
            const lineNumber = position.line;
            const uri = editor.document.uri.toString();
            
            // Get all diagnostics for this file
            const allDiagnostics = vscode.languages.getDiagnostics(editor.document.uri);
            
            log(`[EnterSoundFeedback] Debug - Current line: ${lineNumber}`);
            log(`[EnterSoundFeedback] Debug - URI: ${uri}`);
            log(`[EnterSoundFeedback] Debug - Total diagnostics in file: ${allDiagnostics.length}`);
            
            // Show diagnostics for current line
            const currentLineDiagnostics = allDiagnostics.filter(d => d.range.start.line === lineNumber);
            log(`[EnterSoundFeedback] Debug - Diagnostics on current line: ${currentLineDiagnostics.length}`);
            
            currentLineDiagnostics.forEach((diag, index) => {
                log(`[EnterSoundFeedback] Debug - Diagnostic ${index}: severity=${diag.severity}, source=${diag.source}, message="${diag.message}"`);
            });
            
            // Check our cache
            const severity = getLineSeverity(uri, lineNumber);
            log(`[EnterSoundFeedback] Debug - Cached severity: ${severity}`);
            
            // Show all lines with issues
            const linesWithIssues: string[] = [];
            allDiagnostics.forEach(diag => {
                const line = diag.range.start.line;
                const severityName = diag.severity === 0 ? 'Error' : diag.severity === 1 ? 'Warning' : diag.severity === 2 ? 'Info' : 'Hint';
                linesWithIssues.push(`Line ${line}: ${severityName} - ${diag.message}`);
            });
            
            vscode.window.showInformationMessage(
                `Current line ${lineNumber}: ${currentLineDiagnostics.length} diagnostics. ` +
                `Total file diagnostics: ${allDiagnostics.length}. Check console for details.`
            );
            
        } catch (error) {
            vscode.window.showErrorMessage(`Debug failed: ${error}`);
        }
    });
    context.subscriptions.push(debugCommand);

    log('[EnterSoundFeedback] Enter sound feedback feature registered successfully');
}

/**
 * Clean up enter sound feedback resources
 */
export function cleanupEnterSoundFeedback() {
    log('[EnterSoundFeedback] Cleaned up resources');
}
