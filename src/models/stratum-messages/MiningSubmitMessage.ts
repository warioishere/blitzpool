import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';
import * as bitcoinjs from 'bitcoinjs-lib';


export class MiningSubmitMessage extends StratumBaseMessage {

    public params: string[];

    public userId: string;
    public jobId: string;
    public extraNonce2: string;
    public ntime: string;
    public nonce: string;
    public versionMask?: string | null;

    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;
    }

    /**
     * Field-mapping factory — replaces the class-transformer `plainToInstance`
     * call site. Six index→field reads, one allocation.
     */
    public static parse(plain: { id?: number | string; params: string[] }): MiningSubmitMessage {
        const m = new MiningSubmitMessage();
        m.id = plain.id ?? null;
        m.params = plain.params;
        m.userId = plain.params[0];
        m.jobId = plain.params[1];
        m.extraNonce2 = plain.params[2];
        m.ntime = plain.params[3];
        m.nonce = plain.params[4];
        m.versionMask = plain.params[5] == null ? '0' : plain.params[5];
        return m;
    }

    public response() {
        return {
            id: this.id,
            error: null,
            result: true,
        };
    }

    public hash(): string {
        const canonical = JSON.stringify({
            versionMask: this.versionMask ?? '',
            nonce: this.nonce,
            extraNonce2: this.extraNonce2,
            ntime: this.ntime,
            jobId: this.jobId,
        });
        return bitcoinjs.crypto.hash256(Buffer.from(canonical)).toString('base64');
    }
}
