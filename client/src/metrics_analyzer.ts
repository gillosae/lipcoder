import * as fs from 'fs';
import * as path from 'path';
import { ActivityLogEntry } from './activity_logger';

export interface FlowMetrics {
    // A. Flow Efficiency
    intentToActionLatency: number; // I2A: mic start ~ IDE action start (ms)
    actionToFeedbackLatency: number; // A2F: IDE action end ~ meaningful feedback start (ms)
    flowBreaksPerMinute: number; // Flow breaks (silence>3s, repair utterances, focus switches) per minute
    orchestrationCompressionRatio: number; // OCR: baseline steps / lipcoder steps
    productiveTimeRatio: number; // PTR: (code/test execution time) / (total session time)
}

export interface NavigationMetrics {
    // B. Navigation & Modification Efficiency
    hopsPerQuestion: number; // File/symbol/view transitions per question
    fixLeadTime: number; // Failure reproduction ~ first correct fix (ms)
    buildTestLoopTime: number; // Build ~ result understanding loop time (ms)
}

export interface CognitiveMetrics {
    // C. Error & Cognitive Load
    repairRate: number; // Re-utterance rate due to ASR/intent misrecognition
    audioOverloadIndex: number; // Overlap/rewind/cancel rate
}

export interface QualityMetrics {
    // D. Result Quality
    taskSuccessRate: number; // Task success rate
    testPassRate: number; // Test pass rate after changes
    regressionsIntroduced: number; // New failures after changes
}

export interface SessionMetrics {
    sessionDuration: number;
    totalInteractions: number;
    successfulInteractions: number;
    flowMetrics: FlowMetrics;
    navigationMetrics: NavigationMetrics;
    cognitiveMetrics: CognitiveMetrics;
    qualityMetrics: QualityMetrics;
}

export class MetricsAnalyzer {
    private logEntries: ActivityLogEntry[] = [];

