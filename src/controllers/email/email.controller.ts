import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AddressEmailService, AddressEmailServiceError } from '../../services/address-email.service';
import { maskEmail } from '../../utils/email-mask.utils';

interface RegisterDto {
    address: string;
    email: string;
}

@Controller('email')
export class EmailController {

    constructor(private readonly addressEmailService: AddressEmailService) {}

    /**
     * POST /api/email/register
     * Bind an email to a mining address. Sends a verification link to the
     * email — the binding is not "verified" until the link is clicked.
     */
    // 5 register attempts / minute per IP. Each call sends an email —
    // looser limits invite SMTP-quota abuse and spam-listing of the
    // pool's sender domain.
    @UseGuards(ThrottlerGuard)
    @Throttle(5, 60)
    @Post('register')
    async register(@Body() body: RegisterDto): Promise<{ ok: true; verificationSent: true }> {
        try {
            await this.addressEmailService.register(body.address?.trim() ?? '', body.email);
            return { ok: true, verificationSent: true };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    /**
     * GET /api/email/verify/:token
     * Confirm an email binding via the link from the verification email.
     * Returns the verified binding (address + email) so the UI can render
     * confirmation + a "go back to your dashboard" link.
     */
    @Get('verify/:token')
    async verify(@Param('token') token: string): Promise<{ address: string; email: string; verifiedAt: string }> {
        try {
            const binding = await this.addressEmailService.verify(token);
            return {
                address: binding.address,
                email: binding.email,
                verifiedAt: new Date(binding.verifiedAt!).toISOString(),
            };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    /**
     * GET /api/email/by-address/:address
     * Lookup the verified-email binding for an address. The endpoint is
     * unauthenticated and `/app/:address` is a public URL, so the email
     * is returned MASKED (`a***@domain`) — the address owner already
     * knows their full email, and the masked form is enough for the
     * Settings page to confirm "yes, a binding exists, prefix is `a***`".
     * Returns `{ email: null }` when no verified binding exists.
     */
    @Get('by-address/:address')
    async byAddress(@Param('address') address: string): Promise<{ email: string | null; verifiedAt: string | null }> {
        const binding = await this.addressEmailService.getVerified(address);
        if (!binding) return { email: null, verifiedAt: null };
        return {
            email: maskEmail(binding.email),
            verifiedAt: binding.verifiedAt != null ? new Date(binding.verifiedAt).toISOString() : null,
        };
    }

    private toHttp(e: any): HttpException {
        if (e instanceof AddressEmailServiceError) {
            const status = e.code === 'not-found' ? HttpStatus.NOT_FOUND
                : e.code === 'expired' ? HttpStatus.GONE
                : e.code === 'already-bound' ? HttpStatus.CONFLICT
                : e.code === 'email-disabled' || e.code === 'config-missing' ? HttpStatus.SERVICE_UNAVAILABLE
                : HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal', message: e?.message ?? 'unknown' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
