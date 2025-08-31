import * as vscode from 'vscode';
import { log, logError, logSuccess, logWarning } from '../utils';
import { getOpenAIClient } from '../llm';
import { speakGPT } from '../audio';
import { getLastActiveEditorTabAware } from './last_editor_tracker';
import { terminalBuffer } from './terminal';
import * as fs from 'fs';
import * as path from 'path';

interface TerminalError {
    type: 'syntax' | 'runtime' | 'import' | 'type' | 'other';
    message: string;
    file?: string;
    line?: number;
    column?: number;
    fullOutput: string;
    timestamp: Date;
}

interface ErrorFix {
    file: string;
    originalCode: string;
    fixedCode: string;
    explanation: string;
    confidence: number;
}

interface ErrorExplanation {
    errorType: string;
    errorMessage: string;
    file?: string;
    line?: number;
    column?: number;
    detailedExplanation: string;
    possibleCauses: string[];
    suggestedFixes: string[];
    severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Extract errors from terminal buffer
 */
function extractTerminalErrors(): TerminalError[] {
    const errors: TerminalError[] = [];
    
    if (!terminalBuffer || terminalBuffer.length === 0) {
        log('[TerminalErrorFixer] No terminal buffer available');
        return errors;
    }

    // Look at recent terminal output (last 50 entries)
    const recentEntries = terminalBuffer.slice(-50);
    
    for (const entry of recentEntries) {
        if (entry.type === 'output') {
            const content = entry.content;
            const lowerContent = content.toLowerCase();
            
            // Python syntax errors
            if (lowerContent.includes('syntaxerror') || lowerContent.includes('syntax error')) {
                const fileMatch = content.match(/File "([^"]+)", line (\d+)/);
                errors.push({
                    type: 'syntax',
                    message: content,
                    file: fileMatch ? fileMatch[1] : undefined,
                    line: fileMatch ? parseInt(fileMatch[2]) : undefined,
                    fullOutput: content,
                    timestamp: entry.timestamp
                });
            }
            // Python import errors
            else if (lowerContent.includes('modulenotfounderror') || lowerContent.includes('importerror')) {
                const fileMatch = content.match(/File "([^"]+)", line (\d+)/);
                errors.push({
                    type: 'import',
                    message: content,
                    file: fileMatch ? fileMatch[1] : undefined,
                    line: fileMatch ? parseInt(fileMatch[2]) : undefined,
                    fullOutput: content,
                    timestamp: entry.timestamp
                });
            }
            // Python runtime errors
            else if (lowerContent.includes('traceback') || 
                     lowerContent.includes('nameerror') || 
                     lowerContent.includes('typeerror') ||
                     lowerContent.includes('attributeerror') ||
                     lowerContent.includes('keyerror') ||
                     lowerContent.includes('indexerror')) {
                const fileMatch = content.match(/File "([^"]+)", line (\d+)/);
                errors.push({
                    type: 'runtime',
                    message: content,
                    file: fileMatch ? fileMatch[1] : undefined,
                    line: fileMatch ? parseInt(fileMatch[2]) : undefined,
                    fullOutput: content,
                    timestamp: entry.timestamp
                });
            }
            // JavaScript/TypeScript errors
            else if (lowerContent.includes('error:') || 
                     lowerContent.includes('referenceerror') ||
                     lowerContent.includes('typeerror') ||
                     lowerContent.includes('syntaxerror')) {
                // Try to extract file and line info from JS/TS errors
                const fileMatch = content.match(/at .+ \(([^:]+):(\d+):(\d+)\)/) || 
                                content.match(/([^:]+):(\d+):(\d+)/);
                errors.push({
                    type: lowerContent.includes('syntaxerror') ? 'syntax' : 'runtime',
                    message: content,
                    file: fileMatch ? fileMatch[1] : undefined,
                    line: fileMatch ? parseInt(fileMatch[2]) : undefined,
                    column: fileMatch ? parseInt(fileMatch[3]) : undefined,
                    fullOutput: content,
                    timestamp: entry.timestamp
                });
            }
            // Generic errors - be more aggressive in detecting errors
            else if (lowerContent.includes('error') || 
                     lowerContent.includes('failed') || 
                     lowerContent.includes('cannot') || 
                     lowerContent.includes('not found') ||
                     lowerContent.includes('undefined') ||
                     lowerContent.includes('missing') ||
                     lowerContent.includes('invalid') ||
                     lowerContent.includes('unexpected') ||
                     lowerContent.includes('unresolved') ||
                     lowerContent.includes('could not') ||
                     lowerContent.includes('unable to') ||
                     lowerContent.includes('compilation failed') ||
                     lowerContent.includes('build failed')) {
                
                // Try to extract file info from generic errors too
                const fileMatch = content.match(/([^:\s]+\.(py|js|ts|java|cpp|c|go|rs|rb|php|pl))/) ||
                                content.match(/File "([^"]+)"/) ||
                                content.match(/at ([^:]+):(\d+):(\d+)/) ||
                                content.match(/([^:]+):(\d+)/);
                
