import * as vscode from 'vscode';
import { log, logError, logWarning } from './utils';

export interface ASRPopupOptions {
    title?: string;
    showWaveform?: boolean;
    showTranscription?: boolean;
    width?: number;
    height?: number;
}

export class ASRPopup {
    private panel: vscode.WebviewPanel | null = null;
    private statusBarItem: vscode.StatusBarItem | null = null;
    private notificationItem: vscode.Disposable | null = null;
    private options: ASRPopupOptions;
    private isRecording = false;
    private transcriptionText = '';
    private recordingStartTime = 0;
    private animationFrame: NodeJS.Timeout | null = null;
    private useMinimalUI = true; // Use minimal UI by default

    constructor(options: ASRPopupOptions = {}) {
        this.options = {
            title: 'LipCoder ASR Recording',
            showWaveform: true,
            showTranscription: true,
            width: 400,
            height: 300,
            ...(options || {})
        };
        log('[ASRPopup] ASRPopup initialized successfully');
    }

    /**
     * Show the ASR popup
     */
    show(context: vscode.ExtensionContext): void {
        if (!this.options) {
            logError('[ASRPopup] Options not initialized');
            return;
        }
        
        if (this.useMinimalUI) {
            this.showMinimalUI();
            return;
        }
        
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        // Create webview panel as a floating overlay that doesn't disrupt editor layout
        this.panel = vscode.window.createWebviewPanel(
            'asrPopup',
            this.options.title || 'ASR Recording',
            {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: true  // Don't steal focus from current editor
            },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(context.extensionPath)],
                retainContextWhenHidden: true  // Keep context when hidden
            }
        );

        // Set HTML content
        this.panel.webview.html = this.getWebviewContent();

        // Handle disposal
        this.panel.onDidDispose(() => {
            this.panel = null;
            this.stopAnimation();
        });

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'stop':
                        this.hide();
                        break;
                    case 'minimize':
                        // Minimize the panel (not fully hide)
                        if (this.panel) {
                            this.panel.reveal(vscode.ViewColumn.Beside, true);
                        }
                        break;
                }
            }
        );

        log('[ASR-Popup] ASR popup created and shown');
    }

    /**
     * Show minimal UI using status bar and notifications
     */
    private showMinimalUI(): void {
        // Create status bar item if not exists
        if (!this.statusBarItem) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.statusBarItem.command = 'lipcoder.showASRPopup'; // Allow clicking to show full popup
        }
        
        this.statusBarItem.text = '$(record) ASR Ready';
        this.statusBarItem.tooltip = 'ASR Recording Status - Click for details';
        this.statusBarItem.show();
        
        log('[ASR-Popup] Minimal ASR UI shown in status bar');
    }

    /**
     * Hide the ASR popup
     */
    hide(): void {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
        
        if (this.statusBarItem) {
            this.statusBarItem.hide();
        }
        
        if (this.notificationItem) {
            this.notificationItem.dispose();
            this.notificationItem = null;
        }
        
        this.stopAnimation();
        log('[ASR-Popup] ASR popup hidden');
    }

    /**
     * Update recording status
     */
    setRecordingStatus(isRecording: boolean): void {
        this.isRecording = isRecording;
        
        if (isRecording) {
            this.recordingStartTime = Date.now();
            this.startAnimation();
        } else {
            this.stopAnimation();
        }

        if (this.useMinimalUI) {
            this.updateMinimalUI();
        } else {
            this.updateContent();
        }
    }

    /**
     * Update transcription text
     */
    updateTranscription(text: string): void {
        this.transcriptionText = text;
        
        if (this.useMinimalUI) {
            this.updateMinimalUI();
            // Show transcription as a non-blocking notification
            if (text && text.trim()) {
                vscode.window.showInformationMessage(`ASR: ${text}`, { modal: false });
            }
        } else {
            this.updateContent();
        }
    }

    /**
     * Update minimal UI (status bar and notifications)
     */
    private updateMinimalUI(): void {
        if (!this.statusBarItem) {
            return;
        }
        
        if (this.isRecording) {
            const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
            this.statusBarItem.text = `$(record) Recording... ${elapsed}s`;
            this.statusBarItem.tooltip = 'ASR is recording - Press Ctrl+Shift+A to stop';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (this.transcriptionText) {
            this.statusBarItem.text = `$(check) ASR: ${this.transcriptionText.substring(0, 30)}${this.transcriptionText.length > 30 ? '...' : ''}`;
            this.statusBarItem.tooltip = `Last transcription: ${this.transcriptionText}`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        } else {
            this.statusBarItem.text = '$(record) ASR Ready';
            this.statusBarItem.tooltip = 'ASR Recording Status - Press Ctrl+Shift+A to start';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    /**
     * Show error message
     */
    showError(error: string): void {
        if (this.useMinimalUI) {
            // Show error as notification and update status bar
            vscode.window.showErrorMessage(`ASR Error: ${error}`);
            if (this.statusBarItem) {
                this.statusBarItem.text = '$(error) ASR Error';
                this.statusBarItem.tooltip = `ASR Error: ${error}`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            }
        } else {
            this.sendMessage({
                command: 'error',
                error: error
            });
        }
    }

    /**
     * Start waveform animation
     */
    private startAnimation(): void {
        if (this.animationFrame) return;

        const animate = () => {
            if (this.isRecording && this.panel) {
                // Generate random waveform data for visualization
                const waveformData = Array.from({length: 32}, () => Math.random() * 0.8 + 0.1);
                const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                
                this.sendMessage({
                    command: 'updateWaveform',
                    data: waveformData,
                    elapsed: elapsed
                });

                this.animationFrame = setTimeout(animate, 100); // 10 FPS
            }
        };

        animate();
    }

    /**
     * Stop waveform animation
     */
    private stopAnimation(): void {
        if (this.animationFrame) {
            clearTimeout(this.animationFrame);
            this.animationFrame = null;
        }
    }

    /**
     * Update content in the webview
     */
    private updateContent(): void {
        if (!this.panel) return;

        this.sendMessage({
            command: 'updateStatus',
            isRecording: this.isRecording,
            transcription: this.transcriptionText,
            elapsed: this.isRecording ? Math.floor((Date.now() - this.recordingStartTime) / 1000) : 0
        });
    }

    /**
     * Send message to webview
     */
    private sendMessage(message: any): void {
        if (this.panel) {
            this.panel.webview.postMessage(message);
        }
    }

    /**
     * Get the HTML content for the webview
     */
    private getWebviewContent(): string {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ASR Recording</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 20px;
            height: 100vh;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .title {
            font-size: 16px;
            font-weight: bold;
        }

        .controls {
            display: flex;
            gap: 10px;
        }

        .btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }

        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .btn.danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }

        .status {
            text-align: center;
            margin-bottom: 20px;
        }

        .recording-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: bold;
        }

        .recording-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background-color: #ff4444;
            animation: pulse 1s infinite;
        }

        .recording-dot.idle {
            background-color: #666;
            animation: none;
        }

        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.1); }
            100% { opacity: 1; transform: scale(1); }
        }

        .waveform-container {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 20px;
            margin-bottom: 20px;
            height: 100px;
            position: relative;
            overflow: hidden;
        }

        .waveform {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 2px;
        }

        .waveform-bar {
            width: 8px;
            background-color: var(--vscode-progressBar-background);
            border-radius: 2px;
            transition: height 0.1s ease;
            min-height: 4px;
        }

        .transcription-container {
            flex: 1;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 15px;
            overflow-y: auto;
        }

        .transcription-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .transcription-text {
            font-size: 14px;
            line-height: 1.4;
            min-height: 60px;
            word-wrap: break-word;
        }

        .transcription-placeholder {
            color: var(--vscode-input-placeholderForeground);
            font-style: italic;
        }

        .timer {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            margin-top: 10px;
        }

        .error {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
            font-size: 12px;
        }

        .hidden {
            display: none;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">ASR Recording</div>
        <div class="controls">
            <button class="btn" onclick="minimize()">−</button>
            <button class="btn danger" onclick="stop()">✕</button>
        </div>
    </div>

    <div id="error" class="error hidden"></div>

    <div class="status">
        <div class="recording-indicator">
            <div id="recordingDot" class="recording-dot idle"></div>
            <span id="statusText">Ready to record</span>
        </div>
        <div id="timer" class="timer">00:00</div>
    </div>

    <div class="waveform-container">
        <div id="waveform" class="waveform">
            ${Array.from({length: 32}, () => '<div class="waveform-bar"></div>').join('')}
        </div>
    </div>

    <div class="transcription-container">
        <div class="transcription-label">Transcription</div>
        <div id="transcription" class="transcription-text">
            <div class="transcription-placeholder">Your speech will appear here...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let isRecording = false;

        function stop() {
            vscode.postMessage({ command: 'stop' });
        }

        function minimize() {
            vscode.postMessage({ command: 'minimize' });
        }

        function formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return \`\${mins.toString().padStart(2, '0')}:\${secs.toString().padStart(2, '0')}\`;
        }

        function updateWaveform(data) {
            const bars = document.querySelectorAll('.waveform-bar');
            bars.forEach((bar, index) => {
                if (index < data.length) {
                    const height = Math.max(4, data[index] * 60);
                    bar.style.height = height + 'px';
                    bar.style.opacity = isRecording ? '1' : '0.3';
                }
            });
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'updateStatus':
                    isRecording = message.isRecording;
                    const dot = document.getElementById('recordingDot');
                    const statusText = document.getElementById('statusText');
                    const timer = document.getElementById('timer');
                    const transcription = document.getElementById('transcription');
                    
                    if (isRecording) {
                        dot.className = 'recording-dot';
                        statusText.textContent = 'Recording...';
                    } else {
                        dot.className = 'recording-dot idle';
                        statusText.textContent = 'Processing...';
                    }
                    
                    timer.textContent = formatTime(message.elapsed);
                    
                    if (message.transcription) {
                        transcription.innerHTML = '<div>' + message.transcription + '</div>';
                    } else if (!isRecording) {
                        transcription.innerHTML = '<div class="transcription-placeholder">Your speech will appear here...</div>';
                    }
                    break;
                    
                case 'updateWaveform':
                    updateWaveform(message.data);
                    document.getElementById('timer').textContent = formatTime(message.elapsed);
                    break;
                    
                case 'error':
                    const errorDiv = document.getElementById('error');
                    errorDiv.textContent = message.error;
                    errorDiv.className = 'error';
                    break;
            }
        });

        // Initialize with empty waveform
        updateWaveform(Array(32).fill(0.1));
    </script>
</body>
</html>`;
    }

    /**
     * Dispose of the popup
     */
    dispose(): void {
        this.hide();
        
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
            this.statusBarItem = null;
        }
        
        if (this.notificationItem) {
            this.notificationItem.dispose();
            this.notificationItem = null;
        }
    }

    /**
     * Toggle between minimal and full UI
     */
    toggleUIMode(): void {
        this.useMinimalUI = !this.useMinimalUI;
        log(`[ASR-Popup] Switched to ${this.useMinimalUI ? 'minimal' : 'full'} UI mode`);
        
        if (this.useMinimalUI) {
            // Hide panel if it's open
            if (this.panel) {
                this.panel.dispose();
                this.panel = null;
            }
            this.showMinimalUI();
        } else {
            // Hide status bar item
            if (this.statusBarItem) {
                this.statusBarItem.hide();
            }
        }
    }
} 