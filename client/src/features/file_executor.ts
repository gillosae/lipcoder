import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ExtensionContext } from 'vscode';
import { speakGPT, speakTokenList } from '../audio';
import { log, logError } from '../utils';
import { stopReading } from './stop_reading';
import { executeCommandInLipCoderTerminal } from './terminal';
import { logFeatureUsage, logCommandExecution } from '../activity_logger';
import { comprehensiveEventTracker } from '../comprehensive_event_tracker';

interface ExecutionConfig {
    command: string;
    args?: string[];
    workingDirectory?: string;
    requiresTerminal?: boolean;
}

interface FileExecutionResult {
    success: boolean;
    message: string;
    filePath?: string;
    command?: string;
}

/**
 * File execution mappings based on file extensions
 */
const FILE_EXECUTION_MAP: Record<string, ExecutionConfig> = {
    // Python files
    '.py': {
        command: 'python',
        requiresTerminal: true
    },
    
    // JavaScript/Node.js files
    '.js': {
        command: 'node',
        requiresTerminal: true
    },
    
    // TypeScript files (requires compilation)
    '.ts': {
        command: 'npx',
        args: ['ts-node'],
        requiresTerminal: true
    },
    
    // Shell scripts
    '.sh': {
        command: 'bash',
        requiresTerminal: true
    },
    
    // Batch files (Windows)
    '.bat': {
        command: 'cmd',
        args: ['/c'],
        requiresTerminal: true
    },
    
    // PowerShell scripts
    '.ps1': {
        command: 'powershell',
        args: ['-ExecutionPolicy', 'Bypass', '-File'],
        requiresTerminal: true
    },
    
    // Java files (compile and run)
    '.java': {
        command: 'javac',
        requiresTerminal: true
    },
    
    // C/C++ files (requires compilation)
    '.c': {
        command: 'gcc',
        args: ['-o'],
        requiresTerminal: true
    },
    '.cpp': {
        command: 'g++',
        args: ['-o'],
        requiresTerminal: true
    },
    
    // Go files
    '.go': {
        command: 'go',
        args: ['run'],
        requiresTerminal: true
    },
    
    // Rust files
    '.rs': {
        command: 'rustc',
        requiresTerminal: true
    },
    
    // Ruby files
    '.rb': {
        command: 'ruby',
        requiresTerminal: true
    },
    
    // PHP files
    '.php': {
        command: 'php',
        requiresTerminal: true
    },
    
    // Perl files
    '.pl': {
        command: 'perl',
        requiresTerminal: true
    }
};

/**
 * Execute the currently active file in the editor
 */
export async function executeCurrentFile(): Promise<void> {
    try {
        stopReading();
        
        // Get the currently active editor
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!activeEditor) {
            await speakGPT('현재 열린 파일이 없습니다');
            vscode.window.showWarningMessage('현재 열린 파일이 없습니다', { modal: false });
            return;
        }

        const document = activeEditor.document;
        const filePath = document.uri.fsPath;
        const fileName = path.basename(filePath);
        
        // Check if the file is saved
        if (document.isDirty) {
            await speakGPT('파일을 저장하고 실행합니다');
            await document.save();
        }

        // Check if the file is executable
        if (!isExecutableFile(fileName)) {
            const extension = path.extname(fileName);
            await speakGPT(`${extension} 파일은 실행할 수 없습니다`);
            vscode.window.showWarningMessage(`${extension} 파일은 실행할 수 없습니다`, { modal: false });
            return;
        }

        await speakGPT(`${fileName} 파일을 실행합니다`);
        
        // Execute the file
        const result = await executeFile(fileName);
        
        if (result.success) {
            await speakGPT('파일 실행이 완료되었습니다');
        } else {
            await speakGPT(`실행 실패: ${result.message}`);
        }

    } catch (error) {
        logError(`[FileExecutor] Error executing current file: ${error}`);
        await speakGPT('파일 실행 중 문제가 발생했습니다');
        vscode.window.showErrorMessage(`파일 실행 실패: ${error}`, { modal: false });
    }
}

