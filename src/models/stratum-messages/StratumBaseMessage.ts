import { eRequestMethod } from '../enums/eRequestMethod';

export class StratumBaseMessage {
    id?: number | string = null;
    method: eRequestMethod;
}
