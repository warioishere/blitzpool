import { Sv2ExtranonceManager } from './sv2-extranonce-manager';

afterEach(() => {
  delete process.env.NODE_APP_INSTANCE;
});

describe('Sv2ExtranonceManager', () => {
  it('allocates unique prefixes for different channels', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    const p2 = mgr.allocate(2);
    const p3 = mgr.allocate(3);

    expect(p1).not.toEqual(p2);
    expect(p2).not.toEqual(p3);
    expect(p1).not.toEqual(p3);
  });

  it('returns same prefix for same channel on re-allocation', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1a = mgr.allocate(1);
    const p1b = mgr.allocate(1);
    expect(p1a).toEqual(p1b);
  });

  it('prefix is 4 bytes by default', () => {
    const mgr = new Sv2ExtranonceManager();
    const p = mgr.allocate(1);
    expect(p.length).toBe(4);
  });

  it('minerExtranonceSize is total minus prefix', () => {
    const mgr = new Sv2ExtranonceManager(4, 8);
    expect(mgr.minerExtranonceSize).toBe(4);

    const mgr2 = new Sv2ExtranonceManager(2, 6);
    expect(mgr2.minerExtranonceSize).toBe(4);
  });

  it('releases prefix and allows reuse', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    expect(mgr.allocatedCount).toBe(1);

    mgr.release(1);
    expect(mgr.allocatedCount).toBe(0);
    expect(mgr.getPrefix(1)).toBeUndefined();

    // Should be able to allocate again (may get same or different prefix)
    const p2 = mgr.allocate(10);
    expect(p2.length).toBe(4);
    expect(mgr.allocatedCount).toBe(1);
  });

  it('release is idempotent for unknown channels', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(() => mgr.release(999)).not.toThrow();
  });

  it('getPrefix returns undefined for unallocated channel', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(mgr.getPrefix(42)).toBeUndefined();
  });

  it('getPrefix returns the allocated prefix', () => {
    const mgr = new Sv2ExtranonceManager();
    const p = mgr.allocate(1);
    expect(mgr.getPrefix(1)).toEqual(p);
  });

  it('handles many allocations without collision', () => {
    const mgr = new Sv2ExtranonceManager();
    const prefixes = new Set<string>();

    for (let i = 1; i <= 1000; i++) {
      const p = mgr.allocate(i);
      const hex = p.toString('hex');
      expect(prefixes.has(hex)).toBe(false);
      prefixes.add(hex);
    }

    expect(mgr.allocatedCount).toBe(1000);
  });

  it('works with 2-byte prefix size', () => {
    const mgr = new Sv2ExtranonceManager(2, 4);
    const p = mgr.allocate(1);
    expect(p.length).toBe(2);
    expect(mgr.minerExtranonceSize).toBe(2);
  });

  it('reuses released prefix slot', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    mgr.allocate(2);
    mgr.release(1);

    // Allocate a new channel - p1's prefix should be available
    const p3 = mgr.allocate(3);
    expect(p3.length).toBe(4);
    expect(mgr.allocatedCount).toBe(2);
  });

  it('tracks allocatedCount correctly', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(mgr.allocatedCount).toBe(0);
    mgr.allocate(1);
    expect(mgr.allocatedCount).toBe(1);
    mgr.allocate(2);
    expect(mgr.allocatedCount).toBe(2);
    mgr.release(1);
    expect(mgr.allocatedCount).toBe(1);
    mgr.release(2);
    expect(mgr.allocatedCount).toBe(0);
  });

  describe('PM2 cluster partitioning', () => {
    it('worker 0 prefixes start with 0x00 top byte', () => {
      process.env.NODE_APP_INSTANCE = '0';
      const mgr = new Sv2ExtranonceManager();
      const p = mgr.allocate(1);
      expect(p[0]).toBe(0x00);
      expect(p.readUInt32BE(0)).toBe(1); // 0x00000001
    });

    it('worker 1 prefixes start with 0x01 top byte', () => {
      process.env.NODE_APP_INSTANCE = '1';
      const mgr = new Sv2ExtranonceManager();
      const p = mgr.allocate(1);
      expect(p[0]).toBe(0x01);
      expect(p.readUInt32BE(0)).toBe(0x01000001);
    });

    it('worker 3 prefixes start with 0x03 top byte', () => {
      process.env.NODE_APP_INSTANCE = '3';
      const mgr = new Sv2ExtranonceManager();
      const p = mgr.allocate(1);
      expect(p[0]).toBe(0x03);
      expect(p.readUInt32BE(0)).toBe(0x03000001);
    });

    it('different workers never produce the same prefix', () => {
      const allPrefixes = new Set<string>();

      for (let workerId = 0; workerId < 4; workerId++) {
        process.env.NODE_APP_INSTANCE = String(workerId);
        const mgr = new Sv2ExtranonceManager();
        for (let ch = 1; ch <= 100; ch++) {
          const p = mgr.allocate(ch);
          const hex = p.toString('hex');
          expect(allPrefixes.has(hex)).toBe(false);
          allPrefixes.add(hex);
        }
      }

      expect(allPrefixes.size).toBe(400);
    });

    it('sequential prefixes stay within the worker partition', () => {
      process.env.NODE_APP_INSTANCE = '2';
      const mgr = new Sv2ExtranonceManager();
      for (let ch = 1; ch <= 50; ch++) {
        const p = mgr.allocate(ch);
        expect(p[0]).toBe(0x02); // top byte always matches worker ID
      }
    });
  });
});
