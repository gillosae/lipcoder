import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { log, logSuccess, logError, logWarning, logInfo } from '../utils';
import { lipcoderLog } from '../logger';

/**
 * Register debug output commands to help troubleshoot logging issues
 */
export function registerDebugOutput(context: ExtensionContext) {
    context.subscriptions.push(
        // Show LipCoder output channel
        vscode.commands.registerCommand('lipcoder.showDebugOutput', async () => {
            // Show the LipCoder output channel
            lipcoderLog.show(true);
            
            // Test all logging functions
            log('[DEBUG] Testing console and output channel logging...');
            logSuccess('[DEBUG] Success message test');
            logError('[DEBUG] Error message test');
            logWarning('[DEBUG] Warning message test');
            logInfo('[DEBUG] Info message test');
            
            // Show information message
            vscode.window.showInformationMessage(
                'LipCoder debug output restored! Check the "LipCoder" output channel and Developer Console.',
                'Open Developer Console'
            ).then(selection => {
                if (selection === 'Open Developer Console') {
                    vscode.commands.executeCommand('workbench.action.toggleDevTools');
                }
            });
        }),

        // Open Developer Console
        vscode.commands.registerCommand('lipcoder.openDeveloperConsole', async () => {
            await vscode.commands.executeCommand('workbench.action.toggleDevTools');
            log('[DEBUG] Developer Console opened');
            vscode.window.showInformationMessage('Developer Console opened. Check the Console tab for lipcoder logs.');
        }),

        // Clear all output channels
        vscode.commands.registerCommand('lipcoder.clearDebugOutput', async () => {
            lipcoderLog.clear();
            log('[DEBUG] LipCoder output channel cleared');
            vscode.window.showInformationMessage('LipCoder debug output cleared.');
        }),

        // Test logging functionality
        vscode.commands.registerCommand('lipcoder.testLogging', async () => {
            const timestamp = new Date().toISOString();
            
            log(`[TEST] ${timestamp} - Testing basic logging`);
            logSuccess(`[TEST] ${timestamp} - Testing success logging`);
            logError(`[TEST] ${timestamp} - Testing error logging`);
            logWarning(`[TEST] ${timestamp} - Testing warning logging`);
            logInfo(`[TEST] ${timestamp} - Testing info logging`);
            
            lipcoderLog.appendLine(`[TEST] ${timestamp} - Direct output channel test`);
            
            // Show the output channel
            lipcoderLog.show(true);
            
            vscode.window.showInformationMessage(
                'Logging test completed! Check both the LipCoder output channel and Developer Console.',
                'Show Output Channel',
                'Open Developer Console'
            ).then(selection => {
                if (selection === 'Show Output Channel') {
                    lipcoderLog.show(true);
                } else if (selection === 'Open Developer Console') {
                    vscode.commands.executeCommand('workbench.action.toggleDevTools');
                }
            });
        }),

        // Show all available output channels
        vscode.commands.registerCommand('lipcoder.showAllOutputChannels', async () => {
            // Show the output panel
            await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
            
            log('[DEBUG] Output panel opened. Available channels should be visible in the dropdown.');
            
            vscode.window.showInformationMessage(
                'Output panel opened. Look for these LipCoder channels in the dropdown: "LipCoder", "LipCoder ASR", "ASR Streaming"'
            );
        })
    );
}
