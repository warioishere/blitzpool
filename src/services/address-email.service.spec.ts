jest.mock('node-telegram-bot-api', () => jest.fn());

import { AddressEmailService, AddressEmailServiceError } from './address-email.service';

function makeRepo<T>() {
    const rows: T[] = [];
    return {
        rows,
        save: jest.fn(async (row: T) => {
            const r = row as any;
            const idx = (rows as any[]).findIndex((existing: any) => {
                if ('token' in r && existing.token === r.token) return true;
                if ('address' in r && existing.address === r.address && !('token' in r)) return true;
                return false;
            });
            if (idx >= 0) {
                rows[idx] = { ...(rows[idx] as any), ...r };
                return rows[idx];
            }
            rows.push({ ...r });
            return row;
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        findOneBy: jest.fn(async (where: any) => {
            return (rows as any[]).find((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
        }),
        delete: jest.fn(async (where: any) => {
            const remaining = (rows as any[]).filter((r) => {
                if (typeof where === 'string') return r.token !== where;
                return !Object.entries(where).every(([k, v]) => r[k] === v);
            });
            const removed = rows.length - remaining.length;
            rows.length = 0;
            rows.push(...remaining as any);
            return { affected: removed };
        }),
    };
}

function makeService() {
    const bindingRepo = makeRepo<any>();
    const verificationRepo = makeRepo<any>();
    const emailService = {
        isEnabled: jest.fn(() => true),
        sendVerification: jest.fn(async () => undefined),
        sendBindingChangeAttempt: jest.fn(async () => undefined),
    };
    const config = {
        get: jest.fn((key: string) => key === 'POOL_BASE_URL' ? 'https://blitzpool.test' : undefined),
    };
    const service = new AddressEmailService(
        bindingRepo as any,
        verificationRepo as any,
        emailService as any,
        config as any,
    );
    return { service, bindingRepo, verificationRepo, emailService };
}

describe('AddressEmailService — K1-minimal FCFS-lock + binding-change notification', () => {

    it('register on a fresh address creates a pending token + sends verification', async () => {
        const { service, verificationRepo, emailService } = makeService();
        const result = await service.register('bc1qalice', 'alice@example.com');
        expect(result.token).toBeDefined();
        expect(verificationRepo.rows).toHaveLength(1);
        expect((verificationRepo.rows[0] as any).email).toBe('alice@example.com');
        expect(emailService.sendVerification).toHaveBeenCalledTimes(1);
        expect(emailService.sendBindingChangeAttempt).not.toHaveBeenCalled();
    });

    it('K1: register with DIFFERENT email refuses with already-bound + notifies existing email', async () => {
        const { service, bindingRepo, verificationRepo, emailService } = makeService();
        // Seed a verified binding
        bindingRepo.rows.push({
            address: 'bc1qbob',
            email: 'bob@example.com',
            verifiedAt: new Date(),
        });

        await expect(service.register('bc1qbob', 'eve@evil.com'))
            .rejects.toMatchObject({ code: 'already-bound' });

        // No new pending token written
        expect(verificationRepo.rows).toHaveLength(0);
        // Owner notified with masked attempted email
        expect(emailService.sendBindingChangeAttempt).toHaveBeenCalledTimes(1);
        const arg = (emailService.sendBindingChangeAttempt as jest.Mock).mock.calls[0][0];
        expect(arg.to).toBe('bob@example.com');
        expect(arg.address).toBe('bc1qbob');
        expect(arg.attemptedEmailMasked).toBe('e***@e***.com');
        // No verification email sent to attacker
        expect(emailService.sendVerification).not.toHaveBeenCalled();
    });

    it('K1: same-email re-register is allowed (idempotent re-confirm flow)', async () => {
        const { service, bindingRepo, verificationRepo, emailService } = makeService();
        bindingRepo.rows.push({
            address: 'bc1qalice',
            email: 'alice@example.com',
            verifiedAt: new Date(),
        });

        const result = await service.register('bc1qalice', 'alice@example.com');
        expect(result.token).toBeDefined();
        expect(verificationRepo.rows).toHaveLength(1);
        expect(emailService.sendVerification).toHaveBeenCalledTimes(1);
        expect(emailService.sendBindingChangeAttempt).not.toHaveBeenCalled();
    });

    it('K1: same-email re-register is case-insensitive on the email comparison', async () => {
        const { service, bindingRepo, emailService } = makeService();
        bindingRepo.rows.push({
            address: 'bc1qalice',
            email: 'alice@example.com',
            verifiedAt: new Date(),
        });
        // User submits with different case — should still be treated as same email
        await expect(service.register('bc1qalice', 'Alice@Example.COM')).resolves.toBeDefined();
        expect(emailService.sendBindingChangeAttempt).not.toHaveBeenCalled();
    });

    it('K1: notification failure does NOT change the refusal — register still rejects with already-bound', async () => {
        // Probing for binding-presence by varying SMTP deliverability would be
        // possible if the response shape depended on whether the alert sent.
        // The implementation fires-and-forgets the notification so this is decoupled.
        const { service, bindingRepo, emailService } = makeService();
        bindingRepo.rows.push({
            address: 'bc1qbob',
            email: 'bob@example.com',
            verifiedAt: new Date(),
        });
        (emailService.sendBindingChangeAttempt as jest.Mock).mockRejectedValueOnce(new Error('SMTP down'));

        await expect(service.register('bc1qbob', 'eve@evil.com'))
            .rejects.toMatchObject({ code: 'already-bound' });
    });

    it('K1: pending (un-verified) binding does NOT trigger FCFS-lock — only verifiedAt matters', async () => {
        // A row may exist transiently without verifiedAt during a partial flow
        // (e.g. legacy data, manual ops). FCFS only locks when the binding is
        // actually verified, otherwise we'd permanently brick the address.
        const { service, bindingRepo } = makeService();
        bindingRepo.rows.push({
            address: 'bc1qbob',
            email: 'old@example.com',
            verifiedAt: null,
        });

        await expect(service.register('bc1qbob', 'new@example.com')).resolves.toBeDefined();
    });

    it('verify on already-verified binding with DIFFERENT pending email refuses (defense-in-depth)', async () => {
        // Even if a stale pending token from before the FCFS-deploy still
        // exists, it must not overwrite the verified binding.
        const { service, bindingRepo, verificationRepo } = makeService();
        bindingRepo.rows.push({
            address: 'bc1qbob',
            email: 'bob@example.com',
            verifiedAt: new Date(),
        });
        verificationRepo.rows.push({
            token: 'stale-tok',
            address: 'bc1qbob',
            email: 'eve@evil.com',
            expiresAt: new Date(Date.now() + 60_000),
        });

        await expect(service.verify('stale-tok'))
            .rejects.toMatchObject({ code: 'already-bound' });
    });

    it('verify on already-verified binding with SAME pending email is idempotent (refreshes verifiedAt)', async () => {
        const { service, bindingRepo, verificationRepo } = makeService();
        const oldDate = new Date('2025-01-01');
        bindingRepo.rows.push({
            address: 'bc1qalice',
            email: 'alice@example.com',
            verifiedAt: oldDate,
        });
        verificationRepo.rows.push({
            token: 'tok-1',
            address: 'bc1qalice',
            email: 'alice@example.com',
            expiresAt: new Date(Date.now() + 60_000),
        });

        const result = await service.verify('tok-1');
        expect(result.email).toBe('alice@example.com');
        expect(result.verifiedAt!.getTime()).toBeGreaterThan(oldDate.getTime());
    });
});
