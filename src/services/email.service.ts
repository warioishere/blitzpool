import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

interface InvitationEmailContext {
    to: string;
    address: string;
    groupName: string;
    inviterAddress: string;
    acceptUrl: string;
    declineUrl: string;
    expiresAt: Date;
}

interface VerificationEmailContext {
    to: string;
    address: string;
    verifyUrl: string;
    expiresAt: Date;
}

/**
 * Sends transactional emails for the address-email-binding and group-invitation
 * flows. Reads SMTP credentials from env (SMTP_HOST/PORT/USER/PASS/FROM) and
 * the public UI base URL from POOL_BASE_URL. Uses inline-styled HTML templates
 * matching the dashboard's dark indigo theme so the email feels like part of
 * the app, not a separate service.
 */
@Injectable()
export class EmailService implements OnModuleInit {

    private readonly logger = new Logger(EmailService.name);
    private transport: Transporter | null = null;
    private fromAddress: string;
    private enabled = false;

    constructor(private readonly config: ConfigService) {}

    onModuleInit(): void {
        const host = this.config.get<string>('SMTP_HOST');
        const port = parseInt(this.config.get<string>('SMTP_PORT') ?? '587', 10);
        const secure = (this.config.get<string>('SMTP_SECURE') ?? 'false').toLowerCase() === 'true';
        const user = this.config.get<string>('SMTP_USER');
        const pass = this.config.get<string>('SMTP_PASS');
        const from = this.config.get<string>('SMTP_FROM');

        if (!host || !user || !pass || !from) {
            this.logger.warn('EmailService disabled: SMTP_HOST/USER/PASS/FROM not all set. Invitation + verification emails will fail until configured.');
            return;
        }

        this.transport = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: { user, pass },
        });
        this.fromAddress = from;
        this.enabled = true;
        this.logger.log(`EmailService configured (host=${host}:${port}, secure=${secure}, from=${from})`);
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    async sendVerification(ctx: VerificationEmailContext): Promise<void> {
        if (!this.enabled || !this.transport) {
            throw new Error('EmailService not configured');
        }
        const subject = 'Confirm your email address — Blitz Pool';
        const html = renderVerificationHtml(ctx);
        const text = renderVerificationText(ctx);
        await this.transport.sendMail({
            from: this.fromAddress,
            to: ctx.to,
            subject,
            html,
            text,
        });
    }

    async sendInvitation(ctx: InvitationEmailContext): Promise<void> {
        if (!this.enabled || !this.transport) {
            throw new Error('EmailService not configured');
        }
        const subject = `Invitation to join ${ctx.groupName} — Blitz Pool`;
        const html = renderInvitationHtml(ctx);
        const text = renderInvitationText(ctx);
        await this.transport.sendMail({
            from: this.fromAddress,
            to: ctx.to,
            subject,
            html,
            text,
        });
    }
}

// ── Theme ────────────────────────────────────────────────────────────
//
// Inline-styled HTML — email clients strip <style> tags, so colours/fonts
// have to live on each element. Palette mirrors the dashboard's
// mdc-dark-indigo theme:
//   surface: #1e1e1e (page bg)
//   card:    #2a2a2a
//   border:  #3a3a3a
//   primary: #9FA8DA
//   text:    #ffffff / #cfd8dc / #888

const COLOR_BG = '#1e1e1e';
const COLOR_CARD = '#2a2a2a';
const COLOR_BORDER = '#3a3a3a';
const COLOR_PRIMARY = '#9FA8DA';
const COLOR_PRIMARY_TEXT = '#1a1a1a';
const COLOR_TEXT = '#ffffff';
const COLOR_MUTED = '#9e9e9e';