                errors.push({
                    type: 'other',
                    message: content,
                    file: fileMatch ? fileMatch[1] : undefined,
                    line: fileMatch && fileMatch[2] && !isNaN(parseInt(fileMatch[2])) ? parseInt(fileMatch[2]) : undefined,
                    fullOutput: content,
                    timestamp: entry.timestamp
                });
            }
        }
    }

    // Sort by timestamp (most recent first)
    errors.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    log(`[TerminalErrorFixer] Found ${errors.length} errors in terminal buffer`);
    return errors;
}

/**
 * Generate detailed error explanation using LLM
 */
async function generateErrorExplanation(error: TerminalError): Promise<ErrorExplanation | null> {
    try {
        const client = getOpenAIClient();
        
        const prompt = `You are a helpful coding assistant that explains errors concisely. Analyze this error and provide a brief, focused explanation in Korean.

ERROR INFORMATION:
Type: ${error.type}
${error.file ? `File: ${error.file}` : ''}
${error.line ? `Line: ${error.line}` : ''}
${error.column ? `Column: ${error.column}` : ''}

ERROR MESSAGE:
${error.message}

Please analyze this error and respond in the following JSON format:
{
    "errorType": "Brief error type in Korean (e.g., '구문 오류', '런타임 오류', '임포트 오류')",
    "errorMessage": "Clean, user-friendly error message in Korean",
    "detailedExplanation": "Brief explanation of what went wrong in Korean (1-2 sentences max)",
    "possibleCauses": ["Top 1-2 most likely causes in Korean", "Keep each cause brief"],
    "suggestedFixes": ["Top 1-2 most practical fixes in Korean", "Keep each fix brief and actionable"],
    "severity": "low/medium/high/critical"
}

Rules:
1. Explain everything in Korean
2. Keep explanations VERY brief and to the point
3. Focus on the most important information only
4. Use simple, clear language
5. Limit to essential details - no verbose explanations
6. Maximum 10 lines of spoken content total

Response:`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        if (!result) {
            return null;
        }

        try {
            const parsed = JSON.parse(result);
            return {
                errorType: parsed.errorType,
                errorMessage: parsed.errorMessage,
                file: error.file,
                line: error.line,
                column: error.column,
                detailedExplanation: parsed.detailedExplanation,
                possibleCauses: parsed.possibleCauses || [],
                suggestedFixes: parsed.suggestedFixes || [],
                severity: parsed.severity || 'medium'
            };
        } catch (parseError) {
            logError(`[TerminalErrorFixer] Failed to parse LLM explanation response: ${parseError}`);
            return null;
        }

    } catch (error) {
        logError(`[TerminalErrorFixer] LLM explanation request failed: ${error}`);
        return null;
    }
}

/**
 * Generate code fix using LLM with diff-based approach like vibe coding
 */
