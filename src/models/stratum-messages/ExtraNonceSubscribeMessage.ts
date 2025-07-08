import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class ExtraNonceSubscribeMessage extends StratumBaseMessage {
    constructor() {
        super();
        this.method = eRequestMethod.EXTRANONCE_SUBSCRIBE;
    }

    public response() {
        return {
            id: this.id,
            error: null,
            result: true,
        };
    }
}