function shellHtml(title: string, bodyHtml: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${COLOR_TEXT};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLOR_BG};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:${COLOR_CARD};border:1px solid ${COLOR_BORDER};border-radius:8px;overflow:hidden;">
      <tr><td style="padding:24px 32px;border-bottom:1px solid ${COLOR_BORDER};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="font-size:20px;font-weight:600;color:${COLOR_TEXT};">⚡ Blitz Pool</td>
            <td align="right" style="font-size:12px;color:${COLOR_MUTED};">Mining Pool</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:32px;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid ${COLOR_BORDER};font-size:11px;color:${COLOR_MUTED};line-height:1.5;">
        This is a transactional email from Blitz Pool. If you did not expect this message you can safely ignore it — no action will be taken.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buttonHtml(href: string, label: string, primary = true): string {
    if (primary) {
        return `<a href="${escapeAttr(href)}" style="display:inline-block;background:${COLOR_PRIMARY};color:${COLOR_PRIMARY_TEXT};padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
    }
    return `<a href="${escapeAttr(href)}" style="display:inline-block;background:transparent;color:${COLOR_TEXT};padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px;border:1px solid ${COLOR_BORDER};">${escapeHtml(label)}</a>`;
}

function renderVerificationHtml(ctx: VerificationEmailContext): string {
    const expires = ctx.expiresAt.toUTCString();
    const body = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${COLOR_TEXT};">Confirm your email address</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  This email is being bound to mining address:
</p>
<p style="margin:0 0 24px;padding:12px 16px;background:${COLOR_BG};border-radius:6px;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};word-break:break-all;">
  ${escapeHtml(ctx.address)}
</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  Click the button below to confirm. Once confirmed, payout-group admins will be able to invite this address into their group.
</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
  <tr><td>${buttonHtml(ctx.verifyUrl, 'Confirm email')}</td></tr>
</table>
<p style="margin:0 0 8px;font-size:12px;color:${COLOR_MUTED};">
  Or paste this link into your browser:
</p>
<p style="margin:0 0 24px;font-size:12px;color:${COLOR_MUTED};word-break:break-all;">
  <a href="${escapeAttr(ctx.verifyUrl)}" style="color:${COLOR_PRIMARY};text-decoration:underline;">${escapeHtml(ctx.verifyUrl)}</a>
</p>
<p style="margin:0;font-size:12px;color:${COLOR_MUTED};">
  Link expires ${escapeHtml(expires)}.
</p>
`;
    return shellHtml('Confirm your email address', body);
}

function renderVerificationText(ctx: VerificationEmailContext): string {
    return [
        `Confirm your email for Blitz Pool`,
        ``,
        `Address: ${ctx.address}`,
        ``,
        `Click to confirm: ${ctx.verifyUrl}`,
        ``,
        `Link expires ${ctx.expiresAt.toUTCString()}.`,
        ``,
        `If you didn't request this, ignore the email.`,
    ].join('\n');
}

function renderInvitationHtml(ctx: InvitationEmailContext): string {
    const expires = ctx.expiresAt.toUTCString();
    const body = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${COLOR_TEXT};">Group invitation</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  You've been invited to join the payout group <strong style="color:${COLOR_PRIMARY};">${escapeHtml(ctx.groupName)}</strong>.
</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;background:${COLOR_BG};border-radius:6px;">
  <tr><td style="padding:16px;">
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${COLOR_MUTED};">Your address</p>
    <p style="margin:0 0 16px;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};word-break:break-all;">
      ${escapeHtml(ctx.address)}
    </p>
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${COLOR_MUTED};">Invited by</p>
    <p style="margin:0;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_TEXT};word-break:break-all;">
      ${escapeHtml(ctx.inviterAddress)}
    </p>
  </td></tr>
</table>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  When you accept, your mining address joins this group and future blocks you find will be paid out via the group's PROP-style coinbase split.
</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
  <tr>
    <td style="padding-right:12px;">${buttonHtml(ctx.acceptUrl, 'Accept invitation')}</td>
    <td>${buttonHtml(ctx.declineUrl, 'Decline', false)}</td>
  </tr>
</table>
<p style="margin:0 0 8px;font-size:12px;color:${COLOR_MUTED};">
  Or copy these links:
</p>
<p style="margin:0 0 6px;font-size:12px;color:${COLOR_MUTED};word-break:break-all;">
  Accept: <a href="${escapeAttr(ctx.acceptUrl)}" style="color:${COLOR_PRIMARY};text-decoration:underline;">${escapeHtml(ctx.acceptUrl)}</a>
</p>
<p style="margin:0 0 24px;font-size:12px;color:${COLOR_MUTED};word-break:break-all;">
  Decline: <a href="${escapeAttr(ctx.declineUrl)}" style="color:${COLOR_PRIMARY};text-decoration:underline;">${escapeHtml(ctx.declineUrl)}</a>
</p>
<p style="margin:0;font-size:12px;color:${COLOR_MUTED};">
  Invitation expires ${escapeHtml(expires)}. If you don't recognise the inviter, decline.
</p>
`;
    return shellHtml(`Invitation to join ${ctx.groupName}`, body);
}

function renderInvitationText(ctx: InvitationEmailContext): string {
    return [
        `You've been invited to join the payout group "${ctx.groupName}" on Blitz Pool.`,
        ``,
        `Your address: ${ctx.address}`,
        `Invited by:   ${ctx.inviterAddress}`,
        ``,
        `Accept:  ${ctx.acceptUrl}`,
        `Decline: ${ctx.declineUrl}`,
        ``,
        `Invitation expires ${ctx.expiresAt.toUTCString()}.`,
        `If you don't recognise the inviter, decline.`,
    ].join('\n');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