async function generateCodeFixWithDiff(currentCode: string, terminalOutput: string, fileName: string, fileExtension: string): Promise<TerminalFixResult | null> {
    try {
        const client = getOpenAIClient();
        
        const hasTerminalOutput = terminalOutput && terminalOutput.trim().length > 0;
        
        const prompt = `You are a code fixing expert. ${hasTerminalOutput ? 'Analyze the terminal error and provide a structured fix.' : 'Analyze the code for potential errors and provide fixes.'}

FILE: ${fileName}
LANGUAGE: ${getFileLanguage(fileName)}

CURRENT CODE:
\`\`\`${getFileLanguage(fileName)}
${currentCode}
\`\`\`

${hasTerminalOutput ? `RECENT TERMINAL OUTPUT (includes error messages):
\`\`\`
${terminalOutput}
\`\`\`` : 'NO TERMINAL OUTPUT - Analyze the code directly for potential issues.'}

INSTRUCTIONS:
${hasTerminalOutput ? '- Analyze the terminal output to identify the specific error' : '- Analyze the code directly for syntax errors, import issues, undefined variables, type errors, and other common problems'}
- Provide the complete fixed code
- Explain what was wrong and how you fixed it
- Make minimal changes - only fix what's broken
- Preserve all existing functionality and structure
${!hasTerminalOutput ? '- Focus on common issues like: syntax errors, missing imports, undefined variables, incorrect function calls, type mismatches' : ''}

Respond in the following JSON format:
{
    "canFix": true/false,
    "fixedCode": "The complete corrected file content",
    "explanation": "Brief explanation of what was wrong and how it was fixed (in Korean)",
    "summary": "One-line summary of the fix (in Korean)",
    "confidence": 0.0-1.0,
    "errorType": "syntax|runtime|import|type|other",
    "changes": [
        {
            "type": "modification|addition|deletion",
            "lineNumber": 123,
            "oldContent": "original line content",
            "newContent": "fixed line content",
            "description": "what changed"
        }
    ]
}

IMPORTANT: 
- Set canFix to true for most common programming errors
- Only set canFix to false for very complex architectural issues or missing external dependencies
- Set confidence to 0.8+ for clear syntax/import/variable errors
${!hasTerminalOutput ? '- If no obvious errors are found in the code, set canFix to false and explain that the code appears correct' : ''}
- Explain in Korean what you fixed
- Include specific line-by-line changes in the changes array

Response:`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 4000,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        
        if (!result) {
            log(`[TerminalErrorFixer] No response from LLM for ${fileName}`);
            return null;
        }

        try {
            const parsed = JSON.parse(result);
            
            if (!parsed.canFix) {
                log(`[TerminalErrorFixer] LLM cannot fix error: ${parsed.explanation}`);
                return null;
            }

            // Calculate diff statistics
            const originalLines = currentCode.split('\n');
            const fixedLines = parsed.fixedCode.split('\n');
            
            let totalAdded = 0;
            let totalRemoved = 0;
            
            // Simple diff calculation
            if (fixedLines.length > originalLines.length) {
                totalAdded = fixedLines.length - originalLines.length;
            } else if (originalLines.length > fixedLines.length) {
                totalRemoved = originalLines.length - fixedLines.length;
            }

            return {
                modifiedText: parsed.fixedCode,
                originalText: currentCode,
                summary: parsed.summary || '터미널 에러 수정',
                changeDescription: parsed.explanation,
                totalAdded,
                totalRemoved,
                changeType: parsed.errorType || 'other',
                confidence: parsed.confidence || 0.7,
                changes: parsed.changes || []
            };

        } catch (parseError) {
            logError(`[TerminalErrorFixer] Failed to parse LLM response: ${parseError}`);
            return null;
        }

    } catch (error) {
        logError(`[TerminalErrorFixer] LLM request failed for ${fileName}: ${error}`);
        return null;
    }
}

// Use a simpler result type that can be converted to VibeCodingResult
interface TerminalFixResult {
    modifiedText: string;
    originalText: string;
    summary: string;
    changeDescription: string;
    totalAdded: number;
    totalRemoved: number;
    changeType: string;
    confidence?: number;
    changes?: Array<{
        type: string;
        lineNumber: number;
        oldContent: string;
        newContent: string;
        description: string;
    }>;
}

/**
 * Apply fixed code directly to file
 */
async function applyDirectFileFix(filePath: string, fixedCode: string): Promise<boolean> {
    try {
        // Write the fixed code directly to the file
        fs.writeFileSync(filePath, fixedCode, 'utf8');
        
        log(`[TerminalErrorFixer] Applied fix to ${filePath}`);
        return true;

    } catch (error) {
        logError(`[TerminalErrorFixer] Failed to apply fix to ${filePath}: ${error}`);
        return false;
    }
}

/**
 * Generate code fix using LLM (legacy function - keeping for compatibility)
 */
async function generateCodeFix(error: TerminalError, fileContent: string, fileName: string): Promise<ErrorFix | null> {
    try {
        const client = getOpenAIClient();
        
        const prompt = `You are an expert code fixing assistant. Your job is to fix coding errors aggressively but correctly.

ERROR INFORMATION:
Type: ${error.type}
File: ${fileName}
${error.line ? `Line: ${error.line}` : ''}
${error.column ? `Column: ${error.column}` : ''}

FULL ERROR MESSAGE:
${error.message}

CURRENT FILE CONTENT:
\`\`\`${getFileLanguage(fileName)}
${fileContent}
\`\`\`

INSTRUCTIONS:
- Analyze the error message carefully and identify the exact problem
- Fix the error by making the necessary code changes
- Most common errors (syntax, import, undefined variables, type errors) should be fixable
- Be confident in your fixes - if you understand the error, you can fix it
- Preserve the original code structure and logic as much as possible
- Only change what's necessary to fix the error

Respond in the following JSON format:
{
    "canFix": true/false,
    "explanation": "Clear explanation of what was wrong and how you fixed it (in Korean)",
    "fixedCode": "The complete fixed file content",
    "confidence": 0.0-1.0,
    "changes": "Brief summary of what you changed"
}

IMPORTANT: 
- Set canFix to true for most common programming errors
- Only set canFix to false for very complex architectural issues or missing external dependencies
- Set confidence to 0.8+ for clear syntax/import/variable errors
- Set confidence to 0.6+ for logical fixes
- Explain in Korean what you fixed

Response:`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2000,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        if (!result) {
            return null;
        }

        try {
            const parsed = JSON.parse(result);
            if (!parsed.canFix) {
                log(`[TerminalErrorFixer] LLM cannot fix error: ${parsed.explanation}`);
                return null;
            }

            return {
                file: fileName,
                originalCode: fileContent,
                fixedCode: parsed.fixedCode,
                explanation: parsed.explanation,
                confidence: parsed.confidence || 0.5
            };
        } catch (parseError) {
            logError(`[TerminalErrorFixer] Failed to parse LLM response: ${parseError}`);
            return null;
        }

    } catch (error) {
        logError(`[TerminalErrorFixer] LLM request failed: ${error}`);
        return null;
    }
}

