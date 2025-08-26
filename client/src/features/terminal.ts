import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk, playWave, clearAudioStoppingState, cleanupAudioResources } from '../audio';
import { stopReading, stopAllAudio, stopForNewLineReading, lineAbortController } from './stop_reading';
import { stopEarconPlayback } from '../earcon';
import { logWarning, logError, logSuccess, log } from '../utils';
import { logFeatureUsage } from '../activity_logger';
import { config } from '../config';
import { isEarcon, getSpecialCharSpoken, twoLenExceptions, threeLenExceptions } from '../mapping';
import { splitWordChunks, isDictionaryWord, isCamelCase, splitCamel } from './word_logic';
import { containsKorean } from '../language_detection';
import * as path from 'path';

// Terminal screen buffer management
let terminalScreenLines: string[] = [];
let terminalInputLines: string[] = []; // Store all input commands
let terminalBuffer: Array<{type: 'input' | 'output', content: string, timestamp: Date}> = []; // Complete terminal history
let currentLineIndex = -1;
let isReadingMode = false; // Toggle for reading mode vs normal terminal mode
let activePtyProcesses = new Set<any>();
let hasNodePty = false;
let fallbackTerminal: vscode.Terminal | null = null;
let currentPtyProcess: any = null;
let terminalOutputBuffer: string[] = []; // Enhanced buffer for better output tracking

let currentInputBuffer = ''; // Current command being typed

// Live echo/complete tracking
let awaitingCompletion = false;       // set when user presses TAB
let echoCaptureActive = false;        // transient while shell redraws/completes current line

// Terminal-specific audio control
let terminalAbortController = new AbortController();
let isTerminalSpeaking = false;
let terminalAudioLock = false; // Global lock to prevent any terminal audio overlap

// Word navigation variables
let currentWordIndex = -1;
let currentLineWords: string[] = [];

// Terminal output summary variables
let waitingForCommandOutput = false;
let commandStartTime: Date | null = null;
let commandOutputBuffer: Array<{type: 'input' | 'output', content: string, timestamp: Date}> = [];

// Suggestion dialog state management
let suggestionDialogActive = false;
let pendingSuggestions: CodeExecutionSuggestion[] = [];
let lastSuggestionTime = 0;

// === In-terminal Reading Overlay (ANSI alt-screen) hooks ===
let openReadingAltScreen: (() => void) | null = null;
let refreshReadingAltScreen: (() => void) | null = null;
let closeReadingAltScreen: (() => void) | null = null;

/**
 * Check if terminal suggestion dialog is currently active
 */
export function isTerminalSuggestionDialogActive(): boolean {
    return suggestionDialogActive;
}
let outputSummaryTimeout: NodeJS.Timeout | null = null;

// Korean input composition buffer
let compositionBuffer = '';
let compositionTimeout: NodeJS.Timeout | null = null;

/**
 * ULTRA-AGGRESSIVE terminal audio stopping - NUCLEAR OPTION to ensure no overlap
 */
function stopTerminalAudio(): void {
    log('[Terminal] 🚨 ULTRA-AGGRESSIVE STOP - NUCLEAR AUDIO SHUTDOWN 🚨');
    
    // IMMEDIATE flag setting - prevent ANY new audio
    isTerminalSpeaking = false;
    
    // 1. Abort ALL controllers immediately
    terminalAbortController.abort();
    lineAbortController.abort();
    
    // 2. Stop ALL audio systems - MULTIPLE CALLS for redundancy
    stopAllAudio();
    stopAllAudio(); // Call twice for safety
    stopReading();
    stopForNewLineReading();
    stopEarconPlayback();
    
    // 3. NUCLEAR OPTION - Full audio cleanup
    try {
        cleanupAudioResources();
    } catch (error) {
        log(`[Terminal] Audio cleanup error (expected): ${error}`);
    }
    
    // 4. Kill any remaining processes (if accessible)
    try {
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }
    } catch (error) {
        // Ignore GC errors
    }
    
    // 5. Create fresh controllers
    terminalAbortController = new AbortController();
    
    // 6. Clear ALL audio states
    clearAudioStoppingState();
    
    log('[Terminal] 🚨 NUCLEAR STOP COMPLETE - All audio systems terminated 🚨');
}

/**
 * Terminal-specific speak function with ULTRA-AGGRESSIVE abort control
 */
async function speakTerminalTokens(chunks: TokenChunk[], description: string): Promise<void> {
    // NUCLEAR STOP - Kill everything first
    stopTerminalAudio();
    
    // LONGER wait for complete audio termination
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // TRIPLE CHECK - Make sure we should still speak
    if (terminalAbortController.signal.aborted) {
        log(`[Terminal] Speaking cancelled before starting: ${description}`);
        return;
    }
    
    // ADDITIONAL CHECK - Make sure no other terminal audio is playing
    if (isTerminalSpeaking) {
        log(`[Terminal] Another terminal audio is still playing, aborting: ${description}`);
        return;
    }
    
    // Set speaking flag IMMEDIATELY
    isTerminalSpeaking = true;
    
    try {
        log(`[Terminal] 🎤 Starting to speak: ${description}`);
        
        // FINAL CHECK before actual speech
        if (terminalAbortController.signal.aborted) {
            log(`[Terminal] Last-second abort detected: ${description}`);
            return;
        }
        
        await speakTokenList(chunks, terminalAbortController.signal);
        log(`[Terminal] ✅ Finished speaking: ${description}`);
    } catch (error) {
        if (terminalAbortController.signal.aborted) {
            log(`[Terminal] 🛑 Speaking aborted: ${description}`);
        } else {
            log(`[Terminal] ❌ Speaking error: ${error}`);
        }
    } finally {
        isTerminalSpeaking = false;
        log(`[Terminal] 🏁 Speech cleanup complete: ${description}`);
    }
}

/**
 * Add entry to terminal buffer with timestamp
 */
function addToTerminalBuffer(type: 'input' | 'output', content: string): void {
    const entry = {
        type,
        content: content.trimStart(),
        timestamp: new Date()
    };
    
    terminalBuffer.push(entry);
    
    // Add to command output monitoring if we're waiting for output
    addToCommandOutputBuffer(entry);
    
    // Keep buffer size manageable (last 200 entries)
    if (terminalBuffer.length > 200) {
        terminalBuffer = terminalBuffer.slice(-150);
    }
    
    // Also add to appropriate specific buffer
    if (type === 'input') {
        terminalInputLines.push(content.trim());
        if (terminalInputLines.length > 50) {
            terminalInputLines = terminalInputLines.slice(-30);
        }
    } else {
        terminalScreenLines.push(content.trim());
        if (terminalScreenLines.length > 50) {
            terminalScreenLines = terminalScreenLines.slice(-30);
        }
    }
    
    logSuccess(`[Terminal] Added ${type}: "${content.trim()}"`);
}

// /**
//  * Show reading mode UI indicator
//  */
// function showReadingModeUI(): void {
//     const totalLines = terminalBuffer.length;
//     const currentPos = Math.max(0, currentLineIndex + 1);
//     const currentEntry = terminalBuffer[currentLineIndex];
//     const entryType = currentEntry ? currentEntry.type : 'unknown';
    
//     vscode.window.showInformationMessage(
//         `Reading Mode: Line ${currentPos}/${totalLines} (${entryType})`,
//         { modal: false }
//     );
// }

// /**
//  * Hide reading mode UI
//  */
// function hideReadingModeUI(): void {
//     // Clear any existing status messages
//     vscode.window.setStatusBarMessage('', 1);
// }
function showReadingModeUI(): void {
    if (openReadingAltScreen) openReadingAltScreen();
    if (refreshReadingAltScreen) refreshReadingAltScreen();
}
function hideReadingModeUI(): void {
    if (closeReadingAltScreen) closeReadingAltScreen();
}

/**
 * Parse a terminal line into words for word-level navigation
 */
function parseLineToWords(line: string): string[] {
    if (!line || line.trim().length === 0) {
        return [];
    }
    
    // Split by whitespace and filter out empty strings
    const words = line.trim().split(/\s+/).filter(word => word.length > 0);
    return words;
}

/**
 * Update word navigation state for the current line
 */
function updateWordNavigationState(): void {
    if (currentLineIndex >= 0 && currentLineIndex < terminalBuffer.length) {
        const currentEntry = terminalBuffer[currentLineIndex];
        if (currentEntry) {
            currentLineWords = parseLineToWords(currentEntry.content);
            // Reset word index when switching lines
            currentWordIndex = -1;
        }
    } else {
        currentLineWords = [];
        currentWordIndex = -1;
    }
}

/**
 * Convert a terminal line into proper token chunks using code-like parsing with single voice
 */
function parseTerminalLineToTokens(line: string): TokenChunk[] {
    const chunks: TokenChunk[] = [];
    
    // Use the same word splitting logic as code reading
    const tokens = splitWordChunks(line);
    
    for (const token of tokens) {
        // Check if this token should be an earcon
        if (token.length === 1 && isEarcon(token)) {
            chunks.push({
                tokens: [token],
                category: 'earcon'
            });
        } else {
            // All other tokens use single voice (no category for uniform voice)
            chunks.push({
                tokens: [token],
                category: undefined
            });
        }
    }
    
    return chunks;
}

const SPOKEN_PREFIX_MODE: 'en-short' | 'ko' = 'en-short'; // 'ko'로 바꾸면 한국어로 읽음
function getSpokenPrefix(t: 'input' | 'output'): string {
  if (SPOKEN_PREFIX_MODE === 'ko') return t === 'input' ? '입력' : '출력';
  return t === 'input' ? 'in' : 'out';
}

/**
 * Enhanced terminal output analysis for code execution results and intelligent suggestions
 */
interface TerminalAnalysis {
    hasErrors: boolean;
    errorCount: number;
    warningCount: number;
    summary: string;
    errors: string[];
    warnings: string[];
    successMessages: string[];
    // Enhanced fields for code execution analysis
    codeExecutionType: 'python' | 'javascript' | 'typescript' | 'test' | 'build' | 'install' | 'other';
    syntaxErrors: string[];
    runtimeErrors: string[];
    testResults: TestResult[];
    buildResults: BuildResult[];
    suggestions: CodeExecutionSuggestion[];
}

