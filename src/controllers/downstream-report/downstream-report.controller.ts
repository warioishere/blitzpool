import { Body, Controller, Get, Post } from '@nestjs/common';
import { DownstreamMinerReport } from '../../models/DownstreamMinerReport';
import { DownstreamReportService } from '../../services/downstream-report.service';

@Controller('downstream-report')
export class DownstreamReportController {
  constructor(private readonly downstreamReportService: DownstreamReportService) {}

  @Post()
  async receiveReport(@Body() report: DownstreamMinerReport) {
    await this.downstreamReportService.storeReport(report);
    return { success: true, accepted: report.miners.length };
  }

  @Get()
  getReports() {
    return this.downstreamReportService.getReports();
  }
}