/**
 * Get file language for syntax highlighting
 */
function getFileLanguage(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
        case '.py': return 'python';
        case '.js': return 'javascript';
        case '.ts': return 'typescript';
        case '.jsx': return 'jsx';
        case '.tsx': return 'tsx';
        case '.java': return 'java';
        case '.cpp': case '.cc': case '.cxx': return 'cpp';
        case '.c': return 'c';
        case '.cs': return 'csharp';
        case '.go': return 'go';
        case '.rs': return 'rust';
        case '.php': return 'php';
        case '.rb': return 'ruby';
        default: return 'text';
    }
}

/**
 * Apply code fix to file
 */
async function applyCodeFix(fix: ErrorFix): Promise<boolean> {
    try {
        // Check if file exists
        if (!fs.existsSync(fix.file)) {
            logError(`[TerminalErrorFixer] File not found: ${fix.file}`);
            return false;
        }

        // Read current file content to verify it matches
        const currentContent = fs.readFileSync(fix.file, 'utf8');
        if (currentContent !== fix.originalCode) {
            logWarning(`[TerminalErrorFixer] File content has changed since error analysis`);
            // Continue anyway - the fix might still be applicable
        }

        // Write the fixed content
        fs.writeFileSync(fix.file, fix.fixedCode, 'utf8');
        
        // Open the file in VS Code if not already open
        const document = await vscode.workspace.openTextDocument(fix.file);
        await vscode.window.showTextDocument(document);
        
        logSuccess(`[TerminalErrorFixer] Applied fix to ${fix.file}`);
        return true;

    } catch (error) {
        logError(`[TerminalErrorFixer] Failed to apply fix: ${error}`);
        return false;
    }
}

/**
 * Apply code changes using vibe coding style diff application
 */
async function applyCodeChanges(filePath: string, result: TerminalFixResult): Promise<boolean> {
    try {
        // Open the file in VS Code
        const document = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(document);
        
        // Apply the change by replacing the entire document content
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, result.modifiedText);
        
        const success = await vscode.workspace.applyEdit(edit);
        
        if (success) {
            // Save the document
            await document.save();
            log(`[TerminalErrorFixer] Successfully applied changes to ${path.basename(filePath)}`);
            return true;
        } else {
            logError(`[TerminalErrorFixer] Failed to apply changes to ${path.basename(filePath)}`);
            return false;
        }

    } catch (error) {
        logError(`[TerminalErrorFixer] Error applying changes to ${filePath}: ${error}`);
        return false;
    }
}

/**
 * Enhanced terminal error fixing with diff-based approach like vibe coding
 */
