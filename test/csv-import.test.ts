import { describe, expect, it } from 'vitest';

import { importCsvRows, parseCsvRecords } from '../src/csv-import.js';

describe('CSV import', () => {
  it('parses BOM, quoted values and headers', () => {
    expect(parseCsvRecords('\uFEFFloginName,displayName\nworker,"Worker, One"\n')).toEqual([
      { loginName: 'worker', displayName: 'Worker, One' },
    ]);
  });

  it('returns a result for every row without hiding partial failures', async () => {
    const result = await importCsvRows([
      { loginName: 'worker-1' },
      { loginName: 'worker-2' },
    ], async row => {
      if (row.loginName === 'worker-2') throw new Error('failed');
      return 'created';
    });

    expect(result).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      items: [
        { row: 2, success: true, message: 'created' },
        { row: 3, success: false, message: '导入失败' },
      ],
    });
  });
});
