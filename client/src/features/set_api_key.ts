import * as vscode from 'vscode';

export function registerSetAPIKey(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setOpenAIAPIKey', async () => {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your OpenAI API key',
                ignoreFocusOut: true,
                placeHolder: 'sk-...'
            });
            if (apiKey) {
                await vscode.workspace.getConfiguration('lipcoder').update(
                    'openaiApiKey', apiKey, vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage('OpenAI API key saved.');
            }
        })
    );
}