// client/src/features/switch_panel.ts
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, speakGPT, TokenChunk } from '../audio';

interface PanelItem {
    label: string;
    command: string;
}

export function registerSwitchPanel(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.switchPanel', async () => {
            const panels: PanelItem[] = [
                { label: 'Explorer', command: 'workbench.view.explorer' },
                { label: 'Editor', command: 'workbench.action.focusActiveEditorGroup' },
                // { label: 'Terminal', command: 'workbench.action.terminal.focus' },
                { label: 'Terminal', command: 'lipcoder.openTerminal' },
                { label: 'Problems', command: 'workbench.actions.view.problems' },
                { label: 'Output', command: 'workbench.action.output.toggleOutput' },
                { label: 'Debug Console', command: 'workbench.debug.action.toggleRepl' },
            ];
            const choice = await vscode.window.showQuickPick(
                panels.map(p => p.label),
                { placeHolder: 'Select panel to focus' }
            );
            if (!choice) return;
            const panel = panels.find(p => p.label === choice)!;
            await vscode.commands.executeCommand(panel.command);

            // Visual feedback
            vscode.window.showInformationMessage(`In ${choice}`);
            await speakTokenList([
                { tokens: ['in'], category: undefined },
                { tokens: [choice.toLowerCase()], category: undefined }
            ]);

            // Removed automatic file content reading when switching to editor
        }),
        
        // Direct command to go to explorer with audio feedback
        vscode.commands.registerCommand('lipcoder.goToExplorer', async () => {
            await vscode.commands.executeCommand('workbench.view.explorer');
            
            // Audio feedback
            await speakTokenList([
                { tokens: ['in explorer'], category: undefined }
            ]);
        }),
        
        // Direct command to go to editor with audio feedback
        vscode.commands.registerCommand('lipcoder.goToEditor', async () => {
            try {
                // Check if there's an active editor first
                const activeEditor = vscode.window.activeTextEditor;
                
                if (!activeEditor) {
                    // No active editor, try to open the most recent file or show welcome tab
                    await vscode.commands.executeCommand('workbench.action.showAllEditors');
                    
                    // Wait a bit and check again
                    setTimeout(async () => {
                        const newActiveEditor = vscode.window.activeTextEditor;
                        if (newActiveEditor) {
                            await speakGPT('in editor');
                        } else {
                            await speakGPT('No files open in editor');
                        }
                    }, 200);
                    return;
                }
                
                // There is an active editor, focus it using multiple methods
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                
                // Also try alternative focus commands
                await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                
                // Ensure the document is shown and focused
                await vscode.window.showTextDocument(activeEditor.document, {
                    viewColumn: activeEditor.viewColumn,
                    preserveFocus: false
                });
                
                // Audio feedback
                await speakTokenList([
                    { tokens: ['in editor'], category: undefined }
                ]);
                
            } catch (error) {
                console.error('Error switching to editor:', error);
                await speakTokenList([
                    { tokens: ['Error switching to editor'], category: undefined }
                ]);
            }
        })
    );
}