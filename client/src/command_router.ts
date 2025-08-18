import * as vscode from 'vscode';
import { log, logError, logSuccess, logWarning } from './utils';
import { getOpenAIClient } from './llm';
import { analyzeCodeWithQuestion } from './features/code_analysis';
import { startThinkingAudio, stopThinkingAudio } from './audio';
import { logCommandExecution, logFeatureUsage } from './activity_logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Find a function in the current document using LLM
 */
export async function findFunctionWithLLM(functionName: string, contextEditor?: vscode.TextEditor): Promise<{ line: number; character: number } | null> {
    const editor = contextEditor || vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const document = editor.document;
    const text = document.getText();
    
    try {
        const client = getOpenAIClient();
        
        const prompt = `Find the function "${functionName}" in this code and return the line number where it's defined.

Code:
\`\`\`${document.languageId}
${text}
\`\`\`

Find the function named "${functionName}" and respond with ONLY the line number (1-indexed) where the function is defined.
If the function is not found, respond with "NOT_FOUND".
If multiple functions with similar names exist, choose the closest match.

Examples:
- Function found at line 25 → respond "25"
- Function not found → respond "NOT_FOUND"

Response:`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 10,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        
        if (!result || result === "NOT_FOUND") {
            return null;
        }

        const lineNumber = parseInt(result);
        if (isNaN(lineNumber) || lineNumber < 1 || lineNumber > document.lineCount) {
            return null;
        }

        // Convert to 0-indexed for VS Code API
        return { line: lineNumber - 1, character: 0 };

    } catch (error) {
        logError(`[CommandRouter] LLM function search failed: ${error}`);
        return null;
    }
}

/**
 * Find package.json scripts and execute them
 */
