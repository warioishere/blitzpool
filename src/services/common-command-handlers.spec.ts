import { NumberSuffix } from '../utils/NumberSuffix';
import { buildWorkersOverviewMessage, WorkerOverviewData } from './common-command-handlers';

describe('buildWorkersOverviewMessage', () => {
    it('formats worker overview with suffixes and plain current difficulty', () => {
        const data: WorkerOverviewData = {
            workersCount: 2,
            totalHashrate: 1_500_000_000_000,
            totalShares: 12345,
            bestDifficulty: 987654,
            workers: [
                {
                    name: 'Alpha',
                    hashRate: 1_000_000_000,
                    currentDifficulty: 123,
                    bestDifficulty: '456.78',
                },
                {
                    name: '',
                    hashRate: null,
                    currentDifficulty: null,
                    bestDifficulty: null,
                },
            ],
        };

        const result = buildWorkersOverviewMessage(data, new NumberSuffix());

        expect(result.de).toContain('Gesamt-Hashrate: 1.50TH/s');
        expect(result.en).toContain('Total hashrate: 1.50TH/s');
        expect(result.de).toContain('Gesamt-Shares: 12.35k');
        expect(result.en).toContain('Total shares: 12.35k');
        expect(result.de).toContain('Beste Difficulty: 987.65k');
        expect(result.en).toContain('Best difficulty: 987.65k');
        expect(result.de).toContain(
            ['• Alpha', 'Hashrate: 1.00GH/s', 'Aktuelle Difficulty: 123', 'Beste Difficulty: 456.78'].join('\n')
        );
        expect(result.en).toContain(
            ['• Alpha', 'Hashrate: 1.00GH/s', 'Current difficulty: 123', 'Best difficulty: 456.78'].join('\n')
        );
        expect(result.de).toContain('• Worker 2');
        expect(result.de).toContain('Aktuelle Difficulty: –');
        expect(result.de).toContain('Beste Difficulty: –');
        expect(result.en).toContain('Current difficulty: –');
    });
});
