import { describe, expect, it } from 'vitest';
import { crc32, readZip, safeEntryPath, writeZip } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('crc32 of a known string', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips stored entries, with UTF-8 names', async () => {
    const entries = [
      { path: 'pet.json', data: text('{"id":"cat"}') },
      { path: 'clips/开心.webp', data: new Uint8Array([1, 2, 3, 255]) },
    ];
    const back = await readZip(writeZip(entries));
    expect(back.map((e) => e.path)).toEqual(['pet.json', 'clips/开心.webp']);
    expect(new TextDecoder().decode(back[0].data)).toBe('{"id":"cat"}');
    expect([...back[1].data]).toEqual([1, 2, 3, 255]);
  });

  it('reads deflated entries (zips made by other tools)', async () => {
    const zip = writeZip([{ path: 'a.txt', data: text('hello hello hello') }]);
    // Patch the entry to method 8 with real deflate data.
    const body = new Uint8Array(await new Response(new Blob([text('hello hello hello')]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const name = text('a.txt');
    const local = new Uint8Array(30 + name.length);
    local.set(zip.subarray(0, 30 + name.length));
    const lv = new DataView(local.buffer);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, body.length, true);
    const central = zip.slice(30 + name.length + 17, zip.length - 22);
    const cv = new DataView(central.buffer);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, body.length, true);
    const end = zip.slice(zip.length - 22);
    new DataView(end.buffer).setUint32(16, local.length + body.length, true);
    const out = new Uint8Array(local.length + body.length + central.length + end.length);
    out.set(local, 0);
    out.set(body, local.length);
    out.set(central, local.length + body.length);
    out.set(end, local.length + body.length + central.length);
    const back = await readZip(out);
    expect(new TextDecoder().decode(back[0].data)).toBe('hello hello hello');
  });

  it('rejects non-zips', async () => {
    await expect(readZip(text('not a zip at all, definitely not'))).rejects.toThrow();
  });

  it('safeEntryPath keeps entries inside the folder', () => {
    expect(safeEntryPath('clips/a.webp')).toBe('clips/a.webp');
    expect(safeEntryPath('./clips//a.webp')).toBe('clips/a.webp');
    expect(safeEntryPath('../evil')).toBeNull();
    expect(safeEntryPath('clips/../../evil')).toBeNull();
    expect(safeEntryPath('/etc/x')).toBeNull();
    expect(safeEntryPath('C:\\x')).toBeNull();
  });
});
