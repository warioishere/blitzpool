import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NtfyService {
  public readonly serverUrl?: string;
  public readonly accessToken?: string;
  public readonly topicPrefix?: string;

  constructor(private readonly configService: ConfigService) {
    this.serverUrl = this.configService.get<string>('NTFY_SERVER_URL');
    this.accessToken = this.configService.get<string>('NTFY_ACCESS_TOKEN');
    this.topicPrefix = this.configService.get<string>('NTFY_TOPIC_PREFIX');
  }
}
