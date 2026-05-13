import { eRequestMethod } from '../enums/eRequestMethod';
import { eResponseMethod } from '../enums/eResponseMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class SuggestDifficulty extends StratumBaseMessage {
    params: string | number[];

    public suggestedDifficulty: number;

    constructor() {
        super();
        this.method = eRequestMethod.SUGGEST_DIFFICULTY;
    }

    public static parse(plain: { id?: number | string; params: any[] }): SuggestDifficulty {
        const m = new SuggestDifficulty();
        m.id = plain.id ?? null;
        m.params = plain.params;
        m.suggestedDifficulty = Number(plain.params[0]);
        return m;
    }

    public response(difficulty: number) {
        return {
            id: null,
            method: eResponseMethod.SET_DIFFICULTY,
            params: [difficulty],
        };
    }
}
