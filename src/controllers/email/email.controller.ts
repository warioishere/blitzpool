import { Body, Controller, Get, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { AddressEmailService, AddressEmailServiceError } from '../../services/address-email.service';

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
    async verify(@Param('token') token: string): Promise<{ address: string; email: string; verifiedAt: Date }> {
        try {
            const binding = await this.addressEmailService.verify(token);
            return {
                address: binding.address,
                email: binding.email,
                verifiedAt: binding.verifiedAt!,
            };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    /**
     * GET /api/email/by-address/:address
     * Lookup the verified-email binding for an address. Returns
     * { email, verifiedAt } if bound, or { email: null } if not — used
     * by the dashboard settings page to show the current state without
     * leaking the email address itself unnecessarily (we only return it
     * when explicitly requested by someone visiting that address's page,
     * matching the existing trust model).
     */
    @Get('by-address/:address')
    async byAddress(@Param('address') address: string): Promise<{ email: string | null; verifiedAt: Date | null }> {
        const binding = await this.addressEmailService.getVerified(address);
        if (!binding) return { email: null, verifiedAt: null };
        return { email: binding.email, verifiedAt: binding.verifiedAt };
    }

    private toHttp(e: any): HttpException {
        if (e instanceof AddressEmailServiceError) {
            const status = e.code === 'not-found' ? HttpStatus.NOT_FOUND
                : e.code === 'expired' ? HttpStatus.GONE
                : e.code === 'email-disabled' || e.code === 'config-missing' ? HttpStatus.SERVICE_UNAVAILABLE
                : HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal', message: e?.message ?? 'unknown' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
