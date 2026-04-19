jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsController } from './pplns.controller';

describe('PplnsController.getMiningMode', () => {

    it('delegates to MiningModeService.getMode', async () => {
        const miningModeService = {
            getMode: jest.fn().mockResolvedValue({ mode: 'pplns' }),
        };
        const controller = new PplnsController(
            {} as any,
            miningModeService as any,
        );

        const res = await controller.getMiningMode('bc1qfoo');

        expect(miningModeService.getMode).toHaveBeenCalledWith('bc1qfoo');
        expect(res).toEqual({ mode: 'pplns' });
    });
});
