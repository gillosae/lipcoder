import { lipcoderLog } from './logger';

// const liplog = lipcoderLog.appendLine.bind(lipcoderLog);
export function log(text: string) {
    console.log(`extension ${text}`);
    lipcoderLog.appendLine(`extension ${text}`);
}

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}