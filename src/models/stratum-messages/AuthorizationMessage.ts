import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class AuthorizationMessage extends StratumBaseMessage {

    params: string[];

    public address: string;
    public worker: string;
    public password?: string;

    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;
    }

    public static parse(plain: { id?: number | string; params: string[] }): AuthorizationMessage {
        const m = new AuthorizationMessage();
        m.id = plain.id ?? null;
        m.params = plain.params;
        const accountWorker = plain.params[0];
        const split = accountWorker.split('.');
        m.address = split[0];
        m.worker = split[1] == null ? 'worker' : split[1];
        m.password = plain.params[1];
        return m;
    }

    public response() {
        return {
            id: this.id,
            error: null,
            result: true,
        };
    }
}
