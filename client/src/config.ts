import * as path from 'path';
import type { ExtensionContext } from 'vscode';

let extRoot: string;

/**
 * Initialize config with the extension's root path.
 */
export function initConfig(context: ExtensionContext) {
    extRoot = context.extensionPath;
}

export const config = {
    typingSpeechEnabled: true,  // global flag for typing speech
    playSpeed: 1.4,              // playback speed multiplier

    audioPath: () => path.join(extRoot, 'client', 'audio'),
    pythonPath: () => path.join(extRoot, 'client', 'src', 'python', 'bin', 'python'),
    scriptPath: () => path.join(extRoot, 'client', 'src', 'python', 'silero_tts_infer.py'),

} as {
    typingSpeechEnabled: boolean;
    playSpeed: number;

    audioPath: () => string;
    pythonPath: () => string;
    scriptPath: () => string;
};