export async function fixTerminalErrors(): Promise<void> {
    try {
        await speakGPT('터미널 에러를 분석하고 수정하고 있습니다');
        
        // Extract errors from terminal to find which file to fix
        const errors = extractTerminalErrors();
        
        if (errors.length === 0) {
            // If no terminal errors found, analyze current active editor code for potential errors
            log('[TerminalErrorFixer] No terminal errors found, analyzing current code for potential issues');
            await speakGPT('터미널에 에러가 없어서 현재 코드를 분석하고 있습니다');
            
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                await speakGPT('현재 열린 파일이 없습니다');
                vscode.window.showInformationMessage('현재 열린 파일이 없습니다', { modal: false });
                return;
            }

            const currentCode = activeEditor.document.getText();
            const fileName = path.basename(activeEditor.document.fileName);
            const fileExtension = path.extname(fileName);
            const filePath = activeEditor.document.uri.fsPath;

            if (!currentCode.trim()) {
                await speakGPT('현재 파일이 비어있습니다');
                vscode.window.showInformationMessage('현재 파일이 비어있습니다', { modal: false });
                return;
            }

            await speakGPT(`${fileName} 파일을 분석하고 수정하고 있습니다`);

            // Analyze code without terminal output (empty terminal context)
            const fixResult = await generateCodeFixWithDiff(currentCode, '', fileName, fileExtension);
            
            if (!fixResult) {
                log(`[TerminalErrorFixer] Could not generate fix for ${fileName}`);
                await speakGPT(`${fileName} 파일에서 수정할 에러를 찾을 수 없었습니다`);
                vscode.window.showInformationMessage(`${fileName} 파일에서 수정할 에러를 찾을 수 없었습니다`, { modal: false });
                return;
            }

            // Show what will be changed
            const changeMessage = `${fixResult.summary} (신뢰도: ${Math.round((fixResult.confidence || 0.7) * 100)}%)`;
            vscode.window.showInformationMessage(changeMessage, { modal: false });
            
            // Apply the changes using vibe coding style
            const success = await applyCodeChanges(filePath, fixResult);
            
            if (success) {
                // Speak the detailed explanation
                await speakGPT(`${fileName} 파일이 수정되었습니다. ${fixResult.changeDescription}`);
                
                // Show success notification with details
                const successMessage = `✅ ${fileName} 수정 완료: ${fixResult.summary}`;
                vscode.window.showInformationMessage(successMessage, { modal: false });
                
                logSuccess(`[TerminalErrorFixer] Successfully fixed ${fileName}: ${fixResult.summary}`);
                
                // Log the changes for debugging
                if (fixResult.changes && fixResult.changes.length > 0) {
                    log(`[TerminalErrorFixer] Changes applied to ${fileName}:`);
                    for (const change of fixResult.changes.slice(0, 3)) { // Log first 3 changes
                        log(`  Line ${change.lineNumber}: ${change.type} - ${change.description}`);
                    }
                }
            } else {
                await speakGPT(`${fileName} 파일 수정 중 문제가 발생했습니다`);
            }
            
            return;
        }

        // Get recent terminal output for context (more context for better analysis)
        const recentTerminalOutput = terminalBuffer.slice(-25)
            .map(entry => `[${entry.timestamp.toLocaleTimeString()}] [${entry.type.toUpperCase()}] ${entry.content}`)
            .join('\n');

        log(`[TerminalErrorFixer] Found ${errors.length} errors, processing most recent ones`);
        
        let fixesApplied = 0;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        // Process up to 2 most recent errors
        for (const error of errors.slice(0, 2)) {
            let targetFile = error.file;
            
            // If no file info in error, try to use current active editor
            if (!targetFile) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    targetFile = activeEditor.document.uri.fsPath;
                    log(`[TerminalErrorFixer] No file in error, using active editor: ${path.basename(targetFile)}`);
                } else {
                    log(`[TerminalErrorFixer] Skipping error without file info and no active editor`);
                    continue;
                }
            }

            // Resolve file path
            let filePath = targetFile;
            if (!path.isAbsolute(filePath) && workspaceRoot) {
                filePath = path.resolve(workspaceRoot, filePath);
            }

            // Check if file exists
            if (!fs.existsSync(filePath)) {
                log(`[TerminalErrorFixer] File not found: ${filePath}`);
                continue;
            }

            try {
                const currentCode = fs.readFileSync(filePath, 'utf8');
                const fileName = path.basename(filePath);
                const fileExtension = path.extname(fileName);

                await speakGPT(`${fileName} 파일을 분석하고 수정하고 있습니다`);

                // Use enhanced LLM fixing with diff approach
                const fixResult = await generateCodeFixWithDiff(currentCode, recentTerminalOutput, fileName, fileExtension);
                
                if (!fixResult) {
                    log(`[TerminalErrorFixer] Could not generate fix for ${fileName}`);
                    await speakGPT(`${fileName} 파일의 에러를 자동으로 수정할 수 없었습니다`);
                    continue;
                }

                // Show what will be changed
                const changeMessage = `${fixResult.summary} (신뢰도: ${Math.round((fixResult.confidence || 0.7) * 100)}%)`;
                vscode.window.showInformationMessage(changeMessage, { modal: false });
                
                // Apply the changes using vibe coding style
                const success = await applyCodeChanges(filePath, fixResult);
                
                if (success) {
                    fixesApplied++;
                    
                    // Speak the detailed explanation
                    await speakGPT(`${fileName} 파일이 수정되었습니다. ${fixResult.changeDescription}`);
                    
                    // Show success notification with details
                    const successMessage = `✅ ${fileName} 수정 완료: ${fixResult.summary}`;
                    vscode.window.showInformationMessage(successMessage, { modal: false });
                    
                    logSuccess(`[TerminalErrorFixer] Successfully fixed ${fileName}: ${fixResult.summary}`);
                    
                    // Log the changes for debugging
                    if (fixResult.changes && fixResult.changes.length > 0) {
                        log(`[TerminalErrorFixer] Changes applied to ${fileName}:`);
                        for (const change of fixResult.changes.slice(0, 3)) { // Log first 3 changes
                            log(`  Line ${change.lineNumber}: ${change.type} - ${change.description}`);
                        }
                    }
                } else {
                    await speakGPT(`${fileName} 파일 수정 중 문제가 발생했습니다`);
                }

            } catch (fileError) {
                logError(`[TerminalErrorFixer] Error processing file ${filePath}: ${fileError}`);
                await speakGPT(`${path.basename(filePath)} 파일 처리 중 오류가 발생했습니다`);
                continue;
            }
        }

        // Final summary
        if (fixesApplied > 0) {
            await speakGPT(`총 ${fixesApplied}개의 파일이 성공적으로 수정되었습니다`);
            logSuccess(`[TerminalErrorFixer] Successfully fixed ${fixesApplied} files`);
        } else {
            await speakGPT('터미널 에러를 자동으로 수정할 수 없었습니다. 수동으로 확인해 주세요');
            vscode.window.showWarningMessage('터미널 에러를 자동으로 수정할 수 없었습니다', { modal: false });
        }

    } catch (error) {
        logError(`[TerminalErrorFixer] Error in fixTerminalErrors: ${error}`);
        await speakGPT('에러 수정 중 문제가 발생했습니다');
        vscode.window.showErrorMessage(`에러 수정 실패: ${error}`, { modal: false });
    }
}

