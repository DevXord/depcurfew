// The generated lists of popular npm and Python packages: sourced and dated like every fact, sorted, without repeats,
// and holding the names typosquatting usually targets.
import { describe, expect, it } from 'vitest';
import { popularPackages } from '../../src/knowledge/popular.ts';
import { popularPythonPackages } from '../../src/knowledge/popular-python.ts';
import { ENVIRONMENT_SOURCES, isOfficialSource } from '../../src/knowledge/sources.ts';

describe('popular packages', () => {
  const names = popularPackages.value;

  it('has an official source and a date that is not in the future', () => {
    expect(isOfficialSource(new URL(popularPackages.source), ENVIRONMENT_SOURCES)).toBe(true);
    expect(popularPackages.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(popularPackages.verifiedAt <= new Date().toISOString().slice(0, 10)).toBe(true);
    expect(popularPackages.note.length).toBeGreaterThan(0);
  });

  it('is sorted and has no repeats', () => {
    expect(names.length).toBeGreaterThan(1000);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds well-known packages', () => {
    for (const name of ['lodash', 'react', 'express', 'chalk', 'typescript', 'cross-env', 'electron', '@types/node']) expect(names).toContain(name);
  });
});

describe('popular Python packages', () => {
  const names = popularPythonPackages.value;

  it('has an official source and a date that is not in the future', () => {
    expect(isOfficialSource(new URL(popularPythonPackages.source), ENVIRONMENT_SOURCES)).toBe(true);
    expect(popularPythonPackages.verifiedAt <= new Date().toISOString().slice(0, 10)).toBe(true);
    expect(popularPythonPackages.note.length).toBeGreaterThan(0);
  });

  it('is sorted and has no repeats', () => {
    expect(names.length).toBeGreaterThan(1000);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds well-known projects', () => {
    for (const name of ['requests', 'numpy', 'boto3', 'urllib3', 'python-dateutil', 'django']) expect(names).toContain(name);
  });
});
