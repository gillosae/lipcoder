import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ActivityLogEntry {
    timestamp: string;
    type: 'cursor_movement' | 'asr_command' | 'vibe_coding' | 'feature_usage' | 'command_execution' | 'file_operation' | 'error' | 'interaction_turn' | 'audio_event' | 'navigation' | 'timing' | 'text_change' | 'selection_change' | 'window_focus' | 'tab_change' | 'keyboard_input' | 'mouse_input' | 'extension_lifecycle' | 'feature_start' | 'feature_stop' | 'feature_interrupt' | 'system';
    category?: string;
    action: string;
    details?: any;
    file?: string;
    line?: number;
    character?: number;
    duration?: number;
    // Enhanced timing fields for metrics
    interaction_id?: string;
    t_mic_on?: number;
    t_asr_done?: number;
    t_nlu_done?: number;
    t_action_start?: number;
    t_action_end?: number;
    t_tts_on?: number;
    intent_id?: string;
    success_flag?: boolean;
    repair_flag?: boolean;
    view_hop_count?: number;
    from_location?: string;
    to_location?: string;
    tts_chars?: number;
    overlap_events?: number;
    rewind_count?: number;
    // Additional fields for comprehensive tracking
    selection_start?: { line: number; character: number };
    selection_end?: { line: number; character: number };
    text_content?: string;
    change_type?: 'insert' | 'delete' | 'replace';
    key_combination?: string;
    mouse_button?: 'left' | 'right' | 'middle';
    mouse_position?: { x: number; y: number };
    window_state?: 'focused' | 'unfocused';
    tab_id?: string;
    feature_name?: string;
    interrupt_reason?: string;
}

class ActivityLogger {
    private logDir: string;
    private currentLogFile: string;
    private logStream: fs.WriteStream | null = null;
    private logBuffer: ActivityLogEntry[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private isInitialized = false;
    
    // Interaction tracking
    private currentInteractionId: string | null = null;
    private interactionStartTime: number = 0;
    private lastActivityTime: number = Date.now();
    private currentViewLocation: string = '';
    private hopCount: number = 0;
    private audioOverlapCount: number = 0;
    private rewindCount: number = 0;

    constructor() {
        this.logDir = '/Users/gillosae/Desktop/lipcoder-log';
        this.currentLogFile = this.generateLogFileName();
        this.initializeLogger();
    }

    private generateLogFileName(): string {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
        return path.join(this.logDir, `lipcoder-${dateStr}-${timeStr}.log`);
    }

    private async initializeLogger(): Promise<void> {
        try {
            // Ensure log directory exists
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }

            // Create log file with header
            const header = {
                timestamp: new Date().toISOString(),
                type: 'system' as const,
                action: 'session_start',
                details: {
                    version: vscode.version,
                    workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown',
                    platform: process.platform,
                    arch: process.arch
                }
            };

            this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
            this.logStream.write(JSON.stringify(header) + '\n');
            
            this.isInitialized = true;
            console.log(`[ActivityLogger] Initialized with log file: ${this.currentLogFile}`);

            // Start periodic flush
            this.startPeriodicFlush();

        } catch (error) {
            console.error(`[ActivityLogger] Failed to initialize: ${error}`);
        }
    }

    private startPeriodicFlush(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
        
        // Flush buffer every 5 seconds
        this.flushTimer = setInterval(() => {
            this.flushBuffer();
        }, 5000);
    }

    private flushBuffer(): void {
        if (!this.isInitialized || !this.logStream || this.logBuffer.length === 0) {
            return;
        }

        try {
            for (const entry of this.logBuffer) {
                this.logStream.write(JSON.stringify(entry) + '\n');
            }
            this.logBuffer = [];
        } catch (error) {
            console.error(`[ActivityLogger] Failed to flush buffer: ${error}`);
        }
    }

    public log(entry: Omit<ActivityLogEntry, 'timestamp'>): void {
        const fullEntry: ActivityLogEntry = {
            timestamp: new Date().toISOString(),
            ...entry
        };

        this.logBuffer.push(fullEntry);

        // Immediate flush for errors or important events
        if (entry.type === 'error' || this.logBuffer.length >= 50) {
            this.flushBuffer();
        }
    }

    public logCursorMovement(file: string, line: number, character: number, previousLine?: number, previousCharacter?: number): void {
        this.log({
            type: 'cursor_movement',
            action: 'cursor_position_changed',
            file,
            line,
            character,
            details: {
                previous: previousLine !== undefined && previousCharacter !== undefined 
                    ? { line: previousLine, character: previousCharacter }
                    : undefined
            }
        });
    }