interface TestResult {
    type: 'passed' | 'failed' | 'skipped';
    testName?: string;
    errorMessage?: string;
    line?: number;
}

interface BuildResult {
    type: 'success' | 'error' | 'warning';
    message: string;
    file?: string;
    line?: number;
}

interface CodeExecutionSuggestion {
    title: string;
    description: string;
    instruction: string;
    priority: number;
    category: 'error_fix' | 'test_improvement' | 'code_enhancement' | 'performance';
}

/**
 * Analyze terminal output for errors and important information with enhanced code execution focus
 */
function analyzeTerminalOutput(outputEntries: Array<{type: 'input' | 'output', content: string, timestamp: Date}>): TerminalAnalysis {
    const errors: string[] = [];
    const warnings: string[] = [];
    const successMessages: string[] = [];
    const syntaxErrors: string[] = [];
    const runtimeErrors: string[] = [];
    const testResults: TestResult[] = [];
    const buildResults: BuildResult[] = [];
    const suggestions: CodeExecutionSuggestion[] = [];
    
    // Determine code execution type from input commands
    let codeExecutionType: TerminalAnalysis['codeExecutionType'] = 'other';
    const inputCommands = outputEntries.filter(e => e.type === 'input').map(e => e.content.toLowerCase());
    
    if (inputCommands.some(cmd => cmd.includes('python') || cmd.includes('py '))) {
        codeExecutionType = 'python';
    } else if (inputCommands.some(cmd => cmd.includes('node') || cmd.includes('npm') || cmd.includes('yarn'))) {
        codeExecutionType = 'javascript';
    } else if (inputCommands.some(cmd => cmd.includes('tsc') || cmd.includes('typescript'))) {
        codeExecutionType = 'typescript';
    } else if (inputCommands.some(cmd => cmd.includes('test') || cmd.includes('jest') || cmd.includes('pytest'))) {
        codeExecutionType = 'test';
    } else if (inputCommands.some(cmd => cmd.includes('build') || cmd.includes('compile'))) {
        codeExecutionType = 'build';
    } else if (inputCommands.some(cmd => cmd.includes('install') || cmd.includes('pip'))) {
        codeExecutionType = 'install';
    }
    
    for (const entry of outputEntries) {
        if (entry.type === 'output') {
            const content = entry.content.toLowerCase();
            const originalContent = entry.content;
            
            // Enhanced error detection with specific patterns
            if (content.includes('syntaxerror') || content.includes('syntax error')) {
                syntaxErrors.push(originalContent);
                errors.push(originalContent);
            } else if (content.includes('traceback') || content.includes('exception') || 
                      content.includes('error:') || content.includes('failed') ||
                      content.includes('cannot') || content.includes('not found') || 
                      content.includes('permission denied') || content.includes('access denied') ||
                      content.includes('fatal') || content.includes('undefined') ||
                      content.includes('null pointer') || content.includes('segmentation fault')) {
                runtimeErrors.push(originalContent);
                errors.push(originalContent);
            }
            // Warning detection patterns
            else if (content.includes('warning') || content.includes('deprecated') || content.includes('caution') ||
                     content.includes('notice') || content.includes('outdated')) {
                warnings.push(originalContent);
            }
            // Success detection patterns
            else if (content.includes('success') || content.includes('completed') || content.includes('done') ||
                     content.includes('installed') || content.includes('built') || content.includes('passed') ||
                     content.includes('ok') || content.match(/\d+\s*(test|spec)s?\s*passed/)) {
                successMessages.push(originalContent);
            }
            
            // Test result parsing
            const testPassedMatch = originalContent.match(/(\d+)\s*tests?\s*passed/i);
            const testFailedMatch = originalContent.match(/(\d+)\s*tests?\s*failed/i);
            const testSkippedMatch = originalContent.match(/(\d+)\s*tests?\s*skipped/i);
            
            if (testPassedMatch) {
                testResults.push({ type: 'passed', testName: `${testPassedMatch[1]} tests` });
            }
            if (testFailedMatch) {
                testResults.push({ type: 'failed', testName: `${testFailedMatch[1]} tests` });
            }
            if (testSkippedMatch) {
                testResults.push({ type: 'skipped', testName: `${testSkippedMatch[1]} tests` });
            }
            
            // Build result parsing
            if (content.includes('build successful') || content.includes('compilation successful')) {
                buildResults.push({ type: 'success', message: originalContent });
            } else if (content.includes('build failed') || content.includes('compilation failed')) {
                buildResults.push({ type: 'error', message: originalContent });
            }
        }
    }
    
    // Generate intelligent suggestions based on analysis
    suggestions.push(...generateCodeExecutionSuggestions(
        codeExecutionType, 
        syntaxErrors, 
        runtimeErrors, 
        testResults, 
        buildResults,
        outputEntries
    ));
    
    // Create summary
    let summary = '';
    const hasErrors = errors.length > 0;
    const errorCount = errors.length;
    const warningCount = warnings.length;
    
    if (hasErrors) {
        summary = `Code execution completed with ${errorCount} error${errorCount > 1 ? 's' : ''}`;
        if (warningCount > 0) {
            summary += ` and ${warningCount} warning${warningCount > 1 ? 's' : ''}`;
        }
    } else if (warningCount > 0) {
        summary = `Code execution completed with ${warningCount} warning${warningCount > 1 ? 's' : ''}`;
    } else if (successMessages.length > 0) {
        summary = 'Code executed successfully';
    } else {
        summary = 'Code execution completed';
    }
    
    return {
        hasErrors,
        errorCount,
        warningCount,
        summary,
        errors: errors.slice(0, 3), // Limit to first 3 errors
        warnings: warnings.slice(0, 2), // Limit to first 2 warnings
        successMessages: successMessages.slice(0, 2), // Limit to first 2 success messages
        codeExecutionType,
        syntaxErrors,
        runtimeErrors,
        testResults,
        buildResults,
        suggestions
    };
}

/**
 * Generate intelligent suggestions based on code execution results and errors
 */
function generateCodeExecutionSuggestions(
    executionType: TerminalAnalysis['codeExecutionType'],
    syntaxErrors: string[],
    runtimeErrors: string[],
    testResults: TestResult[],
    buildResults: BuildResult[],
    outputEntries: Array<{type: 'input' | 'output', content: string, timestamp: Date}>
): CodeExecutionSuggestion[] {
    const suggestions: CodeExecutionSuggestion[] = [];
    
    // High priority: Fix syntax errors
    if (syntaxErrors.length > 0) {
        suggestions.push({
            title: `🚨 Fix ${syntaxErrors.length} Syntax Error${syntaxErrors.length > 1 ? 's' : ''}`,
            description: 'Resolve syntax errors preventing code execution',
            instruction: `Fix the syntax errors in your code: ${syntaxErrors.slice(0, 2).join('; ')}. Check for missing parentheses, brackets, colons, or incorrect indentation.`,
            priority: 10,
            category: 'error_fix'
        });
    }
    
    // High priority: Fix runtime errors
    if (runtimeErrors.length > 0) {
        const errorTypes = new Set<string>();
        runtimeErrors.forEach(error => {
            const lowerError = error.toLowerCase();
            if (lowerError.includes('nameerror') || lowerError.includes('not defined')) {
                errorTypes.add('undefined_variables');
            } else if (lowerError.includes('typeerror')) {
                errorTypes.add('type_mismatch');
            } else if (lowerError.includes('indexerror') || lowerError.includes('keyerror')) {
                errorTypes.add('data_access');
            } else if (lowerError.includes('importerror') || lowerError.includes('modulenotfounderror')) {
                errorTypes.add('import_issues');
            } else if (lowerError.includes('attributeerror')) {
                errorTypes.add('attribute_issues');
            } else {
                errorTypes.add('runtime_error');
            }
        });
        
        for (const errorType of errorTypes) {
            switch (errorType) {
                case 'undefined_variables':
                    suggestions.push({
                        title: '🔧 Fix Undefined Variables',
                        description: 'Define missing variables or fix variable names',
                        instruction: 'Check for undefined variables in your code. Make sure all variables are properly defined before use, check for typos in variable names, and ensure proper scope.',
                        priority: 9,
                        category: 'error_fix'
                    });
                    break;
                case 'type_mismatch':
                    suggestions.push({
                        title: '🔄 Fix Type Errors',
                        description: 'Resolve type mismatches and incompatible operations',
                        instruction: 'Fix type errors by ensuring compatible data types in operations, adding type conversions where needed, and validating input types.',
                        priority: 9,
                        category: 'error_fix'
                    });
                    break;
                case 'data_access':
                    suggestions.push({
                        title: '🗂️ Fix Data Access Errors',
                        description: 'Handle index and key errors safely',
                        instruction: 'Add bounds checking for list/array access, validate dictionary keys before access, and implement proper error handling for data operations.',
                        priority: 8,
                        category: 'error_fix'
                    });
                    break;
                case 'import_issues':
                    suggestions.push({
                        title: '📦 Fix Import Errors',
                        description: 'Resolve missing modules and import issues',
                        instruction: 'Install missing packages, fix import paths, check module names for typos, and ensure all dependencies are properly installed.',
                        priority: 9,
                        category: 'error_fix'
                    });
                    break;
                case 'attribute_issues':
                    suggestions.push({
                        title: '🏷️ Fix Attribute Errors',
                        description: 'Resolve missing attributes and method calls',
                        instruction: 'Check object types before accessing attributes, verify method names are correct, and ensure objects are properly initialized.',
                        priority: 8,
                        category: 'error_fix'
                    });
                    break;
            }
        }
    }
    
    // Test-specific suggestions
    const failedTests = testResults.filter(t => t.type === 'failed');
    if (failedTests.length > 0) {
        suggestions.push({
            title: `🧪 Fix ${failedTests.length} Failed Test${failedTests.length > 1 ? 's' : ''}`,
            description: 'Debug and fix failing test cases',
            instruction: `Investigate and fix the failing tests. Review test assertions, check expected vs actual values, and ensure your code logic matches test requirements.`,
            priority: 8,
            category: 'test_improvement'
        });
    }
    
    // Success-based enhancement suggestions
    const passedTests = testResults.filter(t => t.type === 'passed');
    if (passedTests.length > 0 && failedTests.length === 0) {
        suggestions.push({
            title: '✅ Add More Test Coverage',
            description: 'Expand test suite with edge cases and additional scenarios',
            instruction: 'Add more comprehensive test cases including edge cases, error conditions, and boundary value testing to improve code reliability.',
            priority: 6,
            category: 'test_improvement'
        });
    }
    
    // Performance and enhancement suggestions based on execution type
    switch (executionType) {
        case 'python':
            if (syntaxErrors.length === 0 && runtimeErrors.length === 0) {
                suggestions.push({
                    title: '🐍 Enhance Python Code',
                    description: 'Add type hints, error handling, and documentation',
                    instruction: 'Improve your Python code by adding type hints, comprehensive error handling with try-catch blocks, docstrings for functions, and input validation.',
                    priority: 5,
                    category: 'code_enhancement'
                });
            }
            break;
        case 'javascript':
        case 'typescript':
            if (syntaxErrors.length === 0 && runtimeErrors.length === 0) {
                suggestions.push({
                    title: '🚀 Enhance JavaScript/TypeScript Code',
                    description: 'Add error handling, type safety, and async patterns',
                    instruction: 'Improve your code by adding proper error handling, async/await patterns for asynchronous operations, input validation, and TypeScript types if applicable.',
                    priority: 5,
                    category: 'code_enhancement'
                });
            }
            break;
        case 'test':
            if (testResults.length > 0) {
                suggestions.push({
                    title: '🔬 Improve Test Quality',
                    description: 'Enhance test structure and coverage',
                    instruction: 'Improve your tests by adding setup/teardown methods, parameterized tests for multiple scenarios, better assertions, and mock objects for external dependencies.',
                    priority: 6,
                    category: 'test_improvement'
                });
            }
            break;
    }
    
    // Build and performance suggestions
    if (buildResults.some(b => b.type === 'success')) {
        suggestions.push({
            title: '⚡ Optimize Performance',
            description: 'Add performance monitoring and optimization',
            instruction: 'Add performance monitoring, optimize algorithms for better time complexity, implement caching where appropriate, and profile code for bottlenecks.',
            priority: 4,
            category: 'performance'
        });
    }
    
    // General code quality suggestions if no major errors
    if (syntaxErrors.length === 0 && runtimeErrors.length === 0) {
        suggestions.push({
            title: '📋 Add Logging and Monitoring',
            description: 'Implement comprehensive logging for debugging',
            instruction: 'Add structured logging with different log levels, error tracking, and monitoring to help with debugging and maintenance.',
            priority: 5,
            category: 'code_enhancement'
        });
    }
    
    return suggestions.sort((a, b) => b.priority - a.priority).slice(0, 5); // Return top 5 suggestions
}