export async function executePackageJsonScript(scriptName: string): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return false;
    }

    const packageJsonPath = path.join(workspaceFolders[0].uri.fsPath, 'package.json');
    
    try {
        if (!fs.existsSync(packageJsonPath)) {
            vscode.window.showErrorMessage('package.json not found in workspace root');
            return false;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const scripts = packageJson.scripts || {};
        
        // Find matching script (exact match or fuzzy match)
        let matchedScript = scripts[scriptName];
        let actualScriptName = scriptName;
        
        if (!matchedScript) {
            // Try fuzzy matching
            const scriptNames = Object.keys(scripts);
            const fuzzyMatch = scriptNames.find(name => 
                name.includes(scriptName) || scriptName.includes(name)
            );
            
            if (fuzzyMatch) {
                matchedScript = scripts[fuzzyMatch];
                actualScriptName = fuzzyMatch;
            }
        }

        if (!matchedScript) {
            const availableScripts = Object.keys(scripts).join(', ');
            vscode.window.showErrorMessage(
                `Script "${scriptName}" not found. Available scripts: ${availableScripts}`
            );
            return false;
        }

        // Execute the script
        const terminal = vscode.window.createTerminal({
            name: `npm run ${actualScriptName}`,
            cwd: workspaceFolders[0].uri.fsPath
        });
        
        terminal.sendText(`npm run ${actualScriptName}`);
        terminal.show();
        
        vscode.window.showInformationMessage(`Running script: ${actualScriptName}`);
        return true;

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to execute script: ${error}`);
        return false;
    }
}

/**
 * Use LLM to match package.json scripts
 */
async function findPackageJsonScriptWithLLM(spokenText: string): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }

    const packageJsonPath = path.join(workspaceFolders[0].uri.fsPath, 'package.json');
    
    try {
        if (!fs.existsSync(packageJsonPath)) {
            return null;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const scripts = packageJson.scripts || {};
        const scriptNames = Object.keys(scripts);
        
        if (scriptNames.length === 0) {
            return null;
        }

        const client = getOpenAIClient();
        
        const prompt = `The user said: "${spokenText}"

Available npm scripts in package.json:
${scriptNames.map((name, i) => `${i + 1}. ${name}: ${scripts[name]}`).join('\n')}

If the user wants to run one of these scripts, respond with ONLY the script name.
If no script matches, respond with "NONE".

Examples:
- "run build" → "build"
- "start the server" → "start" 
- "run tests" → "test"
- "hello world" → "NONE"

Response:`;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 20,
            temperature: 0.1
        });

        const result = response.choices[0]?.message?.content?.trim();
        
        if (!result || result === "NONE" || !scriptNames.includes(result)) {
            return null;
        }

        return result;

    } catch (error) {
        logError(`[CommandRouter] LLM script matching failed: ${error}`);
        return null;
    }
}

export interface CommandPattern {
    // Pattern to match against transcribed text (can be regex or simple string)
    pattern: string | RegExp;
    // VS Code command to execute
    command: string;
    // Optional arguments to pass to the command
    args?: any[];
    // Optional description for logging/debugging
    description?: string;
    // Whether this is a regex pattern or simple string match
    isRegex?: boolean;
    // Whether to prevent default text insertion after command execution
    preventDefault?: boolean;
    // Function to extract parameters from matched text and return command args
    parameterExtractor?: (match: RegExpMatchArray | string[], originalText: string) => any[];
    // Custom handler function for complex operations
    customHandler?: (match: RegExpMatchArray | string[], originalText: string) => Promise<boolean>;
}

export interface CommandRouterOptions {
    // Whether to show notifications when commands are executed
    showNotifications?: boolean;
    // Whether to log command executions
    enableLogging?: boolean;
    // Whether to fall back to text insertion if no command matches
    fallbackToTextInsertion?: boolean;
    // Whether to use LLM for intelligent command matching
    useLLMMatching?: boolean;
}

export interface RouterEditorContext {
    editor: vscode.TextEditor;
    position: vscode.Position;
    selection: vscode.Selection;
    documentUri: vscode.Uri;
}

export class CommandRouter {
    private patterns: CommandPattern[] = [];
    private options: CommandRouterOptions;
    private editorContext: RouterEditorContext | null = null;

    constructor(options: CommandRouterOptions = {}) {
        this.options = {
            showNotifications: true,
            enableLogging: true,
            fallbackToTextInsertion: true,
            useLLMMatching: true,
            ...options
        };

        // Initialize with default command patterns
        this.initializeDefaultPatterns();
        log('[CommandRouter] Command router initialized with default patterns');
    }

    /**
     * Create function search handler that has access to this context
     */
    private createFunctionSearchHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            const functionName = match[2]?.trim();
            if (!functionName) {
                vscode.window.showErrorMessage('Please specify a function name');
                return false;
            }

            // Use editor context if available, with proper validation
            let targetEditor = this.editorContext?.editor;
            
            // Validate that the captured editor is still valid
            if (targetEditor) {
                try {
                    // Check if the document is still open and valid
                    if (!targetEditor.document || targetEditor.document.isClosed) {
                        logWarning('[CommandRouter] Captured editor context is no longer valid for function search, falling back to active editor');
                        targetEditor = undefined;
                    }
                } catch (error) {
                    logError(`[CommandRouter] Error accessing captured editor for function search: ${error}`);
                    targetEditor = undefined;
                }
            }
            
            // Fallback to current active editor
            if (!targetEditor) {
                targetEditor = vscode.window.activeTextEditor;
            }
            
            if (!targetEditor) {
                vscode.window.showErrorMessage('No editor available to search for function');
                return false;
            }
            
            const position = await findFunctionWithLLM(functionName, targetEditor);
            
            if (position) {
                try {
                    // Make sure the target editor is active
                    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                    
                    const newPosition = new vscode.Position(position.line, position.character);
                    targetEditor.selection = new vscode.Selection(newPosition, newPosition);
                    targetEditor.revealRange(new vscode.Range(newPosition, newPosition));
                    
                    const fileName = path.basename(targetEditor.document.fileName);
                    vscode.window.showInformationMessage(`Found function: ${functionName} at line ${position.line + 1} in ${fileName}`);
                    return true;
                } catch (error) {
                    logError(`[CommandRouter] Error navigating to function: ${error}`);
                    vscode.window.showErrorMessage(`Failed to navigate to function: ${error}`);
                    return false;
                }
            } else {
                vscode.window.showWarningMessage(`Function "${functionName}" not found`);
                return false;
            }
        };
    }

    /**
     * Create line navigation handler that has access to this context
     */
    private createLineNavigationHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            const lineNumberStr = match[2]?.trim();
            if (!lineNumberStr) {
                vscode.window.showErrorMessage('Please specify a line number');
                return false;
            }

            const lineNumber = parseInt(lineNumberStr);
            if (isNaN(lineNumber) || lineNumber < 1) {
                vscode.window.showErrorMessage(`Invalid line number: ${lineNumberStr}`);
                return false;
            }

            // Use editor context if available, with proper validation
            let targetEditor = this.editorContext?.editor;
            
            // Validate that the captured editor is still valid
            if (targetEditor) {
                try {
                    // Check if the document is still open and valid
                    if (!targetEditor.document || targetEditor.document.isClosed) {
                        logWarning('[CommandRouter] Captured editor context is no longer valid for line navigation, falling back to active editor');
                        targetEditor = undefined;
                    }
                } catch (error) {
                    logError(`[CommandRouter] Error accessing captured editor for line navigation: ${error}`);
                    targetEditor = undefined;
                }
            }
            
            // Fallback to current active editor
            if (!targetEditor) {
                targetEditor = vscode.window.activeTextEditor;
            }
            
            if (!targetEditor) {
                vscode.window.showErrorMessage('No editor available to navigate to line');
                return false;
            }

            try {
                // Make sure the target editor is active
                await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                
                // Navigate to the specified line (VS Code uses 0-based indexing)
                const position = new vscode.Position(lineNumber - 1, 0);
                targetEditor.selection = new vscode.Selection(position, position);
                targetEditor.revealRange(new vscode.Range(position, position));
                
                const fileName = path.basename(targetEditor.document.fileName);
                vscode.window.showInformationMessage(`Went to line ${lineNumber} in ${fileName}`);
                logSuccess(`[CommandRouter] Successfully navigated to line ${lineNumber} in ${fileName}`);
                return true;
            } catch (error) {
                logError(`[CommandRouter] Error navigating to line: ${error}`);
                vscode.window.showErrorMessage(`Failed to navigate to line ${lineNumber}: ${error}`);
                return false;
            }
        };
    }

    /**
     * Create simple line navigation handler for "line N" pattern
     */
    private createSimpleLineNavigationHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            const lineNumberStr = match[1]?.trim(); // For "line N", the number is in match[1]
            if (!lineNumberStr) {
                vscode.window.showErrorMessage('Please specify a line number');
                return false;
            }

            const lineNumber = parseInt(lineNumberStr);
            if (isNaN(lineNumber) || lineNumber < 1) {
                vscode.window.showErrorMessage(`Invalid line number: ${lineNumberStr}`);
                return false;
            }

            // Use editor context if available, with proper validation
            let targetEditor = this.editorContext?.editor;
            
            // Validate that the captured editor is still valid
            if (targetEditor) {
                try {
                    // Check if the document is still open and valid
                    if (!targetEditor.document || targetEditor.document.isClosed) {
                        logWarning('[CommandRouter] Captured editor context is no longer valid for line navigation, falling back to active editor');
                        targetEditor = undefined;
                    }
                } catch (error) {
                    logError(`[CommandRouter] Error accessing captured editor for line navigation: ${error}`);
                    targetEditor = undefined;
                }
            }
            
            // Fallback to current active editor
            if (!targetEditor) {
                targetEditor = vscode.window.activeTextEditor;
            }
            
            if (!targetEditor) {
                vscode.window.showErrorMessage('No editor available to navigate to line');
                return false;
            }

            try {
                // Make sure the target editor is active
                await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                
                // Navigate to the specified line (VS Code uses 0-based indexing)
                const position = new vscode.Position(lineNumber - 1, 0);
                targetEditor.selection = new vscode.Selection(position, position);
                targetEditor.revealRange(new vscode.Range(position, position));
                
                const fileName = path.basename(targetEditor.document.fileName);
                vscode.window.showInformationMessage(`Went to line ${lineNumber} in ${fileName}`);
                logSuccess(`[CommandRouter] Successfully navigated to line ${lineNumber} in ${fileName}`);
                return true;
            } catch (error) {
                logError(`[CommandRouter] Error navigating to line: ${error}`);
                vscode.window.showErrorMessage(`Failed to navigate to line ${lineNumber}: ${error}`);
                return false;
            }
        };
    }

    /**
     * Create variable definition navigation handler
     */
    private createVariableDefinitionHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            const variableName = match[2]?.trim();
            if (!variableName) {
                vscode.window.showErrorMessage('Please specify a variable name');
                return false;
            }

            // Use editor context if available, with proper validation
            let targetEditor = this.editorContext?.editor;
            
            // Validate that the captured editor is still valid
            if (targetEditor) {
                try {
                    // Check if the document is still open and valid
                    if (!targetEditor.document || targetEditor.document.isClosed) {
                        logWarning('[CommandRouter] Captured editor context is no longer valid for variable search, falling back to active editor');
                        targetEditor = undefined;
                    }
                } catch (error) {
                    logError(`[CommandRouter] Error accessing captured editor for variable search: ${error}`);
                    targetEditor = undefined;
                }
            }
            
            // Fallback to current active editor
            if (!targetEditor) {
                targetEditor = vscode.window.activeTextEditor;
            }
            
            if (!targetEditor) {
                vscode.window.showErrorMessage('No editor available to search for variable');
                return false;
            }

            try {
                // Search for the variable in the document text
                const document = targetEditor.document;
                const text = document.getText();
                
                // Try to find variable declaration patterns
                const variablePatterns = [
                    new RegExp(`\\b(let|const|var)\\s+${variableName}\\b`, 'i'),
                    new RegExp(`\\b${variableName}\\s*[:]\\s*`, 'i'), // TypeScript type annotation
                    new RegExp(`\\bdef\\s+${variableName}\\s*\\(`, 'i'), // Python function def
                    new RegExp(`\\bfunction\\s+${variableName}\\s*\\(`, 'i'), // JavaScript function
                    new RegExp(`\\b${variableName}\\s*=`, 'i'), // Assignment
                ];

                let foundPosition: vscode.Position | null = null;
                let foundLine = -1;

                for (const pattern of variablePatterns) {
                    const match = text.match(pattern);
                    if (match && match.index !== undefined) {
                        const position = document.positionAt(match.index);
                        foundPosition = position;
                        foundLine = position.line;
                        break;
                    }
                }

                if (foundPosition) {
                    // Make sure the target editor is active
                    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                    
                    targetEditor.selection = new vscode.Selection(foundPosition, foundPosition);
                    targetEditor.revealRange(new vscode.Range(foundPosition, foundPosition));
                    
                    const fileName = path.basename(targetEditor.document.fileName);
                    vscode.window.showInformationMessage(`Found variable: ${variableName} at line ${foundLine + 1} in ${fileName}`);
                    logSuccess(`[CommandRouter] Successfully navigated to variable ${variableName} at line ${foundLine + 1}`);
                    return true;
                } else {
                    // Fallback: use VS Code's go to definition command
                    try {
                        await vscode.commands.executeCommand('editor.action.revealDefinition');
                        vscode.window.showInformationMessage(`Using VS Code's go to definition for: ${variableName}`);
                        return true;
                    } catch (error) {
                        vscode.window.showWarningMessage(`Variable "${variableName}" not found`);
                        return false;
                    }
                }
            } catch (error) {
                logError(`[CommandRouter] Error searching for variable: ${error}`);
                vscode.window.showErrorMessage(`Failed to search for variable: ${error}`);
                return false;
            }
        };
    }

    /**
     * Create parent navigation handler
     */
    private createParentNavigationHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            // Use editor context if available, with proper validation
            let targetEditor = this.editorContext?.editor;
            
            // Validate that the captured editor is still valid
            if (targetEditor) {
                try {
                    // Check if the document is still open and valid
                    if (!targetEditor.document || targetEditor.document.isClosed) {
                        logWarning('[CommandRouter] Captured editor context is no longer valid for parent navigation, falling back to active editor');
                        targetEditor = undefined;
                    }
                } catch (error) {
                    logError(`[CommandRouter] Error accessing captured editor for parent navigation: ${error}`);
                    targetEditor = undefined;
                }
            }
            
            // Fallback to current active editor
            if (!targetEditor) {
                targetEditor = vscode.window.activeTextEditor;
            }
            
            if (!targetEditor) {
                vscode.window.showErrorMessage('No editor available for parent navigation');
                return false;
            }

            try {
                const document = targetEditor.document;
                const currentPosition = targetEditor.selection.active;
                
                // Get document symbols to find parent scope
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri
                ) || [];

                // Find the parent symbol containing the current position
                function findParentSymbol(nodes: vscode.DocumentSymbol[], targetPos: vscode.Position): vscode.DocumentSymbol | null {
                    for (const node of nodes) {
                        // Check if current position is within this symbol
                        if (targetPos.isAfterOrEqual(node.range.start) && targetPos.isBeforeOrEqual(node.range.end)) {
                            // Check children first to find the most specific parent
                            if (node.children && node.children.length > 0) {
                                const childParent = findParentSymbol(node.children, targetPos);
                                if (childParent) {
                                    return node; // Return this node as parent of the found child
                                }
                            }
                            // If we're in this symbol but no deeper child contains us, 
                            // we need to find THIS symbol's parent
                            return null; // Will be handled by caller
                        }
                    }
                    return null;
                }

                // Find parent symbol by walking up the hierarchy
                function findParent(nodes: vscode.DocumentSymbol[], targetPos: vscode.Position, parent?: vscode.DocumentSymbol): vscode.DocumentSymbol | null {
                    for (const node of nodes) {
                        if (targetPos.isAfterOrEqual(node.range.start) && targetPos.isBeforeOrEqual(node.range.end)) {
                            if (node.children && node.children.length > 0) {
                                const childResult = findParent(node.children, targetPos, node);
                                if (childResult) {
                                    return childResult;
                                }
                            }
                            // We found the innermost symbol, return its parent
                            return parent || null;
                        }
                    }
                    return null;
                }

                const parentSymbol = findParent(symbols, currentPosition);

                if (parentSymbol) {
                    // Navigate to parent symbol
                    const parentPosition = new vscode.Position(parentSymbol.range.start.line, parentSymbol.range.start.character);
                    
                    // Make sure the target editor is active
                    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                    
                    targetEditor.selection = new vscode.Selection(parentPosition, parentPosition);
                    targetEditor.revealRange(new vscode.Range(parentPosition, parentPosition));
                    
                    const fileName = path.basename(targetEditor.document.fileName);
                    const parentType = vscode.SymbolKind[parentSymbol.kind] ? vscode.SymbolKind[parentSymbol.kind].toLowerCase() : 'symbol';
                    vscode.window.showInformationMessage(`Moved to parent ${parentType}: ${parentSymbol.name} at line ${parentPosition.line + 1} in ${fileName}`);
                    logSuccess(`[CommandRouter] Successfully navigated to parent ${parentType} ${parentSymbol.name}`);
                    return true;
                } else {
                    vscode.window.showInformationMessage('No parent scope found - you are at the top level');
                    return false;
                }
            } catch (error) {
                logError(`[CommandRouter] Error navigating to parent: ${error}`);
                vscode.window.showErrorMessage(`Failed to navigate to parent: ${error}`);
                return false;
            }
        };
    }

    /**
     * Classify command intent and execute using LLM
     */
    private async classifyAndExecuteWithLLM(text: string): Promise<boolean> {
        let result: string | undefined;
        try {
            // Start thinking audio during LLM processing
            await startThinkingAudio();
            
            const client = getOpenAIClient();
            
            const prompt = `You are a voice command classifier for a code editor. Analyze the following voice command and determine the intent and parameters.

Voice Command: "${text}"

Available command categories:
1. LINE_NAVIGATION - Navigate to specific line number (e.g., "go to line 25", "line 10", "move to line 50")
2. FUNCTION_NAVIGATION - Navigate to function (e.g., "go to function myFunc", "find function calculate")  
3. VARIABLE_DEFINITION - Find variable definition (e.g., "find variable config", "go to variable data definition")
4. PARENT_NAVIGATION - Navigate to parent scope (e.g., "go to parent", "move up", "parent")
5. LIPCODER_COMMAND - LipCoder specific commands (e.g., "symbol tree", "function list", "breadcrumb")
6. SYNTAX_ERROR_COMMAND - Syntax error and diagnostic commands (e.g., "syntax error list", "error list", "errors", "next error", "previous error")
7. FILE_OPERATION - File operations (e.g., "save file", "open file", "new file")
8. EDITOR_OPERATION - Editor operations (e.g., "copy", "paste", "undo", "format")
9. NAVIGATION_OPERATION - General navigation (e.g., "find", "search", "replace")
10. CODE_GENERATION - Generate or modify code (e.g., "complete function x", "make test function for x", "make function x", "create function that does x", "change function x", "modify function x", "함수 x를 바꿔줘", "x를 어떻게 바꿔줘", "refactor function x", "update function x", "코드의 신택스 에러를 고쳐줘", "이 함수에 에러 핸들링을 추가해줘", "이 코드를 리팩토링해줘", "테스트 함수를 만들어줘", "주석을 추가해줘", "타입 힌트를 추가해줘")
11. CODE_ANALYSIS - Analyze code and answer questions (e.g., "what does this function do?", "지금 내가 있는 함수는 뭐하는 함수야?", "explain current function")
12. NOT_A_COMMAND - Just regular text to type

Respond with ONLY valid JSON (no markdown code blocks):
{
  "category": "CATEGORY_NAME",
  "confidence": 0.95,
  "parameters": {
    "lineNumber": 25,
    "functionName": "myFunc",
    "variableName": "config",
    "command": "symbolTree",
    "syntaxErrorAction": "list|next|previous",
    "operation": "save",
    "codeDescription": "function that gets parameter x and y and returns sum",
    "generationType": "complete|create|test",
    "question": "what does this function do?"
  },
  "reasoning": "Brief explanation"
}

Only include parameters relevant to the category. Use null for missing parameters. DO NOT wrap in code blocks.`;

            const response = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 200,
                temperature: 0.1
            });

            result = response.choices[0]?.message?.content?.trim();
            
            // Stop thinking audio after LLM processing
            await stopThinkingAudio();
            
            if (!result) {
                return false;
            }

            // Handle JSON wrapped in markdown code blocks
            let jsonString = result;
            if (result.startsWith('```json') && result.endsWith('```')) {
                jsonString = result.slice(7, -3).trim();
            } else if (result.startsWith('```') && result.endsWith('```')) {
                jsonString = result.slice(3, -3).trim();
            }

            const commandInfo = JSON.parse(jsonString);
            
            if (this.options.enableLogging) {
                log(`[CommandRouter] 🤖 LLM Classification:`);
                log(`[CommandRouter] Category: ${commandInfo.category}`);
                log(`[CommandRouter] Confidence: ${commandInfo.confidence}`);
                log(`[CommandRouter] Parameters: ${JSON.stringify(commandInfo.parameters)}`);
                log(`[CommandRouter] Reasoning: ${commandInfo.reasoning}`);
            }

            // Only execute if confidence is high enough
            if (commandInfo.confidence < 0.7) {
                if (this.options.enableLogging) {
                    log(`[CommandRouter] ⚠️ Low confidence (${commandInfo.confidence}), skipping execution`);
                }
                return false;
            }

            // Execute based on category
            return await this.executeLLMCommand(commandInfo, text);

        } catch (error) {
            // Make sure to stop thinking audio even if LLM fails
            await stopThinkingAudio();
            
            if (this.options.enableLogging) {
                logError(`[CommandRouter] LLM classification failed: ${error}`);
                log(`[CommandRouter] LLM raw response: ${result || 'no response'}`);
            }
            return false;
        }
    }

    /**
     * Execute command based on LLM classification
     */
    private async executeLLMCommand(commandInfo: any, originalText: string): Promise<boolean> {
        const { category, parameters } = commandInfo;

        try {
            switch (category) {
                case 'LINE_NAVIGATION':
                    return await this.executeLLMLineNavigation(parameters, originalText);
                
                case 'FUNCTION_NAVIGATION':
                    return await this.executeLLMFunctionNavigation(parameters, originalText);
                
                case 'VARIABLE_DEFINITION':
                    return await this.executeLLMVariableDefinition(parameters, originalText);
                
                case 'PARENT_NAVIGATION':
                    return await this.executeLLMParentNavigation(originalText);
                
                case 'LIPCODER_COMMAND':
                    return await this.executeLLMLipCoderCommand(parameters, originalText);
                
                case 'SYNTAX_ERROR_COMMAND':
                    return await this.executeLLMSyntaxErrorCommand(parameters, originalText);
                
                case 'FILE_OPERATION':
                    return await this.executeLLMFileOperation(parameters, originalText);
                
                case 'EDITOR_OPERATION':
                    return await this.executeLLMEditorOperation(parameters, originalText);
                
                case 'NAVIGATION_OPERATION':
                    return await this.executeLLMNavigationOperation(parameters, originalText);
                
                case 'CODE_GENERATION':
                    // Route all code generation to vibe coding with original text
                    if (this.options.enableLogging) {
                        log(`[CommandRouter] 🎨 Routing code generation to vibe coding with instruction: "${originalText}"`);
                    }
                    await vscode.commands.executeCommand('lipcoder.vibeCoding', originalText);
                    return true;
                
                case 'CODE_ANALYSIS':
                    return await this.executeLLMCodeAnalysis(parameters, originalText);
                
                case 'NOT_A_COMMAND':
                    if (this.options.enableLogging) {
                        log(`[CommandRouter] 📝 LLM determined this is not a command, will type text`);
                    }
                    return false; // Let it fall through to text insertion
                
                default:
                    if (this.options.enableLogging) {
                        log(`[CommandRouter] ❓ Unknown category: ${category}`);
                    }
                    return false;
            }
        } catch (error) {
            logError(`[CommandRouter] Error executing LLM command: ${error}`);
            return false;
        }
    }

    /**
     * Execute line navigation command
     */
    private async executeLLMLineNavigation(parameters: any, originalText: string): Promise<boolean> {
        const lineNumber = parameters?.lineNumber;
        if (!lineNumber || lineNumber < 1) {
            if (this.options.enableLogging) {
                log(`[CommandRouter] ❌ Invalid line number: ${lineNumber}`);
            }
            return false;
        }

        // Use editor context if available
        let targetEditor = this.editorContext?.editor;
        if (targetEditor) {
            try {
                if (!targetEditor.document || targetEditor.document.isClosed) {
                    targetEditor = undefined;
                }
            } catch (error) {
                targetEditor = undefined;
            }
        }
        
        if (!targetEditor) {
            targetEditor = vscode.window.activeTextEditor;
        }
        
        if (!targetEditor) {
            vscode.window.showErrorMessage('No editor available to navigate to line');
            return false;
        }

        try {
            await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
            const position = new vscode.Position(lineNumber - 1, 0);
            targetEditor.selection = new vscode.Selection(position, position);
            targetEditor.revealRange(new vscode.Range(position, position));
            
            const fileName = path.basename(targetEditor.document.fileName);
            vscode.window.showInformationMessage(`🚀 Went to line ${lineNumber} in ${fileName}`);
            logSuccess(`[CommandRouter] ✅ LLM navigated to line ${lineNumber}`);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to navigate to line ${lineNumber}: ${error}`);
            return false;
        }
    }

    /**
     * Execute function navigation command
     */
    private async executeLLMFunctionNavigation(parameters: any, originalText: string): Promise<boolean> {
        const functionName = parameters?.functionName;
        if (!functionName) {
            return false;
        }

        let targetEditor = this.editorContext?.editor || vscode.window.activeTextEditor;
        if (!targetEditor) {
            vscode.window.showErrorMessage('No editor available to search for function');
            return false;
        }

        const position = await findFunctionWithLLM(functionName, targetEditor);
        if (position) {
            try {
                await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                const newPosition = new vscode.Position(position.line, position.character);
                targetEditor.selection = new vscode.Selection(newPosition, newPosition);
                targetEditor.revealRange(new vscode.Range(newPosition, newPosition));
                
                const fileName = path.basename(targetEditor.document.fileName);
                vscode.window.showInformationMessage(`🎯 Found function: ${functionName} at line ${position.line + 1} in ${fileName}`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to navigate to function: ${error}`);
                return false;
            }
        } else {
            vscode.window.showWarningMessage(`Function "${functionName}" not found`);
            return false;
        }
    }

    /**
     * Execute variable definition command
     */
    private async executeLLMVariableDefinition(parameters: any, originalText: string): Promise<boolean> {
        const variableName = parameters?.variableName;
        if (!variableName) {
            return false;
        }

        // Try VS Code's built-in go to definition
        try {
            await vscode.commands.executeCommand('editor.action.revealDefinition');
            vscode.window.showInformationMessage(`🔍 Using VS Code's go to definition for: ${variableName}`);
            return true;
        } catch (error) {
            vscode.window.showWarningMessage(`Variable "${variableName}" definition not found`);
            return false;
        }
    }

    /**
     * Execute parent navigation command
     */
    private async executeLLMParentNavigation(originalText: string): Promise<boolean> {
        let targetEditor = this.editorContext?.editor || vscode.window.activeTextEditor;
        if (!targetEditor) {
            vscode.window.showErrorMessage('No editor available for parent navigation');
            return false;
        }

        try {
            const document = targetEditor.document;
            const currentPosition = targetEditor.selection.active;
            
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            ) || [];

            // Find parent symbol
            function findParent(nodes: vscode.DocumentSymbol[], targetPos: vscode.Position, parent?: vscode.DocumentSymbol): vscode.DocumentSymbol | null {
                for (const node of nodes) {
                    if (targetPos.isAfterOrEqual(node.range.start) && targetPos.isBeforeOrEqual(node.range.end)) {
                        if (node.children && node.children.length > 0) {
                            const childResult = findParent(node.children, targetPos, node);
                            if (childResult) {
                                return childResult;
                            }
                        }
                        return parent || null;
                    }
                }
                return null;
            }

            const parentSymbol = findParent(symbols, currentPosition);

            if (parentSymbol) {
                const parentPosition = new vscode.Position(parentSymbol.range.start.line, parentSymbol.range.start.character);
                await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                targetEditor.selection = new vscode.Selection(parentPosition, parentPosition);
                targetEditor.revealRange(new vscode.Range(parentPosition, parentPosition));
                
                const fileName = path.basename(targetEditor.document.fileName);
                const parentType = vscode.SymbolKind[parentSymbol.kind] ? vscode.SymbolKind[parentSymbol.kind].toLowerCase() : 'symbol';
                vscode.window.showInformationMessage(`⬆️ Moved to parent ${parentType}: ${parentSymbol.name} in ${fileName}`);
                return true;
            } else {
                vscode.window.showInformationMessage('No parent scope found - you are at the top level');
                return false;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to navigate to parent: ${error}`);
            return false;
        }
    }

    /**
     * Execute LipCoder specific command
     */
    private async executeLLMLipCoderCommand(parameters: any, originalText: string): Promise<boolean> {
        const command = parameters?.command;
        if (!command) {
            return false;
        }

        const commandMap: { [key: string]: string } = {
            'symbolTree': 'lipcoder.symbolTree',
            'symbols': 'lipcoder.symbolTree',
            'functionList': 'lipcoder.functionList',
            'functions': 'lipcoder.functionList',
            'breadcrumb': 'lipcoder.breadcrumb',
            'whereAmI': 'lipcoder.breadcrumb',
            'fileTree': 'lipcoder.fileTree',
            'explorer': 'lipcoder.goToExplorer',
            'editor': 'lipcoder.goToEditor',
            'readLine': 'lipcoder.readLineTokens',
            'lineTokens': 'lipcoder.readLineTokens',
            'readFunction': 'lipcoder.readFunctionTokens',
            'functionTokens': 'lipcoder.readFunctionTokens',
            'stopReading': 'lipcoder.stopReadLineTokens',
            'stopSpeech': 'lipcoder.stopReadLineTokens',
            'toggleCursorReading': 'lipcoder.toggleCursorLineReading',
            'currentLine': 'lipcoder.readCurrentLine',
            'lineNumber': 'lipcoder.readCurrentLine',
            'switchPanel': 'lipcoder.switchPanel',
            'panel': 'lipcoder.switchPanel'
        };

        const vsCodeCommand = commandMap[command];
        if (vsCodeCommand) {
            try {
                if (vsCodeCommand.startsWith('lipcoder.') && this.editorContext && this.editorContext.editor) {
                    await vscode.commands.executeCommand(vsCodeCommand, this.editorContext.editor);
                } else {
                    await vscode.commands.executeCommand(vsCodeCommand);
                }
                vscode.window.showInformationMessage(`🎯 Executed: ${command}`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to execute ${command}: ${error}`);
                return false;
            }
        }
        
        return false;
    }

    /**
     * Execute syntax error command
     */
    private async executeLLMSyntaxErrorCommand(parameters: any, originalText: string): Promise<boolean> {
        const syntaxErrorAction = parameters?.syntaxErrorAction;
        
        // Use parameters if available, otherwise fall back to text analysis
        let action = syntaxErrorAction;
        if (!action) {
            const text = originalText.toLowerCase();
            if (text.includes('syntax error list') || text.includes('error list') || text === 'errors') {
                action = 'list';
            } else if (text.includes('next error') || text.includes('next syntax error')) {
                action = 'next';
            } else if (text.includes('previous error') || text.includes('prev error') || text.includes('previous syntax error')) {
                action = 'previous';
            }
        }
        
        const actionMap: { [key: string]: string } = {
            'list': 'lipcoder.syntaxErrorList',
            'next': 'lipcoder.nextSyntaxError',
            'previous': 'lipcoder.previousSyntaxError'
        };
        
        const command = actionMap[action];
        if (command) {
            try {
                if (this.options.enableLogging) {
                    log(`[CommandRouter] 🔍 Executing syntax error command: ${command}`);
                }
                await vscode.commands.executeCommand(command);
                vscode.window.showInformationMessage(`🔍 Executed: ${action} syntax error`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to execute syntax error command: ${error}`);
                return false;
            }
        }
        
        return false;
    }

    /**
     * Execute file operation command
     */
    private async executeLLMFileOperation(parameters: any, originalText: string): Promise<boolean> {
        const operation = parameters?.operation;
        
        const operationMap: { [key: string]: string } = {
            'save': 'workbench.action.files.save',
            'open': 'workbench.action.quickOpen',
            'new': 'workbench.action.files.newUntitledFile'
        };

        const command = operationMap[operation];
        if (command) {
            try {
                await vscode.commands.executeCommand(command);
                vscode.window.showInformationMessage(`📁 Executed: ${operation} file`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to ${operation} file: ${error}`);
                return false;
            }
        }
        
        return false;
    }

    /**
     * Execute editor operation command
     */
    private async executeLLMEditorOperation(parameters: any, originalText: string): Promise<boolean> {
        const operation = parameters?.operation;
        
        const operationMap: { [key: string]: string } = {
            'copy': 'editor.action.clipboardCopyAction',
            'paste': 'editor.action.clipboardPasteAction',
            'undo': 'undo',
            'redo': 'redo',
            'format': 'editor.action.formatDocument',
            'comment': 'editor.action.commentLine',
            'selectAll': 'editor.action.selectAll'
        };

        const command = operationMap[operation];
        if (command) {
            try {
                await vscode.commands.executeCommand(command);
                vscode.window.showInformationMessage(`✏️ Executed: ${operation}`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to ${operation}: ${error}`);
                return false;
            }
        }
        
        return false;
    }

    /**
     * Execute navigation operation command
     */
    private async executeLLMNavigationOperation(parameters: any, originalText: string): Promise<boolean> {
        const operation = parameters?.operation;
        
        const operationMap: { [key: string]: string } = {
            'find': 'actions.find',
            'search': 'actions.find',
            'replace': 'editor.action.startFindReplaceAction',
            'gotoLine': 'workbench.action.gotoLine'
        };

        const command = operationMap[operation];
        if (command) {
            try {
                await vscode.commands.executeCommand(command);
                vscode.window.showInformationMessage(`🔍 Executed: ${operation}`);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to ${operation}: ${error}`);
                return false;
            }
        }
        
        return false;
    }

    /**
     * Execute code analysis command using LLM
     */
    private async executeLLMCodeAnalysis(parameters: any, originalText: string): Promise<boolean> {
        try {
            // Extract question from parameters or use original text
            const question = parameters?.question || originalText;
            
            if (this.options.enableLogging) {
                log(`[CommandRouter] 🔍 Executing code analysis with question: "${question}"`);
            }
            
            // Call the code analysis function
            await analyzeCodeWithQuestion(question);
            
            if (this.options.enableLogging) {
                log(`[CommandRouter] ✅ Code analysis completed successfully`);
            }
            
            return true;
            
        } catch (error) {
            logError(`[CommandRouter] Code analysis error: ${error}`);
            vscode.window.showErrorMessage(`Code analysis failed: ${error}`);
            return false;
        }
    }

    /**
     * Execute code generation command using LLM
     */
    private async executeLLMCodeGeneration(parameters: any, originalText: string): Promise<boolean> {
        const { codeDescription, generationType, functionName } = parameters;
        
        if (this.options.enableLogging) {
            log(`[CommandRouter] 🤖 Code generation request:`);
            log(`[CommandRouter] Description: ${codeDescription || originalText}`);
            log(`[CommandRouter] Type: ${generationType}`);
            log(`[CommandRouter] Function name: ${functionName}`);
        }

        // Get the active editor
        let targetEditor = this.editorContext?.editor;
        if (targetEditor) {
            try {
                if (!targetEditor.document || targetEditor.document.isClosed) {
                    targetEditor = undefined;
                }
            } catch (error) {
                targetEditor = undefined;
            }
        }
        
        if (!targetEditor) {
            targetEditor = vscode.window.activeTextEditor;
        }
        
        if (!targetEditor) {
            vscode.window.showErrorMessage('No editor available for code generation');
            return false;
        }

        try {
            // Get context around cursor position
            const position = targetEditor.selection.active;
            const document = targetEditor.document;
            const languageId = document.languageId;
            
            // Get surrounding context (few lines before and after cursor)
            const contextRadius = 10;
            const startLine = Math.max(0, position.line - contextRadius);
            const endLine = Math.min(document.lineCount - 1, position.line + contextRadius);
            const contextRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
            const contextText = document.getText(contextRange);
            
            // Analyze the request and generate appropriate code
            const client = getOpenAIClient();
            
            let prompt = `You are an expert ${languageId} developer. Generate code based on the following request:

Voice Command: "${originalText}"
Request: ${codeDescription || originalText}
Language: ${languageId}
Generation Type: ${generationType || 'create'}

Context (current code around cursor):
\`\`\`${languageId}
${contextText}
\`\`\`

Current cursor position: Line ${position.line + 1}, Column ${position.character + 1}

Generate appropriate ${languageId} code that:
1. Follows best practices and conventions for ${languageId}
2. Is contextually appropriate for the surrounding code
3. Is complete and functional
4. Includes proper error handling where appropriate
5. Uses appropriate typing (if TypeScript) or type hints (if Python)

`;

            // Customize prompt based on generation type
            switch (generationType) {
                case 'complete':
                    prompt += `Complete the current function or code block at the cursor position.`;
                    break;
                case 'test':
                    prompt += `Generate comprehensive unit tests for the function "${functionName || 'the target function'}". Include multiple test cases covering normal, edge, and error scenarios.`;
                    break;
                case 'create':
                default:
                    prompt += `Create new ${languageId} code as requested.`;
                    break;
            }

            prompt += `\n\nRespond with ONLY the code to insert, no explanations or markdown code blocks.`;

            const response = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 1000,
                temperature: 0.2
            });

            const generatedCode = response.choices[0]?.message?.content?.trim();
            if (!generatedCode) {
                vscode.window.showErrorMessage('Failed to generate code');
                return false;
            }

            // Insert the generated code at the cursor position
            const edit = new vscode.WorkspaceEdit();
            
            // If we have a selection, replace it; otherwise insert at cursor
            const insertRange = targetEditor.selection.isEmpty ? 
                new vscode.Range(targetEditor.selection.active, targetEditor.selection.active) : 
                targetEditor.selection;
                
            edit.replace(document.uri, insertRange, generatedCode);
            
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                // Position cursor at the end of inserted code
                const lines = generatedCode.split('\n');
                const newPosition = new vscode.Position(
                    position.line + lines.length - 1,
                    lines[lines.length - 1].length
                );
                targetEditor.selection = new vscode.Selection(newPosition, newPosition);
                
                const message = `✨ Generated ${generationType || 'code'}: ${functionName || originalText}`;
                vscode.window.showInformationMessage(message);
                
                if (this.options.enableLogging) {
                    log(`[CommandRouter] ✅ Successfully generated and inserted code`);
                    log(`[CommandRouter] Generated code length: ${generatedCode.length} characters`);
                }
                
                return true;
            } else {
                vscode.window.showErrorMessage('Failed to insert generated code');
                return false;
            }
            
        } catch (error) {
            logError(`[CommandRouter] Code generation error: ${error}`);
            vscode.window.showErrorMessage(`Code generation failed: ${error}`);
            return false;
        }
    }

    /**
     * Create script execution handler that has access to this context
     */
    private createScriptExecutionHandler() {
        return async (match: RegExpMatchArray | string[], originalText: string) => {
            const scriptName = match[2]?.trim();
            if (!scriptName) {
                // Try LLM matching for the whole text
                const llmScript = await findPackageJsonScriptWithLLM(originalText);
                if (llmScript) {
                    return await executePackageJsonScript(llmScript);
                }
                vscode.window.showErrorMessage('Please specify a script name');
                return false;
            }

            return await executePackageJsonScript(scriptName);
        };
    }

    /**
     * Initialize default command patterns for common VS Code operations
     */
    private initializeDefaultPatterns(): void {
        const defaultPatterns: CommandPattern[] = [
            // File operations
            {
                pattern: /^(open file|file open)$/i,
                command: 'workbench.action.quickOpen',
                description: 'Open file quick picker',
                preventDefault: true
            },
            {
                pattern: /^(save file|save)$/i,
                command: 'workbench.action.files.save',
                description: 'Save current file',
                preventDefault: true
            },
            {
                pattern: /^(new file|create file)$/i,
                command: 'workbench.action.files.newUntitledFile',
                description: 'Create new file',
                preventDefault: true
            },
            
            // Navigation commands - more flexible patterns
            {
                pattern: /(?:go\s*to\s*line|goto\s*line|move\s*to\s*line|moveto\s*line|jump\s*to\s*line|jumpto\s*line).*?(\d+)/i,
                command: '',
                description: 'Go to specific line number (flexible)',
                preventDefault: true,
                isRegex: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    log(`[CommandRouter] 🎯 Line navigation handler called!`);
                    log(`[CommandRouter] Original text: "${originalText}"`);
                    log(`[CommandRouter] Match array: ${JSON.stringify(match)}`);
                    log(`[CommandRouter] Match[0]: "${match[0]}"`);
                    log(`[CommandRouter] Match[1]: "${match[1]}"`);
                    
                    const lineNumberStr = match[1]?.trim();
                    if (!lineNumberStr) {
                        log(`[CommandRouter] ❌ No line number found in match[1]`);
                        vscode.window.showErrorMessage('Please specify a line number');
                        return false;
                    }

                    const lineNumber = parseInt(lineNumberStr);
                    if (isNaN(lineNumber) || lineNumber < 1) {
                        log(`[CommandRouter] ❌ Invalid line number: "${lineNumberStr}"`);
                        vscode.window.showErrorMessage(`Invalid line number: ${lineNumberStr}`);
                        return false;
                    }

                    log(`[CommandRouter] ✅ Parsed line number: ${lineNumber}`);

                    // Use editor context if available
                    let targetEditor = this.editorContext?.editor;
                    
                    if (targetEditor) {
                        try {
                            if (!targetEditor.document || targetEditor.document.isClosed) {
                                log(`[CommandRouter] Editor context invalid, falling back to active editor`);
                                targetEditor = undefined;
                            }
                        } catch (error) {
                            log(`[CommandRouter] Error checking editor context: ${error}`);
                            targetEditor = undefined;
                        }
                    }
                    
                    if (!targetEditor) {
                        targetEditor = vscode.window.activeTextEditor;
                        log(`[CommandRouter] Using active editor: ${!!targetEditor}`);
                    }
                    
                    if (!targetEditor) {
                        log(`[CommandRouter] ❌ No editor available`);
                        vscode.window.showErrorMessage('No editor available to navigate to line');
                        return false;
                    }

                    try {
                        log(`[CommandRouter] 🚀 Navigating to line ${lineNumber}...`);
                        
                        await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                        
                        const position = new vscode.Position(lineNumber - 1, 0);
                        targetEditor.selection = new vscode.Selection(position, position);
                        targetEditor.revealRange(new vscode.Range(position, position));
                        
                        const fileName = path.basename(targetEditor.document.fileName);
                        const message = `Went to line ${lineNumber} in ${fileName}`;
                        vscode.window.showInformationMessage(message);
                        log(`[CommandRouter] ✅ Successfully navigated to line ${lineNumber}`);
                        return true;
                    } catch (error) {
                        log(`[CommandRouter] ❌ Error navigating: ${error}`);
                        vscode.window.showErrorMessage(`Failed to navigate to line ${lineNumber}: ${error}`);
                        return false;
                    }
                }
            },
            {
                pattern: /^.*?line\s*(\d+).*?$/i,
                command: '',
                description: 'Navigate to line number (flexible)',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createSimpleLineNavigationHandler()
            },
            {
                pattern: /^(go to line|goto line)$/i,
                command: 'workbench.action.gotoLine',
                description: 'Go to line (open dialog)',
                preventDefault: true,
                isRegex: true
            },
            {
                pattern: /^(find|search)$/i,
                command: 'actions.find',
                description: 'Open find dialog',
                preventDefault: true
            },
            {
                pattern: /^(replace|find and replace)$/i,
                command: 'editor.action.startFindReplaceAction',
                description: 'Open find and replace',
                preventDefault: true
            },

            // Editor commands
            {
                pattern: /^(comment line|comment)$/i,
                command: 'editor.action.commentLine',
                description: 'Toggle line comment',
                preventDefault: true
            },
            {
                pattern: /^(format document|format)$/i,
                command: 'editor.action.formatDocument',
                description: 'Format document',
                preventDefault: true
            },
            {
                pattern: /^(select all)$/i,
                command: 'editor.action.selectAll',
                description: 'Select all text',
                preventDefault: true
            },
            {
                pattern: /^(copy|copy line)$/i,
                command: 'editor.action.clipboardCopyAction',
                description: 'Copy selection or line',
                preventDefault: true
            },
            {
                pattern: /^(paste)$/i,
                command: 'editor.action.clipboardPasteAction',
                description: 'Paste from clipboard',
                preventDefault: true
            },
            {
                pattern: /^(undo)$/i,
                command: 'undo',
                description: 'Undo last action',
                preventDefault: true
            },
            {
                pattern: /^(redo)$/i,
                command: 'redo',
                description: 'Redo last action',
                preventDefault: true
            },

            // Terminal commands
            {
                pattern: /^(open terminal|terminal|go to terminal)$/i,
                command: 'lipcoder.openTerminal',
                description: 'Open LipCoder terminal',
                preventDefault: true
            },
            {
                pattern: /^(terminal up|up line|previous line)$/i,
                command: 'lipcoder.terminalHistoryUp',
                description: 'Navigate to previous terminal line',
                preventDefault: true
            },
            {
                pattern: /^(terminal down|down line|next line)$/i,
                command: 'lipcoder.terminalHistoryDown',
                description: 'Navigate to next terminal line',
                preventDefault: true
            },
            {
                pattern: /^(terminal left|left char|previous char)$/i,
                command: 'lipcoder.terminalCharLeft',
                description: 'Navigate to previous character in terminal',
                preventDefault: true
            },
            {
                pattern: /^(terminal right|right char|next char)$/i,
                command: 'lipcoder.terminalCharRight',
                description: 'Navigate to next character in terminal',
                preventDefault: true
            },
            {
                pattern: /^(terminal word left|previous word|word left)$/i,
                command: 'lipcoder.terminalWordLeft',
                description: 'Navigate to previous word in terminal',
                preventDefault: true
            },
            {
                pattern: /^(terminal word right|next word|word right)$/i,
                command: 'lipcoder.terminalWordRight',
                description: 'Navigate to next word in terminal',
                preventDefault: true
            },
            {
                pattern: /^(terminal line start|line start|home)$/i,
                command: 'lipcoder.terminalLineStart',
                description: 'Move to beginning of current terminal line',
                preventDefault: true
            },
            {
                pattern: /^(terminal line end|line end|end)$/i,
                command: 'lipcoder.terminalLineEnd',
                description: 'Move to end of current terminal line',
                preventDefault: true
            },
            {
                pattern: /^(terminal read line|read line|read current line)$/i,
                command: 'lipcoder.terminalReadCurrentLine',
                description: 'Read current terminal line',
                preventDefault: true
            },
            {
                pattern: /^(terminal read char|read char|read current char)$/i,
                command: 'lipcoder.terminalReadCurrentChar',
                description: 'Read current terminal character',
                preventDefault: true
            },
            {
                pattern: /^(terminal first line|first line|top)$/i,
                command: 'lipcoder.terminalFirstLine',
                description: 'Jump to first line in terminal buffer',
                preventDefault: true
            },
            {
                pattern: /^(terminal last line|last line|bottom)$/i,
                command: 'lipcoder.terminalLastLine',
                description: 'Jump to last line in terminal buffer',
                preventDefault: true
            },
            {
                pattern: /^(terminal search|search terminal|find in terminal)$/i,
                command: 'lipcoder.terminalSearch',
                description: 'Search within terminal output',
                preventDefault: true
            },
            {
                pattern: /^(terminal status|terminal info|where am i)$/i,
                command: 'lipcoder.terminalStatus',
                description: 'Get current terminal position and status',
                preventDefault: true
            },
            {
                pattern: /^(capture terminal|terminal capture|save terminal)$/i,
                command: 'lipcoder.captureTerminalOutput',
                description: 'Capture current terminal output for navigation',
                preventDefault: true
            },

            // View commands
            {
                pattern: /^(toggle sidebar|sidebar)$/i,
                command: 'workbench.action.toggleSidebarVisibility',
                description: 'Toggle sidebar visibility',
                preventDefault: true
            },
            {
                pattern: /^(command palette|commands)$/i,
                command: 'workbench.action.showCommands',
                description: 'Open command palette',
                preventDefault: true
            },

            // Code actions
            {
                pattern: /^(quick fix|fix)$/i,
                command: 'editor.action.quickFix',
                description: 'Show quick fixes',
                preventDefault: true
            },
            {
                pattern: /^(rename symbol|rename)$/i,
                command: 'editor.action.rename',
                description: 'Rename symbol',
                preventDefault: true
            },
            {
                pattern: /^(go to definition|definition)$/i,
                command: 'editor.action.revealDefinition',
                description: 'Go to definition',
                preventDefault: true
            },

            // Text insertion shortcuts
            {
                pattern: /^(new line|line break)$/i,
                command: 'type',
                args: [{ text: '\n' }],
                description: 'Insert new line',
                preventDefault: true
            },
            {
                pattern: /^(tab|indent)$/i,
                command: 'tab',
                description: 'Insert tab/indent',
                preventDefault: true
            },

            // Advanced navigation with LLM - more flexible patterns
            {
                pattern: /^.*?(go to function|find function|navigate to function|move to function|moveto function|jump to function|jumpto function).*?([a-zA-Z_][a-zA-Z0-9_]*).*?$/i,
                command: '',  // Will be handled by customHandler
                description: 'Go to function using LLM search (flexible)',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createFunctionSearchHandler()
            },
            {
                pattern: /^(move to variable|moveto variable)\s+(.+)\s+(definition|def)$/i,
                command: '',  // Will be handled by customHandler
                description: 'Move to variable definition',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createVariableDefinitionHandler()
            },
            {
                pattern: /^(go to variable|goto variable)\s+(.+)\s+(definition|def)$/i,
                command: '',  // Will be handled by customHandler
                description: 'Go to variable definition',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createVariableDefinitionHandler()
            },
            {
                pattern: /^(move to parent|moveto parent|go to parent|goto parent|parent|up one level)$/i,
                command: '',  // Will be handled by customHandler
                description: 'Move to parent scope/function',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createParentNavigationHandler()
            },
            
            // Simplified variable patterns (without requiring "definition")
            {
                pattern: /^(find variable|find var)\s+(.+)$/i,
                command: '',  // Will be handled by customHandler
                description: 'Find variable definition',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createVariableDefinitionHandler()
            },

            // Package.json script execution
            {
                pattern: /^(run script|npm run|execute script|run)\s+(.+)$/i,
                command: '',  // Will be handled by customHandler
                description: 'Run npm script from package.json',
                preventDefault: true,
                isRegex: true,
                customHandler: this.createScriptExecutionHandler()
            },

            // Test command for debugging
            {
                pattern: /^(test command|test)$/i,
                command: '',
                description: 'Test command for debugging',
                preventDefault: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    vscode.window.showInformationMessage(`✅ Test command worked! You said: "${originalText}"`);
                    log(`[CommandRouter] ✅ Test command handler executed successfully`);
                    return true;
                }
            },

            // Debug pattern for specific "go to line 10" case
            {
                pattern: /Go to line 10\./,
                command: '',
                description: 'Debug pattern for "Go to line 10."',
                preventDefault: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    log(`[CommandRouter] 🎯 DEBUG: Exact "Go to line 10." pattern matched!`);
                    vscode.window.showInformationMessage(`🎯 Debug pattern matched: "${originalText}"`);
                    
                    // Navigate to line 10
                    const targetEditor = vscode.window.activeTextEditor;
                    if (targetEditor) {
                        const position = new vscode.Position(9, 0); // Line 10 (0-indexed)
                        targetEditor.selection = new vscode.Selection(position, position);
                        targetEditor.revealRange(new vscode.Range(position, position));
                        vscode.window.showInformationMessage("Navigated to line 10 via debug pattern!");
                    }
                    return true;
                }
            },

            // Super simple debug pattern - match anything with "line" and a number
            {
                pattern: /line.*?(\d+)/i,
                command: '',
                description: 'Super simple line pattern',
                preventDefault: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    log(`[CommandRouter] 🔥 SIMPLE pattern matched!`);
                    log(`[CommandRouter] Original: "${originalText}"`);
                    log(`[CommandRouter] Match: ${JSON.stringify(match)}`);
                    
                    const lineNum = match[1] ? parseInt(match[1]) : 1;
                    vscode.window.showInformationMessage(`🔥 Simple pattern found line: ${lineNum} in "${originalText}"`);
                    
                    const targetEditor = vscode.window.activeTextEditor;
                    if (targetEditor && lineNum > 0) {
                        const position = new vscode.Position(lineNum - 1, 0);
                        targetEditor.selection = new vscode.Selection(position, position);
                        targetEditor.revealRange(new vscode.Range(position, position));
                        vscode.window.showInformationMessage(`Navigated to line ${lineNum}!`);
                    }
                    return true;
                }
            },

            // LipCoder-specific commands
            {
                pattern: /^(symbol tree|symbols)$/i,
                command: 'lipcoder.symbolTree',
                description: 'Speak symbol tree',
                preventDefault: true
            },
            {
                pattern: /^(function list|functions)$/i,
                command: 'lipcoder.functionList',
                description: 'Speak function list',
                preventDefault: true
            },
            {
                pattern: /^(breadcrumb|where am i)$/i,
                command: 'lipcoder.breadcrumb',
                description: 'Read breadcrumb/location',
                preventDefault: true
            },
            {
                pattern: /^(file tree)$/i,
                command: 'lipcoder.fileTree',
                description: 'Build file tree',
                preventDefault: true
            },
            {
                pattern: /^(syntax errors|syntax error list|error list|errors)$/i,
                command: 'lipcoder.syntaxErrorList',
                description: 'Show syntax error list',
                preventDefault: true
            },
            {
                pattern: /^(next error|next syntax error)$/i,
                command: 'lipcoder.nextSyntaxError',
                description: 'Navigate to next syntax error',
                preventDefault: true
            },
            {
                pattern: /^(previous error|prev error|previous syntax error)$/i,
                command: 'lipcoder.previousSyntaxError',
                description: 'Navigate to previous syntax error',
                preventDefault: true
            },
            {
                pattern: /^(first error|first syntax error)$/i,
                command: 'lipcoder.firstSyntaxError',
                description: 'Navigate to first syntax error',
                preventDefault: true
            },
            {
                pattern: /^(go to explorer|explorer)$/i,
                command: 'lipcoder.goToExplorer',
                description: 'Go to explorer panel',
                preventDefault: true
            },
            {
                pattern: /^(go to editor|editor)$/i,
                command: 'lipcoder.goToEditor',
                description: 'Go to editor panel',
                preventDefault: true
            },
            {
                pattern: /^open\s+(.+)$/i,
                command: 'lipcoder.openFile',
                description: 'Open file by name',
                preventDefault: true,
                parameterExtractor: (match: RegExpMatchArray | string[], originalText: string) => [match[1].trim()]
            },
            {
                pattern: /^(read line|line tokens)$/i,
                command: 'lipcoder.readLineTokens',
                description: 'Read current line tokens',
                preventDefault: true
            },
            {
                pattern: /^(read function|function tokens)$/i,
                command: 'lipcoder.readFunctionTokens',
                description: 'Read function tokens',
                preventDefault: true
            },
            {
                pattern: /^(stop reading|stop speech)$/i,
                command: 'lipcoder.stopReadLineTokens',
                description: 'Stop LipCoder speech',
                preventDefault: true
            },
            {
                pattern: /^(toggle cursor reading|cursor reading)$/i,
                command: 'lipcoder.toggleCursorLineReading',
                description: 'Toggle cursor-based line reading',
                preventDefault: true
            },
            {
                pattern: /^(current line|line number)$/i,
                command: 'lipcoder.readCurrentLine',
                description: 'Read current line number',
                preventDefault: true
            },
            {
                pattern: /^(switch panel|panel)$/i,
                command: 'lipcoder.switchPanel',
                description: 'Switch between panels',
                preventDefault: true
            },

            // Code Generation Commands
            {
                pattern: /^(complete function|complete)\s*(.*)$/i,
                command: '',
                description: 'Complete function using AI',
                preventDefault: true,
                isRegex: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    const functionName = match[2]?.trim();
                    return await this.executeLLMCodeGeneration({
                        codeDescription: originalText,
                        generationType: 'complete',
                        functionName: functionName
                    }, originalText);
                }
            },
            {
                pattern: /^(make test function for|create test for|test function for)\s+(.+)$/i,
                command: '',
                description: 'Generate test function using AI',
                preventDefault: true,
                isRegex: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    const functionName = match[2]?.trim();
                    return await this.executeLLMCodeGeneration({
                        codeDescription: originalText,
                        generationType: 'test',
                        functionName: functionName
                    }, originalText);
                }
            },
            {
                pattern: /^(make function|create function)\s+(.+)$/i,
                command: '',
                description: 'Create function using AI',
                preventDefault: true,
                isRegex: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    const functionDescription = match[2]?.trim();
                    return await this.executeLLMCodeGeneration({
                        codeDescription: functionDescription,
                        generationType: 'create',
                        functionName: functionDescription
                    }, originalText);
                }
            },
            {
                pattern: /^(generate|create|make)\s+(.+)$/i,
                command: '',
                description: 'Generate code using AI',
                preventDefault: true,
                isRegex: true,
                customHandler: async (match: RegExpMatchArray | string[], originalText: string) => {
                    const codeDescription = match[2]?.trim();
                    return await this.executeLLMCodeGeneration({
                        codeDescription: codeDescription,
                        generationType: 'create'
                    }, originalText);
                }
            }
        ];

        this.patterns = defaultPatterns;
    }

    /**
     * Add a custom command pattern
     */
    addPattern(pattern: CommandPattern): void {
        this.patterns.push(pattern);
        if (this.options.enableLogging) {
            log(`[CommandRouter] Added custom pattern: ${pattern.description || pattern.command}`);
        }
    }

    /**
     * Remove a command pattern by command name
     */
    removePattern(command: string): boolean {
        const initialLength = this.patterns.length;
        this.patterns = this.patterns.filter(p => p.command !== command);
        const removed = this.patterns.length < initialLength;
        
        if (removed && this.options.enableLogging) {
            log(`[CommandRouter] Removed pattern for command: ${command}`);
        }
        
        return removed;
    }

    /**
     * Use LLM to intelligently match natural language to commands
     */
    private async matchCommandWithLLM(text: string): Promise<CommandPattern | null> {
        if (!this.options.useLLMMatching) {
            return null;
        }

        try {
            const client = getOpenAIClient();
            
            // Create a list of available commands for the LLM to choose from
            const commandList = this.patterns.map(p => ({
                pattern: p.pattern.toString(),
                command: p.command,
                description: p.description || p.command
            }));

                         const prompt = `You are a voice command interpreter for VS Code. The user said: "${text}"

Available commands:
${commandList.map((cmd, i) => `${i + 1}. ${cmd.description} (Pattern: ${cmd.pattern}, Command: ${cmd.command})`).join('\n')}

If the user's speech matches any of these commands (even with natural variations), respond with ONLY the command number (1-${commandList.length}). 
If no command matches, respond with "NONE".

Examples:
- "save this file" → matches "save file" 
- "can you save" → matches "save file"
- "format my code" → matches "format document"
- "show me the sidebar" → matches "toggle sidebar"
- "go to line 25" → matches "go to line number"
- "navigate to function handleClick" → matches "go to function"
- "find the handleSubmit function" → matches "go to function"
- "run the build script" → matches "run npm script"
- "execute test" → matches "run npm script"
- "hello world" → NONE (not a command)

Response:`;

            const response = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 10,
                temperature: 0.1
            });

            const result = response.choices[0]?.message?.content?.trim();
            
            if (this.options.enableLogging) {
                log(`[CommandRouter] LLM response for "${text}": ${result}`);
            }

            if (result === "NONE" || !result) {
                return null;
            }

            // Parse the command number
            const commandIndex = parseInt(result) - 1;
            if (commandIndex >= 0 && commandIndex < this.patterns.length) {
                const matchedPattern = this.patterns[commandIndex];
                if (this.options.enableLogging) {
                    log(`[CommandRouter] LLM matched "${text}" to command: ${matchedPattern.description || matchedPattern.command}`);
                }
                return matchedPattern;
            }

            return null;

        } catch (error) {
            if (this.options.enableLogging) {
                logError(`[CommandRouter] LLM matching failed: ${error}`);
            }
            return null;
        }
    }

    /**
     * Set the editor context for command execution
     */
    setEditorContext(context: RouterEditorContext | null): void {
        this.editorContext = context;
        if (this.options.enableLogging && context) {
            log(`[CommandRouter] Editor context set: ${context.documentUri.fsPath} at line ${context.position.line + 1}`);
        }
    }

    /**
     * Get the current editor context
     */
    getEditorContext(): RouterEditorContext | null {
        return this.editorContext;
    }

    /**
     * Process transcribed text and execute matching commands using LLM
     */
    async processTranscription(text: string): Promise<boolean> {
        if (!text || !text.trim()) {
            return false;
        }

        const trimmedText = text.trim();
        
        if (this.options.enableLogging) {
            log(`[CommandRouter] ==========================================`);
            log(`[CommandRouter] Processing transcription: "${trimmedText}"`);
            log(`[CommandRouter] Using LLM-based command classification`);
        }

        // Use LLM to classify and execute command
        try {
            const commandResult = await this.classifyAndExecuteWithLLM(trimmedText);
            if (commandResult) {
                if (this.options.enableLogging) {
                    log(`[CommandRouter] ✅ LLM successfully executed command`);
                }
                return true;
            } else {
                if (this.options.enableLogging) {
                    log(`[CommandRouter] ⚠️ LLM did not execute command, falling back to pattern matching`);
                }
            }
        } catch (error) {
            if (this.options.enableLogging) {
                logError(`[CommandRouter] LLM command processing failed: ${error}`);
            }
        }

        // Fallback to pattern matching if LLM fails
        let matchedPattern: CommandPattern | null = null;
        if (this.options.useLLMMatching) {
            matchedPattern = await this.matchCommandWithLLM(trimmedText);
        }

        // If LLM didn't find a match, fall back to exact pattern matching
        if (!matchedPattern) {
            if (this.options.enableLogging) {
                log(`[CommandRouter] LLM didn't find match, trying exact pattern matching...`);
            }
            
            for (let i = 0; i < this.patterns.length; i++) {
                const pattern = this.patterns[i];
                
                if (this.options.enableLogging) {
                    log(`[CommandRouter] Testing pattern ${i}: ${pattern.pattern} against "${trimmedText}"`);
                }
                
                const match = this.matchPattern(trimmedText, pattern);
                
                if (match) {
                    if (this.options.enableLogging) {
                        log(`[CommandRouter] ✅ MATCH FOUND! Pattern ${i}: ${pattern.description}`);
                        log(`[CommandRouter] Match result: ${JSON.stringify(match)}`);
                    }
                    
                    // Handle custom handlers immediately
                    if (pattern.customHandler) {
                        try {
                            const result = await pattern.customHandler(match, trimmedText);
                            return result;
                        } catch (error) {
                            logError(`[CommandRouter] Custom handler failed: ${error}`);
                            if (this.options.showNotifications) {
                                vscode.window.showErrorMessage(`Command failed: ${pattern.description || 'Custom command'}`);
                            }
                            continue; // Try next pattern
                        }
                    }
                    
                    matchedPattern = pattern;
                    break;
                } else {
                    if (this.options.enableLogging) {
                        log(`[CommandRouter] ❌ No match for pattern ${i}`);
                    }
                }
            }
            
            if (this.options.enableLogging) {
                log(`[CommandRouter] Pattern matching complete. Found match: ${!!matchedPattern}`);
            }
        }

        // Execute the matched command
        if (matchedPattern) {
            try {
                // Check if pattern has a custom handler
                if (matchedPattern.customHandler) {
                    const result = await matchedPattern.customHandler([trimmedText], trimmedText);
                    return result;
                }

                // Standard command execution
                await this.executeCommand(matchedPattern, [trimmedText], trimmedText);
                return true; // Command was executed
            } catch (error) {
                logError(`[CommandRouter] Failed to execute command ${matchedPattern.command}: ${error}`);
                if (this.options.showNotifications) {
                    vscode.window.showErrorMessage(`Command failed: ${matchedPattern.description || matchedPattern.command}`);
                }
            }
        }

        // If LLM matching is enabled, also try to match package.json scripts
        if (this.options.useLLMMatching) {
            try {
                const scriptName = await findPackageJsonScriptWithLLM(trimmedText);
                if (scriptName) {
                    const success = await executePackageJsonScript(scriptName);
                    if (success) {
                        return true;
                    }
                }
            } catch (error) {
                if (this.options.enableLogging) {
                    logError(`[CommandRouter] LLM script matching failed: ${error}`);
                }
            }
        }

        // No command matched
        if (this.options.enableLogging) {
            logWarning(`[CommandRouter] No command pattern matched for: "${trimmedText}"`);
        }

        return false;
    }

    /**
     * Check if text matches a pattern
     */
    private matchPattern(text: string, pattern: CommandPattern): RegExpMatchArray | string[] | null {
        if (pattern.isRegex || pattern.pattern instanceof RegExp) {
            const regex = pattern.pattern instanceof RegExp ? pattern.pattern : new RegExp(pattern.pattern, 'i');
            return text.match(regex);
        } else {
            // Simple string comparison (case insensitive)
            const patternStr = pattern.pattern as string;
            return text.toLowerCase() === patternStr.toLowerCase() ? [text] : null;
        }
    }

    /**
     * Execute a matched command
     */
    private async executeCommand(pattern: CommandPattern, match: RegExpMatchArray | string[], originalText: string): Promise<void> {
        if (this.options.enableLogging) {
            log(`[CommandRouter] Executing command: ${pattern.command} (${pattern.description || 'no description'})`);
        }

        // Handle parameter extraction
        let args = pattern.args || [];

        if (pattern.parameterExtractor) {
            try {
                const extractedArgs = pattern.parameterExtractor(match, originalText);
                args = extractedArgs && extractedArgs.length > 0 ? extractedArgs : args;
            } catch (error) {
                logError(`[CommandRouter] Parameter extraction failed: ${error}`);
            }
        }



        // Execute the VS Code command
        // For LipCoder commands, pass the captured editor context if available
        if (pattern.command.startsWith('lipcoder.') && this.editorContext && this.editorContext.editor) {
            if (this.options.enableLogging) {
                log(`[CommandRouter] Executing LipCoder command with captured editor context: ${this.editorContext.documentUri.fsPath}`);
            }
            await vscode.commands.executeCommand(pattern.command, this.editorContext.editor, ...args);
        } else {
            await vscode.commands.executeCommand(pattern.command, ...args);
        }

        if (this.options.showNotifications) {
            vscode.window.showInformationMessage(`Executed: ${pattern.description || pattern.command}`);
        }

        logSuccess(`[CommandRouter] Successfully executed: ${pattern.command}`);
    }

    /**
     * Get all registered patterns (for debugging/configuration)
     */
    getPatterns(): CommandPattern[] {
        return [...this.patterns];
    }

    /**
     * Clear all patterns
     */
    clearPatterns(): void {
        this.patterns = [];
        if (this.options.enableLogging) {
            log('[CommandRouter] All patterns cleared');
        }
    }

    /**
     * Reset to default patterns
     */
    resetToDefaults(): void {
        this.clearPatterns();
        this.initializeDefaultPatterns();
        if (this.options.enableLogging) {
            log('[CommandRouter] Reset to default patterns');
        }
    }

    /**
     * Update router options
     */
    updateOptions(newOptions: Partial<CommandRouterOptions>): void {
        this.options = { ...this.options, ...newOptions };
        if (this.options.enableLogging) {
            log(`[CommandRouter] Options updated: ${JSON.stringify(newOptions)}`);
        }
    }
} 