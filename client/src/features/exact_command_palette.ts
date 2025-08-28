import * as vscode from 'vscode';
import { EXACT_COMMANDS, tryExactCommand } from './exact_commands';
import { log } from '../utils';

/**
 * Register all exact commands as VS Code commands for Command Palette access
 */
export async function registerExactCommandPalette(context: vscode.ExtensionContext): Promise<void> {
    log('[ExactCommandPalette] Registering exact commands for Command Palette...');
    
    // Create a map to avoid duplicate command registrations
    const registeredCommands = new Set<string>();
    
    // Register each exact command
    for (const cmd of EXACT_COMMANDS) {
        // Skip if already registered in this session
        if (registeredCommands.has(cmd.command)) {
            continue;
        }
        
        // Check if command already exists in VS Code registry
        try {
            const existingCommands = await vscode.commands.getCommands(true);
            if (existingCommands.includes(cmd.command)) {
                log(`[ExactCommandPalette] Command ${cmd.command} already exists, skipping registration`);
                registeredCommands.add(cmd.command);
                continue;
            }
        } catch (error) {
            log(`[ExactCommandPalette] Error checking existing commands: ${error}`);
        }
        
        registeredCommands.add(cmd.command);
        
        // Create a command handler that executes the exact command
        const commandHandler = async () => {
            try {
                log(`[ExactCommandPalette] Executing command via palette: ${cmd.command}`);
                
                // Use the first pattern as the trigger text for tryExactCommand
                const triggerPattern = cmd.patterns[0];
                const result = await tryExactCommand(triggerPattern);
                
                if (result) {
                    log(`[ExactCommandPalette] Command executed successfully: ${result.response}`);
                    
                    // Show feedback if needed
                    if (result.shouldSpeak && result.response) {
                        // Use status bar for non-intrusive feedback
                        vscode.window.setStatusBarMessage(`LipCoder: ${result.response}`, 2000);
                    }
                } else {
                    log(`[ExactCommandPalette] Command execution failed for: ${cmd.command}`);
                    vscode.window.showWarningMessage(`Failed to execute command: ${cmd.command}`);
                }
            } catch (error) {
                log(`[ExactCommandPalette] Error executing command ${cmd.command}: ${error}`);
                vscode.window.showErrorMessage(`Error executing command: ${error}`);
            }
        };
        
        // Register the command
        try {
            const disposable = vscode.commands.registerCommand(cmd.command, commandHandler);
            context.subscriptions.push(disposable);
            log(`[ExactCommandPalette] Registered command: ${cmd.command}`);
        } catch (error) {
            log(`[ExactCommandPalette] Failed to register command ${cmd.command}: ${error}`);
            // Continue with other commands
        }
    }
    
    // Register line navigation command (special case)
    const lineNavHandler = async () => {
        try {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter line number to navigate to',
                placeHolder: 'e.g., 42',
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num) || num < 1) {
                        return 'Please enter a valid line number (1 or greater)';
                    }
                    return null;
                }
            });
            
            if (input) {
                const lineNumber = parseInt(input);
                const result = await tryExactCommand(`line ${lineNumber}`);
                
                if (result) {
                    vscode.window.setStatusBarMessage(`LipCoder: ${result.response}`, 2000);
                } else {
                    vscode.window.showWarningMessage(`Failed to navigate to line ${lineNumber}`);
                }
            }
        } catch (error) {
            log(`[ExactCommandPalette] Error in line navigation: ${error}`);
            vscode.window.showErrorMessage(`Error navigating to line: ${error}`);
        }
    };
    
    const lineNavDisposable = vscode.commands.registerCommand('lipcoder.goToLineNumber', lineNavHandler);
    context.subscriptions.push(lineNavDisposable);
    
    log(`[ExactCommandPalette] Successfully registered ${registeredCommands.size + 1} exact commands for Command Palette`);
}

/**
 * Get all exact command patterns for help/documentation
 */
export function getExactCommandsForHelp(): Array<{command: string, patterns: string[], feedback: string, type: string}> {
    return EXACT_COMMANDS.map(cmd => ({
        command: cmd.command,
        patterns: cmd.patterns,
        feedback: cmd.feedback,
        type: cmd.type
    }));
}

/**
 * Show help for all available exact commands
 */
export function registerShowExactCommandsHelp(context: vscode.ExtensionContext): void {
    const helpHandler = async () => {
        try {
            const commands = getExactCommandsForHelp();
            
            // Create help content
            let helpContent = '# LipCoder Exact Commands\n\n';
            helpContent += 'These commands can be executed via voice (ASR) or Command Palette:\n\n';
            
            // Group by type
            const navigationCommands = commands.filter(cmd => cmd.type === 'navigation');
            const actionCommands = commands.filter(cmd => cmd.type === 'action');
            
            helpContent += '## Navigation Commands\n\n';
            for (const cmd of navigationCommands) {
                helpContent += `### ${cmd.command}\n`;
                helpContent += `**Feedback:** ${cmd.feedback}\n\n`;
                helpContent += '**Voice patterns:**\n';
                for (const pattern of cmd.patterns.slice(0, 5)) { // Show first 5 patterns
                    helpContent += `- "${pattern}"\n`;
                }
                if (cmd.patterns.length > 5) {
                    helpContent += `- ... and ${cmd.patterns.length - 5} more patterns\n`;
                }
                helpContent += '\n';
            }
            
            helpContent += '## Action Commands\n\n';
            for (const cmd of actionCommands) {
                helpContent += `### ${cmd.command}\n`;
                helpContent += `**Feedback:** ${cmd.feedback}\n\n`;
                helpContent += '**Voice patterns:**\n';
                for (const pattern of cmd.patterns.slice(0, 5)) { // Show first 5 patterns
                    helpContent += `- "${pattern}"\n`;
                }
                if (cmd.patterns.length > 5) {
                    helpContent += `- ... and ${cmd.patterns.length - 5} more patterns\n`;
                }
                helpContent += '\n';
            }
            
            helpContent += '## Special Commands\n\n';
            helpContent += '### Line Navigation\n';
            helpContent += '**Command:** `lipcoder.goToLineNumber`\n';
            helpContent += '**Voice patterns:** "go to line [number]", "line [number]", "줄 [number]"\n';
            helpContent += '**Usage:** Say the pattern followed by a line number, or use Command Palette and enter the line number when prompted.\n\n';
            
            // Create and show document
            const doc = await vscode.workspace.openTextDocument({
                content: helpContent,
                language: 'markdown'
            });
            
            await vscode.window.showTextDocument(doc);
            
        } catch (error) {
            log(`[ExactCommandPalette] Error showing help: ${error}`);
            vscode.window.showErrorMessage(`Error showing help: ${error}`);
        }
    };
    
    const helpDisposable = vscode.commands.registerCommand('lipcoder.showExactCommandsHelp', helpHandler);
    context.subscriptions.push(helpDisposable);
    
    log('[ExactCommandPalette] Registered help command: lipcoder.showExactCommandsHelp');
}
