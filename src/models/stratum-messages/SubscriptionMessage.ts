import { Expose, Transform } from 'class-transformer';
import { IsArray, IsString, MaxLength } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class SubscriptionMessage extends StratumBaseMessage {


    @IsArray()
    params: string[];

    @Expose()
    @IsString()
    @MaxLength(128)
    @Transform(({ value, key, obj, type }) => {
        return obj?.params?.[0] == null ? 'unknown' : SubscriptionMessage.refineUserAgent(obj.params[0]);
    })
    public userAgent: string;

    constructor() {
        super();
        this.method = eRequestMethod.SUBSCRIBE;
    }

    public response(sessionId: string, extraNonce: string) {
        return {
            id: this.id,
            error: null,
            result: [
                [
                    ['mining.notify', sessionId]
                ],
                extraNonce, //Extranonce1 -  Hex-encoded, per-connection unique string which will be used for coinbase serialization later. Keep it safe!
                8 //Extranonce2_size - 8 bytes per ckpool default and required by Braiins Hashpower marketplace (extranonce2_size >= 7). Total extranonce slot = 4 + 8 = 12 bytes (matches MiningJob.ts coinbase padding).
            ]
        }


    }

    public static refineUserAgent(userAgent: string): string {
        // return userAgent;
	userAgent = userAgent.split(' ')[0].split('/')[0].split('V')[0];

        if (userAgent.includes('bosminer') || userAgent.includes('bOS')) {
            userAgent = 'Braiins OS';
        } else if (userAgent.includes('cpuminer')) {
            userAgent = 'cpuminer';
        }
        return userAgent;
    }
}
