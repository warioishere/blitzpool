import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import * as crypto from 'crypto';
import { AddressEmailEntity } from '../ORM/address-email/address-email.entity';
import { EmailVerificationEntity } from '../ORM/address-email/email-verification.entity';
import { EmailService } from './email.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';

const VERIFICATION_TTL_HOURS = 24;
// Loose RFC 5322 sanity check, not a full validator. The MX/handshake
// happens at SMTP-send time anyway — this just rejects obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AddressEmailServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

/**
 * Manages the bidirectional binding between a BTC mining address and an
 * email account.  An address is "email-verified" once the user has clicked
 * the link sent to the email they submitted.  Group invitations require a
 * verified email — that's the out-of-band trust anchor that prevents a
 * malicious admin from silently adding random addresses.
 */
@Injectable()
export class AddressEmailService {

    private readonly logger = new Logger(AddressEmailService.name);

    constructor(
        @InjectRepository(AddressEmailEntity)
        private readonly bindingRepo: Repository<AddressEmailEntity>,
        @InjectRepository(EmailVerificationEntity)
        private readonly verificationRepo: Repository<EmailVerificationEntity>,
        private readonly emailService: EmailService,
        private readonly config: ConfigService,
    ) {}

    /**
     * Submit an email for an address. Sends a verification email and stores
     * a pending token. Re-submitting a different email overwrites any
     * existing pending verifications for the address but does NOT erase
     * an already-verified binding until the new one is confirmed.
     */
    async register(address: string, email: string): Promise<{ token: string }> {
        const normalizedAddress = normalizeBtcAddress(address);
        if (!normalizedAddress) throw new AddressEmailServiceError('invalid-address', 'Address required');
        address = normalizedAddress;
        const normalizedEmail = (email ?? '').trim().toLowerCase();
        if (!EMAIL_RE.test(normalizedEmail)) {
            throw new AddressEmailServiceError('invalid-email', 'Email format invalid');
        }
        if (!this.emailService.isEnabled()) {
            throw new AddressEmailServiceError('email-disabled', 'Email service not configured on server');
        }

        // Drop prior pending tokens for this address — only the latest one is
        // valid. Existing verified binding (if any) stays until the new one
        // is confirmed.
        await this.verificationRepo.delete({ address });

        const token = this.generateToken();
        const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);
        await this.verificationRepo.save(this.verificationRepo.create({
            token,
            address,
            email: normalizedEmail,
            expiresAt,
        }));

        // UI uses HashLocationStrategy — the routable path has to live in
        // the URL fragment (after `#`). Without the hash, Caddy+Angular
        // resolve only the bare "/" and land the user on the homepage,
        // because the path part is never read by the router.
        const verifyUrl = `${this.poolBaseUrl()}/#/email/verify/${token}`;
        await this.emailService.sendVerification({
            to: normalizedEmail,
            address,
            verifyUrl,
            expiresAt,
        });
        return { token };
    }

    /**
     * Confirm an email by consuming a verification token. Idempotent on
     * the resulting binding (re-clicking the same link after success
     * returns the binding without erroring).
     */
    async verify(token: string): Promise<AddressEmailEntity> {
        const pending = await this.verificationRepo.findOneBy({ token });
        if (!pending) {
            throw new AddressEmailServiceError('not-found', 'Verification token unknown or already used');
        }
        if (pending.expiresAt.getTime() < Date.now()) {
            await this.verificationRepo.delete({ token });
            throw new AddressEmailServiceError('expired', 'Verification link expired — request a new one');
        }

        // Replace any existing binding for this address.
        const existing = await this.bindingRepo.findOneBy({ address: pending.address });
        let saved: AddressEmailEntity;
        if (existing) {
            existing.email = pending.email;
            existing.verifiedAt = new Date();
            saved = await this.bindingRepo.save(existing);
        } else {
            saved = await this.bindingRepo.save(this.bindingRepo.create({
                address: pending.address,
                email: pending.email,
                verifiedAt: new Date(),
            }));
        }

        // Consume token and any stale tokens for the same address (defensive).
        await this.verificationRepo.delete({ address: pending.address });
        return saved;
    }

    /**
     * Lookup the verified-email binding for an address, or null if none.
     * Pending (un-verified) tokens are ignored — only confirmed bindings
     * count.
     */
    async getVerified(address: string): Promise<AddressEmailEntity | null> {
        const row = await this.bindingRepo.findOneBy({ address: normalizeBtcAddress(address) });
        if (!row || !row.verifiedAt) return null;
        return row;
    }

    /**
     * Periodic cleanup — drops expired verification tokens. Fires hourly
     * via @Interval; also safe to call directly.
     */
    @Interval(60 * 60 * 1000)
    async purgeExpiredTokens(): Promise<number> {
        try {
            const result = await this.verificationRepo.delete({
                expiresAt: LessThan(new Date()),
            });
            const n = result.affected ?? 0;
            if (n > 0) this.logger.log(`Purged ${n} expired verification tokens`);
            return n;
        } catch (err) {
            this.logger.warn(`purgeExpiredTokens failed: ${(err as Error).message}`);
            return 0;
        }
    }

    private generateToken(): string {
        // 32 bytes = 256 bits, base64url-encoded → 43 chars, URL-safe, fits
        // in our 64-char column with margin.
        return crypto.randomBytes(32).toString('base64url');
    }

    private poolBaseUrl(): string {
        const url = this.config.get<string>('POOL_BASE_URL');
        if (!url) {
            throw new AddressEmailServiceError('config-missing', 'POOL_BASE_URL is not set');
        }
        return url.replace(/\/+$/, '');
    }
}
