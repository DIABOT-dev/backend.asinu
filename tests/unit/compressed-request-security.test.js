const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('compressed request with trailing bytes cannot crash the HTTP parser', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../fixtures/compressed-body.cjs')],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const response = JSON.parse(result.stdout);
  expect(response.healthyStatus).toBe(200);
  expect(response.body).toEqual({ healthy: true });
});
