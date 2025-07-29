import { Injectable } from '@nestjs/common';

interface Sample { ts: number; value: number; }

@Injectable()
export class HashrateHistoryService {
  private history = new Map<string, Map<string, Sample[]>>();

  record(address: string, worker: string | null, value: number) {
    const addrMap = this.history.get(address) || new Map<string, Sample[]>();
    const key = worker || '__TOTAL__';
    const list = addrMap.get(key) || [];
    const now = Date.now();
    list.push({ ts: now, value });
    const cutoff = now - 5 * 60 * 1000;
    while (list.length && list[0].ts < cutoff) {
      list.shift();
    }
    addrMap.set(key, list);
    this.history.set(address, addrMap);
  }

  getAverage(address: string, minutes: number, worker?: string): number {
    const addrMap = this.history.get(address);
    if (!addrMap) return 0;
    const key = worker || '__TOTAL__';
    const list = addrMap.get(key);
    if (!list || list.length === 0) return 0;
    const cutoff = Date.now() - minutes * 60 * 1000;
    const relevant = list.filter(s => s.ts >= cutoff);
    if (relevant.length === 0) return 0;
    const sum = relevant.reduce((a, b) => a + b.value, 0);
    return sum / relevant.length;
  }
}
