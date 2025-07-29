import * as vscode from 'vscode';
import { log, logError, logSuccess, logWarning } from './utils';
import { getOpenAIClient } from './llm';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Find a function in the current document using LLM
 */
async function findFunctionWithLLM(functionName: string): Promise<{ line: number; character: number } | null> {
    const editor = vscode.window.activeTextEditor;
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
async function executePackageJsonScript(scriptName: string): Promise<boolean> {
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

export class CommandRouter {
    private patterns: CommandPattern[] = [];
    private options: CommandRouterOptions;

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
            
            // Navigation commands
            {
                pattern: /^(go to line|goto line)\s*(\d+)?$/i,
                command: 'workbench.action.gotoLine',
                description: 'Go to line',
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
                pattern: /^(open terminal|terminal)$/i,
                command: 'workbench.action.terminal.new',
                description: 'Open new terminal',
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
     * Process transcribed text and execute matching commands
     */
    async processTranscription(text: string): Promise<boolean> {
        if (!text || !text.trim()) {
            return false;
        }

        const trimmedText = text.trim();
        
        if (this.options.enableLogging) {
            log(`[CommandRouter] Processing transcription: "${trimmedText}"`);
        }

        // First try LLM-based intelligent matching
        let matchedPattern: CommandPattern | null = null;
        if (this.options.useLLMMatching) {
            matchedPattern = await this.matchCommandWithLLM(trimmedText);
        }

        // If LLM didn't find a match, fall back to exact pattern matching
        if (!matchedPattern) {
            for (const pattern of this.patterns) {
                const match = this.matchPattern(trimmedText, pattern);
                
                if (match) {
                    matchedPattern = pattern;
                    break;
                }
            }
        }

        // Execute the matched command
        if (matchedPattern) {
            try {
                await this.executeCommand(matchedPattern, [trimmedText], trimmedText);
                return true; // Command was executed
            } catch (error) {
                logError(`[CommandRouter] Failed to execute command ${matchedPattern.command}: ${error}`);
                if (this.options.showNotifications) {
                    vscode.window.showErrorMessage(`Command failed: ${matchedPattern.description || matchedPattern.command}`);
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

        // Handle special cases with extracted parameters
        let args = pattern.args;

        // Special handling for "go to line" command
        if (pattern.command === 'workbench.action.gotoLine' && match.length > 2 && match[2]) {
            // If line number was captured, we could potentially pre-fill it
            // For now, just open the dialog
        }

        // Execute the VS Code command
        await vscode.commands.executeCommand(pattern.command, ...args || []);

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