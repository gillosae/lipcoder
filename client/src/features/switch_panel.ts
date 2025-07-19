// client/src/features/switch_panel.ts
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakToken } from '../audio';

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
            await speakToken('in');
            await speakToken(choice.toLowerCase());

            // 👉 When switching into the editor, trigger a readCurrentLine
            if (choice === 'Editor') {
                await vscode.commands.executeCommand('lipcoder.readCurrentLine');
            }
        })
    );
}