    public logASRCommand(command: string, transcription: string, confidence?: number, duration?: number): void {
        this.log({
            type: 'asr_command',
            action: 'voice_command_executed',
            details: {
                command,
                transcription,
                confidence,
                duration
            }
        });
    }

    public logASRStart(): void {
        this.log({
            type: 'asr_command',
            action: 'asr_recording_started'
        });
    }

    public logASRStop(): void {
        this.log({
            type: 'asr_command',
            action: 'asr_recording_stopped'
        });
    }

    public logVibeCoding(action: string, instruction?: string, file?: string, changes?: any): void {
        this.log({
            type: 'vibe_coding',
            action,
            file,
            details: {
                instruction,
                changes
            }
        });
    }

    public logFeatureUsage(feature: string, action: string, details?: any): void {
        this.log({
            type: 'feature_usage',
            category: feature,
            action,
            details
        });
    }

    public logCommandExecution(command: string, success: boolean, duration?: number, error?: string): void {
        this.log({
            type: 'command_execution',
            action: command,
            details: {
                success,
                duration,
                error
            }
        });
    }

    public logFileOperation(operation: string, file: string, details?: any): void {
        this.log({
            type: 'file_operation',
            action: operation,
            file,
            details
        });
    }

    public logError(error: string, context?: string, details?: any): void {
        this.log({
            type: 'error',
            action: 'error_occurred',
            details: {
                error,
                context,
                ...details
            }
        });
    }

    // Enhanced methods for metrics tracking
    
    public startInteractionTurn(intentId: string): string {
        const interactionId = this.generateInteractionId();
        this.currentInteractionId = interactionId;
        this.interactionStartTime = Date.now();
        this.hopCount = 0;
        this.audioOverlapCount = 0;
        this.rewindCount = 0;
        
        this.log({
            type: 'interaction_turn',
            action: 'interaction_started',
            interaction_id: interactionId,
            intent_id: intentId,
            t_mic_on: this.interactionStartTime
        });
        
        return interactionId;
    }
    
    public logTimingEvent(action: string, timing: Partial<ActivityLogEntry>): void {
        if (!this.currentInteractionId) return;
        
        this.log({
            type: 'timing',
            action,
            interaction_id: this.currentInteractionId,
            ...timing
        });
    }
    
    public logASRComplete(transcription: string, confidence?: number): void {
        if (!this.currentInteractionId) return;
        
        const now = Date.now();
        this.log({
            type: 'timing',
            action: 'asr_completed',
            interaction_id: this.currentInteractionId,
            t_asr_done: now,
            details: { transcription, confidence }
        });
    }
    
    public logActionStart(actionType: string): void {
        if (!this.currentInteractionId) return;
        
        const now = Date.now();
        this.log({
            type: 'timing',
            action: 'action_started',
            interaction_id: this.currentInteractionId,
            t_action_start: now,
            details: { actionType }
        });
    }
    
    public logActionEnd(actionType: string, success: boolean): void {
        if (!this.currentInteractionId) return;
        
        const now = Date.now();
        this.log({
            type: 'timing',
            action: 'action_completed',
            interaction_id: this.currentInteractionId,
            t_action_end: now,
            success_flag: success,
            details: { actionType }
        });
    }
    
    public logTTSStart(text: string): void {
        if (!this.currentInteractionId) return;
        
        const now = Date.now();
        this.log({
            type: 'timing',
            action: 'tts_started',
            interaction_id: this.currentInteractionId,
            t_tts_on: now,
            tts_chars: text.length,
            details: { text: text.substring(0, 100) } // First 100 chars for debugging
        });
    }
    
    public endInteractionTurn(success: boolean, repairFlag: boolean = false): void {
        if (!this.currentInteractionId) return;
        
        const now = Date.now();
        const duration = now - this.interactionStartTime;
        
        this.log({
            type: 'interaction_turn',
            action: 'interaction_completed',
            interaction_id: this.currentInteractionId,
            success_flag: success,
            repair_flag: repairFlag,
            view_hop_count: this.hopCount,
            overlap_events: this.audioOverlapCount,
            rewind_count: this.rewindCount,
            duration
        });
        
        this.currentInteractionId = null;
        this.lastActivityTime = now;
    }
    
    public logNavigation(fromLocation: string, toLocation: string, navigationType: string): void {
        this.hopCount++;
        
        this.log({
            type: 'navigation',
            action: navigationType,
            interaction_id: this.currentInteractionId || undefined,
            from_location: fromLocation,
            to_location: toLocation,
            view_hop_count: this.hopCount
        });
        
        this.currentViewLocation = toLocation;
    }
    
