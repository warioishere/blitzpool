import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

interface GeoLocation {
    city: string;
    country: string;
}

@Injectable()
export class GeoIpService {
    private readonly baseUrl: string;
    private readonly apiKey?: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        this.baseUrl = this.configService.get<string>('GEOIP_URL');
        this.apiKey = this.configService.get<string>('GEOIP_KEY');
    }

    public async getLocation(ip: string): Promise<GeoLocation | null> {
        if (!this.baseUrl) {
            return null;
        }

        try {
            const response = await firstValueFrom(
                this.httpService.get(`${this.baseUrl}${ip}`, {
                    params: this.apiKey ? { key: this.apiKey } : undefined,
                }),
            );
            const { city, country } = response.data;
            if (!city && !country) {
                return null;
            }
            return { city, country };
        } catch (error) {
            return null;
        }
    }
}

