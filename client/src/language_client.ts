import * as path from 'path';
import { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    ServerOptions,
    TransportKind,
    LanguageClientOptions
} from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import { logWarning, logSuccess, logError } from './utils';

let languageClient: LanguageClient | null = null;

export function startLanguageClient(context: ExtensionContext) {
    const serverModule = context.asAbsolutePath(
        path.join('dist', 'server', 'server.js')
    );
    const serverOpts: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug: {
            module: serverModule,
            transport: TransportKind.stdio,
            options: { execArgv: ['--inspect=6009'] },
        },
    };

    const clientOpts: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'javascript' },
            { scheme: 'file', language: 'typescript' },
            { scheme: 'file', language: 'python' },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*'),
        },
    };

    languageClient = new LanguageClient(
        'lipcoder',
        'LipCoder LSP',
        serverOpts,
        clientOpts
    );
    
    context.subscriptions.push({
        dispose: async () => {
            await stopLanguageClient();
        },
    });
    
    languageClient.start();
    return languageClient;
}

/**
 * Stop the language client with proper cleanup
 */
export async function stopLanguageClient(): Promise<void> {
    if (!languageClient) return;
    
    try {
        logWarning('[LanguageClient] Stopping language client...');
        
        // Stop the client and wait for it to fully shut down
        await languageClient.stop(5000); // 5 second timeout
        
        logSuccess('[LanguageClient] Language client stopped successfully');
    } catch (error) {
        logError(`[LanguageClient] Error stopping language client: ${error}`);
        
        // Force dispose if stop() fails
        try {
            languageClient.dispose();
        } catch (disposeError) {
            logError(`[LanguageClient] Error disposing language client: ${disposeError}`);
        }
    } finally {
        languageClient = null;
    }
}