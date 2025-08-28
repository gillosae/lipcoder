import * as vscode from 'vscode';
import { 
    logCursorMovement, 
    logTextChange, 
    logSelectionChange, 
    logWindowFocus, 
    logTabChange, 
    logKeyboardInput, 
    logMouseInput, 
    logFeatureStart, 
    logFeatureStop, 
    logFeatureInterrupt, 
    logCommandExecution, 
    logFileOperation,
    logASRStart,
    logASRStop,
    logASRCommand,
    logExtensionLifecycle,
    logSystemEvent
} from './activity_logger';
import { log } from './utils';

export class ComprehensiveEventTracker {
    private disposables: vscode.Disposable[] = [];
    private lastCursorPosition: vscode.Position | null = null;
    private lastSelection: vscode.Selection | null = null;
    private activeFeatures: Map<string, { startTime: number; details?: any }> = new Map();
    private commandExecutionTimes: Map<string, number> = new Map();

    public initialize(context: vscode.ExtensionContext): void {
        log('[ComprehensiveEventTracker] Initializing comprehensive event tracking...');
        
        // Track cursor movement and selection changes
        this.setupCursorTracking();
        
        // Track text document changes
        this.setupTextChangeTracking();
        
        // Track window focus changes
        this.setupWindowFocusTracking();
        
        // Track tab changes (file open/close/switch)
        this.setupTabTracking();
        
        // Track command execution
        this.setupCommandTracking();
        
        // Track file operations
        this.setupFileOperationTracking();
        
        // Track workspace changes
        this.setupWorkspaceTracking();
        
        // Track terminal events
        this.setupTerminalTracking();
        
        // Track debug events
        this.setupDebugTracking();
        
        // Track extension events
        this.setupExtensionTracking();
        
        // Add all disposables to context
        context.subscriptions.push(...this.disposables);
        
        log('[ComprehensiveEventTracker] Comprehensive event tracking initialized');
        logSystemEvent('comprehensive_tracker_initialized', {
            trackersCount: this.disposables.length
        });
    }