    public logAudioEvent(eventType: 'overlap' | 'rewind' | 'cancel', details?: any): void {
        if (eventType === 'overlap') {
            this.audioOverlapCount++;
        } else if (eventType === 'rewind') {
            this.rewindCount++;
        }
        
        this.log({
            type: 'audio_event',
            action: eventType,
            interaction_id: this.currentInteractionId || undefined,
            overlap_events: this.audioOverlapCount,
            rewind_count: this.rewindCount,
            details
        });
    }
    
    public logFlowBreak(breakType: 'silence' | 'repair_utterance' | 'focus_switch', duration?: number): void {
        const now = Date.now();
        const timeSinceLastActivity = now - this.lastActivityTime;
        
        this.log({
            type: 'interaction_turn',
            action: 'flow_break',
            details: {
                breakType,
                timeSinceLastActivity,
                duration
            }
        });
        
        this.lastActivityTime = now;
    }

    // New comprehensive logging methods
    
    public logTextChange(file: string, change: vscode.TextDocumentContentChangeEvent, changeType: 'insert' | 'delete' | 'replace'): void {
        this.log({
            type: 'text_change',
            action: 'document_modified',
            file,
            line: change.range.start.line,
            character: change.range.start.character,
            change_type: changeType,
            text_content: change.text.length > 100 ? change.text.substring(0, 100) + '...' : change.text,
            details: {
                rangeLength: change.rangeLength,
                textLength: change.text.length,
                startLine: change.range.start.line,
                startChar: change.range.start.character,
                endLine: change.range.end.line,
                endChar: change.range.end.character
            }
        });
    }

    public logSelectionChange(file: string, selection: vscode.Selection): void {
        this.log({
            type: 'selection_change',
            action: 'selection_changed',
            file,
            line: selection.active.line,
            character: selection.active.character,
            selection_start: { line: selection.start.line, character: selection.start.character },
            selection_end: { line: selection.end.line, character: selection.end.character },
            details: {
                isEmpty: selection.isEmpty,
                isReversed: selection.isReversed,
                selectedText: selection.isEmpty ? null : 'text_selected'
            }
        });
    }

    public logWindowFocus(focused: boolean): void {
        this.log({
            type: 'window_focus',
            action: focused ? 'window_focused' : 'window_unfocused',
            window_state: focused ? 'focused' : 'unfocused'
        });
    }

    public logTabChange(file: string, action: 'opened' | 'closed' | 'switched'): void {
        this.log({
            type: 'tab_change',
            action: `tab_${action}`,
            file,
            tab_id: file
        });
    }

    public logKeyboardInput(key: string, modifiers?: string[]): void {
        this.log({
            type: 'keyboard_input',
            action: 'key_pressed',
            key_combination: modifiers ? `${modifiers.join('+')}+${key}` : key,
            details: {
                key,
                modifiers: modifiers || []
            }
        });
    }

    public logMouseInput(button: 'left' | 'right' | 'middle', action: 'click' | 'double_click' | 'drag', position?: { x: number; y: number }): void {
        this.log({
            type: 'mouse_input',
            action: `mouse_${action}`,
            mouse_button: button,
            mouse_position: position,
            details: {
                button,
                action,
                position
            }
        });
    }

    public logFeatureStart(featureName: string, details?: any): void {
        this.log({
            type: 'feature_start',
            action: 'feature_started',
            feature_name: featureName,
            details: {
                featureName,
                startTime: Date.now(),
                ...details
            }
        });
    }

    public logFeatureStop(featureName: string, success: boolean, duration?: number, details?: any): void {
        this.log({
            type: 'feature_stop',
            action: 'feature_stopped',
            feature_name: featureName,
            success_flag: success,
            duration,
            details: {
                featureName,
                success,
                duration,
                endTime: Date.now(),
                ...details
            }
        });
    }

    public logFeatureInterrupt(featureName: string, reason: string, details?: any): void {
        this.log({
            type: 'feature_interrupt',
            action: 'feature_interrupted',
            feature_name: featureName,
            interrupt_reason: reason,
            details: {
                featureName,
                reason,
                interruptTime: Date.now(),
                ...details
            }
        });
    }

    public logExtensionLifecycle(action: 'activate' | 'deactivate' | 'reload', details?: any): void {
        this.log({
            type: 'extension_lifecycle',
            action: `extension_${action}`,
            details: {
                action,
                timestamp: Date.now(),
                ...details
            }
        });
    }

    public logSystemEvent(action: string, details?: any): void {
        this.log({
            type: 'system',
            action,
            details: {
                systemTime: Date.now(),
                ...details
            }
        });
    }
    