/**
 * Main function to explain terminal errors in detail
 */
export async function explainTerminalErrors(): Promise<void> {
    try {
        await speakGPT('터미널 에러를 분석하고 있습니다');
        
        // Extract errors from terminal
        const errors = extractTerminalErrors();
        
        if (errors.length === 0) {
            await speakGPT('터미널에서 에러를 찾을 수 없습니다');
            vscode.window.showInformationMessage('터미널 기록에서 에러를 찾을 수 없습니다', { modal: false });
            return;
        }

        log(`[TerminalErrorFixer] Explaining ${errors.length} errors`);
        
        // Process the most recent error (up to 2 errors)
        const errorsToExplain = errors.slice(0, 2);
        
        for (let i = 0; i < errorsToExplain.length; i++) {
            const error = errorsToExplain[i];
            
            await speakGPT(`${i + 1}번째 에러를 분석하고 있습니다`);
            
            // Generate detailed explanation
            const explanation = await generateErrorExplanation(error);
            
            if (!explanation) {
                log(`[TerminalErrorFixer] Could not generate explanation for error ${i + 1}`);
                continue;
            }

            // Speak the concise explanation (10 lines max)
            let spokenExplanation = `${explanation.errorType}가 발생했습니다. `;
            
            if (explanation.file && explanation.line) {
                const fileName = path.basename(explanation.file);
                spokenExplanation += `${fileName} 파일 ${explanation.line}번째 줄에 문제가 있습니다. `;
            } else if (explanation.file) {
                const fileName = path.basename(explanation.file);
                spokenExplanation += `${fileName} 파일에 문제가 있습니다. `;
            }
            
            spokenExplanation += explanation.detailedExplanation + ' ';
            
            // Only include the most important cause and fix
            if (explanation.possibleCauses.length > 0) {
                spokenExplanation += `원인: ${explanation.possibleCauses[0]}. `;
            }
            
            if (explanation.suggestedFixes.length > 0) {
                spokenExplanation += `해결방법: ${explanation.suggestedFixes[0]}`;
            }

            await speakGPT(spokenExplanation);

            // Show detailed information in VS Code
            const severityIcon = {
                'low': '⚠️',
                'medium': '🔶',
                'high': '🔴',
                'critical': '🚨'
            }[explanation.severity];

            const detailMessage = `${severityIcon} ${explanation.errorType}\n\n` +
                `📄 파일: ${explanation.file ? path.basename(explanation.file) : '알 수 없음'}\n` +
                `📍 위치: ${explanation.line ? `${explanation.line}번째 줄` : '알 수 없음'}\n\n` +
                `📝 설명: ${explanation.detailedExplanation}\n\n` +
                `🔍 가능한 원인:\n${explanation.possibleCauses.map(cause => `• ${cause}`).join('\n')}\n\n` +
                `💡 해결 방법:\n${explanation.suggestedFixes.map(fix => `• ${fix}`).join('\n')}`;

            // Show in information message (non-blocking)
            vscode.window.showInformationMessage(
                `에러 분석 완료: ${explanation.errorType}`,
                { modal: false }
            );

            // Also show in output channel for detailed view
            const outputChannel = vscode.window.createOutputChannel(`LipCoder 에러 분석 ${i + 1}`);
            outputChannel.appendLine(detailMessage);
            outputChannel.show(true);

            // If there's a file, try to open it and highlight the error line
            if (explanation.file && explanation.line && fs.existsSync(explanation.file)) {
                try {
                    const document = await vscode.workspace.openTextDocument(explanation.file);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // Highlight the error line
                    const line = explanation.line - 1; // Convert to 0-based
                    const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
                    editor.selection = new vscode.Selection(range.start, range.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    
                    log(`[TerminalErrorFixer] Opened and highlighted error at ${explanation.file}:${explanation.line}`);
                } catch (fileError) {
                    log(`[TerminalErrorFixer] Could not open file ${explanation.file}: ${fileError}`);
                }
            }
        }

        // Final summary
        if (errorsToExplain.length > 1) {
            await speakGPT(`총 ${errorsToExplain.length}개의 에러를 분석했습니다`);
        }
        
        logSuccess(`[TerminalErrorFixer] Successfully explained ${errorsToExplain.length} errors`);

    } catch (error) {
        logError(`[TerminalErrorFixer] Error in explainTerminalErrors: ${error}`);
        await speakGPT('에러 분석 중 문제가 발생했습니다');
        vscode.window.showErrorMessage(`에러 분석 실패: ${error}`, { modal: false });
    }
}

/**
 * Generate explanation for general terminal output using LLM
 */
async function generateTerminalOutputExplanation(terminalOutput: string): Promise<string | null> {
    try {
        const client = getOpenAIClient();
        
        const prompt = `You are a helpful coding assistant that explains terminal output in detail. Analyze this terminal output and provide a comprehensive explanation in Korean.

TERMINAL OUTPUT:
${terminalOutput}

Please analyze this terminal output and explain:
1. What commands were executed
2. What the output means
3. Whether there are any issues or important information
4. What the user should know about this output

Rules:
1. Explain everything in Korean
2. Be clear and concise
3. Focus on helping the user understand what happened
4. If there are errors, mention them but don't go into deep technical details (that's for the error explainer)
5. If it's normal output, explain what it means
6. Use simple, clear language
7. Keep the explanation conversational and helpful

Provide a natural Korean explanation (not JSON format):`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 800,
            temperature: 0.2
        });

        const result = response.choices[0]?.message?.content?.trim();
        return result || null;

    } catch (error) {
        logError(`[TerminalErrorFixer] LLM explanation request failed: ${error}`);
        return null;
    }
}

