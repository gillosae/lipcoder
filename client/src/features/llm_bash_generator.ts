import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { log, logError, logSuccess } from '../utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getOpenAIClient } from '../llm';

const execAsync = promisify(exec);

export interface BashScriptRequest {
    query: string;
    context?: string;
    workspaceRoot: string;
}

export interface BashScriptResult {
    script: string;
    explanation: string;
    safetyLevel: 'safe' | 'caution' | 'dangerous';
    estimatedTime: string;
    output?: string;
    error?: string;
}

/**
 * Generate bash script using LLM based on natural language request
 */
export async function generateBashScript(request: BashScriptRequest): Promise<BashScriptResult> {
    try {
        log(`[LLM Bash Generator] Generating script for: ${request.query}`);
        
        const client = getOpenAIClient();
        if (!client) {
            throw new Error('OpenAI client not available');
        }
        
        const systemPrompt = `You are a bash script generator for file system operations in a code editor workspace.
Generate safe, efficient bash scripts based on user requests.

IMPORTANT SAFETY RULES:
1. NEVER generate scripts that delete, modify, or move files unless explicitly requested
2. Focus on READ-ONLY operations: find, grep, wc, head, tail, ls, cat, file
3. Always use relative paths starting with "./"
4. Include error handling with "2>/dev/null" where appropriate
5. Limit output with "head" or "tail" to prevent overwhelming results
6. Use safe quoting and escaping

RESPONSE FORMAT (JSON):
{
  "script": "the bash script commands",
  "explanation": "what the script does in simple terms",
  "safetyLevel": "safe|caution|dangerous",
  "estimatedTime": "estimated execution time"
}

EXAMPLES:
User: "find all Python files"
Response: {
  "script": "find . -name '*.py' -type f 2>/dev/null | head -20",
  "explanation": "Searches for Python files (.py) in the current directory and subdirectories, showing first 20 results",
  "safetyLevel": "safe",
  "estimatedTime": "1-3 seconds"
}

User: "count lines in all TypeScript files"
Response: {
  "script": "find . -name '*.ts' -type f 2>/dev/null | xargs wc -l 2>/dev/null | tail -1",
  "explanation": "Finds all TypeScript files and counts total lines of code",
  "safetyLevel": "safe", 
  "estimatedTime": "2-5 seconds"
}`;

        const userPrompt = `Generate a bash script for this request:
"${request.query}"

Workspace context: ${request.context || 'Code editor workspace'}
Working directory: ${request.workspaceRoot}

Respond with JSON only:`;

        const completion = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 500,
            temperature: 0.1
        });
        
        const response = completion.choices[0]?.message?.content?.trim();
        if (!response) {
            throw new Error('No response from LLM');
        }
        
        // Parse JSON response
        let scriptResult: BashScriptResult;
        try {
            const parsed = JSON.parse(response);
            scriptResult = {
                script: parsed.script,
                explanation: parsed.explanation,
                safetyLevel: parsed.safetyLevel || 'caution',
                estimatedTime: parsed.estimatedTime || 'unknown'
            };
        } catch (parseError) {
            // Fallback if JSON parsing fails
            scriptResult = {
                script: response,
                explanation: 'Generated bash script',
                safetyLevel: 'caution',
                estimatedTime: 'unknown'
            };
        }
        
        log(`[LLM Bash Generator] Generated script: ${scriptResult.script}`);
        return scriptResult;
        
    } catch (error) {
        logError(`[LLM Bash Generator] Error generating script: ${error}`);
        throw error;
    }
}

/**
 * Execute the generated bash script safely
 */
export async function executeBashScript(scriptResult: BashScriptResult, workspaceRoot: string): Promise<BashScriptResult> {
    try {
        log(`[LLM Bash Generator] Executing script: ${scriptResult.script}`);
        
        // Safety check
        if (scriptResult.safetyLevel === 'dangerous') {
            throw new Error('Script marked as dangerous - execution blocked for safety');
        }
        
        // Execute the script in the workspace directory
        const fullCommand = `cd "${workspaceRoot}" && ${scriptResult.script}`;
        const { stdout, stderr } = await execAsync(fullCommand, {
            timeout: 30000, // 30 second timeout
            maxBuffer: 1024 * 1024 // 1MB max output
        });
        
        if (stderr && !stderr.includes('2>/dev/null')) {
            log(`[LLM Bash Generator] Script stderr: ${stderr}`);
        }
        
        return {
            ...scriptResult,
            output: stdout.trim(),
            error: stderr ? stderr.trim() : undefined
        };
        
    } catch (error) {
        logError(`[LLM Bash Generator] Error executing script: ${error}`);
        return {
            ...scriptResult,
            error: `Execution error: ${error}`
        };
    }
}

/**
 * Process natural language file operation request
 */
export async function processFileOperationRequest(query: string): Promise<BashScriptResult> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
        }
        
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        
        // Generate script using LLM
        const scriptRequest: BashScriptRequest = {
            query,
            context: 'VS Code workspace with various file types',
            workspaceRoot
        };
        
        const scriptResult = await generateBashScript(scriptRequest);
        
        // Execute the script
        const executedResult = await executeBashScript(scriptResult, workspaceRoot);
        
        return executedResult;
        
    } catch (error) {
        logError(`[LLM Bash Generator] Error processing request: ${error}`);
        throw error;
    }
}

/**
 * Speak the results of bash script execution
 */