    private setupCursorTracking(): void {
        // Track cursor position changes
        const cursorDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
            const editor = event.textEditor;
            const selection = event.selections[0]; // Primary selection
            
            if (!editor || !selection) return;
            
            const currentPosition = selection.active;
            const file = editor.document.uri.fsPath;
            
            // Log cursor movement if position changed
            if (!this.lastCursorPosition || 
                !this.lastCursorPosition.isEqual(currentPosition)) {
                
                logCursorMovement(
                    file,
                    currentPosition.line,
                    currentPosition.character,
                    this.lastCursorPosition?.line,
                    this.lastCursorPosition?.character
                );
                
                this.lastCursorPosition = currentPosition;
            }
            
            // Log selection change if selection changed
            if (!this.lastSelection || 
                !this.lastSelection.isEqual(selection)) {
                
                logSelectionChange(file, selection);
                this.lastSelection = selection;
            }
        });
        
        this.disposables.push(cursorDisposable);
    }

    private setupTextChangeTracking(): void {
        const textChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            const file = event.document.uri.fsPath;
            
            for (const change of event.contentChanges) {
                let changeType: 'insert' | 'delete' | 'replace';
                
                if (change.rangeLength === 0) {
                    changeType = 'insert';
                } else if (change.text.length === 0) {
                    changeType = 'delete';
                } else {
                    changeType = 'replace';
                }
                
                logTextChange(file, change, changeType);
            }
        });
        
        this.disposables.push(textChangeDisposable);
    }

    private setupWindowFocusTracking(): void {
        const focusDisposable = vscode.window.onDidChangeWindowState((state) => {
            logWindowFocus(state.focused);
        });
        
        this.disposables.push(focusDisposable);
    }

    private setupTabTracking(): void {
        // Track when files are opened
        const openDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
            logTabChange(document.uri.fsPath, 'opened');
            logFileOperation('file_opened', document.uri.fsPath, {
                languageId: document.languageId,
                lineCount: document.lineCount
            });
        });
        
        // Track when files are closed
        const closeDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
            logTabChange(document.uri.fsPath, 'closed');
            logFileOperation('file_closed', document.uri.fsPath);
        });
        
        // Track when active editor changes (tab switching)
        const switchDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                logTabChange(editor.document.uri.fsPath, 'switched');
            }
        });
        
        this.disposables.push(openDisposable, closeDisposable, switchDisposable);
    }

    private setupCommandTracking(): void {
        // Intercept all command executions
        const originalExecuteCommand = vscode.commands.executeCommand;
        
        vscode.commands.executeCommand = async <T = unknown>(command: string, ...rest: any[]): Promise<T> => {
            const startTime = Date.now();
            this.commandExecutionTimes.set(command, startTime);
            
            try {
                const result = await originalExecuteCommand.call(vscode.commands, command, ...rest) as T;
                const duration = Date.now() - startTime;
                
                logCommandExecution(command, true, duration);
                
                // Special handling for lipcoder commands
                if (command.startsWith('lipcoder.')) {
                    this.trackLipcoderCommand(command, true, duration, rest);
                }
                
                return result;
            } catch (error) {
                const duration = Date.now() - startTime;
                logCommandExecution(command, false, duration, String(error));
                
                if (command.startsWith('lipcoder.')) {
                    this.trackLipcoderCommand(command, false, duration, rest, String(error));
                }
                
                throw error;
            } finally {
                this.commandExecutionTimes.delete(command);
            }
        };
    }

    private trackLipcoderCommand(command: string, success: boolean, duration: number, args: any[], error?: string): void {
        const featureName = command.replace('lipcoder.', '');
        
        if (success) {
            logFeatureStop(featureName, true, duration, { command, args });
        } else {
            logFeatureInterrupt(featureName, error || 'command_failed', { command, args, duration });
        }
    }

    private setupFileOperationTracking(): void {
        // Track file saves
        const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
            logFileOperation('file_saved', document.uri.fsPath, {
                languageId: document.languageId,
                lineCount: document.lineCount,
                isDirty: document.isDirty
            });
        });
        
        // Track file creation
        const createDisposable = vscode.workspace.onDidCreateFiles((event) => {
            for (const file of event.files) {
                logFileOperation('file_created', file.fsPath);
            }
        });
        
        // Track file deletion
        const deleteDisposable = vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
                logFileOperation('file_deleted', file.fsPath);
            }
        });
        
        // Track file rename
        const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                logFileOperation('file_renamed', file.newUri.fsPath, {
                    oldPath: file.oldUri.fsPath
                });
            }
        });
        
        this.disposables.push(saveDisposable, createDisposable, deleteDisposable, renameDisposable);
    }

    private setupWorkspaceTracking(): void {
        // Track workspace folder changes
        const workspaceDisposable = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.added) {
                logSystemEvent('workspace_folder_added', { path: folder.uri.fsPath });
            }
            for (const folder of event.removed) {
                logSystemEvent('workspace_folder_removed', { path: folder.uri.fsPath });
            }
        });
        
        // Track configuration changes
        const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('lipcoder')) {
                logSystemEvent('lipcoder_config_changed', {
                    affectedSections: ['lipcoder']
                });
            }
        });
        
        this.disposables.push(workspaceDisposable, configDisposable);
    }

    private setupTerminalTracking(): void {
        // Track terminal creation
        const terminalCreateDisposable = vscode.window.onDidOpenTerminal((terminal) => {
            logSystemEvent('terminal_opened', {
                name: terminal.name,
                processId: terminal.processId
            });
        });
        
        // Track terminal closure
        const terminalCloseDisposable = vscode.window.onDidCloseTerminal((terminal) => {
            logSystemEvent('terminal_closed', {
                name: terminal.name,
                exitStatus: terminal.exitStatus
            });
        });
        
        // Track active terminal changes
        const terminalChangeDisposable = vscode.window.onDidChangeActiveTerminal((terminal) => {
            if (terminal) {
                logSystemEvent('terminal_activated', {
                    name: terminal.name,
                    processId: terminal.processId
                });
            }
        });
        
        this.disposables.push(terminalCreateDisposable, terminalCloseDisposable, terminalChangeDisposable);
    }

    private setupDebugTracking(): void {
        // Track debug session start
        const debugStartDisposable = vscode.debug.onDidStartDebugSession((session) => {
            logSystemEvent('debug_session_started', {
                name: session.name,
                type: session.type,
                id: session.id
            });
        });
        
        // Track debug session end
        const debugEndDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
            logSystemEvent('debug_session_ended', {
                name: session.name,
                type: session.type,
                id: session.id
            });
        });
        
        this.disposables.push(debugStartDisposable, debugEndDisposable);
    }

    private setupExtensionTracking(): void {
        // Track when extensions are activated/deactivated
        // This is handled in extension.ts lifecycle events
        
        // Track tasks
        const taskStartDisposable = vscode.tasks.onDidStartTask((event) => {
            logSystemEvent('task_started', {
                name: event.execution.task.name,
                source: event.execution.task.source,
                group: event.execution.task.group?.id
            });
        });
        
        const taskEndDisposable = vscode.tasks.onDidEndTask((event) => {
            logSystemEvent('task_ended', {
                name: event.execution.task.name,
                source: event.execution.task.source,
                group: event.execution.task.group?.id
            });
        });
        
        this.disposables.push(taskStartDisposable, taskEndDisposable);
    }

    // Public methods for feature tracking
    public trackFeatureStart(featureName: string, details?: any): void {
        const startTime = Date.now();
        this.activeFeatures.set(featureName, { startTime, details });
        logFeatureStart(featureName, details);
    }

    public trackFeatureStop(featureName: string, success: boolean, details?: any): void {
        const featureInfo = this.activeFeatures.get(featureName);
        if (featureInfo) {
            const duration = Date.now() - featureInfo.startTime;
            logFeatureStop(featureName, success, duration, { ...featureInfo.details, ...details });
            this.activeFeatures.delete(featureName);
        } else {
            logFeatureStop(featureName, success, undefined, details);
        }
    }

    public trackFeatureInterrupt(featureName: string, reason: string, details?: any): void {
        const featureInfo = this.activeFeatures.get(featureName);
        if (featureInfo) {
            logFeatureInterrupt(featureName, reason, { ...featureInfo.details, ...details });
            this.activeFeatures.delete(featureName);
        } else {
            logFeatureInterrupt(featureName, reason, details);
        }
    }

    // ASR-specific tracking methods
    public trackASRStart(): void {
        this.trackFeatureStart('asr_recording');
        logASRStart();
    }

    public trackASRStop(): void {
        this.trackFeatureStop('asr_recording', true);
        logASRStop();
    }

    public trackASRCommand(command: string, transcription: string, confidence?: number, duration?: number): void {
        logASRCommand(command, transcription, confidence, duration);
        this.trackFeatureStop('asr_command_processing', true, {
            command,
            transcription,
            confidence
        });
    }

    public dispose(): void {
        log('[ComprehensiveEventTracker] Disposing comprehensive event tracker...');
        
        // Log all active features as interrupted
        for (const [featureName, featureInfo] of this.activeFeatures) {
            logFeatureInterrupt(featureName, 'extension_deactivation', {
                duration: Date.now() - featureInfo.startTime
            });
        }
        this.activeFeatures.clear();
        
        // Dispose all event listeners
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        
        logSystemEvent('comprehensive_tracker_disposed');
        log('[ComprehensiveEventTracker] Comprehensive event tracker disposed');
    }
}

// Singleton instance
export const comprehensiveEventTracker = new ComprehensiveEventTracker();