/**
 * Main function to explain general terminal output
 */
export async function explainTerminalOutput(): Promise<void> {
    try {
        // Get abort controller for proper TTS cancellation
        const { lineAbortController } = require('./stop_reading');
        
        await speakGPT('터미널 출력을 분석하고 있습니다', lineAbortController.signal);
        
        if (!terminalBuffer || terminalBuffer.length === 0) {
            await speakGPT('터미널 기록이 없습니다', lineAbortController.signal);
            vscode.window.showInformationMessage('터미널 기록이 없습니다', { modal: false });
            return;
        }

        // Get recent terminal output (last 20 entries for context)
        const recentEntries = terminalBuffer.slice(-20);
        
        if (recentEntries.length === 0) {
            await speakGPT('최근 터미널 출력이 없습니다', lineAbortController.signal);
            vscode.window.showInformationMessage('최근 터미널 출력이 없습니다', { modal: false });
            return;
        }

        // Format terminal output for analysis
        const terminalOutput = recentEntries
            .map(entry => {
                const timestamp = entry.timestamp.toLocaleTimeString();
                return `[${timestamp}] [${entry.type.toUpperCase()}] ${entry.content}`;
            })
            .join('\n');

        log(`[TerminalErrorFixer] Analyzing terminal output (${recentEntries.length} entries)`);
        
        // Generate explanation using LLM
        const explanation = await generateTerminalOutputExplanation(terminalOutput);
        
        if (!explanation) {
            await speakGPT('터미널 출력을 분석할 수 없었습니다', lineAbortController.signal);
            vscode.window.showWarningMessage('터미널 출력을 분석할 수 없었습니다', { modal: false });
            return;
        }

        // Speak the explanation with abort controller support
        await speakGPT(explanation, lineAbortController.signal);

        // Show detailed information in VS Code output channel
        const outputChannel = vscode.window.createOutputChannel('LipCoder 터미널 출력 분석');
        outputChannel.clear();
        outputChannel.appendLine('=== 터미널 출력 분석 ===\n');
        outputChannel.appendLine('📊 분석 결과:');
        outputChannel.appendLine(explanation);
        outputChannel.appendLine('\n=== 원본 터미널 출력 ===');
        outputChannel.appendLine(terminalOutput);
        outputChannel.show(true);

        // Show brief notification
        vscode.window.showInformationMessage('터미널 출력 분석 완료', { modal: false });
        
        logSuccess('[TerminalErrorFixer] Successfully explained terminal output');

    } catch (error) {
        logError(`[TerminalErrorFixer] Error in explainTerminalOutput: ${error}`);
        await speakGPT('터미널 출력 분석 중 문제가 발생했습니다');
        vscode.window.showErrorMessage(`터미널 출력 분석 실패: ${error}`, { modal: false });
    }
}

