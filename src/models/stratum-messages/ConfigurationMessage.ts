import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class ConfigurationMessage extends StratumBaseMessage {

    params: string[];

    constructor() {
        super();
        this.method = eRequestMethod.CONFIGURE;
    }

    public static parse(plain: { id?: number | string; params: string[] }): ConfigurationMessage {
        const m = new ConfigurationMessage();
        m.id = plain.id ?? null;
        m.params = plain.params;
        return m;
    }

    public response() {
        return {
            id: this.id,
            error: null,
            result: {
                'version-rolling': true,
                'version-rolling.mask': '1fffe000',
            },
        };
    }
}
