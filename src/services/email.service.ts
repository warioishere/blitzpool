import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

interface InvitationEmailContext {
    to: string;
    address: string;
    groupName: string;
    inviterAddress: string;
    /** UI page where the recipient reviews the invitation and clicks Accept or Decline. */
    inviteUrl: string;
    expiresAt: Date;
}

interface VerificationEmailContext {
    to: string;
    address: string;
    verifyUrl: string;
    expiresAt: Date;
}

interface BindingChangeAttemptContext {
    /** Currently-bound email — recipient of this notification. */
    to: string;
    /** Mining address whose binding someone tried to overwrite. */
    address: string;
    /** Masked form of the email that was just attempted (e.g. `a***@example.com`). */
    attemptedEmailMasked: string;
}

interface JoinRequestDecisionContext {
    to: string;
    address: string;
    groupName: string;
    /** Public group dashboard URL — recipient lands on the joined group on approve. */
    groupUrl: string;
}

export type CapacityAlertLevel = 'warning' | 'urgent' | 'recovery';

export interface CapacityAlertContext {
    to: string;
    level: CapacityAlertLevel;
    /** Human label for the bucket — 'PPLNS main pool' or 'Group "<name>"'. */
    scope: string;
    /** Distinct miner addresses currently in the window. */
    current: number;
    /** Max outputs the current coinbase weight budget can fit. */
    max: number;
    /** Percentage current / max, 0–1. */
    percent: number;
    /** Active threshold that was crossed, 0–1 (e.g. 0.8 = 80 %). */
    threshold: number;
    /** The literal coinbase weight budget used for the ceiling calc. */
    coinbaseWeightBudget: number;
    /** ENV var name the operator should bump — 'PPLNS_COINBASE_WEIGHT_BUDGET'. */
    envVarName: string;
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

