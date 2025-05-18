import { spawn } from 'child_process';

/**
 * Speak the given text via the `espeak` CLI.
 * Returns a Promise that resolves when speaking is complete.
 */
export function speak(text: string, opts?: { voice?: string; pitch?: number }): Promise<void> {
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
    args.push(safeText);

    return new Promise((resolve, reject) => {
        const proc = spawn('espeak', args, { stdio: 'ignore' });
        proc.on('error', err => reject(err));
        proc.on('close', () => resolve());
    });
}