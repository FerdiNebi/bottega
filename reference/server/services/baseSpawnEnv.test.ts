import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBaseSpawnEnv } from './baseSpawnEnv.js';

const TOUCHED_KEYS = ['APPDATA', 'PATHEXT', 'SystemRoot', 'TMPDIR', 'GH_TOKEN', 'SOME_SECRET'];

describe('buildBaseSpawnEnv', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('passes HOME, PATH and the OS profile/shell variables through', () => {
    process.env['APPDATA'] = 'C:\\Users\\u\\AppData\\Roaming';
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
    process.env['SystemRoot'] = 'C:\\WINDOWS';
    process.env['TMPDIR'] = '/tmp/x';

    const env = buildBaseSpawnEnv();

    expect(env).toEqual(expect.objectContaining({
      HOME: process.env['HOME'],
      PATH: process.env['PATH'],
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\WINDOWS',
      TMPDIR: '/tmp/x',
    }));
  });

  it('does not inherit anything outside the allowlist', () => {
    process.env['GH_TOKEN'] = 'ghp_should_not_leak';
    process.env['SOME_SECRET'] = 'nope';

    const env = buildBaseSpawnEnv();

    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('SOME_SECRET');
  });

  it('omits allowlisted keys that are unset', () => {
    delete process.env['TMPDIR'];

    expect(buildBaseSpawnEnv()).not.toHaveProperty('TMPDIR');
  });
});
