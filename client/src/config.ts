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
    alphabetPath: () => path.join(extRoot, 'client', 'audio', 'alphabet'),
    earconPath: () => path.join(extRoot, 'client', 'audio', 'earcon'),
    numberPath: () => path.join(extRoot, 'client', 'audio', 'number'),
    pythonPath: () => path.join(extRoot, 'client', 'src', 'python', 'bin', 'python'),
    scriptPath: () => path.join(extRoot, 'client', 'src', 'python', 'silero_tts_infer.py'),

} as {
    typingSpeechEnabled: boolean;
    playSpeed: number;

    audioPath: () => string;
    alphabetPath: () => string;
    earconPath: () => string;
    numberPath: () => string;
    pythonPath: () => string;
    scriptPath: () => string;
};