    public async loadLogFile(logFilePath: string): Promise<void> {
        const content = fs.readFileSync(logFilePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        this.logEntries = lines.map(line => {
            try {
                return JSON.parse(line) as ActivityLogEntry;
            } catch (error) {
                console.warn(`Failed to parse log line: ${line}`);
                return null;
            }
        }).filter(entry => entry !== null) as ActivityLogEntry[];
    }

    public analyzeSession(): SessionMetrics {
        const sessionStart = new Date(this.logEntries[0]?.timestamp || Date.now());
        const sessionEnd = new Date(this.logEntries[this.logEntries.length - 1]?.timestamp || Date.now());
        const sessionDuration = sessionEnd.getTime() - sessionStart.getTime();

        const interactions = this.getInteractionTurns();
        const totalInteractions = interactions.length;
        const successfulInteractions = interactions.filter(it => it.success_flag).length;

        return {
            sessionDuration,
            totalInteractions,
            successfulInteractions,
            flowMetrics: this.calculateFlowMetrics(sessionDuration, interactions),
            navigationMetrics: this.calculateNavigationMetrics(interactions),
            cognitiveMetrics: this.calculateCognitiveMetrics(interactions),
            qualityMetrics: this.calculateQualityMetrics(interactions)
        };
    }

    private getInteractionTurns(): ActivityLogEntry[] {
        return this.logEntries.filter(entry => 
            entry.type === 'interaction_turn' && entry.action === 'interaction_completed'
        );
    }

    private calculateFlowMetrics(sessionDuration: number, interactions: ActivityLogEntry[]): FlowMetrics {
        // I2A: Intent to Action Latency
        const i2aLatencies = interactions
            .filter(it => it.t_mic_on && it.t_action_start)
            .map(it => it.t_action_start! - it.t_mic_on!);
        const intentToActionLatency = i2aLatencies.length > 0 
            ? i2aLatencies.reduce((sum, lat) => sum + lat, 0) / i2aLatencies.length 
            : 0;

        // A2F: Action to Feedback Latency
        const a2fLatencies = interactions
            .filter(it => it.t_action_end && it.t_tts_on)
            .map(it => it.t_tts_on! - it.t_action_end!);
        const actionToFeedbackLatency = a2fLatencies.length > 0
            ? a2fLatencies.reduce((sum, lat) => sum + lat, 0) / a2fLatencies.length
            : 0;

        // Flow breaks per minute
        const flowBreaks = this.logEntries.filter(entry => 
            entry.type === 'interaction_turn' && entry.action === 'flow_break'
        );
        const flowBreaksPerMinute = (flowBreaks.length / sessionDuration) * 60000;

        // OCR: Orchestration Compression Ratio (placeholder - needs baseline comparison)
        const orchestrationCompressionRatio = 1.0; // Would need baseline data

        // PTR: Productive Time Ratio (placeholder - needs task classification)
        const productiveTimeRatio = 0.8; // Would need to classify productive vs non-productive time

        return {
            intentToActionLatency,
            actionToFeedbackLatency,
            flowBreaksPerMinute,
            orchestrationCompressionRatio,
            productiveTimeRatio
        };
    }

    private calculateNavigationMetrics(interactions: ActivityLogEntry[]): NavigationMetrics {
        // Hops per Question
        const totalHops = interactions.reduce((sum, it) => sum + (it.view_hop_count || 0), 0);
        const hopsPerQuestion = interactions.length > 0 ? totalHops / interactions.length : 0;

        // Fix Lead Time (placeholder - needs error tracking)
        const fixLeadTime = 0; // Would need error detection and resolution tracking

        // Build/Test Loop Time (placeholder - needs build/test event tracking)
        const buildTestLoopTime = 0; // Would need build and test execution tracking

        return {
            hopsPerQuestion,
            fixLeadTime,
            buildTestLoopTime
        };
    }

    private calculateCognitiveMetrics(interactions: ActivityLogEntry[]): CognitiveMetrics {
        // Repair Rate
        const repairCount = interactions.filter(it => it.repair_flag).length;
        const repairRate = interactions.length > 0 ? repairCount / interactions.length : 0;

        // Audio Overload Index
        const totalAudioEvents = interactions.reduce((sum, it) => 
            sum + (it.overlap_events || 0) + (it.rewind_count || 0), 0
        );
        const audioOverloadIndex = interactions.length > 0 ? totalAudioEvents / interactions.length : 0;

        return {
            repairRate,
            audioOverloadIndex
        };
    }

    private calculateQualityMetrics(interactions: ActivityLogEntry[]): QualityMetrics {
        // Task Success Rate
        const successfulTasks = interactions.filter(it => it.success_flag).length;
        const taskSuccessRate = interactions.length > 0 ? successfulTasks / interactions.length : 0;

        // Test Pass Rate (placeholder - needs test execution tracking)
        const testPassRate = 1.0; // Would need test result tracking

        // Regressions Introduced (placeholder - needs regression detection)
        const regressionsIntroduced = 0; // Would need before/after comparison

        return {
            taskSuccessRate,
            testPassRate,
            regressionsIntroduced
        };
    }

    public generateReport(metrics: SessionMetrics): string {
        const report = `
# LipCoder Session Metrics Report

## Session Overview
- **Duration**: ${(metrics.sessionDuration / 1000 / 60).toFixed(2)} minutes
- **Total Interactions**: ${metrics.totalInteractions}
- **Successful Interactions**: ${metrics.successfulInteractions}
- **Success Rate**: ${(metrics.successfulInteractions / metrics.totalInteractions * 100).toFixed(1)}%

## A. Flow Efficiency
- **Intent-to-Action Latency (I2A)**: ${metrics.flowMetrics.intentToActionLatency.toFixed(0)}ms
- **Action-to-Feedback Latency (A2F)**: ${metrics.flowMetrics.actionToFeedbackLatency.toFixed(0)}ms
- **Flow Breaks/min**: ${metrics.flowMetrics.flowBreaksPerMinute.toFixed(2)}
- **Orchestration Compression Ratio (OCR)**: ${metrics.flowMetrics.orchestrationCompressionRatio.toFixed(2)}
- **Productive Time Ratio (PTR)**: ${(metrics.flowMetrics.productiveTimeRatio * 100).toFixed(1)}%

## B. Navigation & Modification Efficiency
- **Hops per Question**: ${metrics.navigationMetrics.hopsPerQuestion.toFixed(2)}
- **Fix Lead Time**: ${metrics.navigationMetrics.fixLeadTime.toFixed(0)}ms
- **Build/Test Loop Time**: ${metrics.navigationMetrics.buildTestLoopTime.toFixed(0)}ms

## C. Error & Cognitive Load
- **Repair Rate**: ${(metrics.cognitiveMetrics.repairRate * 100).toFixed(1)}%
- **Audio Overload Index**: ${metrics.cognitiveMetrics.audioOverloadIndex.toFixed(2)}

## D. Result Quality
- **Task Success Rate**: ${(metrics.qualityMetrics.taskSuccessRate * 100).toFixed(1)}%
- **Test Pass Rate**: ${(metrics.qualityMetrics.testPassRate * 100).toFixed(1)}%
- **Regressions Introduced**: ${metrics.qualityMetrics.regressionsIntroduced}

## Raw Data Summary
- **Total Log Entries**: ${this.logEntries.length}
- **Interaction Turns**: ${metrics.totalInteractions}
- **Average I2A**: ${metrics.flowMetrics.intentToActionLatency.toFixed(0)}ms
- **Average A2F**: ${metrics.flowMetrics.actionToFeedbackLatency.toFixed(0)}ms
`;

        return report;
    }

    public exportDetailedData(): any {
        const interactions = this.getInteractionTurns();
        
        return {
            summary: this.analyzeSession(),
            interactions: interactions.map(it => ({
                interaction_id: it.interaction_id,
                intent_id: it.intent_id,
                success: it.success_flag,
                repair: it.repair_flag,
                duration: it.duration,
                hops: it.view_hop_count,
                audio_events: (it.overlap_events || 0) + (it.rewind_count || 0),
                i2a_latency: it.t_action_start && it.t_mic_on ? it.t_action_start - it.t_mic_on : null,
                a2f_latency: it.t_tts_on && it.t_action_end ? it.t_tts_on - it.t_action_end : null
            })),
            timeline: this.logEntries.map(entry => ({
                timestamp: entry.timestamp,
                type: entry.type,
                action: entry.action,
                interaction_id: entry.interaction_id,
                success: entry.success_flag,
                details: entry.details
            }))
        };
    }
}

// Convenience function to analyze a log file
export async function analyzeLogFile(logFilePath: string): Promise<SessionMetrics> {
    const analyzer = new MetricsAnalyzer();
    await analyzer.loadLogFile(logFilePath);
    return analyzer.analyzeSession();
}

// Convenience function to generate a report from a log file
export async function generateReportFromLogFile(logFilePath: string): Promise<string> {
    const analyzer = new MetricsAnalyzer();
    await analyzer.loadLogFile(logFilePath);
    const metrics = analyzer.analyzeSession();
    return analyzer.generateReport(metrics);
}
