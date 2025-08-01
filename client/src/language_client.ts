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

/**
 * Get the current language client instance
 */
export function getLanguageClient(): LanguageClient | null {
    return languageClient;
}

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

/**
 * Restart the language client to pick up new server changes
 */
export async function restartLanguageClient(context: ExtensionContext): Promise<LanguageClient | null> {
    logWarning('[LanguageClient] Restarting language client...');
    
    try {
        // Stop the current client if it exists
        await stopLanguageClient();
        
        // Wait a brief moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Start a new client
        const newClient = startLanguageClient(context);
        
        logSuccess('[LanguageClient] Language client restarted successfully');
        return newClient;
    } catch (error) {
        logError(`[LanguageClient] Error restarting language client: ${error}`);
        return null;
    }
}

/**
 * Emergency synchronous language client stop for shutdown scenarios
 */
export function emergencyStopLanguageClient(): void {
    if (!languageClient) return;
    
    try {
        logWarning('[LanguageClient] Emergency stop of language client...');
        
        // Try to stop synchronously first
        languageClient.stop();
        
        // Force dispose regardless
        languageClient.dispose();
        
        logSuccess('[LanguageClient] Language client emergency stopped');
    } catch (error) {
        logError(`[LanguageClient] Error in emergency stop: ${error}`);
    } finally {
        languageClient = null;
    }
}