    private generateInteractionId(): string {
        return `IT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    public async dispose(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        // Final flush
        this.flushBuffer();

        // Log session end
        this.log({
            type: 'system' as any,
            action: 'session_end'
        });

        // Close stream
        if (this.logStream) {
            return new Promise((resolve) => {
                this.logStream!.end(() => {
                    console.log(`[ActivityLogger] Session ended, log saved to: ${this.currentLogFile}`);
                    resolve();
                });
            });
        }
    }

    public getCurrentLogFile(): string {
        return this.currentLogFile;
    }

    public getLogDir(): string {
        return this.logDir;
    }
}

// Singleton instance
export const activityLogger = new ActivityLogger();

// Convenience functions for easy logging
export function logCursorMovement(file: string, line: number, character: number, previousLine?: number, previousCharacter?: number): void {
    activityLogger.logCursorMovement(file, line, character, previousLine, previousCharacter);
}

export function logASRCommand(command: string, transcription: string, confidence?: number, duration?: number): void {
    activityLogger.logASRCommand(command, transcription, confidence, duration);
}

export function logASRStart(): void {
    activityLogger.logASRStart();
}

export function logASRStop(): void {
    activityLogger.logASRStop();
}

export function logVibeCoding(action: string, instruction?: string, file?: string, changes?: any): void {
    activityLogger.logVibeCoding(action, instruction, file, changes);
}

export function logFeatureUsage(feature: string, action: string, details?: any): void {
    activityLogger.logFeatureUsage(feature, action, details);
}

export function logCommandExecution(command: string, success: boolean, duration?: number, error?: string): void {
    activityLogger.logCommandExecution(command, success, duration, error);
}

export function logFileOperation(operation: string, file: string, details?: any): void {
    activityLogger.logFileOperation(operation, file, details);
}

export function logActivityError(error: string, context?: string, details?: any): void {
    activityLogger.logError(error, context, details);
}

// Enhanced convenience functions for metrics
export function startInteractionTurn(intentId: string): string {
    return activityLogger.startInteractionTurn(intentId);
}

export function endInteractionTurn(success: boolean, repairFlag: boolean = false): void {
    activityLogger.endInteractionTurn(success, repairFlag);
}

export function logTimingEvent(action: string, timing: Partial<ActivityLogEntry>): void {
    activityLogger.logTimingEvent(action, timing);
}

export function logASRComplete(transcription: string, confidence?: number): void {
    activityLogger.logASRComplete(transcription, confidence);
}

export function logActionStart(actionType: string): void {
    activityLogger.logActionStart(actionType);
}

export function logActionEnd(actionType: string, success: boolean): void {
    activityLogger.logActionEnd(actionType, success);
}

export function logTTSStart(text: string): void {
    activityLogger.logTTSStart(text);
}

export function logNavigation(fromLocation: string, toLocation: string, navigationType: string): void {
    activityLogger.logNavigation(fromLocation, toLocation, navigationType);
}

export function logAudioEvent(eventType: 'overlap' | 'rewind' | 'cancel', details?: any): void {
    activityLogger.logAudioEvent(eventType, details);
}

export function logFlowBreak(breakType: 'silence' | 'repair_utterance' | 'focus_switch', duration?: number): void {
    activityLogger.logFlowBreak(breakType, duration);
}

// New convenience functions for comprehensive logging
export function logTextChange(file: string, change: vscode.TextDocumentContentChangeEvent, changeType: 'insert' | 'delete' | 'replace'): void {
    activityLogger.logTextChange(file, change, changeType);
}

export function logSelectionChange(file: string, selection: vscode.Selection): void {
    activityLogger.logSelectionChange(file, selection);
}

export function logWindowFocus(focused: boolean): void {
    activityLogger.logWindowFocus(focused);
}

export function logTabChange(file: string, action: 'opened' | 'closed' | 'switched'): void {
    activityLogger.logTabChange(file, action);
}

export function logKeyboardInput(key: string, modifiers?: string[]): void {
    activityLogger.logKeyboardInput(key, modifiers);
}

export function logMouseInput(button: 'left' | 'right' | 'middle', action: 'click' | 'double_click' | 'drag', position?: { x: number; y: number }): void {
    activityLogger.logMouseInput(button, action, position);
}

export function logFeatureStart(featureName: string, details?: any): void {
    activityLogger.logFeatureStart(featureName, details);
}

export function logFeatureStop(featureName: string, success: boolean, duration?: number, details?: any): void {
    activityLogger.logFeatureStop(featureName, success, duration, details);
}

export function logFeatureInterrupt(featureName: string, reason: string, details?: any): void {
    activityLogger.logFeatureInterrupt(featureName, reason, details);
}

export function logExtensionLifecycle(action: 'activate' | 'deactivate' | 'reload', details?: any): void {
    activityLogger.logExtensionLifecycle(action, details);
}

export function logSystemEvent(action: string, details?: any): void {
    activityLogger.logSystemEvent(action, details);
}
