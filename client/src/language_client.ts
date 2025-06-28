import * as path from 'path';
import { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    ServerOptions,
    TransportKind,
    LanguageClientOptions
} from 'vscode-languageclient/node';
import * as vscode from 'vscode';


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

    const client = new LanguageClient(
        'lipcoder',
        'LipCoder LSP',
        serverOpts,
        clientOpts
    );
    context.subscriptions.push({
        dispose: () => {
            client.stop();
        },
    });
    client.start();

    return client;
}