/**
 * Enhanced terminal error fixing that can be called from vibe coding
 */
export async function fixTerminalErrorsVibeCoding(instruction?: string): Promise<any | null> {
    try {
        log(`[TerminalErrorFixer] Called from vibe coding with instruction: ${instruction || 'none'}`);
        
        // Extract errors from terminal
        const errors = extractTerminalErrors();
        
        if (errors.length === 0) {
            log('[TerminalErrorFixer] No terminal errors found for vibe coding');
            return null;
        }

        // Get recent terminal output for context
        const recentTerminalOutput = terminalBuffer.slice(-25)
            .map(entry => `[${entry.timestamp.toLocaleTimeString()}] [${entry.type.toUpperCase()}] ${entry.content}`)
            .join('\n');

        // Get current active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            log('[TerminalErrorFixer] No active editor for vibe coding integration');
            return null;
        }

        const currentCode = activeEditor.document.getText();
        const fileName = path.basename(activeEditor.document.fileName);
        const fileExtension = path.extname(fileName);

        // Use enhanced LLM fixing with diff approach
        const fixResult = await generateCodeFixWithDiff(currentCode, recentTerminalOutput, fileName, fileExtension);
        
        if (!fixResult) {
            log('[TerminalErrorFixer] Could not generate fix for vibe coding');
            return null;
        }

        // Convert to vibe coding compatible format
        const vibeCodingResult = {
            changes: [], // Simple changes array for now
            summary: fixResult.summary,
            totalAdded: fixResult.totalAdded,
            totalRemoved: fixResult.totalRemoved,
            modifiedText: fixResult.modifiedText,
            originalText: fixResult.originalText,
            changeDescription: fixResult.changeDescription,
            affectedFunctions: [],
            changeType: 'partial_modification' as const
        };

        log(`[TerminalErrorFixer] Generated fix for vibe coding: ${fixResult.summary}`);
        return vibeCodingResult;

    } catch (error) {
        logError(`[TerminalErrorFixer] Error in vibe coding integration: ${error}`);
        return null;
    }
}

/**
 * Check if instruction is requesting terminal error fixing
 */
export function isTerminalErrorFixRequest(instruction: string): boolean {
    const terminalErrorPatterns = [
        /터미널.*에러.*고쳐/i,
        /터미널.*오류.*수정/i,
        /에러.*터미널.*수정/i,
        /오류.*터미널.*고쳐/i,
        /terminal.*error.*fix/i,
        /fix.*terminal.*error/i,
        /터미널.*에러.*바탕.*코드.*고쳐/i,
        /터미널.*출력.*바탕.*수정/i
    ];
    
    return terminalErrorPatterns.some(pattern => pattern.test(instruction));
}

/**
 * Register terminal error fixer command
 */
export function registerTerminalErrorFixer(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.fixTerminalErrors', fixTerminalErrors),
        vscode.commands.registerCommand('lipcoder.explainTerminalErrors', explainTerminalErrors),
        vscode.commands.registerCommand('lipcoder.explainTerminalOutput', explainTerminalOutput)
    );
    
    log('[TerminalErrorFixer] Registered terminal error fixer, error explainer, and output explainer commands');
}