export async function speakBashResults(result: BashScriptResult): Promise<void> {
    try {
        const chunks: TokenChunk[] = [];
        
        if (result.error) {
            chunks.push(
                { tokens: ['Script'], category: undefined },
                { tokens: ['execution'], category: undefined },
                { tokens: ['failed'], category: undefined }
            );
        } else if (result.output) {
            const lines = result.output.split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                chunks.push(
                    { tokens: ['No'], category: undefined },
                    { tokens: ['results'], category: undefined },
                    { tokens: ['found'], category: undefined }
                );
            } else if (lines.length === 1) {
                chunks.push(
                    { tokens: ['Found'], category: undefined },
                    { tokens: ['1'], category: undefined },
                    { tokens: ['result'], category: undefined }
                );
            } else {
                chunks.push(
                    { tokens: ['Found'], category: undefined },
                    { tokens: [lines.length.toString()], category: undefined },
                    { tokens: ['results'], category: undefined }
                );
                
                // Speak first few results
                const resultsToSpeak = lines.slice(0, 3);
                for (let i = 0; i < resultsToSpeak.length; i++) {
                    if (i === 0) {
                        chunks.push({ tokens: [':'], category: undefined });
                    } else {
                        chunks.push({ tokens: [','], category: undefined });
                    }
                    
                    const result = resultsToSpeak[i];
                    const fileName = path.basename(result.split('|')[0] || result);
                    chunks.push({ tokens: [fileName], category: undefined });
                }
                
                if (lines.length > 3) {
                    chunks.push(
                        { tokens: ['and'], category: undefined },
                        { tokens: [(lines.length - 3).toString()], category: undefined },
                        { tokens: ['more'], category: undefined }
                    );
                }
            }
        } else {
            chunks.push(
                { tokens: ['Script'], category: undefined },
                { tokens: ['completed'], category: undefined }
            );
        }
        
        await speakTokenList(chunks);
        
    } catch (error) {
        logError(`[LLM Bash Generator] Error speaking results: ${error}`);
    }
}

/**
 * Display bash script results in VS Code
 */
export async function displayBashResults(result: BashScriptResult, query: string): Promise<void> {
    try {
        // Create output channel
        const outputChannel = vscode.window.createOutputChannel('LLM Bash Script');
        outputChannel.clear();
        
        outputChannel.appendLine('='.repeat(60));
        outputChannel.appendLine(`LLM-Generated Bash Script Results`);
        outputChannel.appendLine('='.repeat(60));
        outputChannel.appendLine('');
        
        outputChannel.appendLine(`Query: ${query}`);
        outputChannel.appendLine(`Script: ${result.script}`);
        outputChannel.appendLine(`Explanation: ${result.explanation}`);
        outputChannel.appendLine(`Safety Level: ${result.safetyLevel}`);
        outputChannel.appendLine(`Estimated Time: ${result.estimatedTime}`);
        outputChannel.appendLine('');
        
        if (result.error) {
            outputChannel.appendLine('❌ ERROR:');
            outputChannel.appendLine(result.error);
        } else if (result.output) {
            outputChannel.appendLine('✅ OUTPUT:');
            outputChannel.appendLine(result.output);
        } else {
            outputChannel.appendLine('✅ Script completed successfully (no output)');
        }
        
        outputChannel.appendLine('');
        outputChannel.appendLine('='.repeat(60));
        
        outputChannel.show();
        
    } catch (error) {
        logError(`[LLM Bash Generator] Error displaying results: ${error}`);
    }
}

/**
 * Register LLM bash generator commands
 */
export function registerLLMBashGenerator(context: ExtensionContext) {
    // Command to generate and execute bash script from natural language
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.generateBashScript', async () => {
            try {
                const query = await vscode.window.showInputBox({
                    prompt: 'Describe what you want to do (e.g., "find all JSON files", "count Python files")',
                    placeHolder: 'find all JSON files in this codebase'
                });
                
                if (!query) return;
                
                vscode.window.showInformationMessage(`Generating bash script for: "${query}"`);
                
                const result = await processFileOperationRequest(query);
                
                // Show results
                await displayBashResults(result, query);
                
                // Speak results
                await speakBashResults(result);
                
                logSuccess(`[LLM Bash Generator] Successfully processed: ${query}`);
                
            } catch (error) {
                logError(`[LLM Bash Generator] Command failed: ${error}`);
                vscode.window.showErrorMessage(`Error generating bash script: ${error}`);
            }
        })
    );
    
    // Command to generate script without executing (for review)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.previewBashScript', async () => {
            try {
                const query = await vscode.window.showInputBox({
                    prompt: 'Describe the operation (script will be generated but not executed)',
                    placeHolder: 'find all large files over 1MB'
                });
                
                if (!query) return;
                
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders) {
                    vscode.window.showErrorMessage('No workspace folder open');
                    return;
                }
                
                const scriptRequest: BashScriptRequest = {
                    query,
                    context: 'VS Code workspace',
                    workspaceRoot: workspaceFolders[0].uri.fsPath
                };
                
                const scriptResult = await generateBashScript(scriptRequest);
                
                // Show script for review
                const executeChoice = await vscode.window.showInformationMessage(
                    `Generated Script: ${scriptResult.script}\n\nExplanation: ${scriptResult.explanation}\nSafety: ${scriptResult.safetyLevel}`,
                    { modal: true },
                    'Execute Script',
                    'Copy Script',
                    'Cancel'
                );
                
                if (executeChoice === 'Execute Script') {
                    const result = await executeBashScript(scriptResult, workspaceFolders[0].uri.fsPath);
                    await displayBashResults(result, query);
                    await speakBashResults(result);
                } else if (executeChoice === 'Copy Script') {
                    await vscode.env.clipboard.writeText(scriptResult.script);
                    vscode.window.showInformationMessage('Script copied to clipboard');
                }
                
            } catch (error) {
                logError(`[LLM Bash Generator] Preview command failed: ${error}`);
                vscode.window.showErrorMessage(`Error generating bash script: ${error}`);
            }
        })
    );
}
