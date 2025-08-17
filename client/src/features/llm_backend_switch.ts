import * as vscode from 'vscode';
import { speakTokenList } from '../audio';
import { currentLLMBackend, LLMBackend, setLLMBackend, claudeConfig } from '../config';
import { log } from '../utils';

export function registerLLMBackendSwitch(context: vscode.ExtensionContext) {
    // Command to select LLM backend via quick pick
    const selectLLMBackend = vscode.commands.registerCommand('lipcoder.selectLLMBackend', async () => {
        const items = [
            {
                label: '$(robot) Claude',
                description: 'Anthropic Claude - Advanced reasoning and code understanding',
                backend: LLMBackend.Claude
            },
            {
                label: '$(comment-discussion) ChatGPT',
                description: 'OpenAI GPT-4o-mini - Fast and efficient',
                backend: LLMBackend.ChatGPT
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Current: ${currentLLMBackend === LLMBackend.Claude ? 'Claude' : 'ChatGPT'} - Select LLM backend for vibe coding and chat completions`,
            ignoreFocusOut: true
        });

        if (selected) {
            setLLMBackend(selected.backend);
            
            // Update VS Code settings
            const config = vscode.workspace.getConfiguration('lipcoder');
            await config.update('llmBackend', selected.backend, vscode.ConfigurationTarget.Global);
            
            const backendName = selected.backend === LLMBackend.Claude ? 'Claude' : 'ChatGPT';
            await speakTokenList([{ tokens: [`Switched to ${backendName}`], category: undefined }]);
            vscode.window.showInformationMessage(`LLM Backend switched to ${backendName}`);
            log(`[LLM] Backend switched to ${backendName}`);
        }
    });

    // Command to switch directly to ChatGPT
    const switchToChatGPT = vscode.commands.registerCommand('lipcoder.switchToChatGPT', async () => {
        setLLMBackend(LLMBackend.ChatGPT);
        
        // Update VS Code settings
        const config = vscode.workspace.getConfiguration('lipcoder');
        await config.update('llmBackend', 'chatgpt', vscode.ConfigurationTarget.Global);
        
        await speakTokenList([{ tokens: ['Switched to ChatGPT'], category: undefined }]);
        vscode.window.showInformationMessage('LLM Backend switched to ChatGPT');
        log('[LLM] Backend switched to ChatGPT');
    });

    // Command to switch directly to Claude
    const switchToClaude = vscode.commands.registerCommand('lipcoder.switchToClaude', async () => {
        setLLMBackend(LLMBackend.Claude);
        
        // Update VS Code settings
        const config = vscode.workspace.getConfiguration('lipcoder');
        await config.update('llmBackend', 'claude', vscode.ConfigurationTarget.Global);
        
        await speakTokenList([{ tokens: ['Switched to Claude'], category: undefined }]);
        vscode.window.showInformationMessage('LLM Backend switched to Claude');
        log('[LLM] Backend switched to Claude');
    });

    // Command to show current LLM status
    const showLLMStatus = vscode.commands.registerCommand('lipcoder.showLLMStatus', async () => {
        const backendName = currentLLMBackend === LLMBackend.Claude ? 'Claude' : 'ChatGPT';
        let statusMessage = `Current LLM Backend: ${backendName}`;
        
        if (currentLLMBackend === LLMBackend.Claude) {
            statusMessage += `\nModel: ${claudeConfig.model}`;
            statusMessage += `\nMax Tokens: ${claudeConfig.maxTokens}`;
            statusMessage += `\nTemperature: ${claudeConfig.temperature}`;
            statusMessage += `\nAPI Key: ${claudeConfig.apiKey ? 'Configured' : 'Not Set'}`;
        } else {
            const config = vscode.workspace.getConfiguration('lipcoder');
            const openaiKey = config.get<string>('openaiApiKey') || '';
            statusMessage += `\nModel: gpt-4o-mini`;
            statusMessage += `\nAPI Key: ${openaiKey ? 'Configured' : 'Not Set'}`;
        }

        await speakTokenList([{ tokens: [`Current LLM backend is ${backendName}`], category: undefined }]);
        vscode.window.showInformationMessage(statusMessage);
        log(`[LLM] Status: ${statusMessage.replace(/\n/g, ', ')}`);
    });

    // Command to set Claude API key
    const setClaudeAPIKey = vscode.commands.registerCommand('lipcoder.setClaudeAPIKey', async () => {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your Anthropic Claude API key',
            placeHolder: 'sk-ant-api...',
            password: true,
            ignoreFocusOut: true
        });

        if (apiKey) {
            const config = vscode.workspace.getConfiguration('lipcoder');
            await config.update('claudeApiKey', apiKey, vscode.ConfigurationTarget.Global);
            
            claudeConfig.apiKey = apiKey;
            
            await speakTokenList([{ tokens: ['Claude API key set'], category: undefined }]);
            vscode.window.showInformationMessage('Claude API key has been set successfully!');
            log('[LLM] Claude API key configured');
        }
    });

    context.subscriptions.push(
        selectLLMBackend,
        switchToChatGPT,
        switchToClaude,
        showLLMStatus,
        setClaudeAPIKey
    );
}