    /**
     * K1-minimal: notify the bound email when someone tries to overwrite
     * the address↔email binding. Sent by AddressEmailService.register
     * whenever the FCFS-lock refuses a re-registration. Informational
     * only — no action required from the recipient — but flags any
     * attempted takeover so the legitimate owner can investigate.
     */
    async sendBindingChangeAttempt(ctx: BindingChangeAttemptContext): Promise<void> {
        if (!this.enabled || !this.transport) {
            throw new Error('EmailService not configured');
        }
        const subject = 'Attempted email-binding change on your mining address — Blitz Pool';
        const html = renderBindingChangeAttemptHtml(ctx);
        const text = renderBindingChangeAttemptText(ctx);
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
        const subject = `Invitation to join ${sanitizeHeader(ctx.groupName)} — Blitz Pool`;
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

    /**
     * Notify a miner that their public-directory join request was approved
     * and they're now a member of the group. Best-effort — we log and
     * swallow on failure so the approval flow doesn't fail the admin's
     * request just because SMTP is down.
     */
    async sendJoinRequestApproved(ctx: JoinRequestDecisionContext): Promise<void> {
        if (!this.enabled || !this.transport) return;
        const subject = `Welcome to ${sanitizeHeader(ctx.groupName)} — Blitz Pool`;
        const html = renderJoinDecisionHtml(ctx, 'approved');
        const text = renderJoinDecisionText(ctx, 'approved');
        try {
            await this.transport.sendMail({
                from: this.fromAddress,
                to: ctx.to,
                subject,
                html,
                text,
            });
        } catch (e) {
            this.logger.warn(`sendJoinRequestApproved failed: ${(e as Error).message}`);
        }
    }

    /**
     * Notify a miner that their public-directory join request was rejected.
     * No reason text is sent — keeping the admin UI minimal (no per-decision
     * comment field). Best-effort, same swallow-on-failure semantics.
     */
    async sendJoinRequestRejected(ctx: JoinRequestDecisionContext): Promise<void> {
        if (!this.enabled || !this.transport) return;
        const subject = `Join request to ${sanitizeHeader(ctx.groupName)} declined — Blitz Pool`;
        const html = renderJoinDecisionHtml(ctx, 'rejected');
        const text = renderJoinDecisionText(ctx, 'rejected');
        try {
            await this.transport.sendMail({
                from: this.fromAddress,
                to: ctx.to,
                subject,
                html,
                text,
            });
        } catch (e) {
            this.logger.warn(`sendJoinRequestRejected failed: ${(e as Error).message}`);
        }
    }

    /**
     * Operator alert: the coinbase output capacity (derived from the current
     * PPLNS_COINBASE_WEIGHT_BUDGET) is nearing its ceiling. Sent when the
     * active-miner count crosses a configured threshold (default 80 %), at
     * escalation into 'urgent' (default 95 %), and once when the condition
     * clears back below the warning threshold.
     */
    async sendCapacityAlert(ctx: CapacityAlertContext): Promise<void> {
        if (!this.enabled || !this.transport) {
            throw new Error('EmailService not configured');
        }
        const subject = capacitySubject(ctx);
        const html = renderCapacityAlertHtml(ctx);
        const text = renderCapacityAlertText(ctx);
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
  Open the invitation page to review it and accept or decline. When you accept, your mining address joins this group and future blocks you find will be paid out via the group's PROP-style coinbase split.
</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
  <tr><td>${buttonHtml(ctx.inviteUrl, 'Open invitation')}</td></tr>
</table>
<p style="margin:0 0 8px;font-size:12px;color:${COLOR_MUTED};">
  Or paste this link into your browser:
</p>
<p style="margin:0 0 24px;font-size:12px;color:${COLOR_MUTED};word-break:break-all;">
  <a href="${escapeAttr(ctx.inviteUrl)}" style="color:${COLOR_PRIMARY};text-decoration:underline;">${escapeHtml(ctx.inviteUrl)}</a>
</p>
<p style="margin:0;font-size:12px;color:${COLOR_MUTED};">
  Invitation expires ${escapeHtml(expires)}. If you don't recognise the inviter, decline.
</p>
`;
    return shellHtml(`Invitation to join ${sanitizeHeader(ctx.groupName)}`, body);
}

function renderInvitationText(ctx: InvitationEmailContext): string {
    return [
        `You've been invited to join the payout group "${sanitizeHeader(ctx.groupName)}" on Blitz Pool.`,
        ``,
        `Your address: ${ctx.address}`,
        `Invited by:   ${ctx.inviterAddress}`,
        ``,
        `Open the invitation: ${ctx.inviteUrl}`,
        ``,
        `Invitation expires ${ctx.expiresAt.toUTCString()}.`,
        `If you don't recognise the inviter, decline.`,
    ].join('\n');
}

function renderJoinDecisionHtml(ctx: JoinRequestDecisionContext, decision: 'approved' | 'rejected'): string {
    const isApproved = decision === 'approved';
    const headline = isApproved ? 'Welcome — request approved' : 'Request declined';
    const body = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${COLOR_TEXT};">${escapeHtml(headline)}</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  Your join request to <strong style="color:${COLOR_PRIMARY};">${escapeHtml(ctx.groupName)}</strong> has been
  <strong>${isApproved ? 'approved' : 'declined'}</strong> by the group admin.
</p>
<p style="margin:0 0 24px;padding:12px 16px;background:${COLOR_BG};border-radius:6px;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};word-break:break-all;">
  ${escapeHtml(ctx.address)}
</p>
${isApproved ? `
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  Your address is now a member. Future blocks will be paid out via the group's PROP-style coinbase split.
</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
  <tr><td>${buttonHtml(ctx.groupUrl, 'Open group dashboard')}</td></tr>
</table>
<p style="margin:0;font-size:12px;color:${COLOR_MUTED};">
  Or paste this link: <a href="${escapeAttr(ctx.groupUrl)}" style="color:${COLOR_PRIMARY};">${escapeHtml(ctx.groupUrl)}</a>
</p>
` : `
<p style="margin:0;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  No further action is needed. You can request to join other public groups any time.
</p>
`}
`;
    return shellHtml(headline, body);
}

function renderJoinDecisionText(ctx: JoinRequestDecisionContext, decision: 'approved' | 'rejected'): string {
    if (decision === 'approved') {
        return [
            `Your join request to "${sanitizeHeader(ctx.groupName)}" was approved.`,
            ``,
            `Address: ${ctx.address}`,
            ``,
            `Open group dashboard: ${ctx.groupUrl}`,
        ].join('\n');
    }
    return [
        `Your join request to "${sanitizeHeader(ctx.groupName)}" was declined by the admin.`,
        ``,
        `Address: ${ctx.address}`,
        ``,
        `No further action is needed. You can request to join other public groups any time.`,
    ].join('\n');
}

function renderBindingChangeAttemptHtml(ctx: BindingChangeAttemptContext): string {
    const body = `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;">
  <tr><td style="background:#FFB74D;color:${COLOR_PRIMARY_TEXT};padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.1em;">
    NOTICE
  </td></tr>
</table>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${COLOR_TEXT};">Attempted email-binding change</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  Someone just tried to register a different email against your mining address:
</p>
<p style="margin:0 0 24px;padding:12px 16px;background:${COLOR_BG};border-radius:6px;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};word-break:break-all;">
  ${escapeHtml(ctx.address)}
</p>
<p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${COLOR_MUTED};">Attempted new email</p>
<p style="margin:0 0 24px;font-family:'Roboto Mono',monospace;font-size:14px;color:${COLOR_TEXT};">
  ${escapeHtml(ctx.attemptedEmailMasked)}
</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  The attempt was <strong style="color:${COLOR_PRIMARY};">refused</strong>. Your existing binding is still active and group invitations continue to come to this email address.
</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  No action is required if this was you (e.g. you typed your address by mistake on a friend's device). If you don't recognise this, your address may be on a public block-finder list — there is no exposure beyond this notification.
</p>
<p style="margin:0;font-size:12px;color:${COLOR_MUTED};">
  This is an automated security notification. You will not receive a separate email per attempt — only the first within a short window.
</p>
`;
    return shellHtml('Attempted email-binding change', body);
}

function renderBindingChangeAttemptText(ctx: BindingChangeAttemptContext): string {
    return [
        `Attempted email-binding change on Blitz Pool`,
        ``,
        `Someone tried to register a different email against your mining address:`,
        `  ${ctx.address}`,
        ``,
        `Attempted new email: ${ctx.attemptedEmailMasked}`,
        ``,
        `The attempt was REFUSED. Your existing binding is still active and group invitations continue to come to this email address.`,
        ``,
        `No action is required. If you don't recognise this, your address is likely on a public block-finder list — there is no exposure beyond this notification.`,
    ].join('\n');
}

/**
 * Strip characters that could break email headers (Subject, body section
 * markers). Defense-in-depth — the group-name input is already validated
 * at `GroupService.createGroup`, but any future caller that forgets to
 * validate would still produce a safe header through this helper.
 */
function sanitizeHeader(s: string): string {
    return (s ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 200);
}

// ── Capacity alert ────────────────────────────────────────────────────

function capacitySubject(ctx: CapacityAlertContext): string {
    const pct = (ctx.percent * 100).toFixed(0);
    const scope = sanitizeHeader(ctx.scope);
    if (ctx.level === 'urgent') {
        return `[Blitz Pool] URGENT: ${scope} coinbase capacity at ${pct} %`;
    }
    if (ctx.level === 'recovery') {
        return `[Blitz Pool] Recovered: ${scope} coinbase capacity back to ${pct} %`;
    }
    return `[Blitz Pool] Warning: ${scope} coinbase capacity at ${pct} %`;
}

function renderCapacityAlertHtml(ctx: CapacityAlertContext): string {
    const pct = (ctx.percent * 100).toFixed(1);
    const thresholdPct = (ctx.threshold * 100).toFixed(0);
    const headline = ctx.level === 'urgent'
        ? 'Coinbase capacity critical'
        : ctx.level === 'recovery'
            ? 'Coinbase capacity recovered'
            : 'Coinbase capacity warning';
    const badge = ctx.level === 'urgent' ? '#FF5252'
        : ctx.level === 'recovery' ? '#66BB6A'
            : '#FFB74D';
    const badgeLabel = ctx.level === 'urgent' ? 'URGENT'
        : ctx.level === 'recovery' ? 'RECOVERED'
            : 'WARNING';

    const recSection = ctx.level === 'recovery' ? '' : `
<p style="margin:24px 0 8px;font-size:14px;font-weight:600;color:${COLOR_TEXT};">Recommended action</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  Bump both settings to roughly double the current value (e.g. 100 000 or 200 000):
</p>
<p style="margin:0 0 16px;padding:12px 16px;background:${COLOR_BG};border-radius:6px;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};line-height:1.6;">
  bitcoin.conf: <strong>blockreservedweight=${escapeHtml(String(ctx.coinbaseWeightBudget * 2))}</strong><br>
  blitzpool.env: <strong>${escapeHtml(ctx.envVarName)}=${escapeHtml(String(ctx.coinbaseWeightBudget * 2))}</strong>
</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${COLOR_MUTED};">
  Then restart bitcoind and the pool. Without an increase, every block above 100 % capacity trims the smallest miners to pending — they'll wait longer for their next payout.
</p>`;

    const body = `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;">
  <tr><td style="background:${badge};color:${COLOR_PRIMARY_TEXT};padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.1em;">
    ${badgeLabel}
  </td></tr>
</table>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${COLOR_TEXT};">${escapeHtml(headline)}</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${COLOR_TEXT};">
  ${escapeHtml(ctx.scope)} coinbase capacity is currently at <strong style="color:${COLOR_PRIMARY};">${escapeHtml(pct)} %</strong>
  (threshold ${escapeHtml(thresholdPct)} %).
</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px;background:${COLOR_BG};border-radius:6px;">
  <tr><td style="padding:16px;">
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${COLOR_MUTED};">Active miners</p>
    <p style="margin:0 0 16px;font-family:'Roboto Mono',monospace;font-size:18px;color:${COLOR_TEXT};">
      ${escapeHtml(String(ctx.current))} / ${escapeHtml(String(ctx.max))}
    </p>
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${COLOR_MUTED};">Coinbase weight budget</p>
    <p style="margin:0;font-family:'Roboto Mono',monospace;font-size:13px;color:${COLOR_PRIMARY};">
      ${escapeHtml(ctx.envVarName)}=${escapeHtml(String(ctx.coinbaseWeightBudget))}
    </p>
  </td></tr>
</table>
${recSection}
<p style="margin:24px 0 0;font-size:12px;color:${COLOR_MUTED};">
  This is an automated operator alert. Next check in roughly one hour. Set
  <code style="font-family:'Roboto Mono',monospace;color:${COLOR_TEXT};">POOL_CAPACITY_ALERT_ENABLED=false</code>
  to silence.
</p>
`;
    return shellHtml(headline, body);
}

function renderCapacityAlertText(ctx: CapacityAlertContext): string {
    const pct = (ctx.percent * 100).toFixed(1);
    const thresholdPct = (ctx.threshold * 100).toFixed(0);
    const head = ctx.level === 'urgent'
        ? `URGENT: ${ctx.scope} coinbase capacity critical`
        : ctx.level === 'recovery'
            ? `RECOVERED: ${ctx.scope} coinbase capacity back to normal`
            : `WARNING: ${ctx.scope} coinbase capacity threshold crossed`;

    const lines = [
        head,
        ``,
        `Current: ${ctx.current} / ${ctx.max} miners  (${pct} %)`,
        `Threshold: ${thresholdPct} %`,
        `Budget: ${ctx.envVarName}=${ctx.coinbaseWeightBudget}`,
        ``,
    ];
    if (ctx.level !== 'recovery') {
        lines.push(
            `Recommended: bump both to ${ctx.coinbaseWeightBudget * 2}`,
            `  bitcoin.conf: blockreservedweight=${ctx.coinbaseWeightBudget * 2}`,
            `  blitzpool.env: ${ctx.envVarName}=${ctx.coinbaseWeightBudget * 2}`,
            `Then restart bitcoind + pool.`,
            ``,
        );
    }
    lines.push(
        `Next check in ~1h.`,
        `Silence with POOL_CAPACITY_ALERT_ENABLED=false.`,
    );
    return lines.join('\n');
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
