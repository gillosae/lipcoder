import Speaker from 'speaker';
import { Readable } from 'stream';
import { spawn } from 'child_process';

/**
 * Speak the given text via the `espeak` CLI.
 * Returns a Promise that resolves when speaking is complete.
 */
export function speak(
    text: string,
    opts?: { voice?: string; pitch?: number; gap?: number; beep?: boolean; speed?: number }
): Promise<void> {
    // If token is only whitespace and beep is requested, emit beep immediately
    if (opts?.beep && text.trim() === '') {
        // Emit in-process sine-wave beep for blank tokens
        return beepSound();
    }
    const safeText = text.replace(/"/g, '\\"');
    const args: string[] = [];
    if (opts?.voice) {
        args.push('-v', opts.voice);
    } else {
        args.push('-v', 'en-us');
    }
    if (opts?.pitch !== undefined) {
        args.push('-p', String(opts.pitch));
    }
    if (opts?.gap !== undefined) {
        args.push('-g', String(opts.gap));
    } else {
        args.push('-g', '0'); // zero gap
    }
    if (opts?.speed !== undefined) {
        args.push('-s', String(opts.speed));
    } else {
        args.push('-s', '250'); // default 250 wpm
    }

    // Determine if running on macOS
    const isMac = process.platform === 'darwin';
    const cmd = isMac ? 'espeak' : 'espeak'; //'say' : 'espeak';
    // For macOS 'say', pass only the text; for espeak, append the text as an argument
    const spawnArgs = [...args, safeText];
    // const spawnArgs = isMac ? [text] : [...args, safeText];

    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, spawnArgs, { stdio: 'ignore' });
        proc.on('error', err => reject(err));
        proc.on('close', async () => {
            if (opts?.beep) {
                try {
                    await beepSound();
                } catch {
                    // ignore tone errors
                }
            }
            resolve();
        });
    });
}

/**
 * Emit a single beep in-process and resolve when complete.
 */
export function beepSound(): Promise<void> {
    return generateTone();
}

/**
 * Generate a sine-wave tone in-process.
 */
function generateTone(durationMs: number = 200, frequency: number = 440): Promise<void> {
    const sampleRate = 44100;
    const totalSamples = Math.floor(sampleRate * (durationMs / 1000));
    return new Promise((resolve, reject) => {
        const speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
        let sampleCount = 0;
        const toneStream = new Readable({
            read() {
                if (sampleCount < totalSamples) {
                    const t = sampleCount / sampleRate;
                    const amplitude = Math.sin(2 * Math.PI * frequency * t) * 32767;
                    const buf = Buffer.alloc(2);
                    buf.writeInt16LE(amplitude, 0);
                    sampleCount++;
                    this.push(buf);
                } else {
                    this.push(null);
                }
            }
        });
        toneStream.pipe(speaker);
        speaker.on('close', resolve);
        speaker.on('error', reject);
    });
}