export function registerFileExecutor(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.executeFile', async (...args: any[]) => {
            stopReading();
            
            // Extract filename from arguments
            let filename = '';
            
            // Try to get filename from arguments
            for (const arg of args) {
                if (typeof arg === 'string' && arg.trim()) {
                    filename = arg.trim();
                    break;
                }
            }
            
            // If no filename provided, try to get from active editor
            if (!filename) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    filename = path.basename(activeEditor.document.fileName);
                } else {
                    await speakGPT('파일명을 제공하거나 파일을 열어주세요');
                    return;
                }
            }
            
            try {
                const result = await executeFile(filename);
                if (result.success) {
                    await speakGPT(result.message);
                } else {
                    await speakGPT(`실행 실패: ${result.message}`);
                }
            } catch (error) {
                logError(`File execution error: ${error}`);
                await speakGPT(`파일 실행 중 오류가 발생했습니다: ${error}`);
            }
        }),
        
        vscode.commands.registerCommand('lipcoder.executeCurrentFile', executeCurrentFile)
    );
}

/**
 * Execute a file based on its extension
 */
export async function executeFile(filename: string): Promise<FileExecutionResult> {
    // Track file execution start
    comprehensiveEventTracker.trackFeatureStart('file_execution', { filename });
    logFeatureUsage('file_executor', 'execute_file_started', { filename });
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        comprehensiveEventTracker.trackFeatureStop('file_execution', false, { 
            filename, 
            error: 'no_workspace_folder' 
        });
        return {
            success: false,
            message: '워크스페이스 폴더가 열려있지 않습니다'
        };
    }
    
    // Find the file in the workspace
    const filePath = await findFileInWorkspace(filename);
    if (!filePath) {
        comprehensiveEventTracker.trackFeatureStop('file_execution', false, { 
            filename, 
            error: 'file_not_found' 
        });
        return {
            success: false,
            message: `파일을 찾을 수 없습니다: ${filename}`
        };
    }
    
    const fileExtension = path.extname(filePath).toLowerCase();
    const executionConfig = FILE_EXECUTION_MAP[fileExtension];
    
    if (!executionConfig) {
        comprehensiveEventTracker.trackFeatureStop('file_execution', false, { 
            filename, 
            filePath,
            fileExtension,
            error: 'unsupported_file_type' 
        });
        return {
            success: false,
            message: `지원하지 않는 파일 형식입니다: ${fileExtension}`
        };
    }
    
    // Build the execution command
    const command = buildExecutionCommand(filePath, executionConfig);
    const workingDir = path.dirname(filePath);
    
    // Try to execute in LipCoder terminal first
    const cdCommand = `cd "${workingDir}"`;
    const cdSuccess = await executeCommandInLipCoderTerminal(cdCommand);
    
    if (cdSuccess) {
        // Wait a bit for cd to complete, then execute the file
        await new Promise(resolve => setTimeout(resolve, 200));
        const execSuccess = await executeCommandInLipCoderTerminal(command);
        
        if (execSuccess) {
            // Focus the terminal
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
        } else {
            // Fallback: create or use LipCoder terminal
            log(`[FileExecutor] PTY command failed, using LipCoder terminal fallback`);
            const terminal = await getOrCreateTerminal();
            terminal.sendText(cdCommand);
            terminal.sendText(command);
            terminal.show();
        }
    } else {
        // Fallback: create or use LipCoder terminal
        log(`[FileExecutor] No LipCoder terminal available, using terminal fallback`);
        const terminal = await getOrCreateTerminal();
        terminal.sendText(cdCommand);
        terminal.sendText(command);
        terminal.show();
    }
    
    // Track successful file execution
    comprehensiveEventTracker.trackFeatureStop('file_execution', true, { 
        filename, 
        filePath,
        fileExtension,
        command
    });
    logFeatureUsage('file_executor', 'execute_file_completed', { 
        filename, 
        filePath, 
        command 
    });
    
    return {
        success: true,
        message: `${path.basename(filePath)} 실행됨`,
        filePath: filePath,
        command: command
    };
}

/**
 * Calculate similarity between two strings using Levenshtein distance
 */
function calculateSimilarity(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    
    // Create matrix
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));
    
    // Initialize first row and column
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    // Fill matrix
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,     // deletion
                matrix[i][j - 1] + 1,     // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }
    
    const distance = matrix[len1][len2];
    const maxLength = Math.max(len1, len2);
    return maxLength === 0 ? 1 : (maxLength - distance) / maxLength;
}

/**
 * Find a file in the workspace by name with fuzzy matching for ASR errors
 */
