'use strict';

const { getUserScript } = require('../../src/services/checkin/script.service');

test('cached check-in entry copy follows the request language', async () => {
  const pool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ cluster_key: 'headache', display_name: 'đau đầu', priority: 1, count_7d: 1 }] })
      .mockResolvedValueOnce({ rows: [{ full_name: 'Lan', birth_year: 1970 }] })
      .mockResolvedValueOnce({ rows: [] }),
  };
  const result = await getUserScript(pool, 7, 'en');
  expect(result.greeting).toMatch(/^Hello /);
  expect(result.initial_options.map((option) => option.label)).toEqual([
    'I feel fine', 'A little tired', 'Very tired',
  ]);
});
