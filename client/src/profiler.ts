import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { log, logWarning, logError, logSuccess } from './utils';

// Lightweight profiler using Node's inspector API
// Saves CPU profiles (.cpuprofile) and heap snapshots (.heapsnapshot)

let inspector: typeof import('inspector') | null = null;
try {
    inspector = require('inspector');
} catch (e) {
    inspector = null;
}

const PROFILE_DIR = path.join(os.homedir(), '.lipcoder', 'profiles');
const INDEX_FILE = path.join(PROFILE_DIR, 'profiles.jsonl');

function ensureProfileDir(): void {
    try {
        if (!fs.existsSync(PROFILE_DIR)) {
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
        }
    } catch (e) {
        logWarning(`[Profiler] Failed to create profile dir: ${e}`);
    }
}

function appendProfileIndex(entry: { type: 'cpu'|'heap'; path: string; label?: string; reason?: string; ts: string; pid: number }): void {
    try {
        ensureProfileDir();
        const line = JSON.stringify(entry);
        fs.appendFileSync(INDEX_FILE, line + '\n');
    } catch (e) {
        logWarning(`[Profiler] Failed to write index: ${e}`);
    }
}

let session: import('inspector').Session | null = null;
let cpuProfiling = false;
let cpuProfileLabel = '';
let autoSnapshotsEnabled = false;
let asrProfilingEnabled = false;

export function toggleAutoSnapshots(): boolean {
    autoSnapshotsEnabled = !autoSnapshotsEnabled;
    log(`[Profiler] Auto heap snapshots: ${autoSnapshotsEnabled}`);
    vscode.window.showInformationMessage(`Profiler auto heap snapshots: ${autoSnapshotsEnabled ? 'ON' : 'OFF'}`);
    return autoSnapshotsEnabled;
}

export function toggleASRProfiling(): boolean {
    asrProfilingEnabled = !asrProfilingEnabled;
    log(`[Profiler] ASR operation profiling: ${asrProfilingEnabled}`);
    vscode.window.showInformationMessage(`Profiler ASR operation profiling: ${asrProfilingEnabled ? 'ON' : 'OFF'}`);
    return asrProfilingEnabled;
}

export async function startCPUProfile(label?: string): Promise<void> {
    if (!inspector) {
        vscode.window.showWarningMessage('Profiler unavailable in this runtime');
        return;
    }
    if (cpuProfiling) {
        vscode.window.showInformationMessage('CPU profiling already running');
        return;
    }
    try {
        ensureProfileDir();
        session = new inspector!.Session();
        session.connect();
        await new Promise<void>((resolve, reject) => {
            session!.post('Profiler.enable', {}, (err) => err ? reject(err) : resolve());
        });
        await new Promise<void>((resolve, reject) => {
            session!.post('Profiler.start', {}, (err) => err ? reject(err) : resolve());
        });
        cpuProfiling = true;
        cpuProfileLabel = label || 'profile';
        logSuccess(`[Profiler] CPU profiling started (${cpuProfileLabel})`);
    } catch (e) {
        logError(`[Profiler] Failed to start CPU profile: ${e}`);
    }
}

export async function stopCPUProfile(): Promise<string | null> {
    if (!inspector || !session || !cpuProfiling) {
        vscode.window.showWarningMessage('CPU profiling is not running');
        return null;
    }
    try {
        const result = await new Promise<any>((resolve, reject) => {
            session!.post('Profiler.stop', {}, (err: Error | null, params?: { profile?: unknown }) => {
                if (err) {
                    reject(err);
                } else if (params && 'profile' in params) {
                    resolve((params as any).profile);
                } else {
                    resolve(null);
                }
            });
        });
        session.disconnect();
        session = null;
        cpuProfiling = false;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outPath = path.join(PROFILE_DIR, `${cpuProfileLabel}-${ts}.cpuprofile`);
        fs.writeFileSync(outPath, JSON.stringify(result || {}));
        appendProfileIndex({ type: 'cpu', path: outPath, label: cpuProfileLabel, ts, pid: process.pid });
        logSuccess(`[Profiler] CPU profile saved: ${outPath}`);
        vscode.window.showInformationMessage(`CPU profile saved: ${outPath}`);
        return outPath;
    } catch (e) {
        logError(`[Profiler] Failed to stop CPU profile: ${e}`);
        try { session?.disconnect(); } catch {}
        session = null;
        cpuProfiling = false;
        return null;
    }
}