async function findFileInWorkspace(filename: string): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;
    
    // First try exact match
    const exactPattern = `**/${filename}`;
    let files = await vscode.workspace.findFiles(exactPattern, '**/node_modules/**', 50);
    
    if (files.length > 0) {
        log(`[FileExecutor] Found exact match for: ${filename}`);
        return files[0].fsPath;
    }
    
    // If no exact match, try case-insensitive
    const toCaseInsensitiveGlob = (name: string) => name.split('').map(ch => {
        if (/[a-zA-Z]/.test(ch)) {
            return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
        }
        return ch;
    }).join('');
    
    const caseInsensitivePattern = `**/${toCaseInsensitiveGlob(filename)}`;
    files = await vscode.workspace.findFiles(caseInsensitivePattern, '**/node_modules/**', 50);
    
    if (files.length > 0) {
        log(`[FileExecutor] Found case-insensitive match for: ${filename}`);
        return files[0].fsPath;
    }
    
    // If still no match, try fuzzy matching with all executable files
    const supportedExtensions = getSupportedExtensions();
    const allExecutableFiles: vscode.Uri[] = [];
    
    // Search for all files with supported extensions
    for (const ext of supportedExtensions) {
        const extFiles = await vscode.workspace.findFiles(`**/*${ext}`, '**/node_modules/**', 100);
        allExecutableFiles.push(...extFiles);
    }
    
    if (allExecutableFiles.length === 0) {
        log(`[FileExecutor] No executable files found in workspace`);
        return null;
    }
    
    // Extract base name without extension for comparison
    const inputBasename = path.basename(filename, path.extname(filename)).toLowerCase();
    
    // Score files by similarity
    const scoredFiles = allExecutableFiles.map(file => {
        const basename = path.basename(file.fsPath);
        const basenameNoExt = path.basename(file.fsPath, path.extname(file.fsPath)).toLowerCase();
        const relativePath = vscode.workspace.asRelativePath(file);
        
        let score = 0;
        
        // Exact match (case-insensitive, without extension)
        if (basenameNoExt === inputBasename) {
            score += 1000;
        }
        // Starts with input
        else if (basenameNoExt.startsWith(inputBasename)) {
            score += 800;
        }
        // Input starts with basename (for partial matches like "univ" -> "university")
        else if (inputBasename.startsWith(basenameNoExt)) {
            score += 700;
        }
        // Contains input
        else if (basenameNoExt.includes(inputBasename)) {
            score += 600;
        }
        // Input contains basename
        else if (inputBasename.includes(basenameNoExt)) {
            score += 500;
        }
        
        // Calculate string similarity for fuzzy matching (handles ASR errors like .by -> .py)
        const similarity = calculateSimilarity(inputBasename, basenameNoExt);
        score += similarity * 400; // Weight similarity heavily
        
        // Also check similarity with full filename (including extension)
        const fullSimilarity = calculateSimilarity(filename.toLowerCase(), basename.toLowerCase());
        score += fullSimilarity * 300;
        
        // Prefer files in root or shallow directories
        const pathDepth = relativePath.split('/').length;
        if (pathDepth === 1) {
            score += 50; // Root level
        } else if (pathDepth === 2) {
            score += 25; // One level deep
        }
        
        // Prefer shorter paths
        score += Math.max(0, 20 - relativePath.length / 5);
        
        // Prefer common file types
        const ext = path.extname(file.fsPath).toLowerCase();
        if (['.py', '.js', '.ts'].includes(ext)) {
            score += 10;
        }
        
        return { file, score, basename, similarity, fullSimilarity };
    });
    
    // Sort by score and filter out very low similarity matches
    scoredFiles.sort((a, b) => b.score - a.score);
    
    // Only return matches with reasonable similarity (at least 30% similar)
    const bestMatch = scoredFiles[0];
    if (bestMatch && (bestMatch.similarity > 0.3 || bestMatch.fullSimilarity > 0.3 || bestMatch.score > 600)) {
        log(`[FileExecutor] Found fuzzy match: ${bestMatch.basename} (similarity: ${bestMatch.similarity.toFixed(2)}, score: ${bestMatch.score})`);
        return bestMatch.file.fsPath;
    }
    
    log(`[FileExecutor] No suitable match found for: ${filename}`);
    return null;
}

/**
 * Build the execution command based on file and configuration
 */
