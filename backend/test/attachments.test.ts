import { describe, expect, it } from 'vitest';
import { contentDisposition, isUploadId, safeContentType, safeFilename } from '../src/lib/attachments.js';

describe('attachment helpers', () => {
  it('clean file names', () => {
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFilename('a\u0000b\r\nc.txt')).toBe('a_b_c.txt');
    expect(safeFilename('  .hidden  ')).toBe('hidden');
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename('x'.repeat(300))).toHaveLength(200);
  });

  it('accept only plain content types', () => {
    expect(safeContentType('application/PDF; name="x"')).toBe('application/pdf');
    expect(safeContentType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
    expect(safeContentType('')).toBe('application/octet-stream');
  });

  it('build download dispositions with an ASCII fallback', () => {
    expect(contentDisposition('Fätura "final".pdf')).toBe(`attachment; filename="F_tura _final_.pdf"; filename*=UTF-8''F%C3%A4tura%20%22final%22.pdf`);
  });

  it('recognise upload ids', () => {
    expect(isUploadId('0b8f4a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isUploadId('../x')).toBe(false);
  });
});
