import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface GeoLocation {
    city: string;
    country: string;
}

@Injectable()
export class GeoIpService {
    private readonly logger = new Logger(GeoIpService.name);
    private readonly cache = new Map<string, GeoLocation | null>();
    private readonly baseUrl = process.env.GEOIP_API_URL || 'http://ip-api.com';

    constructor(
        private readonly httpService: HttpService,
    ) {}

    public async getLocation(ip: string): Promise<GeoLocation | null> {
        if (this.cache.has(ip)) {
            return this.cache.get(ip);
        }
        try {
            const response = await firstValueFrom(
                this.httpService.get(`${this.baseUrl}/json/${ip}`, {
                    params: { fields: 'status,city,country' },
                    timeout: 2000,
                }),
            );
            if (response.data.status !== 'success') {
                this.logger.warn(`GeoIP lookup failed for ${ip}: ${response.data.status}`);
                this.cache.set(ip, null);
                return null;
            }
            const { city, country } = response.data;
            if (!city && !country) {
                this.cache.set(ip, null);
                return null;
            }
            const location = { city, country };
            this.cache.set(ip, location);
            return location;
        } catch (error) {
            this.logger.error(`GeoIP lookup error for ${ip}: ${error.message}`);
            this.cache.set(ip, null);
            return null;
        }
    }
}

