import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DownstreamMinerReport } from '../models/DownstreamMinerReport';
import { ClientService } from '../ORM/client/client.service';

interface StoredReport {
  report: DownstreamMinerReport;
  receivedAt: number;
}

@Injectable()
export class DownstreamReportService {
  private readonly logger = new Logger(DownstreamReportService.name);
  private readonly reports = new Map<string, StoredReport>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly clientService: ClientService) {}

  async storeReport(report: DownstreamMinerReport): Promise<void> {
    this.reports.set(report.jdcUserIdentity, {
      report,
      receivedAt: Date.now(),
    });
    this.cleanExpired();

    // Update the userAgent in the DB for the matching client session
    await this.applyUserAgentOverride(report);
  }

  getReports(): DownstreamMinerReport[] {
    this.cleanExpired();
    return Array.from(this.reports.values()).map((s) => s.report);
  }

  private async applyUserAgentOverride(report: DownstreamMinerReport): Promise<void> {
    if (report.miners.length === 0) return;

    // Determine the primary vendor from the reported miners
    const vendorCounts = new Map<string, number>();
    for (const miner of report.miners) {
      const vendor = this.normalizeVendor(miner.vendor);
      vendorCounts.set(vendor, (vendorCounts.get(vendor) || 0) + 1);
    }

    let primaryVendor = 'unknown';
    let maxCount = 0;
    for (const [vendor, count] of vendorCounts) {
      if (count > maxCount) {
        primaryVendor = vendor;
        maxCount = count;
      }
    }

    const newUserAgent = `${primaryVendor}/sv2`;
    const affected = await this.clientService.updateSv2UserAgentByAddress(
      report.jdcUserIdentity,
      newUserAgent,
    );

    if (affected > 0) {
      this.logger.log(
        `Updated userAgent for ${report.jdcUserIdentity} → ${newUserAgent} (${affected} session(s))`,
      );
    }
  }

  private normalizeVendor(vendor: string): string {
    const v = vendor.split(' ')[0].split('/')[0].split('V')[0];
    const lower = v.toLowerCase();

    if (lower.includes('bosminer') || lower.includes('bos')) {
      return 'Braiins OS';
    }
    if (lower.includes('cpuminer')) {
      return 'cpuminer';
    }

    return v || 'unknown';
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, stored] of this.reports) {
      if (now - stored.receivedAt > this.TTL_MS) {
        this.reports.delete(key);
      }
    }
  }
}
