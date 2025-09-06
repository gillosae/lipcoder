import { log } from './utils';
import { config } from './config';

/**
 * Earcon (audio cue) system - simplified for native macOS TTS
 */

/**
 * Play an earcon sound
 */
let currentEarconProcess: any | null = null;

export async function playEarcon(soundPath: string, panning?: number): Promise<void> {
    return new Promise<void>((resolve) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const { spawn } = require('child_process');

            if (!soundPath || !fs.existsSync(soundPath)) {
                log(`[Earcon] File not found: ${soundPath}`);
                resolve();
                return;
            }

            // Stop any currently playing earcon to avoid overlap
            if (currentEarconProcess) {
                try { currentEarconProcess.kill('SIGKILL'); } catch {}
                currentEarconProcess = null;
            }

            const ext = path.extname(soundPath).toLowerCase();
            log(`[Earcon] Playing file: ${soundPath} (ext=${ext})`);

            let proc: any;

            if (ext === '.pcm') {
                // Play raw PCM via sox, applying global playSpeed for responsiveness
                // Assuming 44.1kHz, 16-bit, mono, signed PCM (matches our assets)
                const tempo = Math.max(0.25, Math.min(3.0, Number(config.playSpeed) || 1.0)).toString();
                proc = spawn('sox', [
                    '-t', 'raw',
                    '-r', '44100',
                    '-b', '16',
                    '-c', '1',
                    '-e', 'signed-integer',
                    soundPath,
                    '-d',
                    'tempo', tempo
                ], { stdio: 'ignore' });
            } else if (ext === '.wav' || ext === '.aiff' || ext === '.aif') {
                // Play WAV/AIFF via afplay (macOS)
                proc = spawn('afplay', [soundPath], { stdio: 'ignore' });
            } else {
                // Unknown format; try afplay directly
                proc = spawn('afplay', [soundPath], { stdio: 'ignore' });
            }

            currentEarconProcess = proc;

            const cleanup = () => { currentEarconProcess = null; };

            proc.on('close', () => { cleanup(); resolve(); });
            proc.on('exit', () => { cleanup(); resolve(); });
            proc.on('error', (err: any) => {
                log(`[Earcon] Playback error: ${err}`);
                cleanup();
                resolve();
            });

            // Safety timeout: resolve even if the player hangs
            setTimeout(() => {
                try { if (currentEarconProcess === proc) proc.kill('SIGTERM'); } catch {}
                cleanup();
                resolve();
            }, 600);
        } catch (error) {
            log(`[Earcon] Unexpected error: ${error}`);
            resolve();
        }
    });
}

/**
 * Stop earcon playback
 */
export function stopEarconPlayback(): void {
    log('[Earcon] Stopping earcon playback');
    try {
        if (currentEarconProcess) {
            currentEarconProcess.kill('SIGKILL');
            currentEarconProcess = null;
        }
    } catch {}
}
