import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface GeoLocation {
    city: string;
    country: string;
}

@Injectable()
export class GeoIpService {
    constructor(
        private readonly httpService: HttpService,
    ) {}

    public async getLocation(ip: string): Promise<GeoLocation | null> {
        try {
            const response = await firstValueFrom(
                this.httpService.get(`https://ip-api.com/json/${ip}`, {
                    params: { fields: 'status,city,country' },
                }),
            );
            if (response.data.status !== 'success') {
                return null;
            }
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