export async function takeHeapSnapshot(label?: string, reason?: string): Promise<string | null> {
    if (!inspector) {
        vscode.window.showWarningMessage('Heap snapshot unavailable in this runtime');
        return null;
    }
    ensureProfileDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${label || 'heap'}-${ts}.heapsnapshot`;
    const outPath = path.join(PROFILE_DIR, filename);
    try {
        const localSession = new inspector!.Session();
        localSession.connect();
        const writeStream = fs.createWriteStream(outPath);
        await new Promise<void>((resolve, reject) => {
            localSession.on('HeapProfiler.addHeapSnapshotChunk', (m: any) => {
                writeStream.write(m.params.chunk);
            });
            localSession.post('HeapProfiler.enable');
            localSession.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        writeStream.end();
        localSession.disconnect();
        appendProfileIndex({ type: 'heap', path: outPath, label, reason, ts, pid: process.pid });
        logSuccess(`[Profiler] Heap snapshot saved: ${outPath}`);
        vscode.window.showInformationMessage(`Heap snapshot saved: ${outPath}`);
        return outPath;
    } catch (e) {
        logError(`[Profiler] Failed to take heap snapshot: ${e}`);
        return null;
    }
}

// Called by memory monitor when high memory is detected
export async function maybeSnapshotOnHighMemory(reason: string): Promise<void> {
    if (!autoSnapshotsEnabled) {
        return;
    }
    try {
        log(`[Profiler] High memory detected, taking heap snapshot (reason: ${reason})`);
        await takeHeapSnapshot('highmem', reason);
    } catch (e) {
        logWarning(`[Profiler] Auto snapshot failed: ${e}`);
    }
}

// ASR operation hooks
export async function onASRStart(label?: string): Promise<void> {
    if (!asrProfilingEnabled) {
        return;
    }
    await startCPUProfile(label || 'asr');
}

export async function onASRStop(): Promise<void> {
    if (!asrProfilingEnabled) {
        return;
    }
    await stopCPUProfile();
}

export async function analyzeLatestCPUProfile(): Promise<void> {
    try {
        if (!fs.existsSync(INDEX_FILE)) {
            vscode.window.showWarningMessage('No profiles indexed yet');
            return;
        }
        const lines = fs.readFileSync(INDEX_FILE, 'utf-8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const row = JSON.parse(lines[i]);
            if (row.type === 'cpu' && fs.existsSync(row.path)) {
                const profile = JSON.parse(fs.readFileSync(row.path, 'utf-8'));
                // Simple summary: total nodes and top-level root children
                const nodes = profile.nodes?.length || 0;
                const samples = Array.isArray(profile.samples) ? profile.samples.length : 0;
                const timeDeltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas.reduce((a: number, b: number) => a + b, 0) : 0;
                const seconds = (timeDeltas / 1000).toFixed(2);
                const summary = `CPU Profile: nodes=${nodes}, samples=${samples}, duration≈${seconds}s\nfile: ${row.path}`;
                vscode.window.showInformationMessage(summary);
                logSuccess(`[Profiler] ${summary}`);
                return;
            }
        }
        vscode.window.showWarningMessage('No CPU profiles found to analyze');
    } catch (e) {
        logError(`[Profiler] Failed to analyze CPU profile: ${e}`);
    }
}

export async function openProfilesFolder(): Promise<void> {
    try {
        ensureProfileDir();
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(PROFILE_DIR), true);
    } catch (e) {
        logError(`[Profiler] Failed to open profiles folder: ${e}`);
    }
}