/**
 * Show terminal output summary in popup and speech with intelligent suggestions
 */
async function showTerminalOutputSummary(analysis: TerminalAnalysis): Promise<void> {
    const { hasErrors, errorCount, warningCount, summary, errors, warnings, suggestions } = analysis;
    
    // Prevent interrupting active suggestion dialogs
    if (suggestionDialogActive) {
        log('[Terminal] Suggestion dialog already active, queuing new suggestions');
        // Store suggestions for later if they're higher priority
        const highPrioritySuggestions = suggestions.filter(s => s.priority >= 8);
        if (highPrioritySuggestions.length > 0) {
            pendingSuggestions.push(...highPrioritySuggestions);
        }
        return;
    }
    
    // Prevent too frequent suggestion popups (minimum 3 seconds between)
    const currentTime = Date.now();
    if (currentTime - lastSuggestionTime < 3000 && suggestions.length > 0) {
        log('[Terminal] Too soon for new suggestions, waiting...');
        pendingSuggestions.push(...suggestions);
        return;
    }
    
    // Create popup message
    let popupMessage = summary;
    if (hasErrors && errors.length > 0) {
        popupMessage += '\n\nErrors:\n' + errors.map(err => `• ${err}`).join('\n');
    }
    if (warningCount > 0 && warnings.length > 0) {
        popupMessage += '\n\nWarnings:\n' + warnings.map(warn => `• ${warn}`).join('\n');
    }
    
    // Add suggestions to popup if available
    if (suggestions.length > 0) {
        popupMessage += '\n\n💡 Suggested Actions:\n' + suggestions.slice(0, 3).map(s => `• ${s.title}: ${s.description}`).join('\n');
    }
    
    // Show popup based on user preference [[memory:6411078]] with suggestion actions
    let actionButtons: string[] = [];
    if (suggestions.length > 0) {
        actionButtons.push('Show Suggestions');
    }
    if (hasErrors) {
        actionButtons.push('Fix Errors');
    }
    
    let choice: string | undefined;
    if (hasErrors) {
        // Non-blocking error popup with actions
        choice = await vscode.window.showErrorMessage(popupMessage, { modal: false }, ...actionButtons);
    } else if (warningCount > 0) {
        // Non-blocking warning popup with actions
        choice = await vscode.window.showWarningMessage(popupMessage, { modal: false }, ...actionButtons);
    } else if (suggestions.length > 0) {
        // Non-blocking info popup with suggestions
        choice = await vscode.window.showInformationMessage(popupMessage, { modal: false }, ...actionButtons);
    } else {
        // Simple info popup
        vscode.window.showInformationMessage(popupMessage, { modal: false });
    }
    
    // Handle user choice
    if (choice === 'Show Suggestions' || choice === 'Fix Errors') {
        lastSuggestionTime = currentTime;
        await showCodeExecutionSuggestions(suggestions, analysis);
    }
    
    // Create speech content - simple TTS speech as preferred [[memory:6411078]]
    let speechText = summary;
    if (hasErrors && errors.length > 0) {
        speechText += '. Errors detected: ' + errors.slice(0, 1).join('. '); // Limit to 1 error for speech
    }
    if (warningCount > 0 && warnings.length > 0) {
        speechText += '. Warnings: ' + warnings.slice(0, 1).join('. '); // Limit to 1 warning for speech
    }
    if (suggestions.length > 0) {
        speechText += `. ${suggestions.length} suggestion${suggestions.length > 1 ? 's' : ''} available to improve your code.`;
    }
    
    // Convert to token chunks for speech
    const speechChunks: TokenChunk[] = [{
        tokens: [speechText],
        category: undefined // Use default voice as preferred [[memory:6411083]]
    }];
    
    // Speak the summary using terminal-specific speech function (integrates with stopreading)
    await speakTerminalTokens(speechChunks, 'Code Execution Summary');
}

/**
 * Show code execution suggestions with integration to vibe coding
 */