function buildExecutionCommand(filePath: string, config: ExecutionConfig): string {
    const filename = path.basename(filePath);
    const filenameWithoutExt = path.basename(filePath, path.extname(filePath));
    
    let command = config.command;
    
    // Add arguments if specified
    if (config.args) {
        command += ' ' + config.args.join(' ');
    }
    
    // Handle special cases
    const ext = path.extname(filePath).toLowerCase();
    
    switch (ext) {
        case '.java':
            // Java requires compilation first, then execution
            return `javac "${filename}" && java "${filenameWithoutExt}"`;
            
        case '.c':
            // C requires compilation first, then execution
            return `gcc "${filename}" -o "${filenameWithoutExt}" && ./"${filenameWithoutExt}"`;
            
        case '.cpp':
            // C++ requires compilation first, then execution
            return `g++ "${filename}" -o "${filenameWithoutExt}" && ./"${filenameWithoutExt}"`;
            
        case '.rs':
            // Rust requires compilation first, then execution
            return `rustc "${filename}" && ./"${filenameWithoutExt}"`;
            
        case '.go':
            // Go run handles compilation automatically
            return `${command} "${filename}"`;
            
        case '.ts':
            // TypeScript with ts-node
            return `${command} "${filename}"`;
            
        case '.bat':
            // Windows batch file
            return `${command} "${filename}"`;
            
        case '.ps1':
            // PowerShell script
            return `${command} "${filename}"`;
            
        default:
            // Default case: just run the command with the filename
            return `${command} "${filename}"`;
    }
}

/**
 * Get or create a terminal for file execution - prefer existing LipCoder terminal
 */
async function getOrCreateTerminal(): Promise<vscode.Terminal> {
    // First, look for existing LipCoder terminal (exact match)
    let existingTerminal = vscode.window.terminals.find(terminal => 
        terminal.name === 'LipCoder' || terminal.name === 'LipCoder Terminal (Fallback)'
    );
    
    if (existingTerminal) {
        return existingTerminal;
    }
    
    // If no exact LipCoder terminal, look for any LipCoder-related terminal
    existingTerminal = vscode.window.terminals.find(terminal => 
        terminal.name.includes('LipCoder') || terminal.name.includes('lipcoder')
    );
    
    if (existingTerminal) {
        return existingTerminal;
    }
    
    // If no LipCoder terminal exists, try to open one using the command
    try {
        await vscode.commands.executeCommand('lipcoder.openTerminal');
        
        // Wait a bit for the terminal to be created
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Try to find the newly created LipCoder terminal
        const newTerminal = vscode.window.terminals.find(terminal => 
            terminal.name === 'LipCoder' || terminal.name === 'LipCoder Terminal (Fallback)' ||
            terminal.name.includes('LipCoder') || terminal.name.includes('lipcoder')
        );
        
        if (newTerminal) {
            return newTerminal;
        }
    } catch (error) {
        log(`Failed to open LipCoder terminal: ${error}`);
    }
    
    // Final fallback: create a LipCoder terminal using the official command
    // This ensures we get a proper LipCoder terminal with all features
    try {
        log(`[FileExecutor] Creating new LipCoder terminal as final fallback`);
        await vscode.commands.executeCommand('lipcoder.openTerminal');
        
        // Wait longer for the terminal to be fully created
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Find the newly created terminal
        const finalTerminal = vscode.window.terminals.find(terminal => 
            terminal.name === 'LipCoder' || 
            terminal.name === 'LipCoder Terminal (Fallback)' ||
            terminal.name.includes('LipCoder')
        );
        
        if (finalTerminal) {
            log(`[FileExecutor] Successfully created LipCoder terminal: ${finalTerminal.name}`);
            return finalTerminal;
        }
    } catch (error) {
        log(`[FileExecutor] Failed to create LipCoder terminal: ${error}`);
    }
    
    // Absolute final fallback: create a basic terminal with LipCoder name
    log(`[FileExecutor] Creating basic terminal as absolute final fallback`);
    const terminal = vscode.window.createTerminal({
        name: 'LipCoder Terminal',
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
    
    return terminal;
}

/**
 * Get supported file extensions
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(FILE_EXECUTION_MAP);
}

/**
 * Check if a file extension is supported for execution
 */
export function isExecutableFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ext in FILE_EXECUTION_MAP;
}

/**
 * Get execution info for a file extension
 */
export function getExecutionInfo(filename: string): ExecutionConfig | null {
    const ext = path.extname(filename).toLowerCase();
    return FILE_EXECUTION_MAP[ext] || null;
}