async function showCodeExecutionSuggestions(suggestions: CodeExecutionSuggestion[], analysis: TerminalAnalysis): Promise<void> {
    if (suggestions.length === 0) {
        vscode.window.showInformationMessage('No specific suggestions available for this execution.');
        return;
    }
    
    // Set dialog active state to prevent interruptions
    suggestionDialogActive = true;
    
    try {
        // Import vibe coding function dynamically to avoid circular dependencies
        const { activateVibeCoding } = await import('./vibe_coding.js');
        
        // Create rich suggestion items with categories
        const suggestionItems = suggestions.map(suggestion => ({
            label: `${getCategoryIcon(suggestion.category)} ${suggestion.title}`,
            description: suggestion.description,
            detail: suggestion.instruction,
            instruction: suggestion.instruction,
            category: suggestion.category,
            priority: suggestion.priority
        }));
        
        // Show quick pick with enhanced UI
        const choice = await vscode.window.showQuickPick(suggestionItems, {
            placeHolder: 'Select a suggestion to implement with AI assistance',
            title: `Code Execution Suggestions (${analysis.codeExecutionType})`,
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        
        if (choice) {
            log(`[Terminal] User selected suggestion: ${choice.label} - ${choice.instruction}`);
            
            // Speak the selection with explanation
            await speakTerminalTokens([{
                tokens: [`Selected: ${choice.label.replace(/^[🚨🔧🔄🗂️📦🏷️🧪✅🐍🚀🔬⚡📋]\s*/, '')}. ${choice.description}`],
                category: undefined
            }], 'Suggestion Selected');
            
            // Show confirmation with detailed explanation
            const shouldImplement = await vscode.window.showInformationMessage(
                `Implement: ${choice.label.replace(/^[🚨🔧🔄🗂️📦🏷️🧪✅🐍🚀🔬⚡📋]\s*/, '')}?\n\n${choice.detail}\n\nThis will use AI to automatically implement the suggested improvements.`,
                { modal: true },
                'Yes, implement with AI',
                'No, skip'
            );
            
            if (shouldImplement === 'Yes, implement with AI') {
                // Activate vibe coding with the detailed instruction, suppressing conversational ASR
                await activateVibeCoding(choice.instruction, { suppressConversationalASR: true });
                
                // Reset dialog state after vibe coding completes
                suggestionDialogActive = false;
                
                // Process any pending suggestions after a short delay
                if (pendingSuggestions.length > 0) {
                    setTimeout(async () => {
                        await processPendingSuggestions();
                    }, 1000); // 1 second delay to avoid immediate interruption
                }
            } else {
                // User declined, reset dialog state immediately
                suggestionDialogActive = false;
                
                // Process any pending suggestions after a short delay
                if (pendingSuggestions.length > 0) {
                    setTimeout(async () => {
                        await processPendingSuggestions();
                    }, 1000);
                }
            }
        }
    } catch (error) {
        log(`[Terminal] Error showing code execution suggestions: ${error}`);
        // Fallback to basic suggestion display
        await showBasicCodeSuggestions(suggestions);
        
        // Reset dialog state on error
        suggestionDialogActive = false;
        
        // Process any pending suggestions after a short delay
        if (pendingSuggestions.length > 0) {
            setTimeout(async () => {
                await processPendingSuggestions();
            }, 1000);
        }
    }
}

/**
 * Get category icon for suggestion display
 */
function getCategoryIcon(category: CodeExecutionSuggestion['category']): string {
    switch (category) {
        case 'error_fix': return '🚨';
        case 'test_improvement': return '🧪';
        case 'code_enhancement': return '🚀';
        case 'performance': return '⚡';
        default: return '💡';
    }
}

/**
 * Process pending suggestions that were queued during active dialogs
 */
async function processPendingSuggestions(): Promise<void> {
    if (suggestionDialogActive || pendingSuggestions.length === 0) {
        return;
    }
    
    // Deduplicate and sort pending suggestions by priority
    const uniqueSuggestions = Array.from(
        new Map(pendingSuggestions.map(s => [s.title, s])).values()
    ).sort((a, b) => b.priority - a.priority);
    
    // Clear pending suggestions
    pendingSuggestions = [];
    
    // Show the highest priority pending suggestions
    if (uniqueSuggestions.length > 0) {
        log(`[Terminal] Processing ${uniqueSuggestions.length} pending suggestions`);
        
        // Create a mock analysis for pending suggestions
        const mockAnalysis: TerminalAnalysis = {
            hasErrors: uniqueSuggestions.some(s => s.category === 'error_fix'),
            errorCount: uniqueSuggestions.filter(s => s.category === 'error_fix').length,
            warningCount: 0,
            summary: 'Pending code improvement suggestions',
            errors: [],
            warnings: [],
            successMessages: [],
            codeExecutionType: 'other',
            syntaxErrors: [],
            runtimeErrors: [],
            testResults: [],
            buildResults: [],
            suggestions: uniqueSuggestions.slice(0, 5) // Limit to top 5
        };
        
        await showCodeExecutionSuggestions(uniqueSuggestions.slice(0, 5), mockAnalysis);
    }
}

/**
 * Fallback basic suggestion display
 */
async function showBasicCodeSuggestions(suggestions: CodeExecutionSuggestion[]): Promise<void> {
    const basicSuggestionTexts = suggestions.slice(0, 3).map(s => s.title);
    
    const choice = await vscode.window.showQuickPick(basicSuggestionTexts, {
        placeHolder: 'Select a suggestion to implement',
        title: 'Code Improvement Suggestions'
    });
    
    if (choice) {
        const selectedSuggestion = suggestions.find(s => s.title === choice);
        if (selectedSuggestion) {
            vscode.window.showInformationMessage(
                `Suggestion: ${selectedSuggestion.description}\n\nTo implement: ${selectedSuggestion.instruction}`,
                { modal: false }
            );
        }
    }
}

/**
 * Start monitoring for command output
 */
function startCommandOutputMonitoring(): void {
    waitingForCommandOutput = true;
    commandStartTime = new Date();
    commandOutputBuffer = [];
    
    // Clear any existing timeout
    if (outputSummaryTimeout) {
        clearTimeout(outputSummaryTimeout);
    }
    
    // Set timeout to analyze output after 2 seconds of no new output
    outputSummaryTimeout = setTimeout(async () => {
        if (waitingForCommandOutput && commandOutputBuffer.length > 0) {
            const analysis = analyzeTerminalOutput(commandOutputBuffer);
            
            // Only show summary if there's meaningful output or errors
            if (analysis.hasErrors || analysis.warningCount > 0 || commandOutputBuffer.length > 2) {
                await showTerminalOutputSummary(analysis);
            }
            
            // Reset monitoring state
            waitingForCommandOutput = false;
            commandOutputBuffer = [];
            commandStartTime = null;
        }
    }, 2000); // Wait 2 seconds after last output
}

/**
 * Add output to command monitoring buffer
 */
function addToCommandOutputBuffer(entry: {type: 'input' | 'output', content: string, timestamp: Date}): void {
    if (waitingForCommandOutput) {
        commandOutputBuffer.push(entry);
        
        // Reset the timeout since we got new output
        if (outputSummaryTimeout) {
            clearTimeout(outputSummaryTimeout);
        }
        
        outputSummaryTimeout = setTimeout(async () => {
            if (waitingForCommandOutput && commandOutputBuffer.length > 0) {
                const analysis = analyzeTerminalOutput(commandOutputBuffer);
                
                // Only show summary if there's meaningful output or errors
                if (analysis.hasErrors || analysis.warningCount > 0 || commandOutputBuffer.length > 2) {
                    await showTerminalOutputSummary(analysis);
                }
                
                // Reset monitoring state
                waitingForCommandOutput = false;
                commandOutputBuffer = [];
                commandStartTime = null;
            }
        }, 2000); // Wait 2 seconds after last output
    }
}

/**
 * Clean up all terminal resources
 */
function cleanupTerminalResources(): void {
    logWarning('[Terminal] Cleaning up terminal resources...');
    
    // Kill all active PTY processes
    for (const ptyProcess of activePtyProcesses) {
        try {
            if (ptyProcess && typeof ptyProcess.kill === 'function') {
                ptyProcess.kill('SIGKILL');
            }
        } catch (error) {
            logError(`[Terminal] Error killing PTY process: ${error}`);
        }
    }
    
    // Clean up fallback terminal
    if (fallbackTerminal) {
        fallbackTerminal.dispose();
        fallbackTerminal = null;
    }
    
    // Clean up output summary timeout
    if (outputSummaryTimeout) {
        clearTimeout(outputSummaryTimeout);
        outputSummaryTimeout = null;
    }
    
    // Clean up Korean composition timeout
    if (compositionTimeout) {
        clearTimeout(compositionTimeout);
        compositionTimeout = null;
    }
    
    activePtyProcesses.clear();
    terminalScreenLines = [];
    terminalInputLines = [];
    terminalBuffer = [];
    terminalOutputBuffer = [];
    currentLineIndex = -1;
    currentPtyProcess = null;
    currentInputBuffer = '';
    currentWordIndex = -1;
    currentLineWords = [];
    isReadingMode = false;
    
    // Clean up command output monitoring
    waitingForCommandOutput = false;
    commandStartTime = null;
    commandOutputBuffer = [];
    
    // Clean up suggestion dialog state
    suggestionDialogActive = false;
    pendingSuggestions = [];
    lastSuggestionTime = 0;
    
    // Clean up Korean composition buffer
    compositionBuffer = '';
    
    hideReadingModeUI();

    if (closeReadingAltScreen) closeReadingAltScreen();
    
    logSuccess('[Terminal] Terminal resources cleaned up');
}

/**
 * Get current terminal screen content
 */
function getCurrentScreenContent(): string[] {
    if (currentPtyProcess && typeof currentPtyProcess.getScreenContent === 'function') {
        try {
            return currentPtyProcess.getScreenContent();
        } catch (error) {
            logError(`[Terminal] Error getting screen content: ${error}`);
        }
    }
    
    // Fallback to stored screen lines
    return terminalScreenLines.filter(line => line.trim().length > 0);
}

/**
 * Clean terminal line from ANSI sequences and unwanted characters
 */
function cleanTerminalLine(line: string): string {
    // Strip ANSI/OSC/control chars only. DO NOT inject or rearrange spaces/tokens.
    // This avoids artifacts like "university .py" or ".pypython" that came from previous regex inserts.
    let cleaned = line
        // Remove CSI/SGR etc.
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
        // Remove OSC title sequences
        .replace(/\u001b\]0;.*?\u0007/g, '')
        // Extra ANSI fallbacks
        .replace(/\u001b\[[\d;]*[a-zA-Z]/g, '')
        // Carriage returns
        .replace(/\r/g, '')
        // Other control characters (keep tabs; they are part of spacing)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Zero-width / BOM
        .replace(/[\u200B-\u200D\uFEFF]/g, '');

    // IMPORTANT: Do not "fix" spacing (no camelCase or extension spacing). Preserve original tokens.
    // Do not trim: keep spacing exactly as emitted by the shell.
    return cleaned; // keep spacing exactly as emitted by the shell
}

/**
 * Handle Korean input composition
 * Korean characters might come in as multiple input events during IME composition
 */
function handleKoreanComposition(input: string): string | null {
    // If we receive what looks like a partial Korean character or composition
    if (input.length === 1) {
        const charCode = input.charCodeAt(0);
        
        // Check if this might be part of Korean composition
        // Korean composition often involves characters in these ranges during typing
        if ((charCode >= 0x1100 && charCode <= 0x11FF) || // Hangul Jamo
            (charCode >= 0x3130 && charCode <= 0x318F) || // Hangul Compatibility Jamo
            (charCode >= 0xA960 && charCode <= 0xA97F) || // Hangul Jamo Extended-A
            (charCode >= 0xD7B0 && charCode <= 0xD7FF)) { // Hangul Jamo Extended-B
            
            // This might be a composition character, buffer it
            compositionBuffer += input;
            
            // Clear any existing timeout
            if (compositionTimeout) {
                clearTimeout(compositionTimeout);
            }
            
            // Set a timeout to flush the composition buffer
            compositionTimeout = setTimeout(() => {
                if (compositionBuffer) {
                    log(`[Terminal] Flushing Korean composition buffer: "${compositionBuffer}"`);
                    const result = compositionBuffer;
                    compositionBuffer = '';
                    return result;
                }
            }, 100); // 100ms timeout for composition
            
            return null; // Don't process yet, wait for composition to complete
        }
    }
    
    // If we have a composition buffer and receive a complete Korean character, flush it
    if (compositionBuffer && containsKorean(input)) {
        const result = compositionBuffer + input;
        compositionBuffer = '';
        if (compositionTimeout) {
            clearTimeout(compositionTimeout);
            compositionTimeout = null;
        }
        log(`[Terminal] Korean composition complete: "${result}"`);
        return result;
    }
    
    // If we have a composition buffer and receive non-Korean input, flush the buffer first
    if (compositionBuffer) {
        const buffered = compositionBuffer;
        compositionBuffer = '';
        if (compositionTimeout) {
            clearTimeout(compositionTimeout);
            compositionTimeout = null;
        }
        log(`[Terminal] Flushing composition buffer before processing: "${buffered}" + "${input}"`);
        // Process the buffered content first, then the current input
        // For now, just return the current input and log the buffered content
        return input;
    }
    
    return input; // Return as-is for normal processing
}

/**
 * Check if input character is valid for terminal input
 * Supports ASCII printable characters, Korean characters, and other Unicode text
 */
function isValidInputCharacter(input: string): boolean {
    // Handle empty input
    if (!input || input.length === 0) {
        return false;
    }
    
    // Handle multi-character input (like composed characters or IME input)
    if (input.length > 1) {
        // Check if it's meaningful text (not control sequences)
        return /^[\p{L}\p{N}\p{P}\p{S}\p{M}\s]+$/u.test(input);
    }
    
    // Single character input
    const char = input;
    const charCode = char.charCodeAt(0);
    
    // ASCII printable characters (space to tilde)
    if (charCode >= 32 && charCode <= 126) {
        return true;
    }
    
    // Korean characters
    if (containsKorean(char)) {
        return true;
    }
    
    // Other Unicode letters, numbers, punctuation, symbols
    if (/[\p{L}\p{N}\p{P}\p{S}\p{M}]/u.test(char)) {
        return true;
    }
    
    return false;
}

/**
 * Check if line looks like a command prompt
 */
function isPromptLine(line: string): boolean {
    // Common prompt patterns - more comprehensive
    const promptPatterns = [
        /.*[@#$%>]\s*$/,  // Ends with @, #, $, %, or >
        /.*:\s*$/,        // Ends with colon
        /^\s*[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+.*[#$%>]\s*$/,  // user@host pattern
        /^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+.*[#$%>].*$/,      // user@host anywhere in line
        /gillosae@.*%/,   // Specific user prompt pattern
        /.*Mac.*Book.*Pro.*%/,  // Mac Book Pro prompt pattern
        /.*boost\d+.*%/   // boost project prompt pattern
    ];
    
    return promptPatterns.some(pattern => pattern.test(line));
}

/**
 * Update terminal screen buffer - capture complete lines only
 */
function updateScreenBuffer(data: string): void {
    // Accumulate data until we have complete lines
    terminalOutputBuffer.push(data);
    const fullBuffer = terminalOutputBuffer.join('');
    
    // Only process when we have complete lines (ending with newline)
    if (data.includes('\n') || data.includes('\r')) {
        // Split on either \n or \r (many shells use lone CR for line submission/redraw)
        const lines = fullBuffer.split(/[\r\n]+/);
        
        // Clear the buffer since we're processing it
        terminalOutputBuffer = [];
        
        // Keep the last incomplete line in buffer if any
        if (lines.length > 0 && !/[\r\n]$/.test(fullBuffer)) {
            terminalOutputBuffer.push(lines.pop() || '');
        }
        
        for (const line of lines) {
            const cleanLine = cleanTerminalLine(line);
            
            // Skip empty lines, single characters, or lines with only symbols
            if (cleanLine.length < 2 || /^[^\w\s]*$/.test(cleanLine)) {
                continue;
            }
            
            // Check if this is a new prompt (clear previous buffer on new command)
            if (isPromptLine(cleanLine)) {
                // This is a prompt line - clear previous incomplete entries
                log(`[Terminal] New prompt detected: "${cleanLine}"`);
                // Don't add the prompt itself, just note it
                continue;
            }
            
            // Add meaningful output
            addToTerminalBuffer('output', cleanLine);
            
            // Update current line index to track the latest entry in the combined buffer
            if (currentLineIndex < 0 && terminalBuffer.length > 0) {
                currentLineIndex = terminalBuffer.length - 1;
            }
        }
        
        // Initialize to last line if not set
        if (currentLineIndex < 0 && terminalBuffer.length > 0) {
            currentLineIndex = terminalBuffer.length - 1;
        }
    }
}

/**
 * Create PTY-based terminal with screen buffer capture
 */
function createPtyTerminal(pty: any): void {
    logSuccess('[Terminal] Creating PTY-based terminal with screen buffer');
    hasNodePty = true;
    
    // Reset state
    terminalScreenLines = [];
    terminalInputLines = [];
    terminalBuffer = [];
    currentLineIndex = -1;
    currentInputBuffer = '';
    isReadingMode = false;

    // Spawn shell with proper encoding for Korean support
    const shell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL']!;
    const env = { ...process.env };
    
    // Ensure UTF-8 encoding for Korean support
    if (process.platform !== 'win32') {
        env.LANG = env.LANG || 'en_US.UTF-8';
        env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
        env.LC_CTYPE = env.LC_CTYPE || 'en_US.UTF-8';
    }
    
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
        env: env,
        encoding: 'utf8' // Explicitly set UTF-8 encoding
    });
    
    // Store current process reference
    currentPtyProcess = ptyProcess;
    
    // Track process
    activePtyProcesses.add(ptyProcess);
    ptyProcess.onExit(() => {
        activePtyProcesses.delete(ptyProcess);
        if (currentPtyProcess === ptyProcess) {
            currentPtyProcess = null;
        }
    });

    // Terminal emitters
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<void>();

    // === Terminal dimensions tracking for proper layout ===
    let termCols = 100; // sensible default; will be updated by setDimensions
    let termRows = 30;

    function setTermSize(cols?: number, rows?: number) {
        if (typeof cols === 'number' && cols > 10) termCols = cols;
        if (typeof rows === 'number' && rows > 0) termRows = rows;
    }

    // ANSI + East-Asian width aware helpers (for perfect alignment)
    const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g; // CSI + final byte
    function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }
    // very small wcwidth approximation: treat common CJK ranges as width 2
    const CJK_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
    function charWidth(ch: string): number {
        if (!ch) return 0;
        // surrogate pairs handled as one char by iter over codepoints below
        return CJK_RE.test(ch) ? 2 : 1;
    }
    function visWidth(s: string): number {
        let w = 0;
        const plain = stripAnsi(s);
        for (const ch of plain) w += charWidth(ch);
        return w;
    }
    /**
     * padEndCutAnsiExact: returns a string whose VISIBLE width is EXACTLY `width`.
     * - Preserves ANSI when not truncated
     * - On truncation, returns plain text with ellipsis and then pads to exact width
     */
    function padEndCutAnsiExact(s: string, width: number): string {
        if (width <= 0) return '';
        const plain = stripAnsi(s);
        // fast path when no truncation needed
        let w = 0;
        for (const ch of plain) { w += charWidth(ch); }
        if (w === width) return s; // keep ANSI
        if (w < width) {
            // pad spaces to reach exact width
            return s + ' '.repeat(width - w);
        }
        // truncate to width-1 and add ellipsis (so user sees it's cut)
        let out = '';
        let acc = 0;
        for (const ch of plain) {
            const cw = charWidth(ch);
            if (acc + cw >= Math.max(1, width)) break; // leave space for ellipsis
            out += ch;
            acc += cw;
        }
        // ensure out width <= width-1
        const ell = '…';
        let outW = 0; for (const ch of out) outW += charWidth(ch);
        if (outW > Math.max(0, width - 1)) {
            // trim one more char if needed
            while (out && outW > Math.max(0, width - 1)) {
                const last = out.slice(0, -1);
                out = last;
                outW = 0; for (const ch of out) outW += charWidth(ch);
            }
        }
        // pad (shouldn't need, but for safety)
        const pad = Math.max(0, width - 1 - outW);
        return out + ' '.repeat(pad) + ell; // plain by design on truncation
    }


    // Display-only: very conservative spacing restoration so multi-column ls does not look glued
    // Never mutate the stored buffer; use only when rendering.
    function softVisualSpacing(s: string): string {
        if (!s) return s;
        let out = s;
        // Case 1 (safer): only split after a KNOWN extension when immediately followed by a letter (e.g., ".txtsrc" -> ".txt src", ".pyuniversity" -> ".py university")
        out = out.replace(/\.(txt|py|ts|js|jsx|tsx|json|md|csv|log|yml|yaml|ini|cfg|toml|sh|zsh|bash|env|lock)(?=[A-Za-z])/g, '.$1 ');
        // Case 2: known directory tokens that might appear glued to the next word ("srcuni" -> "src uni")
        out = out.replace(/\b(src|bin|dist|build|lib|include|node_modules)(?=[A-Za-z])/g, '$1 ');
        // Case 3: very common filename that may glue to previous token
        // e.g., "datarequirements.txt" -> "data requirements.txt"
        out = out.replace(/([A-Za-z0-9])(?=requirements\.(txt|in)\b)/g, '$1 ');
        // Case 4: if a directory token got separated from its slash ("src /university.py"), merge the space back
        out = out.replace(/([A-Za-z0-9_-])\s+\/(?=[^/])/g, '$1/');
        // Case 5: split when a known dir token is glued to previous letters ("asdfsdfdfddata" -> "asdfsdfdfd data")
        out = out.replace(/([A-Za-z0-9])(?=(src|bin|dist|build|lib|include|node_modules|data)\b)/g, '$1 ');
        return out;
    }

    // === Reading overlay (ANSI alt screen) helpers ===
    let altScreenActive = false;
    let pendingShellOutput: string[] = []; // 읽기 모드 동안 화면엔 안 찍고 여기에만 쌓음

    // ANSI helpers
    const CSI = "\u001b[";
    const SGR = (codes: string) => `${CSI}${codes}m`;
    const reset = SGR("0");
    const dim = SGR("2");
    const inverse = SGR("7");
    const bold = SGR("1");
    const fgCyan = SGR("38;5;45");
    const fgGreen = SGR("38;5;34");
    const fgBlue = SGR("38;5;33");
    const fgGray = SGR("38;5;246");
    const bgSel = SGR("48;5;236");
    const bgBox = SGR("48;5;250"); // bright light gray background for active line
    const fgBox = SGR("38;5;16");  // dark fg for contrast on the bright box

    function termWrite(s: string) { writeEmitter.fire(s); }
    function clearScreen() { termWrite("\u001b[2J\u001b[H"); }

    function renderReadingOverlay(): void {
        if (!altScreenActive) return;
        clearScreen();

        const total = terminalBuffer.length;
        const pos = Math.max(0, currentLineIndex);

        // compute layout sizes
        const colPadding = 2; // spaces between meta and content
        const digits = String(Math.max(1, total)).length;
        const metaFixed = 1 + digits + 1 /*# +ln +space*/ + 3 /*IN/OUT*/ + 1 /*space*/ + 8 /*hh:mm:ss fixed*/;
        const safeCols = Math.max(30, termCols || 100);
        const contentWidth = Math.max(10, safeCols - metaFixed - colPadding);

        // window around current line
        const windowSize = Math.max(8, Math.min(28, termRows - 4));
        const start = Math.max(0, pos - Math.floor(windowSize / 2));
        const end = Math.min(total, start + windowSize);
        const actualStart = Math.max(0, end - windowSize);

        // header (left-aligned, trimmed)
        const rangeText = `${actualStart + 1}-${end} of ${total}`;
        const hint = `↑/↓ line · ⌥←/→ word · Esc/Ctrl+H exit`;
        const headerLeft = `${bold}${fgCyan}Reading Mode${reset}`;
        const headerRight = `${fgGray}${rangeText}${reset}    ${dim}${hint}${reset}`;
        const header = padEndCutAnsiExact(headerLeft + '  ' + headerRight, safeCols);
        termWrite(header + "\n\n");

        // rows (left-aligned, fixed meta width, bright box for active line)
        for (let i = actualStart; i < end; i++) {
            const entry = terminalBuffer[i];
            const isActive = i === pos;

            const ln = String(i + 1).padStart(digits, ' ');
            const badge = entry.type === 'input' ? `${bold}${fgGreen}IN${reset}` : `${bold}${fgBlue}OUT${reset}`;
            const ts = entry.timestamp.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); // always HH:MM:SS

            // meta column: "#<ln> IN hh:mm:ss" (ANSI-colored but width-normalized)
            const metaAnsi = `${dim}#${ln}${reset} ${badge} ${dim}${ts}${reset}`;
            const metaOut = padEndCutAnsiExact(metaAnsi, metaFixed);

            // content column (plain text, truncated with ellipsis)
            let content = (entry.content || '').replace(/[\u0000-\u001F\u007F]/g, '');
            // Read-mode only: make tabs visible as 4 spaces for stable columns
            content = content.replace(/\t/g, '    ');
            // Display-only spacing fix so things like "datarequirements.txtsrc" read correctly
            content = softVisualSpacing(content);
            content = padEndCutAnsiExact(content, contentWidth);

            const spacer = ' '.repeat(colPadding);
            const linePlain = metaOut + spacer + content; // compose left-aligned row
            const row = padEndCutAnsiExact(linePlain, safeCols);

            if (isActive) {
                // bright box across the whole row (no inverse)
                termWrite(`${bgBox}${fgBox}${row}${reset}\n`);
            } else {
                termWrite(`${row}\n`);
            }
        }

        const footer = `${dim}Tip: 읽기 모드 동안 출력은 버퍼링되며, 종료 시 원래 화면으로 복귀합니다.${reset}`;
        termWrite("\n" + padEndCutAnsiExact(footer, safeCols) + "\n");
    }

    function enterAltScreen() {
        if (altScreenActive) return;
        altScreenActive = true;
        // alt-screen 진입, 화면 클리어, 커서 숨김
        termWrite("\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l");
        renderReadingOverlay();
    }

    function exitAltScreen() {
        if (!altScreenActive) return;
        // flush buffered shell output gathered during reading mode
        if (pendingShellOutput.length > 0) {
            termWrite(pendingShellOutput.join(''));
            pendingShellOutput = [];
        }
        // 커서 표시, alt-screen 종료 (원 화면 복귀)
        termWrite("\u001b[?25h\u001b[?1049l");
        altScreenActive = false;
        termWrite(`${dim}Exited Reading Mode${reset}\r\n`);
    }

    // 바깥 커맨드에서 접근 가능하도록 노출
    openReadingAltScreen = () => enterAltScreen();
    refreshReadingAltScreen = () => renderReadingOverlay();
    closeReadingAltScreen = () => exitAltScreen();



    // Capture output and update screen buffer
    ptyProcess.onData((data: string) => {
        // 1) While in Reading Mode, buffer to pending and parse as before
        if (isReadingMode) {
            pendingShellOutput.push(data);
            updateScreenBuffer(data);
            return;
        }

        // 2) Live-capture shell echo for TAB completion and inline edits
        //    When TAB is pressed, many shells print the completed tail or redraw the line.
        //    We approximate by:
        //      - starting capture when awaitingCompletion is true (after TAB)
        //      - appending visible chars to currentInputBuffer until newline
        try {
            const plain = data
                .replace(/\u001b\]0;.*?\u0007/g, '')      // strip OSC title
                .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // strip CSI
                .replace(/\u0007/g, '');                   // bell

            // start capture only when TAB was just pressed
            if (awaitingCompletion) {
                echoCaptureActive = true;
            }

            if (echoCaptureActive) {
                // Collect printable chars from this chunk (excluding CR/LF)
                let added = '';
                for (const ch of plain) {
                    const code = ch.charCodeAt(0);
                    if (ch === '\n') { echoCaptureActive = false; break; }
                    if (ch === '\r') { continue; }
                    if (code === 0x7f) { // shell backspace
                        if (currentInputBuffer.length > 0) currentInputBuffer = currentInputBuffer.slice(0, -1);
                        continue;
                    }
                    if (code >= 32) added += ch;
                }
                if (added) {
                    // Avoid duplicating what the user may have typed concurrently
                    const max = Math.min(currentInputBuffer.length, added.length);
                    let overlap = 0;
                    for (let len = max; len > 0; len--) {
                        if (currentInputBuffer.endsWith(added.slice(0, len))) { overlap = len; break; }
                    }
                    currentInputBuffer += added.slice(overlap);
                }
            }
            // stop capture if a newline was included in this chunk
            if (plain.includes('\n')) {
                echoCaptureActive = false;
            }
        } catch {}
        awaitingCompletion = false; // one-shot

        // 3) Always write to terminal and parse for history
        writeEmitter.fire(data);
        updateScreenBuffer(data);
    });

    // Simple pseudoterminal interface
    const ptyTerminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,

        open: () => {
            logSuccess('[Terminal] PTY terminal with screen buffer opened');
        },

        close: () => {
            logWarning('[Terminal] PTY terminal closed');
            ptyProcess.kill();
            closeEmitter.fire();
        },

        setDimensions: (dim: vscode.TerminalDimensions) => {
            if (!dim) return;
            setTermSize(dim.columns, dim.rows);
            if (altScreenActive) renderReadingOverlay();
            // keep the real PTY in sync to avoid wrapping mismatch
            try { if (ptyProcess && typeof ptyProcess.resize === 'function') ptyProcess.resize(dim.columns, dim.rows); } catch {}
        },

        handleInput: async (input: string) => {
            // Handle Korean input composition
            const processedInput = handleKoreanComposition(input);
            if (processedInput === null) {
                // Input is being composed, don't process yet
                return;
            }
            
            // Use the processed input for the rest of the function
            const finalInput = processedInput;
            
            // Handle reading mode navigation
            if (isReadingMode) {
                if (finalInput === '\u001b[A') { // Up arrow in reading mode
                    stopTerminalAudio();
                    await vscode.commands.executeCommand('lipcoder.terminalHistoryUp');
                    return;
                }
                if (finalInput === '\u001b[B') { // Down arrow in reading mode
                    stopTerminalAudio();
                    await vscode.commands.executeCommand('lipcoder.terminalHistoryDown');
                    return;
                }
                if (finalInput === '\u0008') { // Ctrl+H - toggle back to normal mode
                    stopAllAudio();
                    await vscode.commands.executeCommand('lipcoder.toggleTerminalReadingMode');
                    return;
                }
                // In reading mode, ignore other input except escape
                if (finalInput === '\u001b') { // Escape key - exit reading mode
                    stopAllAudio();
                    await vscode.commands.executeCommand('lipcoder.toggleTerminalReadingMode');
                    return;
                }
                return; // Ignore all other input in reading mode
            }
            
            // Normal terminal mode
            // Intercept Ctrl+H to enter reading mode
            if (finalInput === '\u0008') { // Ctrl+H
                stopAllAudio();
                await vscode.commands.executeCommand('lipcoder.toggleTerminalReadingMode');
                return;
            }

            // Track shell completion (TAB)
            if (finalInput === '\t') { // TAB: let the shell complete and capture its echo
                awaitingCompletion = true;
            }

            // Ctrl+C: cancel current input (do not submit it)
            if (finalInput === '\u0003') { // ETX
                currentInputBuffer = '';
                echoCaptureActive = false;
                awaitingCompletion = false;
                // let the shell handle SIGINT; we just ensure buffer separation
                ptyProcess.write(input);
                return;
            }

            // Handle regular input
            stopAllAudio();

            // Track input for buffer
            if (finalInput === '\r' || finalInput === '\n') {
                echoCaptureActive = false; // finalize echo capture on submit
                // Command submitted - add to input buffer and clear recent output noise
                if (currentInputBuffer.trim().length > 0) {
                    const command = currentInputBuffer.trim();

                    // Clear any recent noise from buffer before adding the command
                    // Remove last few entries if they look like command echoes or prompts
                    let removedCount = 0;
                    while (terminalBuffer.length > 0 && removedCount < 5) { // Limit removal to prevent over-cleaning
                        const lastEntry = terminalBuffer[terminalBuffer.length - 1];
                        if (lastEntry.type === 'output' &&
                            (lastEntry.content.includes(command) ||
                             lastEntry.content.length < 3 ||
                             isPromptLine(lastEntry.content) ||
                             lastEntry.content.includes('nnpm') || // Fix duplicate 'n' in npm
                             lastEntry.content.includes(command.substring(0, Math.min(command.length, 10))))) {
                            terminalBuffer.pop();
                            if (terminalScreenLines.length > 0) {
                                terminalScreenLines.pop();
                            }
                            removedCount++;
                        } else {
                            break;
                        }
                    }

                    // Only add command if it's not a duplicate of the last input
                    const lastInput = terminalBuffer.slice().reverse().find(entry => entry.type === 'input');
                    if (!lastInput || lastInput.content !== command) {
                        addToTerminalBuffer('input', command);
                        log(`[Terminal] Command executed: "${command}"`);

                        // Start monitoring for command output to provide summary
                        startCommandOutputMonitoring();
                    } else {
                        log(`[Terminal] Duplicate command ignored: "${command}"`);
                    }

                    currentInputBuffer = '';
                }
            } else if (finalInput === '\u007f' || finalInput === '\b') {
                // Backspace
                if (currentInputBuffer.length > 0) {
                    currentInputBuffer = currentInputBuffer.slice(0, -1);
                }
            } else if (isValidInputCharacter(finalInput)) {
                // Regular character (including Korean characters)
                currentInputBuffer += finalInput;
            }

            // Pass through to terminal (use original input for PTY)
            ptyProcess.write(input);

            // Simple character echo for typing feedback
            if (isValidInputCharacter(finalInput) && finalInput !== '\r' && finalInput !== '\n') {
                const chunks: TokenChunk[] = [{
                    tokens: [finalInput],
                    category: undefined // Use default voice as preferred [[memory:6411083]]
                }];
                await speakTokenList(chunks);
            }
        }
    };

    // Create and show terminal
    const terminal = vscode.window.createTerminal({ name: 'LipCoder', pty: ptyTerminal });
    terminal.show();
}

/**
 * Create fallback terminal
 */
function createFallbackTerminal(): void {
    logWarning('[Terminal] Creating fallback terminal');
    hasNodePty = false;
    
    terminalScreenLines = [];
    terminalInputLines = [];
    terminalBuffer = [];
    currentLineIndex = -1;
    currentInputBuffer = '';
    isReadingMode = false;

    fallbackTerminal = vscode.window.createTerminal({
        name: 'LipCoder Terminal (Fallback)',
        shellPath: process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'],
        cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
    });
    
    fallbackTerminal.show();
    
    vscode.window.showInformationMessage(
        'LipCoder Terminal: Fallback mode. Use "Add Terminal Output" to add content for navigation.',
        { modal: false }
    );
}

/**
 * Register terminal commands with simple navigation
 */
export function registerTerminalReader(context: ExtensionContext) {
    // Auto-open LipCoder terminal when other terminals close
    const terminalCloseListener = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
        if (closedTerminal.name !== 'LipCoder' && closedTerminal.name !== 'LipCoder Terminal (Fallback)') {
            await new Promise(resolve => setTimeout(resolve, 200));
            await vscode.commands.executeCommand('lipcoder.openTerminal');
            
            vscode.window.showInformationMessage('Terminal closed - LipCoder terminal opened', { modal: false });
            await speakTokenList([{ tokens: ['Terminal closed, LipCoder terminal opened'], category: undefined }]);
        }
    });
    
    context.subscriptions.push(terminalCloseListener);
    context.subscriptions.push(
        // Open LipCoder terminal
        vscode.commands.registerCommand('lipcoder.openTerminal', () => {
            let pty: any;
            try {
                pty = require('node-pty');
                createPtyTerminal(pty);
            } catch (err) {
                logError(`[Terminal] Failed to load node-pty: ${err}`);
                createFallbackTerminal();
            }
        }),

        // Toggle terminal reading mode (Ctrl+H)
        vscode.commands.registerCommand('lipcoder.toggleTerminalReadingMode', async () => {
            stopAllAudio();
            
            if (terminalBuffer.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available for reading mode'], category: undefined }]);
                return;
            }
            
            isReadingMode = !isReadingMode;
            
            if (isReadingMode) {
                // Entering reading mode: ALWAYS start from the most recent INPUT line; fallback to last line
                {
                    let idx = -1;
                    for (let i = terminalBuffer.length - 1; i >= 0; i--) {
                    if (terminalBuffer[i].type === 'input') { idx = i; break; }
                    }
                    currentLineIndex = (idx >= 0) ? idx : (terminalBuffer.length - 1);
                }
                
                // Log the entire terminal buffer to console
                log('[Terminal Reading Mode] Full terminal buffer:');
                log('='.repeat(80));
                terminalBuffer.forEach((entry, index) => {
                    const marker = index === currentLineIndex ? '>>> ' : '    ';
                    const timestamp = entry.timestamp.toLocaleTimeString();
                    log(`${marker}[${index + 1}] ${entry.type.toUpperCase()} (${timestamp}): ${entry.content}`);
                });
                log('='.repeat(80));
                log(`Total entries: ${terminalBuffer.length}, Current position: ${currentLineIndex + 1}`);
                
                showReadingModeUI();

                if (openReadingAltScreen) openReadingAltScreen();
                
                const enterReadingEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(enterReadingEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ 
                    tokens: [`Reading mode activated.`], // ${terminalBuffer.length} lines available. Use up and down arrows to navigate.
                    category: undefined 
                }]);
                
                // Read current line
                await new Promise(resolve => setTimeout(resolve, 500));
                const currentEntry = terminalBuffer[currentLineIndex];
                if (currentEntry) {
                    const lineTokens = parseTerminalLineToTokens(currentEntry.content);
                    const prefix = getSpokenPrefix(currentEntry.type);
                    const lineNumberChunk: TokenChunk = { tokens: [`${prefix} line ${currentLineIndex + 1}`], category: undefined };
                    await speakTerminalTokens([lineNumberChunk, ...lineTokens], 'Read current line');
                }
            } else {
                // Exiting reading mode
                hideReadingModeUI();

                if (closeReadingAltScreen) closeReadingAltScreen();
                
                const exitReadingEarcon = path.join(config.audioPath(), 'earcon', 'backspace.pcm');
                await playWave(exitReadingEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ tokens: ['Reading mode deactivated. Terminal is now interactive.'], category: undefined }]);
            }
        }),

        // Read current terminal screen content
        vscode.commands.registerCommand('lipcoder.terminalReadHistory', async () => {
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Stop any previous reading immediately
            stopAllAudio();
            
            // Read last 5 screen lines
            const recentLines = terminalScreenLines.slice(-5);
            const screenText = recentLines.join(' ... ');
            
            const historyEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
            await playWave(historyEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ tokens: ['Terminal screen:', screenText], category: undefined }]);
        }),

        // Read last terminal line
        vscode.commands.registerCommand('lipcoder.terminalReadLast', async () => {
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content'], category: undefined }]);
                return;
            }
            
            // Stop any previous reading immediately
            stopAllAudio();
            const lastLine = terminalScreenLines[terminalScreenLines.length - 1];
            
            const lastEarcon = path.join(config.audioPath(), 'earcon', 'dot.pcm');
            await playWave(lastEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            await speakTokenList([{ tokens: [lastLine], category: undefined }]);
        }),

        // Navigate up through terminal buffer
        vscode.commands.registerCommand('lipcoder.terminalHistoryUp', async () => {
            // Use aggressive terminal-specific stopping
            stopTerminalAudio();
            
            logFeatureUsage('terminalHistoryUp', 'navigate');
            
            if (terminalBuffer.length === 0) {
                await speakTerminalTokens([{ tokens: ['No terminal content available'], category: undefined }], 'No content message');
                return;
            }
            
            // Initialize to last line if not set
            if (currentLineIndex < 0) {
                currentLineIndex = terminalBuffer.length - 1;
            } else {
                const newIndex = currentLineIndex - 1;
                if (newIndex < 0) {
                    // Already at top, give feedback but don't read line again
                    const topEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    await playWave(topEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await speakTerminalTokens([{ tokens: ['Top of terminal buffer'], category: undefined }], 'Top of buffer message');
                    return;
                }
                currentLineIndex = newIndex;
            }
            
            const currentEntry = terminalBuffer[currentLineIndex];
            const lineNumber = currentLineIndex + 1;
            
            
            // Update UI if in reading mode
            if (isReadingMode) {
                showReadingModeUI();
            }
            if (isReadingMode && refreshReadingAltScreen) refreshReadingAltScreen();
            
            // Play navigation earcon
            const upEarcon = path.join(config.audioPath(), 'earcon', 'indent_1.pcm');
            await playWave(upEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (!currentEntry || currentEntry.content.trim().length === 0) {
                const prefix = getSpokenPrefix((currentEntry?.type as ('input'|'output')) || 'output');
                await speakTerminalTokens([{ tokens: [`${prefix} line ${lineNumber} empty`], category: undefined }], 'History line (empty)');
            } else {
                // Parse the terminal line into proper tokens with earcons
                const lineTokens = parseTerminalLineToTokens(currentEntry.content);
                const prefix = getSpokenPrefix(currentEntry.type);
                const lineNumberChunk: TokenChunk = { tokens: [`${prefix} line ${lineNumber}`], category: undefined };
                await speakTerminalTokens([lineNumberChunk, ...lineTokens], 'History line');
            }
        }),

        // Navigate down through terminal buffer
        vscode.commands.registerCommand('lipcoder.terminalHistoryDown', async () => {
            // Use aggressive terminal-specific stopping
            stopTerminalAudio();
            
            logFeatureUsage('terminalHistoryDown', 'navigate');
            
            if (terminalBuffer.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Initialize to first line if not set
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
            } else {
                const newIndex = currentLineIndex + 1;
                if (newIndex >= terminalBuffer.length) {
                    // Already at bottom, give feedback
                    const bottomEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    await playWave(bottomEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await speakTokenList([{ tokens: ['Bottom of terminal buffer'], category: undefined }]);
                    return;
                }
                currentLineIndex = newIndex;
            }
            
            const currentEntry = terminalBuffer[currentLineIndex];
            const lineNumber = currentLineIndex + 1;
            
            
            // Update UI if in reading mode
            if (isReadingMode) {
                showReadingModeUI();
            }
            if (isReadingMode && refreshReadingAltScreen) refreshReadingAltScreen();
            
            // Play navigation earcon
            const downEarcon = path.join(config.audioPath(), 'earcon', 'indent_2.pcm');
            await playWave(downEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (!currentEntry || currentEntry.content.trim().length === 0) {
                const prefix = getSpokenPrefix((currentEntry?.type as ('input'|'output')) || 'output');
                await speakTerminalTokens([{ tokens: [`${prefix} line ${lineNumber} empty`], category: undefined }], 'History line (empty)');
            } else {
                // Parse the terminal line into proper tokens with earcons
                const lineTokens = parseTerminalLineToTokens(currentEntry.content);
                const prefix = getSpokenPrefix(currentEntry.type);
                const lineNumberChunk: TokenChunk = { tokens: [`${prefix} line ${lineNumber}`], category: undefined };
                await speakTerminalTokens([lineNumberChunk, ...lineTokens], 'History line');
            }
        }),

        // Clear terminal screen buffer
        vscode.commands.registerCommand('lipcoder.terminalClearHistory', async () => {
            terminalScreenLines = [];
            terminalInputLines = [];
            terminalBuffer = [];
            terminalOutputBuffer = [];
            currentLineIndex = -1;
            currentInputBuffer = '';
            isReadingMode = false;
            hideReadingModeUI();

            if (closeReadingAltScreen) closeReadingAltScreen();
            
            const clearEarcon = path.join(config.audioPath(), 'earcon', 'backspace.pcm');
            await playWave(clearEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ tokens: ['Terminal buffer cleared'], category: undefined }]);
        }),

        // Capture current terminal content manually
        vscode.commands.registerCommand('lipcoder.captureTerminalOutput', async () => {
            const activeTerminal = vscode.window.activeTerminal;
            if (!activeTerminal) {
                await speakTokenList([{ tokens: ['No active terminal to capture'], category: undefined }]);
                return;
            }

            // Get clipboard content before and after selection
            const originalClipboard = await vscode.env.clipboard.readText();
            
            // Select all terminal content
            await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Copy to clipboard
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Get the copied content
            const terminalContent = await vscode.env.clipboard.readText();
            
            // Restore original clipboard
            await vscode.env.clipboard.writeText(originalClipboard);
            
            if (terminalContent && terminalContent !== originalClipboard) {
                // Clear existing buffers
                terminalScreenLines = [];
                terminalInputLines = [];
                terminalBuffer = [];
                terminalOutputBuffer = [];
                
                // Process the captured content
                const lines = terminalContent.split(/\r?\n/);
                for (const line of lines) {
                    const cleanLine = cleanTerminalLine(line);
                    
                    // Skip empty lines, single characters, or lines with only symbols
                    if (cleanLine.length < 2 || /^[^\w\s]*$/.test(cleanLine)) {
                        continue;
                    }
                    
                    // Skip prompt lines
                    if (isPromptLine(cleanLine)) {
                        continue;
                    }
                    
                    // Try to detect if this is input (command) or output
                    // Look for common command patterns
                    const commandPatterns = /^(ls|cd|pwd|cat|grep|find|npm|node|git|mkdir|rm|cp|mv|echo|clear|history)\b/;
                    const isInput = commandPatterns.test(cleanLine) || 
                                   cleanLine.split(' ').length <= 3; // Short commands are likely input
                    
                    addToTerminalBuffer(isInput ? 'input' : 'output', cleanLine);
                }
                
                // Set current position to the last line
                currentLineIndex = terminalBuffer.length - 1;
                
                const captureEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(captureEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ 
                    tokens: [`Captured ${terminalBuffer.length} lines from terminal. Press Ctrl+H to enter reading mode.`], 
                    category: undefined 
                }]);
            } else {
                await speakTokenList([{ tokens: ['No terminal content captured'], category: undefined }]);
            }
        }),

        // Add manual output (for fallback mode)
        vscode.commands.registerCommand('lipcoder.addTerminalOutput', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter terminal output to add to screen buffer',
                placeHolder: 'Terminal output...'
            });
            
            if (input && input.trim()) {
                // Ask user if this is input or output
                const entryType = await vscode.window.showQuickPick(
                    ['Output', 'Input'],
                    { placeHolder: 'Is this terminal input or output?' }
                );
                
                if (entryType) {
                    addToTerminalBuffer(entryType.toLowerCase() as 'input' | 'output', input.trim());
                    
                    // Set current line to the newly added line
                    currentLineIndex = terminalBuffer.length - 1;
                }
                
                const confirmEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(confirmEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: ['Added to terminal screen'], category: undefined }]);
            }
        }),

        // Quick setup for your terminal content
        vscode.commands.registerCommand('lipcoder.setupTerminalDemo', async () => {
            stopAllAudio();
            
            // Clear existing content
            terminalScreenLines = [];
            terminalInputLines = [];
            terminalBuffer = [];
            
            // Add the lines with proper input/output classification
            const demoEntries = [
                { type: 'input' as const, content: 'npm start' },
                { type: 'output' as const, content: '> boost1-university-search@1.0.0 start' },
                { type: 'output' as const, content: 'ts-node src/university.ts' },
                { type: 'output' as const, content: '=== University API Challenge ===' },
                { type: 'output' as const, content: 'Problem 1: Fetching US universities...' },
                { type: 'output' as const, content: 'fetchUSUniversities function not implemented' },
                { type: 'output' as const, content: 'Usage:' },
                { type: 'output' as const, content: 'npm start    # Run all university challenges' },
                { type: 'input' as const, content: 'gillosae@gimgillosaui-MacBookPro boost1 %' }
            ];
            
            // Add entries to buffer
            for (const entry of demoEntries) {
                addToTerminalBuffer(entry.type, entry.content);
            }
            
            // Set current position to the bottom (prompt line)
            currentLineIndex = terminalBuffer.length - 1;
            
            const confirmEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
            await playWave(confirmEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ 
                tokens: [`Demo terminal content loaded. ${terminalBuffer.length} lines ready. Press Ctrl+H to enter reading mode.`], 
                category: undefined 
            }]);
        }),

        // Debug terminal state
        vscode.commands.registerCommand('lipcoder.debugTerminalState', async () => {
            stopAllAudio();
            
            const totalLines = terminalBuffer.length;
            const currentPos = currentLineIndex + 1; // 1-based for user
            const inputLines = terminalInputLines.length;
            const outputLines = terminalScreenLines.length;
            
            // Also log to console for debugging
            console.log('[Terminal Debug]', {
                totalLines,
                currentPos,
                inputLines,
                outputLines,
                isReadingMode,
                terminalBuffer,
                currentLineIndex
            });
            
            await speakTokenList([{ 
                tokens: [`Terminal has ${totalLines} total lines (${inputLines} input, ${outputLines} output), currently at line ${currentPos}. Reading mode: ${isReadingMode ? 'on' : 'off'}`], 
                category: undefined 
            }]);
            
            // If no lines, suggest manual addition
            if (totalLines === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await speakTokenList([{ 
                    tokens: ['Use Add Terminal Output command to add content manually'], 
                    category: undefined 
                }]);
            }
        }),

        // Debug editor tracking state
        vscode.commands.registerCommand('lipcoder.debugEditorTracking', async () => {
            stopAllAudio();
            
            const { debugEditorTracking, getLastActiveEditor, getRecentEditors } = await import('./last_editor_tracker.js');
            
            // Log debug info to console
            debugEditorTracking();
            
            // Get current state
            const lastEditor = getLastActiveEditor();
            const recentEditors = getRecentEditors();
            const currentActive = vscode.window.activeTextEditor;
            
            let statusMessage = `Editor tracking: ${recentEditors.length} recent editors tracked. `;
            statusMessage += `Current active: ${currentActive ? 'yes' : 'no'}. `;
            statusMessage += `Last active available: ${lastEditor ? 'yes' : 'no'}.`;
            
            if (lastEditor) {
                const fileName = lastEditor.document.fileName.split('/').pop() || 'unknown';
                statusMessage += ` Last editor: ${fileName}`;
            }
            
            await speakTokenList([{ 
                tokens: [statusMessage], 
                category: undefined 
            }]);
        }),

        // Kill terminal and open LipCoder terminal
        vscode.commands.registerCommand('lipcoder.killTerminalAndOpenLipCoder', async () => {
            const activeTerminal = vscode.window.activeTerminal;
            
            if (activeTerminal) {
                activeTerminal.dispose();
                
                const killEarcon = path.join(config.audioPath(), 'earcon', 'backspace.pcm');
                await playWave(killEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await vscode.commands.executeCommand('lipcoder.openTerminal');
                
                await speakTokenList([{ tokens: ['Terminal killed, LipCoder terminal opened'], category: undefined }]);
            } else {
                await vscode.commands.executeCommand('lipcoder.openTerminal');
                await speakTokenList([{ tokens: ['No active terminal, LipCoder terminal opened'], category: undefined }]);
            }
        }),

        // Navigate to next word in current terminal line (Option+Right Arrow)
        vscode.commands.registerCommand('lipcoder.terminalWordRight', async () => {
            stopAllAudio();
            
            logFeatureUsage('terminalWordRight', 'navigate');
            
            if (terminalBuffer.length === 0 || currentLineIndex < 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Ensure word navigation state is updated
            updateWordNavigationState();

            if (currentLineWords.length === 0) {
                await speakTokenList([{ tokens: ['No words in current line'], category: undefined }]);
                return;
            }
            
            // Move to next word
            const newWordIndex = currentWordIndex + 1;
            if (newWordIndex >= currentLineWords.length) {
                // Already at last word, give feedback
                const endEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                await playWave(endEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ tokens: ['End of line'], category: undefined }]);
                return;
            }
            
            currentWordIndex = newWordIndex;
            const currentWord = currentLineWords[currentWordIndex];
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Read the current word
            await speakTokenList([{ tokens: [currentWord], category: undefined }]);
        }),

        // Navigate to previous word in current terminal line (Option+Left Arrow)
        vscode.commands.registerCommand('lipcoder.terminalWordLeft', async () => {
            stopAllAudio();
            
            logFeatureUsage('terminalWordLeft', 'navigate');
            
            if (terminalBuffer.length === 0 || currentLineIndex < 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Ensure word navigation state is updated
            updateWordNavigationState();

            if (currentLineWords.length === 0) {
                await speakTokenList([{ tokens: ['No words in current line'], category: undefined }]);
                return;
            }
            
            // Initialize to last word if not set
            if (currentWordIndex < 0) {
                currentWordIndex = currentLineWords.length - 1;
            } else {
                const newWordIndex = currentWordIndex - 1;
                if (newWordIndex < 0) {
                    // Already at first word, give feedback
                    const startEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    await playWave(startEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await speakTokenList([{ tokens: ['Beginning of line'], category: undefined }]);
                    return;
                }
                currentWordIndex = newWordIndex;
            }
            
            const currentWord = currentLineWords[currentWordIndex];
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Read the current word
            await speakTokenList([{ tokens: [currentWord], category: undefined }]);
        })
    );
    
    // Register cleanup
    context.subscriptions.push({
        dispose: cleanupTerminalResources
    });
}